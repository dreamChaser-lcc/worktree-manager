import React, { useEffect, useRef, useState } from 'react';
import {
  buildCodebuddyAcpPromptUrl,
  cancelCodebuddyAcp,
  connectCodebuddyAcp,
  fetchCodebuddySessionHistory,
  resolveCodebuddyAcpInterruption,
  setCodebuddyAcpMode,
  setCodebuddyAcpModel
} from '../api/codebuddy-client.js';

/**
 * ACP 通道的对话面板（完整输入框）。
 *
 * 与 rest 面板的区别：
 * - 发送走 ACP 的 session/prompt，支持流式输出、停止、切换模型与权限模式
 * - 历史仍用 REST 的 /sessions/{id}/history 读取（两边读的是同一段会话）
 *
 * ACP 的 SSE 事件（NDJSON）里关心的两类：
 *   { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } }
 *   { method: "session/update", params: { update: { sessionUpdate: "tool_call", title } } }
 *   { id, result: { stopReason } }   ← 本轮结束
 */
/** 权限模式的短标签（下拉里用） */
const MODE_LABEL_MAP = {
  default: '每次都问',
  acceptEdits: '自动允许文件编辑',
  plan: '只分析不改',
  auto: 'AI 审查每个动作',
  dontAsk: '不问，只跑安全操作',
  bypassPermissions: '跳过所有提示',
  fullAccess: '跳过所有检查（含危险命令）'
};

/** 权限模式的完整说明（下拉下方常驻显示当前项） */
const MODE_DETAIL_MAP = {
  default: '每次工具首次使用都弹确认——最安全，但一句话要问你好几次',
  acceptEdits: '文件编辑自动放行，其他操作仍然会问你',
  plan: '只能读取和分析，不能改文件、也不能执行命令',
  auto: '每个动作先由 AI 审查：通过就放行，不通过只拦那一步',
  dontAsk: '不弹确认：已批准的和安全的操作直接跑，其余一律拒绝',
  bypassPermissions: '跳过所有权限提示，危险操作也直接执行',
  fullAccess: '跳过所有检查（含危险命令），只在完全信任的环境用'
};

export function CodebuddyAcpPanel({ instanceId, instanceState, sessionId, onNotice }) {
  const [requestList, setRequestList] = useState([]);
  const [sessionName, setSessionName] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pendingText, setPendingText] = useState('');
  const [sending, setSending] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [liveToolList, setLiveToolList] = useState([]);
  const [modelList, setModelList] = useState([]);
  const [modeList, setModeList] = useState([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedModeId, setSelectedModeId] = useState('');
  const [switchingConfig, setSwitchingConfig] = useState(false);
  // 工具权限请求（interruption_request）：agent 卡在确认上，必须由客户端回应才会继续
  const [interruptionList, setInterruptionList] = useState([]);
  const [resolvingInterruptionId, setResolvingInterruptionId] = useState('');
  // 长时间无结果时提示「可能在等确认」，避免用户一直干等
  const [stallHintVisible, setStallHintVisible] = useState(false);
  const messageViewReference = useRef(null);
  const abortControllerReference = useRef(null);
  const requestEpochRef = useRef(0);
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;

  const instanceRunning = instanceState === 'running';
  const composerDisabled = !instanceRunning || !sessionId || sending;

  /** 拉历史（REST，和 rest 面板读同一段会话） */
  async function loadHistory() {
    if (!instanceId || !sessionId || !instanceRunning) {
      setRequestList([]);
      setLoading(false);
      return;
    }
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    setLoading(true);
    try {
      const historyData = await fetchCodebuddySessionHistory(instanceId, sessionId);
      if (requestEpoch !== requestEpochRef.current) {
        return;
      }
      setRequestList(historyData.requestList || []);
      setSessionName(historyData.sessionName || '');
    } catch (historyError) {
      if (requestEpoch === requestEpochRef.current && onNoticeRef.current) {
        onNoticeRef.current({ type: 'error', text: historyError.message });
      }
    } finally {
      if (requestEpoch === requestEpochRef.current) {
        setLoading(false);
      }
    }
  }

  /** 建立 ACP 连接：拿模型 / 权限模式列表（实例刚起来时端口可能未就绪，静默重试一次） */
  async function connectAcp(isRetry = false) {
    if (!instanceId || !sessionId || !instanceRunning) {
      setModelList([]);
      setModeList([]);
      return;
    }
    try {
      const connectResult = await connectCodebuddyAcp(instanceId, sessionId);
      const availableModelList = (connectResult.models && connectResult.models.availableModels) || [];
      const availableModeList = (connectResult.modes && connectResult.modes.availableModes) || [];
      setModelList(availableModelList);
      setModeList(availableModeList);
      setSelectedModelId(
        (connectResult.models && connectResult.models.currentModelId) || availableModelList[0]?.modelId || ''
      );
      setSelectedModeId(
        (connectResult.modes && connectResult.modes.currentModeId) || availableModeList[0]?.id || ''
      );
    } catch (connectError) {
      if (!isRetry) {
        setTimeout(() => connectAcp(true), 2500);
        return;
      }
      if (onNoticeRef.current) {
        onNoticeRef.current({ type: 'error', text: `ACP 连接失败：${connectError.message}` });
      }
    }
  }

  // 上下文变化时重置并重新加载。
  // 用 cleanup 标记判定「这次结果还归我管」，比自增代次更不容易被 effect 重跑误伤。
  // 串行执行：ACP 的 session/load 会回放整段历史（很重），和 history 并发会互相拖慢。
  useEffect(() => {
    let cancelled = false;
    setRequestList([]);
    setSessionName('');
    setLiveText('');
    setLiveToolList([]);
    setLoading(false);

    (async () => {
      if (!instanceId || !sessionId || !instanceRunning) {
        return;
      }
      setLoading(true);
      try {
        const historyData = await fetchCodebuddySessionHistory(instanceId, sessionId);
        if (cancelled) {
          return;
        }
        setRequestList(historyData.requestList || []);
        setSessionName(historyData.sessionName || '');
      } catch (historyError) {
        if (!cancelled && onNoticeRef.current) {
          onNoticeRef.current({ type: 'error', text: historyError.message });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
      if (cancelled) {
        return;
      }
      await connectAcp();
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, sessionId, instanceRunning]);

  useEffect(() => {
    if (messageViewReference.current) {
      messageViewReference.current.scrollTop = messageViewReference.current.scrollHeight;
    }
  }, [requestList, liveText, liveToolList]);

  /** 解析 ACP 的 SSE 流，边收边渲染 */
  async function consumeAcpStream(responseBody) {
    const streamReader = responseBody.getReader();
    const textDecoder = new TextDecoder();
    let pendingBuffer = '';
    let accumulatedText = '';
    while (true) {
      const { done, value } = await streamReader.read();
      if (done) {
        break;
      }
      pendingBuffer += textDecoder.decode(value, { stream: true });
      let boundaryIndex = pendingBuffer.indexOf('\n\n');
      while (boundaryIndex >= 0) {
        const rawChunk = pendingBuffer.slice(0, boundaryIndex);
        pendingBuffer = pendingBuffer.slice(boundaryIndex + 2);
        boundaryIndex = pendingBuffer.indexOf('\n\n');

        const dataLine = rawChunk.split('\n').find((lineText) => lineText.startsWith('data: '));
        if (!dataLine) {
          continue;
        }
        let acpMessage = null;
        try {
          acpMessage = JSON.parse(dataLine.slice(6));
        } catch {
          continue;
        }

        if (acpMessage.method === 'session/update' && acpMessage.params) {
          const updatePayload = acpMessage.params.update;
          if (!updatePayload) {
            continue;
          }
          if (
            updatePayload.sessionUpdate === 'agent_message_chunk' &&
            updatePayload.content &&
            updatePayload.content.text
          ) {
            accumulatedText += updatePayload.content.text;
            setLiveText(accumulatedText);
          } else if (updatePayload.sessionUpdate === 'tool_call') {
            const toolLabel = updatePayload.title || updatePayload.kind || '工具调用';
            setLiveToolList((previousList) => [...previousList, toolLabel]);
          } else if (updatePayload.sessionUpdate === 'interruption_request') {
            // 权限确认：agent 在这里阻塞，不回应该请求就一直转圈
            const toolCallId = updatePayload.toolCallId || '';
            if (toolCallId) {
              setInterruptionList((previousList) => {
                if (previousList.some((item) => item.toolCallId === toolCallId)) {
                  return previousList;
                }
                return [
                  ...previousList,
                  {
                    toolCallId,
                    toolName: updatePayload.toolName || updatePayload.title || '工具',
                    detailText: updatePayload.input
                      ? JSON.stringify(updatePayload.input).slice(0, 300)
                      : updatePayload.title || ''
                  }
                ];
              });
            }
          }
        }
      }
    }
    return accumulatedText;
  }

  /**
   * 卡住检测：ACP 的权限确认不走 session/prompt 的流（实测是 `_codebuddy.ai/command` 这类反向通知），
   * 平台目前无法代为确认。所以超过阈值就明确告诉用户，而不是让人对着「思考中」干等。
   */
  useEffect(() => {
    if (!sending) {
      setStallHintVisible(false);
      return undefined;
    }
    const stallTimer = setTimeout(() => setStallHintVisible(true), 60_000);
    return () => clearTimeout(stallTimer);
  }, [sending]);

  /**
   * 发送期间监测实例是否还活着。
   * 实例被关掉/崩溃时，上游 SSE 不会主动结束，界面会永远停在「思考中」，
   * 所以这里每 8 秒探一次 overview，发现实例不在 running 就主动中断本轮。
   */
  useEffect(() => {
    if (!sending || !instanceId) {
      return undefined;
    }
    const livenessTimer = setInterval(async () => {
      try {
        const overviewResponse = await fetch('/api/codebuddy/overview');
        const overviewData = await overviewResponse.json();
        const matchedInstance = (overviewData.instanceList || []).find(
          (instanceEntry) => instanceEntry.id === instanceId
        );
        if (!matchedInstance || matchedInstance.state !== 'running') {
          if (abortControllerReference.current) {
            abortControllerReference.current.abort();
          }
          if (onNoticeRef.current) {
            onNoticeRef.current({
              type: 'error',
              text: '实例已停止或不可用，本轮对话已中断'
            });
          }
        }
      } catch {
        // overview 拿不到就跳过这轮探测
      }
    }, 8000);
    return () => clearInterval(livenessTimer);
  }, [sending, instanceId]);

  async function handleSend() {
    const trimmedText = pendingText.trim();
    if (!trimmedText || !instanceId || !sessionId || sending) {
      return;
    }
    setSending(true);
    setPendingText('');
    setLiveText('');
    setLiveToolList([]);
    setInterruptionList([]);

    const abortController = new AbortController();
    abortControllerReference.current = abortController;
    try {
      const promptResponse = await fetch(buildCodebuddyAcpPromptUrl(instanceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          prompt: [{ type: 'text', text: trimmedText }]
        }),
        signal: abortController.signal
      });
      if (!promptResponse.ok || !promptResponse.body) {
        const errorBody = await promptResponse.text().catch(() => '');
        throw new Error(`发送失败（HTTP ${promptResponse.status}）${errorBody.slice(0, 120)}`);
      }
      await consumeAcpStream(promptResponse.body);
    } catch (sendError) {
      if (sendError.name !== 'AbortError') {
        if (onNoticeRef.current) {
          onNoticeRef.current({ type: 'error', text: sendError.message });
        }
      }
    } finally {
      abortControllerReference.current = null;
      setSending(false);
      // agent 的回复是在 result 之后才落库的，立刻拉会拿不到这一轮；
      // 先保留流式内容，稍晚一点再用 REST 历史校准（loadHistory 内部有代次校验）
      setTimeout(async () => {
        await loadHistory();
        setLiveText('');
        setLiveToolList([]);
      }, 1200);
    }
  }

  /** 回应工具权限请求 */
  async function handleResolveInterruption(interruptionItem, decision) {
    if (!instanceId || !sessionId) {
      return;
    }
    setResolvingInterruptionId(interruptionItem.toolCallId);
    try {
      await resolveCodebuddyAcpInterruption(instanceId, {
        sessionId,
        toolCallId: interruptionItem.toolCallId,
        decision
      });
      setInterruptionList((previousList) =>
        previousList.filter((item) => item.toolCallId !== interruptionItem.toolCallId)
      );
      if (onNoticeRef.current) {
        const decisionText =
          decision === 'deny' ? '已拒绝该工具调用' : decision === 'allowAll' ? '本会话全部允许' : '已允许';
        onNoticeRef.current({ type: 'success', text: `${interruptionItem.toolName}：${decisionText}` });
      }
    } catch (resolveError) {
      if (onNoticeRef.current) {
        onNoticeRef.current({ type: 'error', text: resolveError.message });
      }
    } finally {
      setResolvingInterruptionId('');
    }
  }

  async function handleStop() {
    if (!instanceId || !sessionId) {
      return;
    }
    try {
      await cancelCodebuddyAcp(instanceId, sessionId);
      if (abortControllerReference.current) {
        abortControllerReference.current.abort();
      }
    } catch (stopError) {
      if (onNoticeRef.current) {
        onNoticeRef.current({ type: 'error', text: stopError.message });
      }
    }
  }

  async function handleModelChange(modelId) {
    setSelectedModelId(modelId);
    setSwitchingConfig(true);
    try {
      await setCodebuddyAcpModel(instanceId, sessionId, modelId);
      if (onNoticeRef.current) {
        onNoticeRef.current({ type: 'success', text: `已切换模型：${modelId}` });
      }
    } catch (modelError) {
      if (onNoticeRef.current) {
        onNoticeRef.current({ type: 'error', text: modelError.message });
      }
    } finally {
      setSwitchingConfig(false);
    }
  }

  async function handleModeChange(modeId) {
    setSelectedModeId(modeId);
    setSwitchingConfig(true);
    try {
      await setCodebuddyAcpMode(instanceId, sessionId, modeId);
      const matchedMode = modeList.find((modeEntry) => modeEntry.id === modeId);
      if (onNoticeRef.current) {
        onNoticeRef.current({ type: 'success', text: `已切换权限模式：${matchedMode ? matchedMode.name : modeId}` });
      }
    } catch (modeError) {
      if (onNoticeRef.current) {
        onNoticeRef.current({ type: 'error', text: modeError.message });
      }
    } finally {
      setSwitchingConfig(false);
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
      : '给智能体发消息（Enter 发送，Shift+Enter 换行）';

  return (
    <div className="codebuddy-chat-panel">
      <div className="codebuddy-chat-toolbar">
        <span className="codebuddy-chat-title">
          {sessionId ? `会话 ${sessionName || sessionId.slice(0, 8)}` : '尚未创建会话'}
          <span className="codebuddy-channel-badge">ACP</span>
        </span>
        <span className="codebuddy-chat-actions">
          <button
            type="button"
            className="button-secondary codebuddy-sync-button"
            disabled={!instanceRunning || syncing}
            onClick={async () => {
              setSyncing(true);
              try {
                await loadHistory();
              } finally {
                setSyncing(false);
              }
            }}
          >
            {syncing ? '同步中…' : '同步终端消息'}
          </button>
        </span>
      </div>

      <div className="codebuddy-message-list" ref={messageViewReference}>
        {loading ? (
          <div className="codebuddy-message-empty">正在读取会话…</div>
        ) : requestList.length === 0 && !liveText ? (
          <div className="codebuddy-message-empty">
            {sessionId ? '这段会话还没有内容' : '请先启动实例并选择会话'}
          </div>
        ) : (
          <>
            {requestList.map((requestEntry, requestIndex) => (
              <div key={`req-${requestIndex}`} className="codebuddy-request-block">
                <div className="codebuddy-message codebuddy-message-user">
                  <div className="codebuddy-message-role">我</div>
                  <div className="codebuddy-message-text">{requestEntry.userInput}</div>
                </div>
                <div className="codebuddy-message codebuddy-message-assistant">
                  <div className="codebuddy-message-role">CodeBuddy</div>
                  <div className="codebuddy-message-text">{requestEntry.finalReply || '…'}</div>
                </div>
              </div>
            ))}
            {liveText || liveToolList.length > 0 ? (
              <div className="codebuddy-request-block">
                {liveToolList.length > 0 ? (
                  <div className="codebuddy-tool-list">
                    {liveToolList.map((toolLabel, toolIndex) => (
                      <span key={`tool-${toolIndex}`} className="codebuddy-tool-chip">
                        工具：{toolLabel}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="codebuddy-message codebuddy-message-assistant">
                  <div className="codebuddy-message-role">CodeBuddy</div>
                  <div className="codebuddy-message-text">{liveText || '思考中…'}</div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {stallHintVisible && sending ? (
        <div className="alert-warning codebuddy-stall-hint">
          已等待超过 60 秒还没结果：有可能 agent 在等工具权限确认，而 ACP 通道下平台暂时无法代为确认。
          建议点「停止」结束本轮，再把权限模式切成 <strong>Auto</strong> 后重试。
        </div>
      ) : null}

      {interruptionList.length > 0 ? (
        <div className="codebuddy-interruption-list">
          {interruptionList.map((interruptionItem) => (
            <div key={interruptionItem.toolCallId} className="codebuddy-interruption-card">
              <div className="codebuddy-interruption-head">
                需要确认才能继续：{interruptionItem.toolName}
              </div>
              {interruptionItem.detailText ? (
                <pre className="codebuddy-interruption-detail">{interruptionItem.detailText}</pre>
              ) : null}
              <div className="codebuddy-interruption-actions">
                <button
                  type="button"
                  className="button-primary"
                  disabled={resolvingInterruptionId === interruptionItem.toolCallId}
                  onClick={() => handleResolveInterruption(interruptionItem, 'allow')}
                >
                  允许
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={resolvingInterruptionId === interruptionItem.toolCallId}
                  onClick={() => handleResolveInterruption(interruptionItem, 'allowAll')}
                >
                  本会话全部允许
                </button>
                <button
                  type="button"
                  className="button-danger"
                  disabled={resolvingInterruptionId === interruptionItem.toolCallId}
                  onClick={() => handleResolveInterruption(interruptionItem, 'deny')}
                >
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="codebuddy-acp-toolbar">
        <select
          className="form-input codebuddy-acp-select"
          value={selectedModelId}
          disabled={!instanceRunning || modelList.length === 0 || switchingConfig}
          onChange={(changeEvent) => handleModelChange(changeEvent.target.value)}
        >
          {modelList.length === 0 ? <option value="">模型</option> : null}
          {modelList.map((modelEntry) => (
            <option key={modelEntry.modelId} value={modelEntry.modelId}>
              {modelEntry.name}
              {modelEntry.description ? ` · ${modelEntry.description}` : ''}
            </option>
          ))}
        </select>
        <select
          className="form-input codebuddy-acp-select"
          value={selectedModeId}
          disabled={!instanceRunning || modeList.length === 0 || switchingConfig}
          onChange={(changeEvent) => handleModeChange(changeEvent.target.value)}
        >
          {modeList.length === 0 ? <option value="">权限模式</option> : null}
          {modeList.map((modeEntry) => (
            <option key={modeEntry.id} value={modeEntry.id}>
              {modeEntry.name}
              {MODE_LABEL_MAP[modeEntry.id] ? ` · ${MODE_LABEL_MAP[modeEntry.id]}` : ''}
            </option>
          ))}
        </select>
        <span className="codebuddy-acp-mode-hint">
          {MODE_DETAIL_MAP[selectedModeId] || '当前权限模式决定 agent 执行操作前是否需要你确认'}
        </span>
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
        {sending ? (
          <button type="button" className="button-danger codebuddy-send-button" onClick={handleStop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="button-primary codebuddy-send-button"
            disabled={composerDisabled || !pendingText.trim()}
            onClick={handleSend}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
