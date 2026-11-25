import React, { useEffect, useRef, useState } from 'react';
import { CodebuddyAcpPanel } from './CodebuddyAcpPanel.jsx';
import { CodebuddyChatPanel } from './CodebuddyChatPanel.jsx';
import { CodebuddySessionPickerDialog } from './CodebuddySessionPickerDialog.jsx';
import {
  fetchCodebuddyOverview,
  fetchCodebuddySessionList,
  openCodebuddyInHerdr,
  openCodebuddyTerminal,
  startCodebuddyInstance,
  stopCodebuddyInstance
} from '../api/codebuddy-client.js';
import {
  OVERVIEW_INTERVAL_OPTION_LIST,
  readCodebuddyUiConfig,
  writeCodebuddyUiConfig
} from '../utils/codebuddy-ui-config.js';

/**
 * CodeBuddy 工作台页签：左列需求任务，右侧实例控制 + 轻量对话。
 * 实例状态由服务端探活，刷新频率可在页面顶部配置（默认 5 秒，页面隐藏时自动暂停）。
 */

/** 从会话端点 URL 提取端口，无 URL 时返回空串（交由调用方回退到 port 字段） */
function describeSessionUrl(sessionUrl) {
  const matchedPort = String(sessionUrl || '').match(/:(\d+)/);
  return matchedPort ? `端口 ${matchedPort[1]}` : '';
}

/** 实例状态 → 展示文案与样式后缀 */
function describeInstanceState(instanceState) {
  const stateDescriptorMap = {
    running: { stateText: '运行中', stateClass: 'codebuddy-dot-online' },
    starting: { stateText: '启动中', stateClass: 'codebuddy-dot-pending' },
    error: { stateText: '异常', stateClass: 'codebuddy-dot-error' },
    stopped: { stateText: '已停止', stateClass: 'codebuddy-dot-idle' }
  };
  return stateDescriptorMap[instanceState] || { stateText: '未启动', stateClass: 'codebuddy-dot-idle' };
}

export function CodebuddyPanel() {
  const [overviewData, setOverviewData] = useState(null);
  const [overviewError, setOverviewError] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  // 刷新配置：实例状态轮询 + 对话内容同步，存 localStorage
  const [uiConfig, setUiConfig] = useState(readCodebuddyUiConfig);
  // 长耗时操作的全局遮罩（启动/重建实例要 20~40 秒，没有反馈会被反复点击）
  const [pendingActionText, setPendingActionText] = useState('');
  const [pendingElapsedSeconds, setPendingElapsedSeconds] = useState(0);
  const [overviewRefreshing, setOverviewRefreshing] = useState(false);
  // 启动弹窗里的配置：启动位置（窗口 / herdr）、端口（留空自动分配）、续接方式
  const [launchTarget, setLaunchTarget] = useState('herdr-app');
  const [launchPort, setLaunchPort] = useState('');
  // last = 直接续接上次会话；switch = 启动后再弹窗让用户挑
  const [launchResumeMode, setLaunchResumeMode] = useState('last');
  // rest = 轻量输入框（纯文本）；acp = 完整输入框（模型/权限/停止）
  const [launchSessionChannel, setLaunchSessionChannel] = useState('rest');
  const [busyAction, setBusyAction] = useState('');
  const [noticeMessage, setNoticeMessage] = useState(null);
  // 终端会话选择弹窗：列出该 worktree 下的历史会话，选一个续接或新建
  const [sessionPickerVisible, setSessionPickerVisible] = useState(false);
  // 选择器服务哪个入口：terminal=本地 TUI，herdr=herdr 工作区
  const [sessionPickerMode, setSessionPickerMode] = useState('terminal');
  const [sessionList, setSessionList] = useState([]);
  const [sessionListLoading, setSessionListLoading] = useState(false);
  const [sessionListMessage, setSessionListMessage] = useState('');
  const [sessionInstanceRunning, setSessionInstanceRunning] = useState(false);
  // herdr 服务未运行时的启动确认层（记住待打开的会话，确认后接着续接）
  const [herdrConfirmVisible, setHerdrConfirmVisible] = useState(false);
  const [pendingHerdrSessionId, setPendingHerdrSessionId] = useState('');
  const mountedReference = useRef(true);

  useEffect(() => {
    mountedReference.current = true;
    return () => {
      mountedReference.current = false;
    };
  }, []);

  // 遮罩期间计时，让用户知道「还在跑」而不是死了
  useEffect(() => {
    if (!pendingActionText) {
      setPendingElapsedSeconds(0);
      return undefined;
    }
    const startTimestamp = Date.now();
    const elapsedTimer = setInterval(() => {
      setPendingElapsedSeconds(Math.floor((Date.now() - startTimestamp) / 1000));
    }, 1000);
    return () => clearInterval(elapsedTimer);
  }, [pendingActionText]);

  async function loadOverview({ silent = false } = {}) {
    if (!silent) {
      setOverviewRefreshing(true);
    }
    try {
      const nextOverview = await fetchCodebuddyOverview();
      if (!mountedReference.current) {
        return;
      }
      setOverviewData(nextOverview);
      setOverviewError(null);
    } catch (loadError) {
      if (!silent && mountedReference.current) {
        setOverviewError(loadError.message);
      }
    } finally {
      if (!silent) {
        setOverviewRefreshing(false);
      }
    }
  }

  /**
   * 实例状态轮询（只刷状态灯/端口，不刷对话内容）。
   * 页面切到后台时暂停：标签页不可见时没人看状态，继续请求纯属浪费。
   * 回到前台立刻补一次，避免看到过期状态。
   */
  const loadOverviewRef = useRef(loadOverview);
  loadOverviewRef.current = loadOverview;

  useEffect(() => {
    loadOverviewRef.current();
    let overviewTimer = null;
    const startOverviewPolling = () => {
      if (overviewTimer) {
        return;
      }
      overviewTimer = setInterval(
        () => loadOverviewRef.current({ silent: true }),
        uiConfig.overviewPoll.intervalMs
      );
    };
    const stopOverviewPolling = () => {
      if (!overviewTimer) {
        return;
      }
      clearInterval(overviewTimer);
      overviewTimer = null;
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopOverviewPolling();
        return;
      }
      loadOverviewRef.current({ silent: true });
      if (uiConfig.overviewPoll.enabled) {
        startOverviewPolling();
      }
    };

    // 配置为「关闭」时只拉一次，不再起定时器
    if (uiConfig.overviewPoll.enabled && !document.hidden) {
      startOverviewPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopOverviewPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiConfig.overviewPoll.enabled, uiConfig.overviewPoll.intervalMs]);

  // 首次拿到数据后默认选中第一个需求
  useEffect(() => {
    if (selectedTaskId || !overviewData) {
      return;
    }
    const firstTask = (overviewData.requirementTaskList || [])[0];
    if (firstTask) {
      setSelectedTaskId(firstTask.id);
    }
  }, [overviewData, selectedTaskId]);

  const taskList = (overviewData && overviewData.requirementTaskList) || [];
  const instanceList = (overviewData && overviewData.instanceList) || [];
  const environment = (overviewData && overviewData.environment) || null;
  const selectedTask = taskList.find((taskEntry) => taskEntry.id === selectedTaskId) || null;
  const selectedInstance = instanceList.find((instanceEntry) => instanceEntry.taskId === selectedTaskId) || null;
  const environmentReady = Boolean(environment && environment.executableAvailable && environment.tokenAvailable);
  // 平台按会话读写对话：优先用实例记录的 activeSessionId
  const activeSessionId = (selectedInstance && selectedInstance.activeSessionId) || '';

  /** 更新并持久化刷新配置 */
  function updateUiConfig(nextConfig) {
    setUiConfig(nextConfig);
    writeCodebuddyUiConfig(nextConfig);
  }

  function handleSelectTask(taskId) {
    setSelectedTaskId(taskId);
    setNoticeMessage(null);
    setLaunchPort('');
    // 切换需求时收起可能残留的选择框，避免带着上一个需求的上下文继续操作
    setSessionPickerVisible(false);
  }

  /**
   * 启动入口：先让用户选「启动位置（终端 CLI / herdr）+ 端口 + 会话」，
   * 一个需求只会拉起一个实例，端口也由这里定死。
   */
  async function handleStartInstanceFlow(presetTarget) {
    if (!selectedTask) {
      return;
    }
    if (selectedInstance && selectedInstance.state === 'running') {
      setNoticeMessage({
        type: 'warning',
        text: `实例已在运行（端口 ${selectedInstance.port}），无需重复启动`
      });
      return;
    }
    setLaunchTarget(presetTarget || 'herdr-app');
    setLaunchPort(selectedInstance ? String(selectedInstance.port) : '');
    await openSessionPicker('launch');
  }

  /** 按弹窗里选好的配置真正拉起实例 */
  async function handleLaunchWithSession(sessionId) {
    if (!selectedTask) {
      return;
    }
    // 先收起启动弹窗，再用遮罩接管整个等待过程
    setSessionPickerVisible(false);
    setBusyAction('start');
    setNoticeMessage(null);
    setPendingActionText('正在启动 CodeBuddy 实例（首次约 20~30 秒）…');
    try {
      const startResult = await startCodebuddyInstance({
        taskId: selectedTask.id,
        port: launchPort.trim() || undefined,
        launchTarget,
        sessionId: sessionId || undefined,
        // 默认续接上次会话；用户选了"启动后选择会话"时，起来之后再弹窗挑
        resumeMode: sessionId ? undefined : 'last',
        sessionChannel: launchSessionChannel
      });
      setSessionPickerVisible(false);
      setLaunchPort('');
      const targetTextMap = {
      herdr: 'herdr 工作区',
      'herdr-app': 'herdr app',
      window: '独立终端窗口'
    };
    const targetText = targetTextMap[launchTarget] || '独立终端窗口';
      setNoticeMessage({
        type: 'success',
        text: `已在${targetText}启动 CodeBuddy TUI（端口 ${startResult.instance.port}）`
      });
      await loadOverview();

      // 只有选了「启动后选择会话」才弹窗；默认是安静地续接上次那段
      if (launchResumeMode === 'switch') {
        // 先撤掉遮罩，否则会盖住下面要弹的选择框
        setPendingActionText('');
        try {
          const sessionData = await fetchCodebuddySessionList(selectedTask.id);
          const historySessionList = sessionData.sessionList || [];
          setSessionList(historySessionList);
          setSessionInstanceRunning(true);
          setSessionListMessage(sessionData.message || '');
          setSessionPickerMode('switch');
          setSessionPickerVisible(true);
        } catch {
          // 拉取失败不影响已启动的实例
        }
      }
    } catch (startError) {
      setNoticeMessage({ type: 'error', text: startError.message });
    } finally {
      setBusyAction('');
      setPendingActionText('');
    }
  }

  /** 已启动后改选续接会话：按同端口重建 TUI，让它加载所选会话的历史 */
  async function handleSwitchSession(sessionId) {
    if (!selectedTask) {
      return;
    }
    // 立刻收起选择框，让遮罩成为唯一焦点（否则等待期间用户还会去点列表）
    setSessionPickerVisible(false);
    setBusyAction('start');
    setNoticeMessage(null);
    setPendingActionText('正在切换到所选会话（需重建终端）…');
    try {
      const switchResult = await startCodebuddyInstance({
        taskId: selectedTask.id,
        // 沿用当前端口，避免切会话后端口漂移
        port: selectedInstance && selectedInstance.state === 'running' ? String(selectedInstance.port) : '',
        launchTarget,
        sessionId,
        // 切换会话沿用当前通道，不因为重建而丢掉配置
        sessionChannel: (selectedInstance && selectedInstance.sessionChannel) || 'rest',
        forceRestart: true
      });
      setSessionPickerVisible(false);
      setNoticeMessage({
        type: 'success',
        text: `已续接历史会话（端口 ${switchResult.instance.port}）`
      });
      await loadOverview();
    } catch (switchError) {
      setNoticeMessage({ type: 'error', text: switchError.message });
    } finally {
      setBusyAction('');
      setPendingActionText('');
    }
  }

  /** 新建会话：按同端口重建 TUI，不续接任何历史 */
  async function handleNewSession() {
    if (!selectedTask) {
      return;
    }
    setBusyAction('start');
    setNoticeMessage(null);
    setPendingActionText('正在新建空白会话（需重建终端）…');
    try {
      const startResult = await startCodebuddyInstance({
        taskId: selectedTask.id,
        port: selectedInstance && selectedInstance.state === 'running' ? String(selectedInstance.port) : '',
        launchTarget,
        resumeMode: 'new',
        sessionChannel: (selectedInstance && selectedInstance.sessionChannel) || 'rest',
        forceRestart: true
      });
      setNoticeMessage({
        type: 'success',
        text: `已新建空白会话（端口 ${startResult.instance.port}）`
      });
      await loadOverview();
    } catch (createError) {
      setNoticeMessage({ type: 'error', text: createError.message });
    } finally {
      setBusyAction('');
      setPendingActionText('');
    }
  }

  /** 切换会话：打开历史会话选择器（列表里不再有"新建会话"项） */
  async function handleOpenSwitchSession() {
    await openSessionPicker('switch');
  }

  async function handleStopInstance() {
    if (!selectedInstance) {
      return;
    }
    setBusyAction('stop');
    setNoticeMessage(null);
    setPendingActionText('正在停止实例…');
    try {
      const stopResult = await stopCodebuddyInstance(selectedInstance.id);
      setNoticeMessage({
        type: 'success',
        text: stopResult.detachedOnly
          ? '已解除与该 CodeBuddy 进程的绑定（进程本身仍在运行）'
          : '实例已停止'
      });
      await loadOverview();
    } catch (stopError) {
      setNoticeMessage({ type: 'error', text: stopError.message });
    } finally {
      setBusyAction('');
      setPendingActionText('');
    }
  }

  function handleOpenOfficialWorkbench() {
    if (selectedInstance && selectedInstance.webUiUrl) {
      window.open(selectedInstance.webUiUrl, '_blank', 'noopener,noreferrer');
    }
  }

  /**
   * 打开会话选择器：pickerMode=terminal 选完走本地 TUI，pickerMode=herdr 选完走 herdr 工作区。
   * 两个入口都要先拉该 worktree 下的历史会话（避免跨目录 sessionId 报 "No conversation found"）。
   */
  async function openSessionPicker(pickerMode) {
    if (!selectedTask) {
      return;
    }
    setSessionPickerMode(pickerMode);
    setSessionPickerVisible(true);
    setSessionList([]);
    setSessionListMessage('');
    setSessionListLoading(true);
    setSessionInstanceRunning(Boolean(selectedInstance && selectedInstance.state === 'running'));
    try {
      const sessionData = await fetchCodebuddySessionList(selectedTask.id);
      setSessionList(sessionData.sessionList || []);
      setSessionInstanceRunning(Boolean(sessionData.instanceRunning));
      setSessionListMessage(sessionData.message || '');
    } catch (listError) {
      setSessionListMessage(listError.message);
    } finally {
      setSessionListLoading(false);
    }
  }

  /**
   * 在 herdr 打开工作区；sessionId 有值时顺带在工作区面板里执行 codebuddy --resume 续接对话。
   * herdr 服务未运行时接口返回 needsServerStart，先弹确认再带 startServer 重试。
   */
  async function executeHerdrOpen(sessionId, startServer) {
    if (!selectedTask) {
      return;
    }
    setBusyAction('herdr');
    setNoticeMessage(null);
    try {
      const herdrResult = await openCodebuddyInHerdr(selectedTask.id, sessionId, startServer);
      if (herdrResult.needsServerStart) {
        setPendingHerdrSessionId(sessionId || '');
        setHerdrConfirmVisible(true);
        return;
      }

      // 会话已有 TUI 在跑：不新起进程，只聚焦/提示
      if (herdrResult.mode === 'focus-herdr') {
        setSessionPickerVisible(false);
        setNoticeMessage({ type: 'success', text: '该会话已在 herdr 中运行，已切换到对应工作区' });
        return;
      }
      if (herdrResult.mode === 'running-elsewhere' || herdrResult.mode === 'running-in-window') {
        setSessionPickerVisible(false);
        setNoticeMessage({
          type: 'warning',
          text: `CodeBuddy TUI 已在运行（${
            describeSessionUrl(herdrResult.sessionUrl) || `端口 ${herdrResult.port || '未知'}`
          }），未重复打开`
        });
        return;
      }

      setSessionPickerVisible(false);
      const clientActionText =
        herdrResult.clientAction === 'launched'
          ? '，已启动 herdr 终端'
          : herdrResult.clientAction === 'activated'
            ? '，已切到 herdr 窗口'
            : '';
      const resumeText = herdrResult.commandResult ? '，已在该面板续接所选会话' : '';
      const errorText = herdrResult.commandError ? `（续接失败：${herdrResult.commandError}）` : '';
      setNoticeMessage({
        type: herdrResult.commandError ? 'error' : 'success',
        text: `${herdrResult.created ? '已在 herdr 新建工作区' : '已在 herdr 复用工作区'}「${herdrResult.label}」${clientActionText}${resumeText}${errorText}`
      });
    } catch (herdrError) {
      setNoticeMessage({ type: 'error', text: herdrError.message });
    } finally {
      setBusyAction('');
    }
  }

  /** 选定会话后按当前弹窗模式执行：launch=启动实例，terminal/herdr=打开已有入口 */
  async function handleSelectSession(sessionId) {
    if (!selectedTask) {
      return;
    }
    if (sessionPickerMode === 'launch') {
      await handleLaunchWithSession(sessionId);
      return;
    }
    if (sessionPickerMode === 'switch') {
      // 选「新建会话」= 保持当前空白会话，直接关掉弹窗
      if (!sessionId) {
        setSessionPickerVisible(false);
        return;
      }
      await handleSwitchSession(sessionId);
      return;
    }
    if (sessionPickerMode === 'herdr') {
      await executeHerdrOpen(sessionId, false);
      return;
    }
    setBusyAction('terminal');
    setNoticeMessage(null);
    try {
      const openResult = await openCodebuddyTerminal(selectedTask.id, { sessionId });
      setSessionPickerVisible(false);
      if (openResult.reused) {
        setSessionPickerVisible(false);
        setNoticeMessage({
          type: 'warning',
          text: `CodeBuddy TUI 已在运行（${describeSessionUrl(openResult.sessionUrl) || `端口 ${openResult.port || '未知'}`}），已尝试切到该窗口`
        });
        return;
      }
      setNoticeMessage({
        type: 'success',
        text: openResult.mode === 'resume' ? '已打开终端 TUI 并续接所选会话' : '已打开新会话终端'
      });
    } catch (openError) {
      setNoticeMessage({ type: 'error', text: openError.message });
    } finally {
      setBusyAction('');
    }
  }


  return (
    <div className="codebuddy-workbench">
      {overviewError ? (
        <div className="alert-error codebuddy-notice-bar">
          <span className="codebuddy-notice-text">{overviewError}</span>
          <button
            type="button"
            className="codebuddy-notice-close"
            title="关闭提示"
            onClick={() => setOverviewError(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {environment && !environmentReady ? (
        <div className="alert-warning">
          {environment.environmentIssue || 'CodeBuddy 环境不可用'}
          <span className="codebuddy-env-hint">（配置文件：{environment.settingsPath}）</span>
        </div>
      ) : null}

      <div className="codebuddy-refresh-bar">
        <span className="codebuddy-refresh-label">刷新设置</span>
        <label className="codebuddy-refresh-item">
          实例状态
          <select
            className="form-input codebuddy-refresh-select"
            value={uiConfig.overviewPoll.enabled ? String(uiConfig.overviewPoll.intervalMs) : 'off'}
            onChange={(changeEvent) => {
              const selectedValue = changeEvent.target.value;
              updateUiConfig({
                ...uiConfig,
                overviewPoll:
                  selectedValue === 'off'
                    ? { ...uiConfig.overviewPoll, enabled: false }
                    : { ...uiConfig.overviewPoll, enabled: true, intervalMs: Number(selectedValue) }
              });
            }}
          >
            {OVERVIEW_INTERVAL_OPTION_LIST.map((intervalValue) => (
              <option key={intervalValue} value={intervalValue}>
                每 {intervalValue / 1000} 秒
              </option>
            ))}
            <option value="off">关闭</option>
          </select>
        </label>
        <span className="codebuddy-refresh-hint">
          {uiConfig.overviewPoll.enabled
            ? '页面切到后台时自动暂停；对话内容的同步频率在右侧面板设置'
            : '已关闭：点需求列表的「刷新」手动更新实例状态'}
        </span>
      </div>

      {noticeMessage ? (
        <div
          className={`codebuddy-notice-bar ${
            noticeMessage.type === 'error'
              ? 'alert-error'
              : noticeMessage.type === 'warning'
                ? 'alert-warning'
                : 'alert-success'
          }`}
        >
          <span className="codebuddy-notice-text">{noticeMessage.text}</span>
          <button
            type="button"
            className="codebuddy-notice-close"
            title="关闭提示"
            onClick={() => setNoticeMessage(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="codebuddy-layout">
        <aside className="codebuddy-task-column">
          <div className="list-toolbar">
            <span className="form-label">需求任务（{taskList.length}）</span>
            <button
              type="button"
              className="button-secondary task-action-button"
              disabled={overviewRefreshing}
              onClick={() => loadOverview()}
            >
              {overviewRefreshing ? '刷新中…' : '刷新'}
            </button>
          </div>

          <div className="codebuddy-task-list">
            {taskList.length === 0 ? (
              <div className="codebuddy-task-empty">暂无需求任务</div>
            ) : (
              taskList.map((taskEntry) => {
                const taskInstance = instanceList.find((instanceEntry) => instanceEntry.taskId === taskEntry.id);
                const stateDescriptor = describeInstanceState(taskInstance ? taskInstance.state : 'stopped');
                return (
                  <button
                    key={taskEntry.id}
                    type="button"
                    className={
                      taskEntry.id === selectedTaskId
                        ? 'codebuddy-task-item codebuddy-task-item-active'
                        : 'codebuddy-task-item'
                    }
                    onClick={() => handleSelectTask(taskEntry.id)}
                  >
                    <span className="codebuddy-task-title">{taskEntry.requirementName}</span>
                    <span className="codebuddy-task-meta">
                      <span className={`codebuddy-state-dot ${stateDescriptor.stateClass}`} />
                      <span className="codebuddy-task-state-text">{stateDescriptor.stateText}</span>
                      {taskInstance ? <span className="codebuddy-task-port">:{taskInstance.port}</span> : null}
                    </span>
                    <span className="codebuddy-task-branch">{taskEntry.branchName}</span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="codebuddy-detail-column">
          {!selectedTask ? (
            <div className="placeholder-panel">请选择左侧的需求任务</div>
          ) : (
            <div>
              <div className="codebuddy-instance-bar">
                <div className="codebuddy-instance-info">
                  <span className="codebuddy-instance-name">{selectedTask.requirementName}</span>
                  <span className="codebuddy-instance-line">
                    <span
                      className={`codebuddy-state-dot ${describeInstanceState(selectedInstance ? selectedInstance.state : 'stopped').stateClass}`}
                    />
                    <span>
                      {describeInstanceState(selectedInstance ? selectedInstance.state : 'stopped').stateText}
                      {selectedInstance ? ` · 端口 ${selectedInstance.port}` : ''}
                      {selectedInstance && selectedInstance.ownedByPlatform === false ? ' · 复用已有进程' : ''}
                    </span>
                  </span>
                </div>

                <div className="codebuddy-instance-actions">
                  <button
                    type="button"
                    className="button-primary task-action-button"
                    disabled={!environmentReady || busyAction !== '' || Boolean(selectedInstance && selectedInstance.state === 'running')}
                    onClick={() => handleStartInstanceFlow('window')}
                  >
                    {busyAction === 'start' ? '启动中…' : '启动实例'}
                  </button>
                  <button
                    type="button"
                    className="button-danger task-action-button"
                    disabled={!selectedInstance || busyAction !== '' || selectedInstance.state === 'stopped'}
                    onClick={handleStopInstance}
                  >
                    {busyAction === 'stop'
                      ? '处理中…'
                      : selectedInstance && selectedInstance.ownedByPlatform === false
                        ? '解除绑定'
                        : '停止'}
                  </button>
                  <button
                    type="button"
                    className="button-secondary task-action-button"
                    disabled={!selectedInstance || !selectedInstance.webUiUrl}
                    onClick={handleOpenOfficialWorkbench}
                  >
                    完整工作台
                  </button>
                </div>
              </div>

              {selectedInstance && selectedInstance.lastError ? (
                <div className="alert-error">{selectedInstance.lastError}</div>
              ) : null}

              {selectedInstance && selectedInstance.sessionChannel === 'acp' ? (
                <CodebuddyAcpPanel
                  instanceId={selectedInstance.id}
                  instanceState={selectedInstance.state}
                  sessionId={activeSessionId}
                  onNotice={setNoticeMessage}
                />
              ) : (
                <CodebuddyChatPanel
                  instanceId={selectedInstance ? selectedInstance.id : ''}
                  instanceState={selectedInstance ? selectedInstance.state : 'stopped'}
                  sessionId={activeSessionId}
                  syncConfig={uiConfig.sessionSync}
                  onSyncConfigChange={(nextSyncConfig) =>
                    updateUiConfig({ ...uiConfig, sessionSync: nextSyncConfig })
                  }
                  onNotice={setNoticeMessage}
                  onNewSession={handleNewSession}
                  onSwitchSession={handleOpenSwitchSession}
                />
              )}
            </div>
          )}
        </section>
      </div>

      {sessionPickerVisible ? (
        <CodebuddySessionPickerDialog
          taskName={selectedTask ? selectedTask.requirementName : ''}
          sessionList={sessionList}
          loading={sessionListLoading}
          loadingMessage={sessionListMessage}
          instanceRunning={sessionInstanceRunning}
          pickerMode={sessionPickerMode}
          launchTarget={launchTarget}
          port={launchPort}
          resumeMode={launchResumeMode}
          currentSessionId={activeSessionId}
          sessionChannel={launchSessionChannel}
          onLaunchTargetChange={setLaunchTarget}
          onPortChange={setLaunchPort}
          onResumeModeChange={setLaunchResumeMode}
          onSessionChannelChange={setLaunchSessionChannel}
          onSelectSession={handleSelectSession}
          onClose={() => setSessionPickerVisible(false)}
        />
      ) : null}

      {herdrConfirmVisible ? (
        <div className="herdr-confirm-overlay">
          <div className="herdr-confirm-dialog">
            <div className="herdr-confirm-title">herdr 服务未运行</div>
            <p className="herdr-confirm-text">
              在 herdr 里打开工作区需要先启动 herdr 服务，是否现在启动？（会新开一个 herdr 终端窗口）
            </p>
            <div className="herdr-confirm-path">
              {selectedTask && selectedTask.workspaceFilePath
                ? selectedTask.workspaceFilePath
                : selectedInstance
                  ? selectedInstance.instanceDirectoryPath
                  : ''}
            </div>
            <div className="herdr-confirm-actions">
              <button type="button" className="button-secondary" onClick={() => setHerdrConfirmVisible(false)}>
                取消
              </button>
              <button
                type="button"
                className="button-primary"
                disabled={busyAction === 'herdr'}
                onClick={async () => {
                  setHerdrConfirmVisible(false);
                  await executeHerdrOpen(pendingHerdrSessionId, true);
                }}
              >
                启动并打开
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 长耗时操作遮罩：启动/重建实例要 20~40 秒，这里挡住重复点击并给出进度感 */}
      {pendingActionText ? (
        <div className="codebuddy-loading-overlay">
          <div className="codebuddy-loading-box">
            <div className="codebuddy-loading-spinner" />
            <div className="codebuddy-loading-text">{pendingActionText}</div>
            <div className="codebuddy-loading-elapsed">已等待 {pendingElapsedSeconds} 秒</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
