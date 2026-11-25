import React, { useEffect, useState } from 'react';
import { TaskLogPanel } from './TaskLogPanel.jsx';
import { deriveProjectNameFromPath } from './RequirementTaskForm.jsx';
import {
  activateCodebuddyInstance,
  fetchCodebuddyOverview,
  fetchCodebuddySessionList,
  startCodebuddyInstance,
  stopCodebuddyInstance
} from '../api/codebuddy-client.js';

/** 路径宽松比较（斜杠/大小写不敏感），用于匹配 worktree 清单条目 */
function isSameLoosePath(firstPath, secondPath) {
  const normalizeText = (pathText) => String(pathText || '').replace(/\//g, '\\').toLowerCase();
  return normalizeText(firstPath) === normalizeText(secondPath);
}

/**
 * 渲染"分支位置"区块：展示关联 worktree 当前实际所在分支，
 * 标注与需求分支是否一致；未关联时回退显示主仓库当前分支；另提示需求分支的签出位置。
 */
function renderBranchLocationInfo(locateEntry, projectEntry, requirementBranchName) {
  if (!locateEntry) {
    return <span className="section-empty">查询中...</span>;
  }
  if (locateEntry.locateError) {
    return <span className="history-reason">查询失败：{locateEntry.locateError}</span>;
  }

  const worktreeList = locateEntry.worktreeList || [];
  const currentWorktreeEntry = projectEntry.worktreePath
    ? worktreeList.find((worktreeEntry) => isSameLoosePath(worktreeEntry.path, projectEntry.worktreePath))
    : null;
  const mainWorktreeEntry = worktreeList.find((worktreeEntry) => worktreeEntry.isMain);
  const requirementBranchEntry = worktreeList.find(
    (worktreeEntry) => worktreeEntry.branch === requirementBranchName
  );

  if (projectEntry.worktreePath && !currentWorktreeEntry) {
    return <span className="history-reason">关联已失效（目录不在 worktree 列表中）</span>;
  }

  return (
    <div>
      <div>
        当前分支：
        {currentWorktreeEntry ? (
          <span>
            {currentWorktreeEntry.branch || '(detached)'}
            {currentWorktreeEntry.branch === requirementBranchName ? (
              <span className="badge-status badge-clean">与需求一致</span>
            ) : (
              <span className="badge-status badge-dirty">非需求分支</span>
            )}
            {currentWorktreeEntry.isDirty ? <span className="badge-status badge-dirty">有未提交修改</span> : null}
          </span>
        ) : mainWorktreeEntry ? (
          <span>
            {mainWorktreeEntry.branch || '(detached)'}
            <span className="history-reason">（主仓库，项目未关联 worktree）</span>
          </span>
        ) : (
          <span className="section-empty">未知</span>
        )}
      </div>
      {requirementBranchEntry &&
      (!currentWorktreeEntry || !isSameLoosePath(requirementBranchEntry.path, currentWorktreeEntry.path)) ? (
        <div className="form-hint">
          需求分支 {requirementBranchName} 签出于：{requirementBranchEntry.path}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 需求明细弹窗：以弹窗形式集中展示工作区文件、涉及项目与关联 worktree、
 * 依赖状态与分支位置、独立安装日志；数据与动作由父组件（需求任务面板）注入。
 */
export function RequirementTaskDetailDialog({
  requirementTask,
  locateTaskResponse,
  dependencyTaskResponse,
  conflictProjectKeySet,
  installJobEntryMap,
  installRunningKeyMap,
  sharedRestoreKeyMap,
  pathActionPending,
  workspaceRegenerationPending,
  onClose,
  onOpenDirectory,
  onRevealPath,
  onOpenInHerdr,
  onCloseInHerdr,
  onOpenInHerdrApp,
  onCloseHerdrAppSpace,
  onSetLifecycle,
  onRegenerateWorkspace,
  onRestoreShared,
  onRequestIndependentInstall,
  onInstallFinished
}) {
  const locateProjectList = locateTaskResponse && locateTaskResponse.projectList ? locateTaskResponse.projectList : [];
  const dependencyProjectList =
    dependencyTaskResponse && dependencyTaskResponse.projectList ? dependencyTaskResponse.projectList : [];
  // herdr 打开结果就地展示：弹窗遮罩会盖住列表顶部提示，所以自己保留一份
  const [herdrNotice, setHerdrNotice] = useState(null);
  // herdr 服务未运行时的启动确认层
  const [confirmHerdrStart, setConfirmHerdrStart] = useState(false);
  // 生命周期切换的结果提示与请求中状态
  const [lifecycleNotice, setLifecycleNotice] = useState(null);
  const [lifecyclePending, setLifecyclePending] = useState(false);

  // ===== CodeBuddy 实例（一个需求一个实例，入口在这个弹窗里） =====
  const [codebuddyInstance, setCodebuddyInstance] = useState(null);
  const [codebuddyPending, setCodebuddyPending] = useState('');
  const [codebuddyNotice, setCodebuddyNotice] = useState(null);
  // 默认在 herdr app 里打开：桌面客户端里能直接看到需求空间，不需要额外找窗口
  const [codebuddyLaunchTarget, setCodebuddyLaunchTarget] = useState('herdr-app');
  const [codebuddySessionList, setCodebuddySessionList] = useState([]);
  const [codebuddySessionListOpen, setCodebuddySessionListOpen] = useState(false);

  /** 拉一次实例状态（与 CodeBuddy 页签共用同一份实例表） */
  async function refreshCodebuddyInstance() {
    try {
      const overviewData = await fetchCodebuddyOverview();
      const matchedInstance = (overviewData.instanceList || []).find(
        (instanceEntry) => instanceEntry.taskId === requirementTask.id
      );
      // 只有真正 running 才算「已启用」；stopped/error 的残留记录不应显示成运行中
      setCodebuddyInstance(matchedInstance && matchedInstance.state === 'running' ? matchedInstance : null);
    } catch {
      // 拉不到就保持原状，不打断弹窗
    }
  }

  useEffect(() => {
    refreshCodebuddyInstance();
    // 弹窗开着的时候也定时刷新，避免实例在别处被起停后这里还显示旧状态
    const instanceStateTimer = setInterval(() => {
      refreshCodebuddyInstance();
    }, 8000);
    return () => clearInterval(instanceStateTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requirementTask.id]);

  /** 启用实例：终端或 herdr，默认续接平台记录的上次会话 */
  async function handleEnableCodebuddy() {
    setCodebuddyPending('start');
    setCodebuddyNotice(null);
    try {
      const startResult = await startCodebuddyInstance({
        taskId: requirementTask.id,
        launchTarget: codebuddyLaunchTarget,
        resumeMode: 'last'
      });
      await refreshCodebuddyInstance();
      setCodebuddyNotice({
        type: 'success',
        text: `实例已启动（端口 ${startResult.instance.port}）`
      });
    } catch (startError) {
      setCodebuddyNotice({ type: 'error', text: startError.message });
    } finally {
      setCodebuddyPending('');
    }
  }

  /** 激活已打开的窗口：不启动新进程 */
  async function handleActivateCodebuddy() {
    if (!codebuddyInstance) {
      return;
    }
    setCodebuddyPending('activate');
    setCodebuddyNotice(null);
    try {
      const activateResult = await activateCodebuddyInstance(codebuddyInstance.id);
      if (activateResult.strategy === 'window-title' || activateResult.strategy === 'session') {
        setCodebuddyNotice({ type: 'success', text: '已定位到该需求的终端窗口' });
      } else if (activateResult.strategy === 'window') {
        setCodebuddyNotice({
          type: 'warning',
          text: '已把终端窗口切到前台，但 TUI 可能在别的标签页，需要手动切一下标签'
        });
      } else {
        setCodebuddyNotice({
          type: 'error',
          text: '没找到终端窗口，可能已被关闭。可先点「停止」再重新启用。'
        });
      }
    } catch (activateError) {
      setCodebuddyNotice({ type: 'error', text: activateError.message });
    } finally {
      setCodebuddyPending('');
    }
  }

  async function handleStopCodebuddy() {
    if (!codebuddyInstance) {
      return;
    }
    setCodebuddyPending('stop');
    setCodebuddyNotice(null);
    try {
      await stopCodebuddyInstance(codebuddyInstance.id);
      // 先乐观清空（后端 kill 是异步的，紧接着拉 overview 可能还读到 running）
      setCodebuddyInstance(null);
      setCodebuddySessionListOpen(false);
      setCodebuddyNotice({ type: 'success', text: '实例已停止' });
      // 稍后再校准一次真实状态
      setTimeout(() => {
        refreshCodebuddyInstance();
      }, 1500);
    } catch (stopError) {
      setCodebuddyNotice({ type: 'error', text: stopError.message });
    } finally {
      setCodebuddyPending('');
    }
  }

  /** 展开/收起会话列表 */
  async function handleToggleCodebuddySessions() {
    if (codebuddySessionListOpen) {
      setCodebuddySessionListOpen(false);
      return;
    }
    setCodebuddyPending('sessions');
    setCodebuddyNotice(null);
    try {
      const sessionData = await fetchCodebuddySessionList(requirementTask.id);
      setCodebuddySessionList(sessionData.sessionList || []);
      setCodebuddySessionListOpen(true);
    } catch (sessionError) {
      setCodebuddyNotice({ type: 'error', text: sessionError.message });
    } finally {
      setCodebuddyPending('');
    }
  }

  /** 切到某个历史会话：同端口重建 TUI，让它 --resume 该会话 */
  async function handleSwitchCodebuddySession(sessionId) {
    if (!codebuddyInstance) {
      return;
    }
    setCodebuddyPending(`switch:${sessionId}`);
    setCodebuddyNotice(null);
    try {
      await startCodebuddyInstance({
        taskId: requirementTask.id,
        port: String(codebuddyInstance.port),
        launchTarget: ['herdr', 'herdr-app'].includes(codebuddyInstance.launchTarget)
          ? codebuddyInstance.launchTarget
          : 'window',
        sessionId,
        forceRestart: true
      });
      await refreshCodebuddyInstance();
      setCodebuddySessionListOpen(false);
      setCodebuddyNotice({ type: 'success', text: '已切换到所选会话' });
    } catch (switchError) {
      setCodebuddyNotice({ type: 'error', text: switchError.message });
    } finally {
      setCodebuddyPending('');
    }
  }

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-dialog requirement-detail-dialog" onClick={(clickEvent) => clickEvent.stopPropagation()}>
        <div className="picker-toolbar">
          <span className="picker-current-path">
            需求明细 — {requirementTask.requirementName || requirementTask.branchName}
          </span>
          <button type="button" className="button-secondary" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="requirement-detail-body">
          <span className="form-label">生命周期</span>
          <div className="detail-lifecycle-row">
            <select
              className="form-input detail-lifecycle-select"
              value={requirementTask.lifecycle || '待开发'}
              disabled={Boolean(requirementTask.deletedAt) || lifecyclePending}
              onChange={async (changeEvent) => {
                const nextLifecycle = changeEvent.target.value;
                setLifecycleNotice(null);
                setLifecyclePending(true);
                try {
                  const updateResult = await onSetLifecycle(requirementTask, nextLifecycle);
                  if (updateResult) {
                    setLifecycleNotice({ type: updateResult.ok ? 'success' : 'error', text: updateResult.text });
                  }
                } finally {
                  setLifecyclePending(false);
                }
              }}
            >
              <option value="待开发">待开发</option>
              <option value="开发中">开发中</option>
              <option value="测试中">测试中</option>
              <option value="已发布">已发布</option>
            </select>
            <span className="form-hint">
              决定任务落在哪个 tab：待开发/开发中 → 待提测，测试中 → 已提测，已发布 → 已发布
            </span>
          </div>
          {requirementTask.deletedAt ? (
            <div className="alert-warning">该任务已删除，状态不可修改；恢复后可继续推进。</div>
          ) : null}
          {lifecycleNotice ? (
            <div className={lifecycleNotice.type === 'success' ? 'alert-success' : 'alert-error'}>
              {lifecycleNotice.text}
            </div>
          ) : null}
        </div>

        <div className="requirement-detail-body">
          <span className="form-label">工作区文件</span>
          {requirementTask.workspaceFilePath ? (
            <div>
              <div className="settings-current-path">{requirementTask.workspaceFilePath}</div>
              <div className="cell-actions">
                <button
                  type="button"
                  className="button-secondary"
                  disabled={pathActionPending.isPending(`open:${requirementTask.workspaceFilePath}`)}
                  onClick={() => onOpenDirectory(requirementTask.workspaceFilePath)}
                >
                  {pathActionPending.isPending(`open:${requirementTask.workspaceFilePath}`) ? (
                    <span>
                      <span className="button-spinner" />
                      打开中...
                    </span>
                  ) : (
                    '打开工作区'
                  )}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={pathActionPending.isPending(`reveal:${requirementTask.workspaceFilePath}`)}
                  onClick={() => onRevealPath(requirementTask.workspaceFilePath)}
                >
                  {pathActionPending.isPending(`reveal:${requirementTask.workspaceFilePath}`) ? (
                    <span>
                      <span className="button-spinner" />
                      定位中...
                    </span>
                  ) : (
                    '显示'
                  )}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={workspaceRegenerationPending.isPending(`ws-regen:${requirementTask.id}`)}
                  onClick={() => onRegenerateWorkspace(requirementTask.id)}
                >
                  {workspaceRegenerationPending.isPending(`ws-regen:${requirementTask.id}`) ? (
                    <span>
                      <span className="button-spinner" />
                      生成中...
                    </span>
                  ) : (
                    '重新生成'
                  )}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  title="在 herdr 里打开该需求的工作区（目录为工作区文件所在目录）"
                  disabled={pathActionPending.isPending(`herdr:${requirementTask.workspaceFilePath}`)}
                  onClick={async () => {
                    setHerdrNotice(null);
                    const herdrResult = await onOpenInHerdr(
                      requirementTask.workspaceFilePath,
                      requirementTask.requirementName
                    );
                    // 服务没跑：先弹确认，用户同意后再拉起 herdr
                    if (herdrResult && herdrResult.needsServerStart) {
                      setConfirmHerdrStart(true);
                      return;
                    }
                    if (herdrResult) {
                      setHerdrNotice({
                        type: herdrResult.ok ? 'success' : 'error',
                        text: herdrResult.text
                      });
                    }
                  }}
                >
                  {pathActionPending.isPending(`herdr:${requirementTask.workspaceFilePath}`) ? (
                    <span>
                      <span className="button-spinner" />
                      打开中...
                    </span>
                  ) : (
                    '在 herdr 打开'
                  )}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  title="在 herdr app（PC 客户端）里打开该需求的终端，工作目录为工作区文件所在目录"
                  disabled={pathActionPending.isPending(`herdr-app:${requirementTask.workspaceFilePath}`)}
                  onClick={async () => {
                    setHerdrNotice(null);
                    const appResult = await onOpenInHerdrApp(
                      requirementTask.workspaceFilePath,
                      requirementTask.requirementName,
                      requirementTask.id
                    );
                    if (appResult) {
                      setHerdrNotice({
                        type: appResult.ok ? 'success' : 'error',
                        text: appResult.text
                      });
                    }
                  }}
                >
                  {pathActionPending.isPending(`herdr-app:${requirementTask.workspaceFilePath}`) ? (
                    <span>
                      <span className="button-spinner" />
                      打开中...
                    </span>
                  ) : (
                    '在 herdr app 打开'
                  )}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  title="关闭该需求在 herdr app 里的 space（space 内的终端会一并结束）"
                  disabled={pathActionPending.isPending(`herdr-app-close:${requirementTask.workspaceFilePath}`)}
                  onClick={async () => {
                    setHerdrNotice(null);
                    const appCloseResult = await onCloseHerdrAppSpace(requirementTask.workspaceFilePath);
                    if (appCloseResult) {
                      setHerdrNotice({
                        type: appCloseResult.ok ? 'success' : 'error',
                        text: appCloseResult.text
                      });
                    }
                  }}
                >
                  {pathActionPending.isPending(`herdr-app-close:${requirementTask.workspaceFilePath}`) ? (
                    <span>
                      <span className="button-spinner" />
                      关闭中...
                    </span>
                  ) : (
                    '关闭 herdr app 空间'
                  )}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  title="关闭该需求在 herdr 里的工作区（终端内运行的进程会一并结束）"
                  disabled={pathActionPending.isPending(`herdr-close:${requirementTask.workspaceFilePath}`)}
                  onClick={async () => {
                    setHerdrNotice(null);
                    const closeResult = await onCloseInHerdr(
                      requirementTask.workspaceFilePath,
                      requirementTask.requirementName
                    );
                    if (closeResult) {
                      setHerdrNotice({
                        type: closeResult.ok ? 'success' : 'error',
                        text: closeResult.text
                      });
                    }
                  }}
                >
                  {pathActionPending.isPending(`herdr-close:${requirementTask.workspaceFilePath}`) ? (
                    <span>
                      <span className="button-spinner" />
                      关闭中...
                    </span>
                  ) : (
                    '关闭 herdr 终端'
                  )}
                </button>
              </div>
              {herdrNotice ? (
                <div className={herdrNotice.type === 'success' ? 'alert-success' : 'alert-error'}>
                  {herdrNotice.text}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="form-hint">
              未生成。编辑任务勾选“保存后生成工作区文件”，或点击“重新生成”。
              <button
                type="button"
                className="button-secondary workspace-generate-button"
                disabled={workspaceRegenerationPending.isPending(`ws-regen:${requirementTask.id}`)}
                onClick={() => onRegenerateWorkspace(requirementTask.id)}
              >
                {workspaceRegenerationPending.isPending(`ws-regen:${requirementTask.id}`) ? (
                  <span>
                    <span className="button-spinner" />
                    生成中...
                  </span>
                ) : (
                  '重新生成'
                )}
              </button>
            </div>
          )}

          <span className="form-label">CodeBuddy 实例</span>
          <div className="project-detail-card">
            {codebuddyInstance ? (
              <>
                <div className="codebuddy-instance-status">
                  <span className="badge-status badge-clean">运行中</span>
                  <span>端口 {codebuddyInstance.port}</span>
                  {codebuddyInstance.activeSessionId ? (
                    <span className="form-hint">
                      会话 {String(codebuddyInstance.activeSessionId).slice(0, 8)}
                    </span>
                  ) : null}
                </div>
                <div className="codebuddy-instance-action-row">
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={Boolean(codebuddyPending)}
                    onClick={handleActivateCodebuddy}
                  >
                    {codebuddyPending === 'activate' ? (
                      <span>
                        <span className="button-spinner" />
                        激活中...
                      </span>
                    ) : (
                      '激活终端'
                    )}
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={Boolean(codebuddyPending)}
                    onClick={handleToggleCodebuddySessions}
                  >
                    {codebuddySessionListOpen ? '收起会话' : '切换会话'}
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!codebuddyInstance.webUiUrl}
                    onClick={() => {
                      const webUrl = codebuddyInstance.webUiUrl;
                      if (webUrl) {
                        window.open(webUrl, '_blank', 'noopener');
                      }
                    }}
                  >
                    完整工作台
                  </button>
                  <button
                    type="button"
                    className="button-danger"
                    disabled={Boolean(codebuddyPending)}
                    onClick={handleStopCodebuddy}
                  >
                    {codebuddyPending === 'stop' ? '停止中...' : '停止'}
                  </button>
                </div>
                {codebuddySessionListOpen ? (
                  <div className="picker-list codebuddy-session-list">
                    {codebuddySessionList.length === 0 ? (
                      <div className="picker-item-empty">该目录下还没有历史会话</div>
                    ) : (
                      codebuddySessionList.map((sessionEntry) => {
                        const isCurrentSession =
                          codebuddyInstance.activeSessionId === sessionEntry.id;
                        return (
                          <button
                            key={sessionEntry.id}
                            type="button"
                            className={
                              isCurrentSession
                                ? 'codebuddy-session-item codebuddy-session-item-current'
                                : 'codebuddy-session-item'
                            }
                            disabled={Boolean(codebuddyPending) || isCurrentSession}
                            onClick={() => handleSwitchCodebuddySession(sessionEntry.id)}
                          >
                            <span className="codebuddy-session-item-title">
                              {sessionEntry.name}
                              {isCurrentSession ? (
                                <span className="codebuddy-current-badge">当前</span>
                              ) : null}
                            </span>
                            <span className="codebuddy-session-item-meta">
                              {sessionEntry.isRunning ? '运行中' : `${sessionEntry.messageCount} 条消息`}
                              <span className="codebuddy-session-item-id">
                                {sessionEntry.id.slice(0, 8)}
                              </span>
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="form-hint">
                  未启用。启用后会在所选位置打开 CodeBuddy 终端，并续接该需求上次使用的会话。
                </div>
                <div className="codebuddy-instance-launch-row">
                  <span className="codebuddy-instance-launch-label">打开方式</span>
                  <label className="codebuddy-instance-radio">
                    <input
                      type="radio"
                      checked={codebuddyLaunchTarget === 'window'}
                      onChange={() => setCodebuddyLaunchTarget('window')}
                    />
                    <span>终端窗口</span>
                  </label>
                  <label className="codebuddy-instance-radio">
                    <input
                      type="radio"
                      checked={codebuddyLaunchTarget === 'herdr'}
                      onChange={() => setCodebuddyLaunchTarget('herdr')}
                    />
                    <span>herdr 工作区</span>
                  </label>
                  <label className="codebuddy-instance-radio">
                    <input
                      type="radio"
                      checked={codebuddyLaunchTarget === 'herdr-app'}
                      onChange={() => setCodebuddyLaunchTarget('herdr-app')}
                    />
                    <span>herdr app</span>
                  </label>
                </div>
                <div className="codebuddy-instance-launch-actions">
                  <button
                    type="button"
                    className="button-primary"
                    disabled={Boolean(codebuddyPending)}
                    onClick={handleEnableCodebuddy}
                  >
                    {codebuddyPending === 'start' ? (
                      <span>
                        <span className="button-spinner" />
                        启用中...
                      </span>
                    ) : (
                      '启用实例'
                    )}
                  </button>
                </div>
              </>
            )}
            {codebuddyNotice ? (
              <div
                className={`codebuddy-instance-notice ${
                  codebuddyNotice.type === 'success'
                    ? 'alert-success'
                    : codebuddyNotice.type === 'warning'
                      ? 'alert-warning'
                      : 'alert-error'
                }`}
              >
                {codebuddyNotice.text}
              </div>
            ) : null}
          </div>

          <span className="form-label">涉及项目与关联 worktree</span>
          {(() => {
            const highRiskList = dependencyProjectList.filter(
              (projectDependency) => projectDependency.riskLevel === 'high'
            );
            if (highRiskList.length === 0) {
              return null;
            }
            return (
              <div className="alert-error">
                依赖风险提醒（重点）：{highRiskList
                  .map((projectDependency) => `${projectDependency.projectName} —— ${projectDependency.riskMessage}`)
                  .join('；')}
                。建议对相关项目执行"独立安装"。
              </div>
            );
          })()}
          {requirementTask.projectList.map((projectEntry, projectIndex) => {
            const locateEntry = locateProjectList[projectIndex] || null;
            const dependencyEntry = dependencyProjectList[projectIndex] || null;
            const installActionKey = `${requirementTask.id}:${projectIndex}`;
            const installJobEntry = installJobEntryMap ? installJobEntryMap[installActionKey] : null;
            const installRunning = Boolean(installRunningKeyMap && installRunningKeyMap[installActionKey]);
            const sharedRestoring = Boolean(sharedRestoreKeyMap && sharedRestoreKeyMap[installActionKey]);
            const projectConflictKey = `${String(projectEntry.repoPath || '')
              .replace(/\//g, '\\')
              .toLowerCase()}|${requirementTask.branchName}`;
            const hasBranchConflict = conflictProjectKeySet.has(projectConflictKey);
            return (
              <div key={`${requirementTask.id}-project-${projectIndex}`} className="project-detail-card">
                <div className="project-detail-header">
                  <span className="form-label">{projectEntry.projectName || '（未命名项目）'}</span>
                  {hasBranchConflict ? <span className="badge-status badge-dirty">分支冲突</span> : null}
                  {dependencyEntry && dependencyEntry.riskLevel === 'high' ? (
                    <span className="badge-status badge-dirty">依赖高风险</span>
                  ) : null}
                </div>

                <div className="project-detail-line">
                  <span className="detail-line-label">主仓库</span>
                  <span className="detail-line-value">
                    {projectEntry.repoPath || <span className="section-empty">未设置</span>}
                  </span>
                  {projectEntry.repoPath ? (
                    <>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={pathActionPending.isPending(`open:${projectEntry.repoPath}`)}
                        onClick={() => onOpenDirectory(projectEntry.repoPath)}
                      >
                        {pathActionPending.isPending(`open:${projectEntry.repoPath}`) ? (
                          <span>
                            <span className="button-spinner" />
                            打开中...
                          </span>
                        ) : (
                          '打开'
                        )}
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={pathActionPending.isPending(`reveal:${projectEntry.repoPath}`)}
                        onClick={() => onRevealPath(projectEntry.repoPath)}
                      >
                        {pathActionPending.isPending(`reveal:${projectEntry.repoPath}`) ? (
                          <span>
                            <span className="button-spinner" />
                            定位中...
                          </span>
                        ) : (
                          '显示'
                        )}
                      </button>
                    </>
                  ) : null}
                </div>

                <div className="project-detail-line">
                  <span className="detail-line-label">worktree</span>
                  <span className="detail-line-value">
                    {projectEntry.worktreePath || <span className="section-empty">未关联</span>}
                  </span>
                  {projectEntry.worktreePath ? (
                    <>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={pathActionPending.isPending(`open:${projectEntry.worktreePath}`)}
                        onClick={() => onOpenDirectory(projectEntry.worktreePath)}
                      >
                        {pathActionPending.isPending(`open:${projectEntry.worktreePath}`) ? (
                          <span>
                            <span className="button-spinner" />
                            打开中...
                          </span>
                        ) : (
                          '打开'
                        )}
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={pathActionPending.isPending(`reveal:${projectEntry.worktreePath}`)}
                        onClick={() => onRevealPath(projectEntry.worktreePath)}
                      >
                        {pathActionPending.isPending(`reveal:${projectEntry.worktreePath}`) ? (
                          <span>
                            <span className="button-spinner" />
                            定位中...
                          </span>
                        ) : (
                          '显示'
                        )}
                      </button>
                    </>
                  ) : (
                    <span className="form-hint">先创建并挂载</span>
                  )}
                </div>

                <div className="project-detail-line">
                  <span className="detail-line-label">依赖</span>
                  <span className="detail-line-value">
                    {dependencyEntry ? (
                      <>
                        <div className="dependency-status-row">
                          {dependencyEntry.riskLevel === 'high' ? (
                            <span className="badge-status badge-dirty">高风险</span>
                          ) : dependencyEntry.dependencyMode === 'shared' ? (
                            <span className="badge-status badge-clean">共享主目录</span>
                          ) : dependencyEntry.dependencyMode === 'independent' ? (
                            <span className="badge-status badge-main">独立安装</span>
                          ) : dependencyEntry.dependencyMode === 'missing' ? (
                            <span className="badge-status badge-occupied">未安装</span>
                          ) : null}
                          {projectEntry.worktreePath && dependencyEntry.dependencyMode === 'independent' ? (
                            <button
                              type="button"
                              className="button-secondary dependency-install-button"
                              disabled={sharedRestoring || installRunning}
                              onClick={() => onRestoreShared(projectIndex, projectEntry)}
                            >
                              {sharedRestoring ? (
                                <span>
                                  <span className="button-spinner" />
                                  恢复中...
                                </span>
                              ) : (
                                '恢复共享'
                              )}
                            </button>
                          ) : projectEntry.worktreePath ? (
                            <button
                              type="button"
                              className="button-secondary dependency-install-button"
                              disabled={installRunning || sharedRestoring}
                              onClick={() => onRequestIndependentInstall(projectIndex, projectEntry)}
                            >
                              {installRunning ? (
                                <span>
                                  <span className="button-spinner" />
                                  安装中...
                                </span>
                              ) : (
                                '独立安装'
                              )}
                            </button>
                          ) : null}
                        </div>
                        <div className="form-hint">{dependencyEntry.riskMessage}</div>
                      </>
                    ) : (
                      <span className="section-empty">查询中...</span>
                    )}
                  </span>
                </div>

                <div className="project-detail-line">
                  <span className="detail-line-label">分支位置</span>
                  <span className="detail-line-value">
                    {renderBranchLocationInfo(locateEntry, projectEntry, requirementTask.branchName)}
                    {hasBranchConflict ? (
                      <div className="conflict-hint">
                        注意：分支 {requirementTask.branchName} 同时被其他需求在相同项目上关联，存在冲突，请核对
                      </div>
                    ) : null}
                  </span>
                </div>

                {installJobEntry ? (
                  <TaskLogPanel
                    jobId={installJobEntry.jobId}
                    title={
                      installJobEntry.installMode === 'custom'
                        ? `自定义脚本安装：${projectEntry.projectName}`
                        : `独立安装：${projectEntry.projectName}`
                    }
                    onFinished={(finishStatus) => onInstallFinished(projectIndex, projectEntry, finishStatus)}
                  />
                ) : null}
              </div>
            );
          })}
          <span className="form-label">涉及项目名称</span>
          {requirementTask.projectList.map((projectEntry, projectIndex) => {
            const derivedProjectName =
              deriveProjectNameFromPath(projectEntry.repoPath || projectEntry.worktreePath) ||
              projectEntry.projectName ||
              '（未设置）';
            const locateEntry = locateProjectList[projectIndex];
            const projectGitWebUrl = locateEntry ? locateEntry.gitWebUrl : null;
            return (
              <div key={`${requirementTask.id}-name-${projectIndex}`} className="project-name-line">
                <span>{derivedProjectName}</span>
                {projectGitWebUrl ? (
                  <a className="project-git-link" href={projectGitWebUrl} target="_blank" rel="noreferrer">
                    {projectGitWebUrl}
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>

        {confirmHerdrStart ? (
          <div
            className="herdr-confirm-overlay"
            onClick={(clickEvent) => {
              clickEvent.stopPropagation();
              setConfirmHerdrStart(false);
            }}
          >
            <div className="herdr-confirm-dialog" onClick={(clickEvent) => clickEvent.stopPropagation()}>
              <div className="herdr-confirm-title">启动 herdr 服务</div>
              <p className="herdr-confirm-text">
                herdr 服务当前没有运行。点「启动并打开」会在新终端窗口启动 herdr，并打开该需求的工作区目录：
              </p>
              <div className="herdr-confirm-path">{requirementTask.workspaceFilePath}</div>
              <div className="herdr-confirm-actions">
                <button type="button" className="button-secondary" onClick={() => setConfirmHerdrStart(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="button-primary"
                  disabled={pathActionPending.isPending(`herdr:${requirementTask.workspaceFilePath}`)}
                  onClick={async () => {
                    setConfirmHerdrStart(false);
                    const startResult = await onOpenInHerdr(
                      requirementTask.workspaceFilePath,
                      requirementTask.requirementName,
                      true
                    );
                    if (startResult) {
                      setHerdrNotice({
                        type: startResult.ok ? 'success' : 'error',
                        text: startResult.text || 'herdr 正在启动，请稍候查看终端窗口'
                      });
                    }
                  }}
                >
                  启动并打开
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
