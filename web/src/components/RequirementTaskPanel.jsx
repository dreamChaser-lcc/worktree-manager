import React, { useEffect, useMemo, useState } from 'react';
import { RequirementTaskForm, deriveProjectNameFromPath } from './RequirementTaskForm.jsx';
import { TaskLogPanel } from './TaskLogPanel.jsx';
import { DependencyInstallDialog } from './DependencyInstallDialog.jsx';
import { usePendingActions } from '../utils/usePendingActions.js';
import {
  fetchRequirementTaskList,
  updateRequirementTask,
  deleteRequirementTask,
  restoreRequirementTask,
  permanentDeleteRequirementTask,
  generateRequirementWorkspace,
  fetchRequirementTaskLocate,
  fetchRequirementDependencyCheck,
  startRequirementIndependentInstall,
  restoreSharedDependencies,
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
  // 删除/彻底删除确认弹窗：强制删除勾选（有未提交修改时丢弃修改）与失败详情（弹窗内展示并引导重试）
  const [deleteForceChecked, setDeleteForceChecked] = useState(false);
  const [deleteFailedMessage, setDeleteFailedMessage] = useState(null);
  const [permanentForceChecked, setPermanentForceChecked] = useState(false);
  const [permanentFailedMessage, setPermanentFailedMessage] = useState(null);
  const [actionMessage, setActionMessage] = useState(null);
  // 需求任务面板：刷新进行中标记（禁用按钮 + spinner，明确告知刷新动作在执行）
  const [refreshing, setRefreshing] = useState(false);
  // 展开明细时按需获取的分支定位数据（taskId → locate 响应）
  const [locateDataMap, setLocateDataMap] = useState({});
  // 展开明细时按需获取的依赖检查数据（taskId → dependency-check 响应）
  const [dependencyDataMap, setDependencyDataMap] = useState({});
  // 各项目已启动的独立安装任务（`${taskId}:${projectIndex}` → { jobId, installMode }）
  const [installJobMap, setInstallJobMap] = useState({});
  // 独立安装选项弹窗：null | { taskEntry, projectIndex, projectEntry }
  const [installDialogState, setInstallDialogState] = useState(null);
  // 安装请求发起中的 key 集合（`${taskId}:${projectIndex}`），用于禁用按钮防连点
  const [installStartingKeyMap, setInstallStartingKeyMap] = useState({});
  // 恢复共享进行中（同步长操作：删独立 node_modules + 重建 junction，可能耗时较久）
  const [sharedRestoreKeyMap, setSharedRestoreKeyMap] = useState({});
  // 安装任务运行中（启动成功 → 任务落终态），用于依赖行按钮禁用与 loading 反馈
  const [installRunningKeyMap, setInstallRunningKeyMap] = useState({});
  // 删除/彻底删除确认弹窗的提交中标记（确认按钮 spinner 与禁用）
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [permanentDeleting, setPermanentDeleting] = useState(false);
  // 恢复 / 工作区重新生成 / 打开与显示 等异步按钮的 pending 管理
  const restorePending = usePendingActions();
  const workspaceRegenPending = usePendingActions();
  const pathActionPending = usePendingActions();
  // 备注就地编辑：编辑中的任务 id 与草稿文本（列表行内直接改，无需进编辑表单）
  const [remarkEditingTaskId, setRemarkEditingTaskId] = useState(null);
  const [remarkEditingText, setRemarkEditingText] = useState('');
  const [remarkSaving, setRemarkSaving] = useState(false);
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
    await workspaceRegenPending.run(`ws-regen:${taskId}`, async () => {
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
    });
  }

  /** 展开/收起明细；展开时实时获取分支定位与依赖检查数据 */
  async function handleToggleExpand(taskEntry) {
    const nextExpandedTaskId = expandedTaskId === taskEntry.id ? null : taskEntry.id;
    setExpandedTaskId(nextExpandedTaskId);
    if (nextExpandedTaskId) {
      loadExpandedTaskData(nextExpandedTaskId);
    }
  }

  /** 拉取指定需求的分支定位与依赖检查数据（展开明细与手动刷新共用）；返回全部完成的 Promise */
  function loadExpandedTaskData(taskId) {
    return Promise.all([
      fetchRequirementTaskLocate(taskId)
        .then((locateData) => setLocateDataMap((previousMap) => ({ ...previousMap, [taskId]: locateData })))
        .catch((locateError) => setActionMessage({ type: 'error', text: `分支定位失败: ${locateError.message}` })),
      fetchRequirementDependencyCheck(taskId)
        .then((dependencyData) =>
          setDependencyDataMap((previousMap) => ({ ...previousMap, [taskId]: dependencyData }))
        )
        .catch((dependencyError) => setActionMessage({ type: 'error', text: `依赖检查失败: ${dependencyError.message}` }))
    ]);
  }

  /** 刷新：需求列表 + 已展开明细的分支定位与依赖检查一并重拉，期间按钮展示 loading；同时清掉上一次操作的提示 */
  async function handleRefreshAll() {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    setActionMessage(null);
    try {
      await Promise.all([
        refreshTaskList(),
        expandedTaskId ? loadExpandedTaskData(expandedTaskId) : Promise.resolve()
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  /** 按 key 增删布尔标记的通用写法（loading/运行态集合用） */
  function setKeyFlag(mapSetter, actionKey, flagValue) {
    mapSetter((previousMap) => {
      const nextMap = { ...previousMap };
      if (flagValue) {
        nextMap[actionKey] = true;
      } else {
        delete nextMap[actionKey];
      }
      return nextMap;
    });
  }

  /** 对项目 worktree 发起独立安装（共享 junction 会先断开再安装；customScriptText 非空走自定义脚本） */
  async function handleStartIndependentInstall(taskEntry, projectIndex, projectEntry, customScriptText) {
    const installActionKey = `${taskEntry.id}:${projectIndex}`;
    setInstallStartingKeyMap((previousMap) => ({ ...previousMap, [installActionKey]: true }));
    try {
      const installResult = await startRequirementIndependentInstall(
        taskEntry.id,
        projectEntry.worktreePath,
        customScriptText
      );
      setInstallJobMap((previousMap) => ({
        ...previousMap,
        [installActionKey]: { jobId: installResult.jobId, installMode: installResult.installMode }
      }));
      // 任务运行中：依赖行按钮进入「安装中...」禁用态，落终态后由 onFinished 解除并刷新
      setKeyFlag(setInstallRunningKeyMap, installActionKey, true);
      const installModeText = installResult.installMode === 'custom' ? '自定义脚本安装' : '默认安装';
      setActionMessage({
        type: 'success',
        text: `${installModeText}任务已启动（${installResult.packageManager}${installResult.junctionRemoved ? '，已断开共享链接' : ''}），日志见下方；完成后状态自动刷新。`
      });
      setInstallDialogState(null);
      refreshDependencyCheck(taskEntry.id);
    } catch (installError) {
      // 409 等错误保留弹窗，方便用户看到原因后直接重试或取消
      setActionMessage({ type: 'error', text: installError.message });
    } finally {
      setInstallStartingKeyMap((previousMap) => {
        const nextMap = { ...previousMap };
        delete nextMap[installActionKey];
        return nextMap;
      });
    }
  }

  /** 在资源管理器中显示路径（文件定位选中，目录直接打开） */
  async function handleRevealPath(targetPath) {
    await pathActionPending.run(`reveal:${targetPath}`, async () => {
      try {
        await revealInExplorer(targetPath);
      } catch (revealError) {
        setActionMessage({ type: 'error', text: revealError.message });
      }
    });
  }

  /** 拼装删除失败详情：逐项目给出原因与未提交文件清单，并引导勾选强制删除重试 */
  function buildDeleteFailedText(deleteError) {
    const failedList = (deleteError.details && deleteError.details.failedList) || [];
    const detailLineList = failedList.map((failedItem) => {
      const uncommittedFileList = failedItem.uncommittedFiles || [];
      const fileText =
        uncommittedFileList.length > 0
          ? `；未提交内容（${uncommittedFileList.length} 处）：${uncommittedFileList
              .slice(0, 5)
              .join('、')}${uncommittedFileList.length > 5 ? ` 等` : ''}`
          : '';
      return `${failedItem.projectName}：${failedItem.reason}${fileText}`;
    });
    return [
      deleteError.message,
      ...detailLineList,
      deleteError.status === 409 ? '处理建议：先到 worktree 里提交或还原上述修改后重试；确认放弃修改可勾选“强制删除”后重试。' : ''
    ].filter(Boolean).join('\n');
  }

  async function handleDeleteConfirmed(taskEntry, forceRemoval) {
    setDeleteSubmitting(true);
    try {
      const deleteResult = await deleteRequirementTask(taskEntry.id, forceRemoval);
      const removedCount = (deleteResult.removedWorktreeList || []).length;
      setConfirmDeleteTask(null);
      setDeleteForceChecked(false);
      setDeleteFailedMessage(null);
      setExpandedTaskId(expandedTaskId === taskEntry.id ? null : expandedTaskId);
      setActionMessage({
        type: 'success',
        text: `已删除需求任务并移除 ${removedCount} 个关联 worktree（含文件目录）；git 分支（本地与远程）均已保留，可点击“恢复”重建 worktree。`
      });
      refreshTaskList();
    } catch (deleteError) {
      // 失败时弹窗保留：详情与“强制删除”入口都在弹窗内，避免用户失去重试路径
      setDeleteFailedMessage(buildDeleteFailedText(deleteError));
      if (deleteError.status === 409) {
        refreshTaskList();
      }
    } finally {
      setDeleteSubmitting(false);
    }
  }

  async function handleRestore(taskEntry) {
    await restorePending.run(`restore:${taskEntry.id}`, async () => {
      try {
        const restoreResult = await restoreRequirementTask(taskEntry.id);
        const restoredWorktreeList = restoreResult.restoredWorktreeList || [];
        const skippedCount = (restoreResult.skippedWorktreeList || []).length;
        const branchSummaryText = restoredWorktreeList
          .map((restoredItem) => `${restoredItem.projectName}(${restoredItem.branchName})`)
          .join('、');
        const sharedDependencyCount = restoredWorktreeList.filter(
          (restoredItem) => restoredItem.dependencyAction === 'shared'
        ).length;
        const unhandledDependencyList = restoredWorktreeList.filter(
          (restoredItem) => restoredItem.dependencyAction !== 'shared'
        );
        const dependencySummaryText =
          restoredWorktreeList.length > 0
            ? `依赖：${sharedDependencyCount} 个已重建共享链接${
                unhandledDependencyList.length > 0
                  ? `，${unhandledDependencyList.length} 个未处理（${unhandledDependencyList
                      .map((restoredItem) => `${restoredItem.projectName}：${restoredItem.dependencyReason}`)
                      .join('；')}；可在明细中点“独立安装”）`
                  : ''
              }`
            : '';
        setActionMessage({
          type: 'success',
          text: `恢复完成：重建 ${restoredWorktreeList.length} 个 worktree${branchSummaryText ? ` — ${branchSummaryText}` : ''}；${dependencySummaryText}${skippedCount ? `（${skippedCount} 个此前已恢复）` : ''}工作区文件已重新生成。`
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
    });
  }

  /** 重新拉取指定需求的依赖检查数据（安装/恢复共享后刷新状态） */
  function refreshDependencyCheck(taskId) {
    fetchRequirementDependencyCheck(taskId)
      .then((dependencyData) =>
        setDependencyDataMap((previousMap) => ({ ...previousMap, [taskId]: dependencyData }))
      )
      .catch(() => {});
  }

  /** 恢复共享：删除独立安装的 node_modules，重建与主仓库的 junction 共享（同步长操作，按钮带 loading） */
  async function handleRestoreShared(taskEntry, projectIndex, projectEntry) {
    const restoreActionKey = `${taskEntry.id}:${projectIndex}`;
    setKeyFlag(setSharedRestoreKeyMap, restoreActionKey, true);
    try {
      const restoreResult = await restoreSharedDependencies(taskEntry.id, projectEntry.worktreePath);
      setActionMessage({
        type: 'success',
        text: `已恢复共享主目录依赖${restoreResult.removedIndependentModules ? '（独立安装的 node_modules 已移除）' : ''}。`
      });
      refreshDependencyCheck(taskEntry.id);
    } catch (restoreError) {
      setActionMessage({ type: 'error', text: restoreError.message });
    } finally {
      setKeyFlag(setSharedRestoreKeyMap, restoreActionKey, false);
    }
  }

  async function handlePermanentDeleteConfirmed(taskEntry, forceRemoval) {
    setPermanentDeleting(true);
    try {
      const deleteResult = await permanentDeleteRequirementTask(taskEntry.id, forceRemoval);
      const removedCount = (deleteResult.removedWorktreeList || []).length;
      setConfirmPermanentTask(null);
      setPermanentForceChecked(false);
      setPermanentFailedMessage(null);
      setExpandedTaskId(expandedTaskId === taskEntry.id ? null : expandedTaskId);
      setActionMessage({
        type: 'success',
        text: `已彻底删除：任务记录与 ${removedCount} 个关联 worktree（含文件目录）均已移除${deleteResult.workspaceFileDeleted ? '，工作区文件一并删除' : ''}；git 分支（本地与远程）保留。`
      });
      refreshTaskList();
    } catch (deleteError) {
      // 失败时弹窗保留：详情与“强制删除”入口都在弹窗内
      setPermanentFailedMessage(buildDeleteFailedText(deleteError));
      if (deleteError.status === 409) {
        refreshTaskList();
      }
    } finally {
      setPermanentDeleting(false);
    }
  }

  async function handleOpenWorktree(worktreePath) {
    await pathActionPending.run(`open:${worktreePath}`, async () => {
      try {
        await openDirectoryInEditor(worktreePath);
        setActionMessage({ type: 'success', text: `已请求编辑器打开：${worktreePath}` });
      } catch (openError) {
        setActionMessage({ type: 'error', text: openError.message });
      }
    });
  }

  /** 备注就地编辑：进入编辑态（其余任务的编辑态自动关闭） */
  function handleStartRemarkEdit(taskEntry) {
    setRemarkEditingTaskId(taskEntry.id);
    setRemarkEditingText(taskEntry.reservedContent || '');
  }

  /**
   * 保存备注：复用需求更新接口，携带现有完整字段 + 新备注（generateWorkspace=false 不触发工作区文件重建）。
   * 保存成功后刷新列表并退出编辑态。
   */
  async function handleSaveRemark(taskEntry) {
    setRemarkSaving(true);
    try {
      await updateRequirementTask(taskEntry.id, {
        requirementName: taskEntry.requirementName || '',
        requirementUrl: taskEntry.requirementUrl,
        branchName: taskEntry.branchName,
        reservedContent: remarkEditingText.trim(),
        projectList: taskEntry.projectList,
        generateWorkspace: false
      });
      setRemarkEditingTaskId(null);
      setRemarkEditingText('');
      setActionMessage({ type: 'success', text: '备注已更新。' });
      refreshTaskList();
    } catch (saveError) {
      setActionMessage({ type: 'error', text: `备注保存失败: ${saveError.message}` });
    } finally {
      setRemarkSaving(false);
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
        <button type="button" className="button-secondary" disabled={refreshing} onClick={handleRefreshAll}>
          {refreshing ? (
            <span>
              <span className="button-spinner" />
              刷新中...
            </span>
          ) : (
            '刷新'
          )}
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
                            disabled={restorePending.isPending(`restore:${taskEntry.id}`)}
                            onClick={() => handleRestore(taskEntry)}
                          >
                            {restorePending.isPending(`restore:${taskEntry.id}`) ? (
                              <span>
                                <span className="button-spinner" />
                                恢复中...
                              </span>
                            ) : (
                              '恢复'
                            )}
                          </button>
                          <button
                            type="button"
                            className="button-danger"
                            onClick={() => {
                              setConfirmPermanentTask(taskEntry);
                              setPermanentForceChecked(false);
                              setPermanentFailedMessage(null);
                            }}
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
                            onClick={() => {
                              setConfirmDeleteTask(taskEntry);
                              setDeleteForceChecked(false);
                              setDeleteFailedMessage(null);
                            }}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                <tr className="remark-row">
                  <td colSpan={5}>
                    {remarkEditingTaskId === taskEntry.id ? (
                      <div className="remark-edit-area">
                        <textarea
                          className="reserved-textarea"
                          value={remarkEditingText}
                          autoFocus
                          placeholder="填写需求背景、联调约定等（可留空）"
                          onChange={(changeEvent) => setRemarkEditingText(changeEvent.target.value)}
                        />
                        <div className="picker-footer">
                          <button
                            type="button"
                            className="button-secondary"
                            disabled={remarkSaving}
                            onClick={() => setRemarkEditingTaskId(null)}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="button-primary"
                            disabled={remarkSaving}
                            onClick={() => handleSaveRemark(taskEntry)}
                          >
                            {remarkSaving ? '保存中...' : '保存备注'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="remark-line">
                        <span className="detail-line-label">备注</span>
                        <span
                          className={
                            taskEntry.reservedContent ? 'remark-text' : 'remark-text remark-text-empty'
                          }
                        >
                          {taskEntry.reservedContent || '（无备注）'}
                          <button
                            type="button"
                            className="remark-pencil"
                            title="编辑备注"
                            onClick={() => handleStartRemarkEdit(taskEntry)}
                          >
                            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
                              <path
                                d="M11.33 2.22a1.55 1.55 0 0 1 2.2 2.2L5.2 12.76l-3.03.82.82-3.03 8.34-8.33z"
                                stroke="currentColor"
                                strokeWidth="1.3"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        </span>
                      </div>
                    )}
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
                                disabled={pathActionPending.isPending(`open:${taskEntry.workspaceFilePath}`)}
                                onClick={() => handleOpenWorktree(taskEntry.workspaceFilePath)}
                              >
                                {pathActionPending.isPending(`open:${taskEntry.workspaceFilePath}`) ? (
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
                                disabled={pathActionPending.isPending(`reveal:${taskEntry.workspaceFilePath}`)}
                                onClick={() => handleRevealPath(taskEntry.workspaceFilePath)}
                              >
                                {pathActionPending.isPending(`reveal:${taskEntry.workspaceFilePath}`) ? (
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
                                disabled={workspaceRegenPending.isPending(`ws-regen:${taskEntry.id}`)}
                                onClick={() => handleRegenerateWorkspace(taskEntry.id)}
                              >
                                {workspaceRegenPending.isPending(`ws-regen:${taskEntry.id}`) ? (
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
                              disabled={workspaceRegenPending.isPending(`ws-regen:${taskEntry.id}`)}
                              onClick={() => handleRegenerateWorkspace(taskEntry.id)}
                            >
                              {workspaceRegenPending.isPending(`ws-regen:${taskEntry.id}`) ? (
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
                          const installJobEntry = installJobMap[`${taskEntry.id}:${projectIndex}`];
                          const installActionKey = `${taskEntry.id}:${projectIndex}`;
                          const installRunning = Boolean(installRunningKeyMap[installActionKey]);
                          const sharedRestoring = Boolean(sharedRestoreKeyMap[installActionKey]);
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
                                  <>
                                    <button
                                      type="button"
                                      className="button-secondary"
                                      disabled={pathActionPending.isPending(`open:${projectEntry.repoPath}`)}
                                      onClick={() => handleOpenWorktree(projectEntry.repoPath)}
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
                                      onClick={() => handleRevealPath(projectEntry.repoPath)}
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
                                      onClick={() => handleOpenWorktree(projectEntry.worktreePath)}
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
                                      onClick={() => handleRevealPath(projectEntry.worktreePath)}
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
                                            onClick={() => handleRestoreShared(taskEntry, projectIndex, projectEntry)}
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
                                            onClick={() =>
                                              setInstallDialogState({ taskEntry, projectIndex, projectEntry })
                                            }
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
                                  {renderBranchLocationCell(locateEntry, projectEntry, taskEntry.branchName)}
                                  {hasBranchConflict ? (
                                    <div className="conflict-hint">
                                      注意：分支 {taskEntry.branchName} 同时被其他需求在相同项目上关联，存在冲突，请核对
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
                                  onFinished={(finishStatus) => {
                                    // 任务落终态：解除「安装中」标记并刷新依赖状态，无需手动刷新
                                    setKeyFlag(setInstallRunningKeyMap, installActionKey, false);
                                    refreshDependencyCheck(taskEntry.id);
                                    // 桌面端（Electron 壳注入）发系统原生通知；浏览器模式无此桥接自动跳过
                                    if (window.desktopBridge && typeof window.desktopBridge.notify === 'function') {
                                      const installSucceeded = finishStatus === 'success';
                                      window.desktopBridge.notify(
                                        installSucceeded ? '依赖安装完成' : '依赖安装失败',
                                        `${projectEntry.projectName}：${installSucceeded ? '可回到明细查看依赖状态' : '请在日志中排查失败原因'}`
                                      );
                                    }
                                  }}
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
            {deleteFailedMessage ? <div className="alert-error">{deleteFailedMessage}</div> : null}
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
            <label className="radio-label">
              <input
                type="checkbox"
                checked={deleteForceChecked}
                onChange={(changeEvent) => setDeleteForceChecked(changeEvent.target.checked)}
              />
              强制删除（worktree 存在未提交修改时直接丢弃，不可恢复；建议先提交或还原）
            </label>
            <div className="picker-footer">
              <button type="button" className="button-secondary" onClick={() => setConfirmDeleteTask(null)}>
                取消
              </button>
              <button
                type="button"
                className={deleteForceChecked ? 'button-danger' : 'button-primary'}
                disabled={deleteSubmitting}
                onClick={() => handleDeleteConfirmed(confirmDeleteTask, deleteForceChecked)}
              >
                {deleteSubmitting ? (
                  <span>
                    <span className="button-spinner" />
                    删除中...
                  </span>
                ) : deleteForceChecked ? (
                  '确认强制删除'
                ) : (
                  '确认删除'
                )}
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
            {permanentFailedMessage ? <div className="alert-error">{permanentFailedMessage}</div> : null}
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
            <label className="radio-label">
              <input
                type="checkbox"
                checked={permanentForceChecked}
                onChange={(changeEvent) => setPermanentForceChecked(changeEvent.target.checked)}
              />
              强制删除（worktree 存在未提交修改时直接丢弃，不可恢复；建议先提交或还原）
            </label>
            <div className="picker-footer">
              <button type="button" className="button-secondary" onClick={() => setConfirmPermanentTask(null)}>
                取消
              </button>
              <button
                type="button"
                className="button-danger"
                disabled={permanentDeleting}
                onClick={() => handlePermanentDeleteConfirmed(confirmPermanentTask, permanentForceChecked)}
              >
                {permanentDeleting ? (
                  <span>
                    <span className="button-spinner" />
                    删除中...
                  </span>
                ) : (
                  '确认彻底删除'
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {installDialogState ? (
        <DependencyInstallDialog
          projectName={installDialogState.projectEntry.projectName || '（未命名项目）'}
          worktreePath={installDialogState.projectEntry.worktreePath}
          packageManagerName={
            dependencyDataMap[installDialogState.taskEntry.id] &&
            dependencyDataMap[installDialogState.taskEntry.id].projectList[installDialogState.projectIndex]
              ? dependencyDataMap[installDialogState.taskEntry.id].projectList[installDialogState.projectIndex]
                  .packageManager
              : null
          }
          submitting={Boolean(
            installStartingKeyMap[
              `${installDialogState.taskEntry.id}:${installDialogState.projectIndex}`
            ]
          )}
          onCancel={() => setInstallDialogState(null)}
          onConfirmInstall={(customScriptText) =>
            handleStartIndependentInstall(
              installDialogState.taskEntry,
              installDialogState.projectIndex,
              installDialogState.projectEntry,
              customScriptText
            )
          }
        />
      ) : null}
    </div>
  );
}
