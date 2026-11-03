import React, { useEffect, useState } from 'react';
import { SearchableSelect } from './SearchableSelect.jsx';
import { DirectoryPicker } from './DirectoryPicker.jsx';
import { RecentRepoBar } from './RecentRepoBar.jsx';
import { BranchSelector } from './BranchSelector.jsx';
import { DependencyStrategySection } from './DependencyStrategySection.jsx';
import { TaskLogPanel } from './TaskLogPanel.jsx';
import { buildRequirementDirectoryPath, deriveProjectNameFromPath } from './RequirementTaskForm.jsx';
import { createWorktree, fetchRepositoryCheck, fetchRequirementTaskList, fetchDefaultBaseRef } from '../api/client.js';

/** 创建 Worktree 表单：目录选择 → 分支 → 依赖策略 → 可选后置动作；主仓库目录由应用层共享 */
export function CreateWorktreeForm({
  repoPath,
  onRepoPathChange,
  recentRepoList,
  initialBrowsePath,
  workspaceDirectory,
  workspaceLayoutEnabled
}) {
  const [repoCheckResult, setRepoCheckResult] = useState(null);
  const [targetPath, setTargetPath] = useState('');
  const [branchMode, setBranchMode] = useState('existing');
  const [branchName, setBranchName] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [packageManager, setPackageManager] = useState(undefined); // undefined=未检测 null=无 lockfile
  const [recommendedStrategy, setRecommendedStrategy] = useState(null);
  const [strategy, setStrategy] = useState('share');
  const [shouldCopyIgnoredFiles, setShouldCopyIgnoredFiles] = useState(true);
  const [shouldOpenInEditor, setShouldOpenInEditor] = useState(false);
  const [requirementTaskList, setRequirementTaskList] = useState([]);
  const [requirementTaskId, setRequirementTaskId] = useState('');
  // 新建分支的默认起点（远程最新分支，如 origin/master）
  const [defaultBaseRef, setDefaultBaseRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createResult, setCreateResult] = useState(null);
  const [createError, setCreateError] = useState(null);

  // 主目录变化 → 实时校验 git 仓库并重置分支/推荐状态
  useEffect(() => {
    setRepoCheckResult(null);
    setPackageManager(undefined);
    setRecommendedStrategy(null);
    setBranchName('');
    if (!repoPath) {
      return;
    }
    fetchRepositoryCheck(repoPath)
      .then((checkData) => setRepoCheckResult(checkData))
      .catch((checkError) => setRepoCheckResult({ isGitRepository: false, checkError: checkError.message }));
  }, [repoPath]);

  function handleBranchOverviewLoaded(overviewData) {
    setPackageManager(overviewData.packageManager);
    setRecommendedStrategy(overviewData.recommendedStrategy);
    // 默认共享主目录（推荐标识仅作参考展示）
    setStrategy('share');
  }

  // 需求任务下拉数据：本组件随页签挂载，加载一次即可
  useEffect(() => {
    fetchRequirementTaskList()
      .then((listData) => setRequirementTaskList(listData.tasks || []))
      .catch(() => setRequirementTaskList([]));
  }, []);

  // 主仓库变化 → 取新建分支默认起点（远程最新分支）
  useEffect(() => {
    setDefaultBaseRef('');
    if (!repoPath) {
      return;
    }
    fetchDefaultBaseRef(repoPath)
      .then((baseData) => setDefaultBaseRef(baseData.baseRef || ''))
      .catch(() => setDefaultBaseRef(''));
  }, [repoPath]);

  function resetResult() {
    setCreateResult(null);
    setCreateError(null);
  }

  async function handleCreateSubmit() {
    setSubmitting(true);
    resetResult();
    try {
      const responseData = await createWorktree({
        repoPath,
        targetPath,
        branchMode,
        branchName,
        baseRef: baseRef || undefined,
        dependencyStrategy: strategy,
        copyIgnoredFiles: shouldCopyIgnoredFiles,
        openInEditor: shouldOpenInEditor,
        requirementTaskId: requirementTaskId || undefined
      });
      setCreateResult(responseData);
    } catch (submitError) {
      setCreateError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  }

  const repositoryValid = Boolean(repoCheckResult && repoCheckResult.isGitRepository);
  const canSubmit = repositoryValid && Boolean(targetPath) && Boolean(branchName) && !submitting;

  // 关联需求且开启聚合目录模式时，目标路径默认定位到 <工作区目录>\<需求名称>，子目录按项目名预填
  const selectedRequirementTask = requirementTaskId
    ? requirementTaskList.find((taskEntry) => taskEntry.id === requirementTaskId)
    : null;
  const targetRequirementDirectory =
    requirementTaskId && workspaceLayoutEnabled && selectedRequirementTask
      ? buildRequirementDirectoryPath(
          workspaceDirectory,
          selectedRequirementTask.requirementName || selectedRequirementTask.branchName
        )
      : '';
  const targetSuggestSubdirectoryName =
    requirementTaskId && repoPath ? deriveProjectNameFromPath(repoPath) : undefined;

  return (
    <div>
      <RecentRepoBar repoPath={repoPath} recentRepoList={recentRepoList} onRepoPathChange={(selectedPath) => {
        onRepoPathChange(selectedPath);
        resetResult();
      }} />
      <DirectoryPicker
        label="主仓库目录"
        value={repoPath}
        onChange={(selectedPath) => {
          onRepoPathChange(selectedPath);
          resetResult();
        }}
        initialPath={initialBrowsePath}
      />
      {repoPath && repoCheckResult ? (
        repositoryValid ? (
          <div className="alert-success">已识别 git 仓库（当前分支: {repoCheckResult.currentBranch || '未知'}）</div>
        ) : (
          <div className="alert-error">该目录不是有效 git 仓库{repoCheckResult.checkError ? `：${repoCheckResult.checkError}` : ''}</div>
        )
      ) : null}

      <DirectoryPicker
        label="新 worktree 路径"
        value={targetPath}
        onChange={setTargetPath}
        hintText={
          targetRequirementDirectory
            ? '已定位到需求聚合目录；子目录名已按项目名预填，可修改'
            : '建议放主仓库同级目录；可在选择目录时追加一个尚未存在的子目录名'
        }
        allowNewSubdirectory
        initialPath={targetRequirementDirectory || initialBrowsePath}
        suggestSubdirectoryName={targetSuggestSubdirectoryName}
      />

      <BranchSelector
        repoPath={repoPath}
        branchMode={branchMode}
        branchName={branchName}
        baseRef={baseRef}
        onBranchModeChange={(selectedMode) => {
          setBranchMode(selectedMode);
          // 切到新建分支时重新填名称并预填远程默认起点；切到已有分支保留当前分支名（不用重新选）
          if (selectedMode === 'new') {
            setBranchName('');
            setBaseRef(defaultBaseRef || '');
          } else {
            setBaseRef('');
          }
        }}
        onBranchNameChange={setBranchName}
        onBaseRefChange={setBaseRef}
        onOverviewLoaded={handleBranchOverviewLoaded}
      />

      <DependencyStrategySection
        packageManager={packageManager}
        recommendedStrategy={recommendedStrategy}
        strategy={strategy}
        onStrategyChange={setStrategy}
      />

      {requirementTaskList.length > 0 ? (
        <div className="form-row">
          <label className="form-label">关联需求任务（可选）</label>
          <SearchableSelect
            value={requirementTaskId}
            onChange={(selectedTaskId) => {
              setRequirementTaskId(selectedTaskId);
              // 选择需求任务后自动带入其开发分支（已有分支模式下直接回填选中）
              const matchedTask = requirementTaskList.find((taskEntry) => taskEntry.id === selectedTaskId);
              if (matchedTask && matchedTask.branchName) {
                setBranchName(matchedTask.branchName);
              }
            }}
            placeholder="不关联"
            filterPlaceholder="输入筛选分支或需求链接..."
            emptyText="无匹配需求任务"
            options={[
              { value: '', label: '不关联' },
              ...requirementTaskList.map((taskEntry) => ({
                value: taskEntry.id,
                label: `${taskEntry.branchName} — ${taskEntry.requirementUrl}`
              }))
            ]}
          />
          <div className="form-hint">创建成功后自动把新 worktree 挂到需求中主仓库匹配的项目条目</div>
        </div>
      ) : null}

      <div className="form-row">
        <label className="form-label">创建后动作（可选）</label>
        <label className="radio-label">
          <input
            type="checkbox"
            checked={shouldCopyIgnoredFiles}
            onChange={(changeEvent) => setShouldCopyIgnoredFiles(changeEvent.target.checked)}
          />
          复制被忽略文件（.env、.env.local、*.local）
        </label>
        <label className="radio-label">
          <input
            type="checkbox"
            checked={shouldOpenInEditor}
            onChange={(changeEvent) => setShouldOpenInEditor(changeEvent.target.checked)}
          />
          创建成功后用编辑器打开（默认 VS Code）
        </label>
      </div>

      <button type="button" className="button-primary" disabled={!canSubmit} onClick={handleCreateSubmit}>
        {submitting ? '创建中...' : '创建 Worktree'}
      </button>

      {createError ? <div className="alert-error">{createError}</div> : null}

      {createResult ? (
        <div className="result-panel">
          <div className="alert-success">
            创建成功：{createResult.worktree.path}（分支 {createResult.worktree.branch}）
          </div>
          {createResult.dependencyResult.status === 'linked' ? (
            <div className="alert-success">依赖已共享自主目录（junction）</div>
          ) : null}
          {createResult.dependencyResult.status === 'failed' ? (
            <div className="alert-warning">依赖处理失败：{createResult.dependencyResult.message}</div>
          ) : null}
          {createResult.requirementTaskAttach ? (
            createResult.requirementTaskAttach.attached ? (
              <div className="alert-success">{createResult.requirementTaskAttach.message}</div>
            ) : (
              <div className="alert-warning">需求任务关联未完成：{createResult.requirementTaskAttach.message}</div>
            )
          ) : null}
          {createResult.ignoreFileCopyResult && !createResult.ignoreFileCopyResult.skipped ? (
            <div className="alert-success">
              已复制忽略文件：{createResult.ignoreFileCopyResult.copiedFiles.join('、') || '（白名单无命中）'}
            </div>
          ) : null}
          {createResult.warnings && createResult.warnings.length > 0 ? (
            <div className="alert-warning">{createResult.warnings.join('\n')}</div>
          ) : null}
          <TaskLogPanel jobId={createResult.installJobId} title="依赖安装任务" />
        </div>
      ) : null}
    </div>
  );
}
