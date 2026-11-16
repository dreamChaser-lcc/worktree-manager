import React, { useEffect, useRef, useState } from 'react';
import { fetchCodebuddySessionHistory, replyCodebuddySession } from '../api/codebuddy-client.js';
import { SESSION_SYNC_INTERVAL_OPTION_LIST } from '../utils/codebuddy-ui-config.js';

/**
 * 轻量对话面板（session 机制）。
 *
 * 按 sessionId 拉「问答对」快照，而不是订阅 SSE：
 * 平台和终端 TUI 用同一段会话，两边都能读写，只是刷新节奏不同。
 *
 * 自动同步（轮询）默认关闭；配置由父组件持有并持久化（见 codebuddy-ui-config）。
 * 关闭时只能靠「同步终端消息」手动拉取；发送后的自动刷新始终保留（否则发完看不到结果）。
 */
const DEFAULT_SYNC_CONFIG = { enabled: false, intervalMs: 5000 };

export function CodebuddyChatPanel({
  instanceId,
  instanceState,
  sessionId,
  syncConfig = DEFAULT_SYNC_CONFIG,
  onSyncConfigChange,
  onNotice,
  onNewSession,
  onSwitchSession
}) {
  const [requestList, setRequestList] = useState([]);
  const [sessionName, setSessionName] = useState('');
  const [occupiedByTerminal, setOccupiedByTerminal] = useState(false);
  const [terminalProcessId, setTerminalProcessId] = useState(null);
  const [pendingText, setPendingText] = useState('');
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(false);
  const messageViewReference = useRef(null);
  /**
   * 请求代次：快速切换需求/会话时，先发出的请求可能后返回。
   * 每次发起或切换上下文都自增，回调里比对代次，过期结果直接丢弃，
   * 否则会出现「标题是 B、消息是 A」的串台。
   */
  const requestEpochRef = useRef(0);
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;

  const instanceRunning = instanceState === 'running';
  const composerDisabled = !instanceRunning || !sessionId || occupiedByTerminal || sending;
  const autoSyncEnabled = syncConfig.enabled;

  /**
   * 拉取会话快照。
   * mode: initial=首次加载（显示 loading）、manual=点同步按钮（显示同步中）、auto=后台轮询（静默）
   */
  async function loadHistory(mode = 'initial', isRetry = false) {
    // 实例没跑时不发请求：端口已释放，请求必然 fetch failed，只会污染提示区
    if (!instanceId || !sessionId || !instanceRunning) {
      setRequestList([]);
      setLoading(false);
      setSyncing(false);
      return;
    }
    // 本次请求的代次：返回时如果已经不是最新一次，说明用户切走了，结果作废
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;

    if (mode === 'manual') {
      setSyncing(true);
    } else if (mode === 'initial') {
      setLoading(true);
    }
    try {
      const historyData = await fetchCodebuddySessionHistory(instanceId, sessionId);
      if (requestEpoch !== requestEpochRef.current) {
        return;
      }
      setRequestList(historyData.requestList || []);
      setSessionName(historyData.sessionName || '');
      setOccupiedByTerminal(Boolean(historyData.occupiedByTerminal));
      setTerminalProcessId(historyData.terminalProcessId || null);
    } catch (historyError) {
      if (requestEpoch !== requestEpochRef.current) {
        return;
      }
      // 实例刚重启时端口可能还没就绪，静默重试一次，避免把「启动瞬间的正常抖动」当成错误抛给用户
      if (!isRetry && mode !== 'manual') {
        setTimeout(() => loadHistory('auto', true), 3000);
        return;
      }
      if (onNoticeRef.current) {
        onNoticeRef.current({ type: 'error', text: historyError.message });
      }
    } finally {
      // 只有最新一次请求才有资格复位 loading 状态，避免旧请求把新请求的 loading 提前关掉
      if (requestEpoch === requestEpochRef.current) {
        if (mode === 'manual') {
          setSyncing(false);
        } else if (mode === 'initial') {
          setLoading(false);
        }
      }
    }
  }

  // 切换会话或实例起停时重新拉取（实例刚起来时要补拉一次）
  useEffect(() => {
    // 先作废在途请求并清空上一个上下文的全部残留，再发新请求
    requestEpochRef.current += 1;
    setRequestList([]);
    setSessionName('');
    setOccupiedByTerminal(false);
    setTerminalProcessId(null);
    setLoading(false);
    setSyncing(false);
    loadHistory('initial');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, sessionId, instanceRunning]);

  // 自动同步：仅当用户显式开启时才轮询
  const loadHistoryRef = useRef(loadHistory);
  loadHistoryRef.current = loadHistory;
  useEffect(() => {
    if (!autoSyncEnabled || !instanceId || !sessionId || !instanceRunning) {
      return undefined;
    }
    const pollTimer = setInterval(() => loadHistoryRef.current('auto'), syncConfig.intervalMs);
    return () => clearInterval(pollTimer);
  }, [autoSyncEnabled, syncConfig.intervalMs, instanceId, sessionId, instanceRunning]);

  // 新内容到达后滚到底部
  useEffect(() => {
    if (messageViewReference.current) {
      messageViewReference.current.scrollTop = messageViewReference.current.scrollHeight;
    }
  }, [requestList]);

  async function handleSend() {
    const trimmedText = pendingText.trim();
    if (!trimmedText || !instanceId || !sessionId || sending || occupiedByTerminal) {
      return;
    }
    // 发送期间如果用户切走了，回来的结果不能再写进新上下文的面板
    const epochAtSend = requestEpochRef.current;
    setSending(true);
    try {
      await replyCodebuddySession(instanceId, sessionId, trimmedText);
      if (epochAtSend !== requestEpochRef.current) {
        return;
      }
      setPendingText('');
      // 先乐观回显，再延迟同步真实结果（agent 执行需要时间）
      setRequestList((previousList) => [...previousList, { userInput: trimmedText, finalReply: '' }]);
      setTimeout(() => loadHistory('auto'), 6000);
    } catch (sendError) {
      if (onNoticeRef.current) {
        onNoticeRef.current({ type: 'error', text: sendError.message });
      }
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(keyboardEvent) {
    if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      handleSend();
    }
  }

  const composerPlaceholder = !instanceRunning
    ? '实例未运行，请先启动 CodeBuddy 实例'
    : !sessionId
      ? '当前实例还没有可用的会话'
      : occupiedByTerminal
        ? '终端正在使用这段对话，请先在终端里操作'
        : '发指令（Enter 发送，Shift+Enter 换行）';

  return (
    <div className="codebuddy-chat-panel">
      <div className="codebuddy-chat-toolbar">
        <span className="codebuddy-chat-title">
          {sessionId ? `会话 ${sessionName || sessionId.slice(0, 8)}` : '尚未创建会话'}
          {sessionName ? <span className="codebuddy-chat-state">{sessionId.slice(0, 8)}</span> : null}
        </span>
        <span className="codebuddy-chat-actions">
          <button
            type="button"
            className="button-secondary codebuddy-sync-button"
            disabled={!instanceRunning}
            onClick={onNewSession}
          >
            ＋ 新建会话
          </button>
          <button
            type="button"
            className="button-secondary codebuddy-sync-button"
            disabled={!instanceRunning}
            onClick={onSwitchSession}
          >
            切换会话
          </button>
          <button
            type="button"
            className="button-secondary codebuddy-sync-button"
            disabled={!sessionId || syncing}
            onClick={() => loadHistory('manual')}
          >
            {syncing ? '同步中…' : '同步终端消息'}
          </button>
        </span>
      </div>

      <div className="codebuddy-sync-bar">
        <label className="codebuddy-sync-toggle">
          <input
            type="checkbox"
            checked={autoSyncEnabled}
            onChange={(changeEvent) =>
              onSyncConfigChange({ ...syncConfig, enabled: changeEvent.target.checked })
            }
          />
          自动同步
        </label>
        <select
          className="form-input codebuddy-sync-interval"
          value={syncConfig.intervalMs}
          disabled={!autoSyncEnabled}
          onChange={(changeEvent) =>
            onSyncConfigChange({ ...syncConfig, intervalMs: Number(changeEvent.target.value) })
          }
        >
          {SESSION_SYNC_INTERVAL_OPTION_LIST.map((intervalValue) => (
            <option key={intervalValue} value={intervalValue}>
              每 {intervalValue / 1000} 秒
            </option>
          ))}
        </select>
        <span className="codebuddy-sync-hint">
          {autoSyncEnabled ? '终端里的内容会自动出现' : '已关闭：终端内容需点「同步终端消息」获取'}
        </span>
      </div>

      {occupiedByTerminal ? (
        <div className="alert-warning codebuddy-occupied-hint">
          另一个终端正在使用这段对话（进程 {terminalProcessId || '未知'}），平台侧已禁止发送，避免两边同时写入。
          如需从平台操作，请先关闭那个终端。
        </div>
      ) : null}

      <div className="codebuddy-message-list" ref={messageViewReference}>
        {loading ? (
          <div className="codebuddy-message-empty">正在读取会话…</div>
        ) : requestList.length === 0 ? (
          <div className="codebuddy-message-empty">
            {sessionId ? '这段会话还没有内容' : '请先启动实例并选择会话'}
          </div>
        ) : (
          requestList.map((requestEntry, requestIndex) => (
            <div key={`req-${requestIndex}`} className="codebuddy-request-block">
              <div className="codebuddy-message codebuddy-message-user">
                <div className="codebuddy-message-role">我</div>
                <div className="codebuddy-message-text">{requestEntry.userInput}</div>
              </div>
              <div className="codebuddy-message codebuddy-message-assistant">
                <div className="codebuddy-message-role">CodeBuddy</div>
                <div className="codebuddy-message-text">
                  {requestEntry.finalReply || (
                    <span className="codebuddy-reply-pending">执行中…（稍后点「同步终端消息」获取结果）</span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="codebuddy-composer">
        <textarea
          className="form-input codebuddy-composer-input"
          value={pendingText}
          rows={3}
          placeholder={composerPlaceholder}
          disabled={composerDisabled}
          onChange={(changeEvent) => setPendingText(changeEvent.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="button-primary codebuddy-send-button"
          disabled={composerDisabled || !pendingText.trim()}
          onClick={handleSend}
        >
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
    </div>
  );
}
