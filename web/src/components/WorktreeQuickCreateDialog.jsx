import React, { useEffect, useState } from 'react';
import { DirectoryPicker } from './DirectoryPicker.jsx';
import { BranchSelector } from './BranchSelector.jsx';
import { DependencyStrategySection } from './DependencyStrategySection.jsx';
import { createWorktree, fetchDefaultBaseRef } from '../api/client.js';

/**
 * 需求任务表单内的 worktree 快捷创建弹层：
 * 复用分支选择（含占用标注/新建分支）与依赖策略区，创建成功后把新 worktree 路径回填给项目行。
 */
export function WorktreeQuickCreateDialog({
  repoPath,
  defaultBranchName,
  projectDirectory,
  requirementDirectory,
  suggestSubdirectoryName,
  onCreated,
  onClose
}) {
  // 目标路径直接按 <需求聚合目录>\<项目名> 预填（目录在点击"创建"时才生成），可修改
  const [targetPath, setTargetPath] = useState(() => {
    if (!requirementDirectory || !suggestSubdirectoryName) {
      return '';
    }
    return `${requirementDirectory.replace(/[\\/]+$/, '')}\\${suggestSubdirectoryName}`;
  });
  const [branchMode, setBranchMode] = useState('new');
  const [branchName, setBranchName] = useState(defaultBranchName || '');
  const [baseRef, setBaseRef] = useState('');
  const [packageManager, setPackageManager] = useState(undefined);
  const [recommendedStrategy, setRecommendedStrategy] = useState(null);
  const [strategy, setStrategy] = useState('share');
  const [shouldCopyIgnoredFiles, setShouldCopyIgnoredFiles] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState(null);

  // 重新打开时重置浏览状态：DirectoryPicker 以 key 重建实现
  const [dialogKey] = useState(() => `quick-create-${Date.now()}`);

  // 新建分支默认从远程最新分支创建（origin/HEAD → origin/master|main），可修改
  useEffect(() => {
    if (!repoPath) {
      return;
    }
    fetchDefaultBaseRef(repoPath)
      .then((baseData) => {
        if (baseData.baseRef) {
          setBaseRef(baseData.baseRef);
        }
      })
      .catch(() => {});
  }, [repoPath]);

  const repositoryReady = Boolean(repoPath);
  const canSubmit = repositoryReady && Boolean(targetPath) && Boolean(branchName) && !submitting;

  function handleBranchOverviewLoaded(overviewData) {
    setPackageManager(overviewData.packageManager);
    setRecommendedStrategy(overviewData.recommendedStrategy);
    // 默认独立安装：目录链接共享在部分 Windows 环境（安全更新后）普通权限无法遍历，
    // 共享需要系统权限支持，用户可在此弹窗手动切换
    setStrategy('install');
  }

  async function handleCreateSubmit() {
    setSubmitting(true);
    setCreateError(null);
    try {
      const responseData = await createWorktree({
        repoPath,
        targetPath,
        branchMode,
        branchName,
        baseRef: baseRef || undefined,
        dependencyStrategy: strategy,
        copyIgnoredFiles: shouldCopyIgnoredFiles
      });
      onCreated(responseData.worktree.path, responseData);
    } catch (submitError) {
      setCreateError(submitError.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-dialog quick-create-dialog" onClick={(clickEvent) => clickEvent.stopPropagation()}>
        <div className="picker-toolbar">
          <span className="picker-current-path" title={repoPath}>为项目创建 worktree（主仓库: {repoPath}）</span>
          <button type="button" className="button-secondary" onClick={onClose}>关闭</button>
        </div>

        {createError ? <div className="alert-error">{createError}</div> : null}
        {!repositoryReady ? <div className="alert-error">该项目尚未选择主仓库路径</div> : null}

        {repositoryReady ? (
          <div className="quick-create-body">
            <BranchSelector
              repoPath={repoPath}
              branchMode={branchMode}
              branchName={branchName}
              baseRef={baseRef}
              onBranchModeChange={(selectedMode) => {
                setBranchMode(selectedMode);
                setBranchName(selectedMode === 'new' ? defaultBranchName || '' : '');
              }}
              onBranchNameChange={setBranchName}
              onBaseRefChange={setBaseRef}
              onOverviewLoaded={handleBranchOverviewLoaded}
            />

            <DirectoryPicker
              key={dialogKey}
              label="新 worktree 路径"
              value={targetPath}
              onChange={setTargetPath}
              hintText={
                requirementDirectory
                  ? '已按需求聚合目录预填完整路径（目录在点击创建时才生成），可修改或点浏览调整'
                  : '默认定位到代码默认存储目录；可追加一个尚未存在的子目录名'
              }
              allowNewSubdirectory
              initialPath={requirementDirectory || projectDirectory}
              suggestSubdirectoryName={suggestSubdirectoryName}
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
                复制被忽略文件与目录（.env、.env.local、*.local、.husky）
              </label>
            </div>

            <div className="picker-footer">
              <button type="button" className="button-secondary" onClick={onClose}>取消</button>
              <button type="button" className="button-primary" disabled={!canSubmit} onClick={handleCreateSubmit}>
                {submitting ? '创建中...' : '创建 worktree'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
