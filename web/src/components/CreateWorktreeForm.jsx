import React, { useEffect, useState } from 'react';
import { DirectoryPicker } from './DirectoryPicker.jsx';
import { BranchSelector } from './BranchSelector.jsx';
import { DependencyStrategySection } from './DependencyStrategySection.jsx';
import { TaskLogPanel } from './TaskLogPanel.jsx';
import { createWorktree, fetchRepositoryCheck } from '../api/client.js';

/** 创建 Worktree 表单：目录选择 → 分支 → 依赖策略 → 可选后置动作 */
export function CreateWorktreeForm() {
  const [repoPath, setRepoPath] = useState('');
  const [repoCheckResult, setRepoCheckResult] = useState(null);
  const [targetPath, setTargetPath] = useState('');
  const [branchMode, setBranchMode] = useState('existing');
  const [branchName, setBranchName] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [packageManager, setPackageManager] = useState(undefined); // undefined=未检测 null=无 lockfile
  const [recommendedStrategy, setRecommendedStrategy] = useState(null);
  const [strategy, setStrategy] = useState('skip');
  const [shouldCopyIgnoredFiles, setShouldCopyIgnoredFiles] = useState(true);
  const [shouldOpenInEditor, setShouldOpenInEditor] = useState(false);
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
    // 有推荐则跟随推荐，无推荐保持 skip
    setStrategy(overviewData.recommendedStrategy || 'skip');
  }

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
        openInEditor: shouldOpenInEditor
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

  return (
    <div>
      <DirectoryPicker
        label="主仓库目录"
        value={repoPath}
        onChange={(selectedPath) => {
          setRepoPath(selectedPath);
          resetResult();
        }}
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
        hintText="建议放主仓库同级目录；可在选择目录时追加一个尚未存在的子目录名"
        allowNewSubdirectory
      />

      <BranchSelector
        repoPath={repoPath}
        branchMode={branchMode}
        branchName={branchName}
        baseRef={baseRef}
        onBranchModeChange={(selectedMode) => {
          setBranchMode(selectedMode);
          setBranchName('');
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
