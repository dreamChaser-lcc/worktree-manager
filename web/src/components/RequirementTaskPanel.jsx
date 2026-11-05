import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RequirementTaskForm } from './RequirementTaskForm.jsx';
import { RequirementTaskDetailDialog } from './RequirementTaskDetailDialog.jsx';
import { DependencyInstallDialog } from './DependencyInstallDialog.jsx';
import { TaskActionsRow } from './TaskActionsRow.jsx';
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
  openDirectoryInEditor,
  fetchRequirementTaskPage,
  setRequirementPublished,
  setRequirementStage,
  reorderRequirementTasks
} from '../api/client.js';

function formatTimeText(isoText) {
  return isoText ? isoText.replace('T', ' ').slice(0, 19) : '—';
}

/** 列表时间筛选默认值：默认按创建时间、不限日期 */
const DEFAULT_TIME_FILTER = { timeField: 'createdAt', startDate: '', endDate: '' };

/** 时间筛选是否偏离默认值（用于提示当前列表处于筛选态） */
function hasActiveTimeFilter(timeFilter) {
  return Boolean(timeFilter.startDate) || Boolean(timeFilter.endDate);
}

/** 由 YYYY-MM 推出该月最后一天的日期文本（YYYY-MM-DD），供「快捷月份」一键填充范围 */
function resolveMonthEndDateText(monthText) {
  const [yearText, monthNumberText] = monthText.split('-');
  const lastDayNumber = new Date(Number(yearText), Number(monthNumberText), 0).getDate();
  return `${monthText}-${String(lastDayNumber).padStart(2, '0')}`;
}

/** 把已应用的时间筛选描述成一行文案（如「创建时间 2026-11-01 ~ 2026-11-30」） */
function describeTimeFilter(timeFilter) {
  const fieldText = timeFilter.timeField === 'createdAt' ? '创建时间' : '更新时间';
  const rangeText = [timeFilter.startDate, timeFilter.endDate].filter(Boolean).join(' ~ ');
  return `${fieldText} ${rangeText}`;
}

/**
 * 行内"更多"下拉：hover 展开、移出收起。
 * 菜单用 fixed 定位（JS 计算按钮位置），避免被表格滚动容器（overflow:auto）裁剪；
 * 底部空间不足时自动向上展开。fixed 元素在无 transform 祖先时不受 overflow 裁剪，
 * 且 DOM 仍在容器内，鼠标移向菜单不会触发 mouseleave。
 */
function RowActionsMore({ children }) {
  const triggerReference = useRef(null);
  const [dropdownStyle, setDropdownStyle] = useState(null);

  function updateDropdownPosition() {
    const triggerRect = triggerReference.current.getBoundingClientRect();
    const menuHeight = React.Children.count(children) * 33 + 10;
    let top = triggerRect.bottom;
    if (top + menuHeight > window.innerHeight - 8) {
      top = triggerRect.top - menuHeight;
    }
    setDropdownStyle({
      top: Math.max(8, top),
      left: Math.max(8, triggerRect.right - 140)
    });
  }

  return (
    <div
      className="actions-more"
      onMouseEnter={updateDropdownPosition}
      onMouseLeave={() => setDropdownStyle(null)}
    >
      <button ref={triggerReference} type="button" className="button-secondary actions-more-trigger">
        更多 <span className="actions-more-arrow">▾</span>
      </button>
      {dropdownStyle ? (
        <div className="actions-dropdown" style={dropdownStyle}>
          {children}
        </div>
      ) : null}
    </div>
  );
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

/** 汇总恢复时忽略文件/目录的复制结果：成功项列清单、失败项列原因，均无时不占位 */
function buildRestoreIgnoredCopyText(restoredWorktreeList) {
  const copiedTextList = restoredWorktreeList
    .filter((restoredItem) => restoredItem.ignoredCopyText)
    .map((restoredItem) => `${restoredItem.projectName}：${restoredItem.ignoredCopyText}`);
  const failedTextList = restoredWorktreeList
    .filter((restoredItem) => restoredItem.ignoredCopyErrorText)
    .map((restoredItem) => `${restoredItem.projectName}：${restoredItem.ignoredCopyErrorText}`);
  const summaryPartList = [];
  if (copiedTextList.length > 0) {
    summaryPartList.push(`忽略内容已复制（${copiedTextList.join('；')}）`);
  }
  if (failedTextList.length > 0) {
    summaryPartList.push(`忽略内容复制失败（${failedTextList.join('；')}）`);
  }
  return summaryPartList.join('；');
}

/** 需求任务面板：以需求为维度维护分支与多项目 worktree 列表，支持查看/编辑/删除/打开/工作区文件 */
export function RequirementTaskPanel({ initialBrowsePath, workspaceDirectory, workspaceLayoutEnabled }) {
  const [taskList, setTaskList] = useState([]);
  const [listError, setListError] = useState(null);
  // 列表时间筛选：draft 为输入中的条件，applied 为实际参与请求的条件（点「查询」才生效）
  const [timeFilterDraft, setTimeFilterDraft] = useState({ ...DEFAULT_TIME_FILTER });
  const [timeFilterApplied, setTimeFilterApplied] = useState({ ...DEFAULT_TIME_FILTER });
  // 查询条件面板默认收起（避免长期占位），点「筛选」展开；快捷月份（YYYY-MM）仅用于一键填充日期范围
  const [filterPanelExpanded, setFilterPanelExpanded] = useState(false);
  const [quickMonthText, setQuickMonthText] = useState('');
  // 发布状态 tab 与分页：unpublished（未发布）/ published（已发布），默认未发布
  const [activeStatusTab, setActiveStatusTab] = useState('unpublished');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 20;
  const [totalTasks, setTotalTasks] = useState(0);
  const [formState, setFormState] = useState(null); // null | { mode: 'new' } | { mode: 'edit', record }
  // 需求明细弹窗当前展示的任务 id（null 表示弹窗关闭）
  const [detailDialogTaskId, setDetailDialogTaskId] = useState(null);
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
  // 打开明细弹窗时按需获取的分支定位数据（taskId → locate 响应）
  const [locateDataMap, setLocateDataMap] = useState({});
  // 打开明细弹窗时按需获取的依赖检查数据（taskId → dependency-check 响应）
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
  // 发布标记请求中（按任务 id，禁用按钮 + spinner）
  const [publishPendingId, setPublishPendingId] = useState(null);
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
  // 明细弹窗当前展示的任务对象（随列表刷新自动取最新数据；任务被移除时弹窗自然关闭）
  const detailDialogTaskEntry = useMemo(
    () => taskList.find((taskEntryItem) => taskEntryItem.id === detailDialogTaskId) || null,
    [taskList, detailDialogTaskId]
  );

  function refreshTaskList() {
    fetchRequirementTaskPage({
      status: activeStatusTab,
      page: currentPage,
      pageSize,
      timeField: timeFilterApplied.timeField,
      startDate: timeFilterApplied.startDate,
      endDate: timeFilterApplied.endDate
    })
      .then((listData) => {
        setTaskList(listData.tasks || []);
        setTotalTasks(listData.total || 0);
        setListError(null);
      })
      .catch((loadError) => setListError(loadError.message));
  }

  useEffect(() => {
    refreshTaskList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStatusTab, currentPage, timeFilterApplied]);

  /** 应用时间筛选：回到第 1 页并按新条件重新查询，随后收起筛选面板给列表腾位置 */
  function handleApplyTimeFilter() {
    setCurrentPage(1);
    setTimeFilterApplied({ ...timeFilterDraft });
    setFilterPanelExpanded(false);
  }

  /** 重置时间筛选：清空字段、日期与快捷月份后重新查询 */
  function handleResetTimeFilter() {
    setTimeFilterDraft({ ...DEFAULT_TIME_FILTER });
    setQuickMonthText('');
    setCurrentPage(1);
    setTimeFilterApplied({ ...DEFAULT_TIME_FILTER });
  }

  /** 更新时间筛选草稿的单个字段（timeField / startDate / endDate）；手改日期时清掉快捷月份，避免两处显示不一致 */
  function handleTimeFilterDraftChange(fieldName, fieldValue) {
    if (fieldName === 'startDate' || fieldName === 'endDate') {
      setQuickMonthText('');
    }
    setTimeFilterDraft((previousFilter) => ({ ...previousFilter, [fieldName]: fieldValue }));
  }

  /** 快捷月份：选中某月即把范围填成该月首末日（仍需点「查询」才生效） */
  function handleQuickMonthChange(monthText) {
    setQuickMonthText(monthText);
    if (!monthText) {
      return;
    }
    setTimeFilterDraft((previousFilter) => ({
      ...previousFilter,
      startDate: `${monthText}-01`,
      endDate: resolveMonthEndDateText(monthText)
    }));
  }

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

  /** 打开需求明细弹窗；打开时实时获取分支定位与依赖检查数据 */
  function handleOpenDetailDialog(taskEntry) {
    setDetailDialogTaskId(taskEntry.id);
    loadDetailDialogData(taskEntry.id);
  }

  /** 关闭需求明细弹窗 */
  function handleCloseDetailDialog() {
    setDetailDialogTaskId(null);
  }

  /** 拉取指定需求的分支定位与依赖检查数据（明细弹窗与手动刷新共用）；返回全部完成的 Promise */
  function loadDetailDialogData(taskId) {
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

  /** 刷新：需求列表 + 明细弹窗的分支定位与依赖检查一并重拉，期间按钮展示 loading；同时清掉上一次操作的提示 */
  /** 复制文本到剪贴板（http 局域网环境降级 execCommand）；labelText 用于成功提示（分支名/需求名称） */
  async function handleCopyText(copyText, labelText) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(copyText);
      } else {
        const helperTextArea = document.createElement('textarea');
        helperTextArea.value = copyText;
        helperTextArea.style.position = 'fixed';
        helperTextArea.style.opacity = '0';
        document.body.appendChild(helperTextArea);
        helperTextArea.select();
        document.execCommand('copy');
        document.body.removeChild(helperTextArea);
      }
      setActionMessage({ type: 'success', text: `已复制${labelText}: ${copyText}` });
    } catch (copyError) {
      setActionMessage({ type: 'error', text: '复制失败: ' + copyError.message });
    }
  }

  /** 标记/取消发布（切换 publishedAt 标记） */
  async function handleSetPublished(taskEntry, published) {
    try {
      setPublishPendingId(taskEntry.id);
      await setRequirementPublished(taskEntry.id, published);
      setActionMessage({
        type: 'success',
        text: published ? '已标记为已发布。' : '已取消发布标记。'
      });
      refreshTaskList();
    } catch (publishError) {
      setActionMessage({ type: 'error', text: publishError.message });
    } finally {
      setPublishPendingId(null);
    }
  }
  /** 上移/下移排序：乐观更新本地顺序，持久化到后端 */
  function handleMoveTask(taskEntry, direction) {
    const currentIndex = taskList.findIndex((taskEntryItem) => taskEntryItem.id === taskEntry.id);
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= taskList.length) {
      return;
    }
    const reorderedList = [...taskList];
    const [movedEntry] = reorderedList.splice(currentIndex, 1);
    reorderedList.splice(targetIndex, 0, movedEntry);
    setTaskList(reorderedList);
    reorderRequirementTasks(reorderedList.map((taskEntryItem) => taskEntryItem.id)).catch((reorderError) => {
      setActionMessage({ type: 'error', text: '排序保存失败: ' + reorderError.message });
      refreshTaskList();
    });
  }

  /** 设置阶段标签 */
  async function handleSetStage(taskEntry, stageTag) {
    try {
      await setRequirementStage(taskEntry.id, stageTag);
      setTaskList((previousList) =>
        previousList.map((taskEntryItem) =>
          taskEntryItem.id === taskEntry.id ? { ...taskEntryItem, stageTag: stageTag ||  null } : taskEntryItem
        )
      );
      setActionMessage({ type: 'success', text: stageTag ? '已标记阶段标签。' : '已清除阶段标签。' });
    } catch (stageError) {
      setActionMessage({ type: 'error', text: stageError.message });
    }
  }
  async function handleRefreshAll() {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    setActionMessage(null);
    try {
      await Promise.all([
        refreshTaskList(),
        detailDialogTaskId ? loadDetailDialogData(detailDialogTaskId) : Promise.resolve()
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
      setDetailDialogTaskId((previousTaskId) => (previousTaskId === taskEntry.id ? null : previousTaskId));
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
        const ignoredCopySummaryText = buildRestoreIgnoredCopyText(restoredWorktreeList);
        setActionMessage({
          type: 'success',
          text: `恢复完成：重建 ${restoredWorktreeList.length} 个 worktree${branchSummaryText ? ` — ${branchSummaryText}` : ''}；${dependencySummaryText}${ignoredCopySummaryText ? `；${ignoredCopySummaryText}` : ''}${skippedCount ? `（${skippedCount} 个此前已恢复）` : ''}工作区文件已重新生成。`
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

  /**
   * 独立安装任务落终态：解除「安装中」标记并刷新依赖状态（无需手动刷新）；
   * 桌面端（Electron 壳注入）另发系统原生通知，浏览器模式无此桥接自动跳过。
   */
  function handleIndependentInstallFinished(taskEntry, projectIndex, projectEntry, finishStatus) {
    setKeyFlag(setInstallRunningKeyMap, `${taskEntry.id}:${projectIndex}`, false);
    refreshDependencyCheck(taskEntry.id);
    if (window.desktopBridge && typeof window.desktopBridge.notify === 'function') {
      const installSucceeded = finishStatus === 'success';
      window.desktopBridge.notify(
        installSucceeded ? '依赖安装完成' : '依赖安装失败',
        `${projectEntry.projectName}：${installSucceeded ? '可回到明细查看依赖状态' : '请在日志中排查失败原因'}`
      );
    }
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
      setDetailDialogTaskId((previousTaskId) => (previousTaskId === taskEntry.id ? null : previousTaskId));
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
      <div className="status-tab-row">
          <button
            type="button"
            className={activeStatusTab === 'unpublished' ? 'status-tab status-tab-active' : 'status-tab'}
            onClick={() => { setActiveStatusTab('unpublished'); setCurrentPage(1); }}
          >
            未发布
          </button>
          <button
            type="button"
            className={activeStatusTab === 'published' ? 'status-tab status-tab-active' : 'status-tab'}
            onClick={() => { setActiveStatusTab('published'); setCurrentPage(1); }}
          >
            已发布
          </button>
          <div className="status-tab-actions">
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
          <button
            type="button"
            className={
              hasActiveTimeFilter(timeFilterApplied)
                ? 'button-secondary filter-toggle-button filter-toggle-active'
                : 'button-secondary filter-toggle-button'
            }
            onClick={() => setFilterPanelExpanded((previousExpanded) => !previousExpanded)}
          >
            {filterPanelExpanded ? '收起筛选' : '筛选'}
          </button>
          </div>
        </div>

      {filterPanelExpanded ? (
        <div className="list-filter-row">
          <label className="filter-field">
            <span className="filter-label">时间字段</span>
            <select
              className="form-input filter-control"
              value={timeFilterDraft.timeField}
              onChange={(changeEvent) => handleTimeFilterDraftChange('timeField', changeEvent.target.value)}
            >
              <option value="createdAt">创建时间</option>
              <option value="updatedAt">更新时间</option>
            </select>
          </label>
          <label className="filter-field">
            <span className="filter-label">快捷月份</span>
            <input
              type="month"
              className="form-input filter-control"
              value={quickMonthText}
              onChange={(changeEvent) => handleQuickMonthChange(changeEvent.target.value)}
            />
          </label>
          <label className="filter-field">
            <span className="filter-label">开始日期</span>
            <input
              type="date"
              className="form-input filter-control"
              value={timeFilterDraft.startDate}
              onChange={(changeEvent) => handleTimeFilterDraftChange('startDate', changeEvent.target.value)}
            />
          </label>
          <label className="filter-field">
            <span className="filter-label">结束日期</span>
            <input
              type="date"
              className="form-input filter-control"
              value={timeFilterDraft.endDate}
              onChange={(changeEvent) => handleTimeFilterDraftChange('endDate', changeEvent.target.value)}
            />
          </label>
          <button type="button" className="button-primary" onClick={handleApplyTimeFilter}>
            查询
          </button>
          <button type="button" className="button-secondary" onClick={handleResetTimeFilter}>
            重置
          </button>
        </div>
      ) : hasActiveTimeFilter(timeFilterApplied) ? (
        <div className="filter-collapsed-hint">
          当前筛选：{describeTimeFilter(timeFilterApplied)}
          <button type="button" className="text-link-button" onClick={handleResetTimeFilter}>
            清除
          </button>
        </div>
      ) : null}

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
        <div className="table-scroll">
        <table className="record-table">
          <thead>
            <tr>
              <th>需求链接</th>
              <th>开发分支</th>
              <th>项目数</th>
              <th>时间（更新/创建）</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {taskList.map((taskEntry) => (
              <React.Fragment key={taskEntry.id}>
                <tr className={taskEntry.deletedAt ? 'requirement-deleted-row' : ''}>
                  <td className="requirement-link-cell">
                    <div className="requirement-name-row">
                      <a href={taskEntry.requirementUrl} target="_blank" rel="noreferrer">
                        {taskEntry.requirementName || taskEntry.requirementUrl}
                      </a>
                      <button
                        type="button"
                        className="button-secondary copy-text-button"
                        title="复制需求名称"
                        onClick={() =>
                          handleCopyText(taskEntry.requirementName || taskEntry.requirementUrl, '需求名称')
                        }
                      >
                        复制
                      </button>
                    </div>
                    {taskEntry.deletedAt ? <span className="badge-status badge-occupied">已删除</span> : null}
                    {taskEntry.publishedAt ? <span className="badge-status badge-main">已发布</span> : null}
                  </td>
                  <td>
                    <div className="branch-name-cell">
                      <span className="branch-name-text">{taskEntry.branchName}</span>
                      <button
                        type="button"
                        className="button-secondary copy-text-button"
                        title="复制分支名"
                        onClick={() => handleCopyText(taskEntry.branchName, '分支名')}
                      >
                        复制
                      </button>
                    </div>
                  </td>
                  <td>{taskEntry.projectList.length}</td>
                  <td className="time-cell">
                    <div className="time-line">
                      <span className="time-label">更新</span>
                      <span className="time-value">{formatTimeText(taskEntry.updatedAt)}</span>
                    </div>
                    <div className="time-line">
                      <span className="time-label">创建</span>
                      <span className="time-value">{formatTimeText(taskEntry.createdAt)}</span>
                    </div>
                  </td>
                  <td>
                    <div className="cell-actions">
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => handleOpenDetailDialog(taskEntry)}
                      >
                        查看
                      </button>
                      {taskEntry.deletedAt ? (
                        <RowActionsMore>
                            <button
                              type="button"
                              className="actions-dropdown-item"
                              disabled={restorePending.isPending(`restore:${taskEntry.id}`)}
                              onClick={() => handleRestore(taskEntry)}
                            >
                              {restorePending.isPending(`restore:${taskEntry.id}`) ? '恢复中...' : '恢复'}
                            </button>
                            <button
                              type="button"
                              className="actions-dropdown-item dropdown-item-danger"
                              onClick={() => {
                                setConfirmPermanentTask(taskEntry);
                                setPermanentForceChecked(false);
                                setPermanentFailedMessage(null);
                              }}
                            >
                              彻底删除
                            </button>
                        </RowActionsMore>
                      ) : (
                        <RowActionsMore>
                            <button
                              type="button"
                              className="actions-dropdown-item"
                              onClick={() => { setFormState({ mode: 'edit', record: taskEntry }); setActionMessage(null); }}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="actions-dropdown-item dropdown-item-danger"
                              onClick={() => {
                                setConfirmDeleteTask(taskEntry);
                                setDeleteForceChecked(false);
                                setDeleteFailedMessage(null);
                              }}
                            >
                              删除
                            </button>
                        </RowActionsMore>
                      )}</div>
                  </td>
                </tr>
                <TaskActionsRow
                  taskEntry={taskEntry}
                  activeStatusTab={activeStatusTab}
                  canMoveUp={taskList.findIndex((taskEntryItem) => taskEntryItem.id === taskEntry.id) > 0}
                  canMoveDown={
                    taskList.findIndex((taskEntryItem) => taskEntryItem.id === taskEntry.id) < taskList.length - 1
                  }
                  publishPending={publishPendingId === taskEntry.id}
                  onMoveUp={() => handleMoveTask(taskEntry, 'up')}
                  onMoveDown={() => handleMoveTask(taskEntry, 'down')}
                  onPublish={() => handleSetPublished(taskEntry, true)}
                  onUnpublish={() => handleSetPublished(taskEntry, false)}
                  onSetStage={(nextStageTag) => handleSetStage(taskEntry, nextStageTag)}
                />
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
              </React.Fragment>
            ))}
          </tbody>
        </table>
        </div>
      ) : null}

      {totalTasks > 0 ? (
        <div className="pagination-row">
          <span className="pagination-total">共 {totalTasks} 条</span>
          <button
            type="button"
            className="button-secondary"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage(currentPage - 1)}
          >
            上一页
          </button>
          <span className="pagination-page">第 {currentPage} 页</span>
          <button
            type="button"
            className="button-secondary"
            disabled={currentPage * pageSize >= totalTasks}
            onClick={() => setCurrentPage(currentPage + 1)}
          >
            下一页
          </button>
        </div>
      ) : null}

      {detailDialogTaskEntry ? (
        <RequirementTaskDetailDialog
          requirementTask={detailDialogTaskEntry}
          locateTaskResponse={locateDataMap[detailDialogTaskEntry.id]}
          dependencyTaskResponse={dependencyDataMap[detailDialogTaskEntry.id]}
          conflictProjectKeySet={conflictProjectKeySet}
          installJobEntryMap={installJobMap}
          installRunningKeyMap={installRunningKeyMap}
          sharedRestoreKeyMap={sharedRestoreKeyMap}
          pathActionPending={pathActionPending}
          workspaceRegenerationPending={workspaceRegenPending}
          onClose={handleCloseDetailDialog}
          onOpenDirectory={handleOpenWorktree}
          onRevealPath={handleRevealPath}
          onRegenerateWorkspace={handleRegenerateWorkspace}
          onRestoreShared={(projectIndex, projectEntry) =>
            handleRestoreShared(detailDialogTaskEntry, projectIndex, projectEntry)
          }
          onRequestIndependentInstall={(projectIndex, projectEntry) =>
            setInstallDialogState({ taskEntry: detailDialogTaskEntry, projectIndex, projectEntry })
          }
          onInstallFinished={(projectIndex, projectEntry, finishStatus) =>
            handleIndependentInstallFinished(detailDialogTaskEntry, projectIndex, projectEntry, finishStatus)
          }
        />
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
