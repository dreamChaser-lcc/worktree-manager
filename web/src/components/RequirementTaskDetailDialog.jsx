import React from 'react';
import { TaskLogPanel } from './TaskLogPanel.jsx';
import { deriveProjectNameFromPath } from './RequirementTaskForm.jsx';

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
  onRegenerateWorkspace,
  onRestoreShared,
  onRequestIndependentInstall,
  onInstallFinished
}) {
  const locateProjectList = locateTaskResponse && locateTaskResponse.projectList ? locateTaskResponse.projectList : [];
  const dependencyProjectList =
    dependencyTaskResponse && dependencyTaskResponse.projectList ? dependencyTaskResponse.projectList : [];

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
              </div>
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
      </div>
    </div>
  );
}
