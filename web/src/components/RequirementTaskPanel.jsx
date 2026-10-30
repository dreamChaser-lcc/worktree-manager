import React, { useEffect, useMemo, useState } from 'react';
import { RequirementTaskForm, deriveProjectNameFromPath } from './RequirementTaskForm.jsx';
import { TaskLogPanel } from './TaskLogPanel.jsx';
import {
  fetchRequirementTaskList,
  deleteRequirementTask,
  restoreRequirementTask,
  permanentDeleteRequirementTask,
  generateRequirementWorkspace,
  fetchRequirementTaskLocate,
  fetchRequirementDependencyCheck,
  startRequirementIndependentInstall,
  revealInExplorer,
  openDirectoryInEditor
} from '../api/client.js';

function formatTimeText(isoText) {
  return isoText ? isoText.replace('T', ' ').slice(0, 19) : '—';
}

/** 路径宽松比较（斜杠/大小写不敏感），用于匹配 worktree 清单条目 */
function isSameLoosePath(firstPath, secondPath) {
  const normalizeText = (pathText) => String(pathText || '').replace(/\//g, '\\').toLowerCase();
  return normalizeText(firstPath) === normalizeText(secondPath);
}

/**
 * 跨需求分支冲突检测：同一主仓库在多个需求中被关联、且需求分支相同时视为冲突
 * （同一分支只能签出在一个 worktree，重复关联会互相抢占）。返回冲突键集合 `${repoPath}|${branchName}`。
 */
function buildConflictKeySet(taskList) {
  const keyTaskIdMap = {};
  taskList.forEach((taskEntry) => {
    (taskEntry.projectList || []).forEach((projectEntry) => {
      if (!projectEntry.repoPath) {
        return;
      }
      const conflictKey = `${String(projectEntry.repoPath).replace(/\//g, '\\').toLowerCase()}|${taskEntry.branchName}`;
      if (!keyTaskIdMap[conflictKey]) {
        keyTaskIdMap[conflictKey] = new Set();
      }
      keyTaskIdMap[conflictKey].add(taskEntry.id);
    });
  });
  const conflictKeySet = new Set();
  Object.entries(keyTaskIdMap).forEach(([conflictKey, taskIdSet]) => {
    if (taskIdSet.size > 1) {
      conflictKeySet.add(conflictKey);
    }
  });
  return conflictKeySet;
}

/**
 * 渲染"分支位置"单元格：展示关联 worktree 当前实际所在分支，
 * 标注与需求分支是否一致；未关联时回退显示主仓库当前分支；另提示需求分支的签出位置。
 */
function renderBranchLocationCell(locateEntry, projectEntry, requirementBranchName) {
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

/** 需求任务面板：以需求为维度维护分支与多项目 worktree 列表，支持查看/编辑/删除/打开/工作区文件 */
export function RequirementTaskPanel({ initialBrowsePath, workspaceDirectory, workspaceLayoutEnabled }) {
  const [taskList, setTaskList] = useState([]);
  const [listError, setListError] = useState(null);
  const [formState, setFormState] = useState(null); // null | { mode: 'new' } | { mode: 'edit', record }
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [confirmDeleteTask, setConfirmDeleteTask] = useState(null);
  const [confirmPermanentTask, setConfirmPermanentTask] = useState(null);
  const [actionMessage, setActionMessage] = useState(null);
  // 展开明细时按需获取的分支定位数据（taskId → locate 响应）
  const [locateDataMap, setLocateDataMap] = useState({});
  // 展开明细时按需获取的依赖检查数据（taskId → dependency-check 响应）
  const [dependencyDataMap, setDependencyDataMap] = useState({});
  // 各项目已启动的独立安装任务（`${taskId}:${projectIndex}` → jobId）
  const [installJobMap, setInstallJobMap] = useState({});
  // 跨需求分支冲突：同一项目仓库在不同需求中关联了相同分支
  const conflictProjectKeySet = useMemo(() => buildConflictKeySet(taskList), [taskList]);

  async function refreshTaskList() {
    try {
      const listData = await fetchRequirementTaskList();
      setTaskList(listData.tasks || []);
      setListError(null);
    } catch (loadError) {
      setListError(loadError.message);
    }
  }

  useEffect(() => {
    refreshTaskList();
  }, []);

  function handleSaved(responseData) {
    setFormState(null);
    let messageText = '需求任务已保存。';
    const workspaceFilePath = responseData && responseData.workspace && responseData.workspace.workspaceFilePath;
    if (workspaceFilePath) {
      messageText += ` 工作区文件：${workspaceFilePath}`;
      const excludedProjectList = (responseData.workspace && responseData.workspace.excludedProjectList) || [];
      if (excludedProjectList.length > 0) {
        messageText += `（未纳入：${excludedProjectList
          .map((excludedProject) => `${excludedProject.projectName}(${excludedProject.reason})`)
          .join('、')}）`;
      }
    } else if (responseData && responseData.workspace === null) {
      messageText += ' 未生成工作区文件。';
    }
    setActionMessage({ type: 'success', text: messageText });
    refreshTaskList();
  }

  async function handleRegenerateWorkspace(taskId) {
    try {
      const regenerateResult = await generateRequirementWorkspace(taskId);
      const workspaceResult = regenerateResult.workspace || {};
      let messageText = `工作区文件已生成：${workspaceResult.workspaceFilePath || ''}`;
      const excludedProjectList = workspaceResult.excludedProjectList || [];
      if (excludedProjectList.length > 0) {
        messageText += `（未纳入：${excludedProjectList
          .map((excludedProject) => `${excludedProject.projectName}(${excludedProject.reason})`)
          .join('、')}）`;
      }
      setActionMessage({ type: 'success', text: messageText });
      refreshTaskList();
    } catch (regenerateError) {
      setActionMessage({ type: 'error', text: regenerateError.message });
    }
  }

  /** 展开/收起明细；展开时实时获取分支定位与依赖检查数据 */
  async function handleToggleExpand(taskEntry) {
    const nextExpandedTaskId = expandedTaskId === taskEntry.id ? null : taskEntry.id;
    setExpandedTaskId(nextExpandedTaskId);
    if (nextExpandedTaskId) {
      fetchRequirementTaskLocate(taskEntry.id)
        .then((locateData) => setLocateDataMap((previousMap) => ({ ...previousMap, [taskEntry.id]: locateData })))
        .catch((locateError) => setActionMessage({ type: 'error', text: `分支定位失败: ${locateError.message}` }));
      fetchRequirementDependencyCheck(taskEntry.id)
        .then((dependencyData) =>
          setDependencyDataMap((previousMap) => ({ ...previousMap, [taskEntry.id]: dependencyData }))
        )
        .catch((dependencyError) => setActionMessage({ type: 'error', text: `依赖检查失败: ${dependencyError.message}` }));
    }
  }

  /** 对项目 worktree 发起独立安装（共享 junction 会先断开再安装） */
  async function handleStartIndependentInstall(taskEntry, projectIndex, projectEntry) {
    try {
      const installResult = await startRequirementIndependentInstall(taskEntry.id, projectEntry.worktreePath);
      setInstallJobMap((previousMap) => ({
        ...previousMap,
        [`${taskEntry.id}:${projectIndex}`]: installResult.jobId
      }));
      setActionMessage({
        type: 'success',
        text: `独立安装任务已启动（${installResult.packageManager} install），日志见下方；完成后可收起再展开刷新依赖状态。`
      });
    } catch (installError) {
      setActionMessage({ type: 'error', text: installError.message });
    }
  }

  /** 在资源管理器中显示路径（文件定位选中，目录直接打开） */
  async function handleRevealPath(targetPath) {
    try {
      await revealInExplorer(targetPath);
    } catch (revealError) {
      setActionMessage({ type: 'error', text: revealError.message });
    }
  }

  async function handleDeleteConfirmed(taskEntry) {
    try {
      const deleteResult = await deleteRequirementTask(taskEntry.id);
      const removedCount = (deleteResult.removedWorktreeList || []).length;
      setConfirmDeleteTask(null);
      setExpandedTaskId(expandedTaskId === taskEntry.id ? null : expandedTaskId);
      setActionMessage({
        type: 'success',
        text: `已删除需求任务并移除 ${removedCount} 个关联 worktree（含文件目录）；git 分支（本地与远程）均已保留，可点击“恢复”重建 worktree。`
      });
      refreshTaskList();
    } catch (deleteError) {
      setConfirmDeleteTask(null);
      const failedList = (deleteError.details && deleteError.details.failedList) || [];
      const failedReasonText = failedList
        .map((failedItem) => `${failedItem.projectName}：${failedItem.reason}`)
        .join('；');
      setActionMessage({
        type: 'error',
        text: `${deleteError.message}${failedReasonText ? ` —— ${failedReasonText}` : ''}`
      });
      if (deleteError.status === 409) {
        refreshTaskList();
      }
    }
  }

  async function handleRestore(taskEntry) {
    try {
      const restoreResult = await restoreRequirementTask(taskEntry.id);
      const restoredWorktreeList = restoreResult.restoredWorktreeList || [];
      const skippedCount = (restoreResult.skippedWorktreeList || []).length;
      const branchSummaryText = restoredWorktreeList
        .map((restoredItem) => `${restoredItem.projectName}(${restoredItem.branchName})`)
        .join('、');
      setActionMessage({
        type: 'success',
        text: `恢复完成：重建 ${restoredWorktreeList.length} 个 worktree${branchSummaryText ? ` — ${branchSummaryText}` : ''}${skippedCount ? `（${skippedCount} 个此前已恢复）` : ''}；工作区文件已重新生成。`
      });
      refreshTaskList();
    } catch (restoreError) {
      const failedList = (restoreError.details && restoreError.details.failedList) || [];
      const failedReasonText = failedList
        .map((failedItem) => `${failedItem.projectName}：${failedItem.reason}`)
        .join('；');
      setActionMessage({
        type: 'error',
        text: `${restoreError.message}${failedReasonText ? ` —— ${failedReasonText}` : ''}`
      });
    }
  }

  async function handlePermanentDeleteConfirmed(taskEntry) {
    try {
      const deleteResult = await permanentDeleteRequirementTask(taskEntry.id);
      const removedCount = (deleteResult.removedWorktreeList || []).length;
      setConfirmPermanentTask(null);
      setExpandedTaskId(expandedTaskId === taskEntry.id ? null : expandedTaskId);
      setActionMessage({
        type: 'success',
        text: `已彻底删除：任务记录与 ${removedCount} 个关联 worktree（含文件目录）均已移除${deleteResult.workspaceFileDeleted ? '，工作区文件一并删除' : ''}；git 分支（本地与远程）保留。`
      });
      refreshTaskList();
    } catch (deleteError) {
      setConfirmPermanentTask(null);
      setActionMessage({ type: 'error', text: deleteError.message });
      if (deleteError.status === 409) {
        refreshTaskList();
      }
    }
  }

  async function handleOpenWorktree(worktreePath) {
    try {
      await openDirectoryInEditor(worktreePath);
      setActionMessage({ type: 'success', text: `已请求编辑器打开：${worktreePath}` });
    } catch (openError) {
      setActionMessage({ type: 'error', text: openError.message });
    }
  }

  return (
    <div>
      <div className="list-toolbar">
        <button
          type="button"
          className="button-primary"
          onClick={() => { setFormState({ mode: 'new' }); setActionMessage(null); }}
        >
          新建需求任务
        </button>
        <button type="button" className="button-secondary" onClick={refreshTaskList}>
          刷新
        </button>
      </div>

      {formState ? (
        <div className="picker-overlay">
          <div className="picker-dialog requirement-form-dialog" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <div className="picker-toolbar">
              <span className="picker-current-path">
                {formState.mode === 'edit' ? '编辑需求任务' : '新建需求任务'}
              </span>
              <button type="button" className="button-secondary" onClick={() => setFormState(null)}>
                关闭
              </button>
            </div>
            <div className="requirement-form-body">
              <RequirementTaskForm
                initialRecord={formState.mode === 'edit' ? formState.record : null}
                initialBrowsePath={initialBrowsePath}
                workspaceDirectory={workspaceDirectory}
                workspaceLayoutEnabled={workspaceLayoutEnabled}
                onCancel={() => setFormState(null)}
                onSaved={handleSaved}
              />
            </div>
          </div>
        </div>
      ) : null}

      {listError ? <div className="alert-error">{listError}</div> : null}
      {actionMessage ? (
        <div className={actionMessage.type === 'error' ? 'alert-error' : 'alert-success'}>{actionMessage.text}</div>
      ) : null}

      {taskList.length === 0 && !listError && !formState ? (
        <div className="section-empty">暂无需求任务，点击“新建需求任务”创建第一条记录。</div>
      ) : null}

      {taskList.length > 0 ? (
        <table className="record-table">
          <thead>
            <tr>
              <th>需求链接</th>
              <th>开发分支</th>
              <th>项目数</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {taskList.map((taskEntry) => (
              <React.Fragment key={taskEntry.id}>
                <tr className={taskEntry.deletedAt ? 'requirement-deleted-row' : ''}>
                  <td className="requirement-link-cell">
                    <a href={taskEntry.requirementUrl} target="_blank" rel="noreferrer">
                      {taskEntry.requirementName || taskEntry.requirementUrl}
                    </a>
                    {taskEntry.deletedAt ? <span className="badge-status badge-occupied">已删除</span> : null}
                  </td>
                  <td>{taskEntry.branchName}</td>
                  <td>{taskEntry.projectList.length}</td>
                  <td>{formatTimeText(taskEntry.updatedAt)}</td>
                  <td>
                    <div className="cell-actions">
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => handleToggleExpand(taskEntry)}
                      >
                        {expandedTaskId === taskEntry.id ? '收起' : '查看'}
                      </button>
                      {taskEntry.deletedAt ? (
                        <>
                          <button
                            type="button"
                            className="button-primary"
                            onClick={() => handleRestore(taskEntry)}
                          >
                            恢复
                          </button>
                          <button
                            type="button"
                            className="button-danger"
                            onClick={() => setConfirmPermanentTask(taskEntry)}
                          >
                            彻底删除
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="button-secondary"
                            onClick={() => { setFormState({ mode: 'edit', record: taskEntry }); setActionMessage(null); }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="button-danger"
                            onClick={() => setConfirmDeleteTask(taskEntry)}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedTaskId === taskEntry.id ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="detail-expanded-panel">
                        <span className="form-label">工作区文件</span>
                        {taskEntry.workspaceFilePath ? (
                          <div>
                            <div className="settings-current-path">{taskEntry.workspaceFilePath}</div>
                            <div className="cell-actions">
                              <button
                                type="button"
                                className="button-secondary"
                                onClick={() => handleOpenWorktree(taskEntry.workspaceFilePath)}
                              >
                                打开工作区
                              </button>
                              <button
                                type="button"
                                className="button-secondary"
                                onClick={() => handleRevealPath(taskEntry.workspaceFilePath)}
                              >
                                显示
                              </button>
                              <button
                                type="button"
                                className="button-secondary"
                                onClick={() => handleRegenerateWorkspace(taskEntry.id)}
                              >
                                重新生成
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="form-hint">
                            未生成。编辑任务勾选“保存后生成工作区文件”，或点击“重新生成”。
                            <button
                              type="button"
                              className="button-secondary workspace-generate-button"
                              onClick={() => handleRegenerateWorkspace(taskEntry.id)}
                            >
                              重新生成
                            </button>
                          </div>
                        )}

                        <span className="form-label">涉及项目与关联 worktree</span>
                        {(() => {
                          const dependencyData = dependencyDataMap[taskEntry.id];
                          if (!dependencyData) {
                            return null;
                          }
                          const highRiskList = dependencyData.projectList.filter(
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
                        {taskEntry.projectList.map((projectEntry, projectIndex) => {
                          const locateEntry =
                            locateDataMap[taskEntry.id] && locateDataMap[taskEntry.id].projectList
                              ? locateDataMap[taskEntry.id].projectList[projectIndex]
                              : null;
                          const dependencyData = dependencyDataMap[taskEntry.id];
                          const dependencyEntry =
                            dependencyData && dependencyData.projectList
                              ? dependencyData.projectList[projectIndex]
                              : null;
                          const installJobId = installJobMap[`${taskEntry.id}:${projectIndex}`];
                          const projectConflictKey = `${String(projectEntry.repoPath || '')
                            .replace(/\//g, '\\')
                            .toLowerCase()}|${taskEntry.branchName}`;
                          const hasBranchConflict = conflictProjectKeySet.has(projectConflictKey);
                          return (
                            <div key={`${taskEntry.id}-project-${projectIndex}`} className="project-detail-card">
                              <div className="project-detail-header">
                                <span className="form-label">{projectEntry.projectName || '（未命名项目）'}</span>
                                {hasBranchConflict ? (
                                  <span className="badge-status badge-dirty">分支冲突</span>
                                ) : null}
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
                                  <button
                                    type="button"
                                    className="button-secondary"
                                    onClick={() => handleRevealPath(projectEntry.repoPath)}
                                  >
                                    显示
                                  </button>
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
                                      onClick={() => handleOpenWorktree(projectEntry.worktreePath)}
                                    >
                                      打开
                                    </button>
                                    <button
                                      type="button"
                                      className="button-secondary"
                                      onClick={() => handleRevealPath(projectEntry.worktreePath)}
                                    >
                                      显示
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
                                        {projectEntry.worktreePath ? (
                                          <button
                                            type="button"
                                            className="button-secondary dependency-install-button"
                                            onClick={() =>
                                              handleStartIndependentInstall(taskEntry, projectIndex, projectEntry)
                                            }
                                          >
                                            独立安装
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
                                  {renderBranchLocationCell(locateEntry, projectEntry, taskEntry.branchName)}
                                  {hasBranchConflict ? (
                                    <div className="conflict-hint">
                                      注意：分支 {taskEntry.branchName} 同时被其他需求在相同项目上关联，存在冲突，请核对
                                    </div>
                                  ) : null}
                                </span>
                              </div>

                              {installJobId ? (
                                <TaskLogPanel
                                  jobId={installJobId}
                                  title={`独立安装：${projectEntry.projectName}`}
                                />
                              ) : null}
                            </div>
                          );
                        })}
                        <span className="form-label">涉及项目名称</span>
                        {taskEntry.projectList.map((projectEntry, projectIndex) => {
                          const derivedProjectName =
                            deriveProjectNameFromPath(projectEntry.repoPath || projectEntry.worktreePath) ||
                            projectEntry.projectName ||
                            '（未设置）';
                          const locateEntry = locateDataMap[taskEntry.id];
                          const projectGitWebUrl =
                            locateEntry && locateEntry.projectList
                              ? locateEntry.projectList[projectIndex] &&
                                locateEntry.projectList[projectIndex].gitWebUrl
                              : null;
                          return (
                            <div key={`${taskEntry.id}-name-${projectIndex}`} className="project-name-line">
                              <span>{derivedProjectName}</span>
                              {projectGitWebUrl ? (
                                <a
                                  className="project-git-link"
                                  href={projectGitWebUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {projectGitWebUrl}
                                </a>
                              ) : null}
                            </div>
                          );
                        })}
                        {taskEntry.reservedContent ? (
                          <>
                            <span className="form-label">备注（预留字段）</span>
                            <div className="form-hint">{taskEntry.reservedContent}</div>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      ) : null}

      {confirmDeleteTask ? (
        <div className="picker-overlay">
          <div className="picker-dialog" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <div className="picker-toolbar">
              <span className="picker-current-path">删除需求任务确认</span>
              <button type="button" className="button-secondary" onClick={() => setConfirmDeleteTask(null)}>
                取消
              </button>
            </div>
            <div className="alert-warning">
              <div>执行删除将会做以下事情：</div>
              <div>
                1. 删除该需求关联的 {confirmDeleteTask.projectList.filter((p) => p.worktreePath).length} 个
                worktree，并一并删除 worktree 的文件目录：
              </div>
              <pre className="conflict-file-view">
                {confirmDeleteTask.projectList
                  .filter((projectEntry) => projectEntry.worktreePath)
                  .map((projectEntry) => `${projectEntry.projectName}：${projectEntry.worktreePath}`)
                  .join('\n') || '（无已关联的 worktree）'}
              </pre>
              <div>
                2. <b>git 分支不受影响</b>：本地与远程分支均会保留，删除后可随时点击“恢复”按原路径重建 worktree（目录会重新生成）。
              </div>
            </div>
            <div className="picker-footer">
              <button type="button" className="button-secondary" onClick={() => setConfirmDeleteTask(null)}>
                取消
              </button>
              <button
                type="button"
                className="button-danger"
                onClick={() => handleDeleteConfirmed(confirmDeleteTask)}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmPermanentTask ? (
        <div className="picker-overlay">
          <div className="picker-dialog" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <div className="picker-toolbar">
              <span className="picker-current-path">彻底删除确认（不可恢复）</span>
              <button type="button" className="button-secondary" onClick={() => setConfirmPermanentTask(null)}>
                取消
              </button>
            </div>
            <div className="alert-error">
              <div>执行彻底删除将会做以下事情，且<b>无法恢复</b>：</div>
              <div>
                1. 删除该需求关联的 {confirmPermanentTask.projectList.filter((p) => p.worktreePath).length} 个
                worktree，并一并删除 worktree 的文件目录：
              </div>
              <pre className="conflict-file-view">
                {confirmPermanentTask.projectList
                  .filter((projectEntry) => projectEntry.worktreePath)
                  .map((projectEntry) => `${projectEntry.projectName}：${projectEntry.worktreePath}`)
                  .join('\n') || '（无已关联的 worktree）'}
              </pre>
              <div>2. 删除需求任务记录本身与工作区文件（{confirmPermanentTask.workspaceFilePath || '无'}）。</div>
              <div>
                3. <b>git 分支不受影响</b>：本地与远程分支均会保留（如需连分支一起清理，请用 git 命令自行处理）。
              </div>
            </div>
            <div className="picker-footer">
              <button type="button" className="button-secondary" onClick={() => setConfirmPermanentTask(null)}>
                取消
              </button>
              <button
                type="button"
                className="button-danger"
                onClick={() => handlePermanentDeleteConfirmed(confirmPermanentTask)}
              >
                确认彻底删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
