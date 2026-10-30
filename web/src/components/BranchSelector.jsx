import React, { useEffect, useState } from 'react';
import { fetchBranchOverview } from '../api/client.js';

/**
 * 分支选择区：已有分支（下拉，被占用分支禁选并标注）/
 * 新建分支（输入名 + 起点 ref，默认 HEAD）两种模式。
 * 同时返回包管理器检测结果与依赖策略推荐，由父组件转交给依赖区。
 */
export function BranchSelector({
  repoPath,
  branchMode,
  branchName,
  baseRef,
  onBranchModeChange,
  onBranchNameChange,
  onBaseRefChange,
  onOverviewLoaded
}) {
  const [branchItemList, setBranchItemList] = useState([]);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!repoPath) {
      setBranchItemList([]);
      return;
    }
    fetchBranchOverview(repoPath)
      .then((overviewData) => {
        setBranchItemList(overviewData.branches);
        setLoadError(null);
        if (onOverviewLoaded) {
          onOverviewLoaded({
            packageManager: overviewData.packageManager,
            recommendedStrategy: overviewData.recommendedStrategy
          });
        }
      })
      .catch((error) => setLoadError(error.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  return (
    <div className="form-row">
      <label className="form-label">分支</label>
      <div className="branch-mode-row">
        <label className="radio-label">
          <input
            type="radio"
            name="branchMode"
            checked={branchMode === 'existing'}
            onChange={() => onBranchModeChange('existing')}
          />
          已有分支
        </label>
        <label className="radio-label">
          <input
            type="radio"
            name="branchMode"
            checked={branchMode === 'new'}
            onChange={() => onBranchModeChange('new')}
          />
          新建分支
        </label>
      </div>

      {branchMode === 'existing' ? (
        <div>
          <select
            className="form-input"
            value={branchName}
            onChange={(changeEvent) => onBranchNameChange(changeEvent.target.value)}
          >
            <option value="">请选择分支</option>
            {branchItemList.map((branchItem) => (
              <option key={branchItem.name} value={branchItem.name} disabled={Boolean(branchItem.occupiedBy)}>
                {branchItem.name}
                {branchItem.occupiedBy ? `（已被占用: ${branchItem.occupiedBy}）` : ''}
              </option>
            ))}
          </select>
          <div className="form-hint">被其他 worktree 签出的分支已标注且不可选（git 限制：同一分支不能同时签出）</div>
        </div>
      ) : (
        <div>
          <input
            className="form-input"
            type="text"
            placeholder="新分支名，如 feature/my-task"
            value={branchName}
            onChange={(changeEvent) => onBranchNameChange(changeEvent.target.value)}
          />
          <input
            className="form-input base-ref-input"
            type="text"
            placeholder="起点 ref（留空 = 当前 HEAD）"
            value={baseRef}
            onChange={(changeEvent) => onBaseRefChange(changeEvent.target.value)}
          />
        </div>
      )}

      {loadError ? <div className="alert-error">{loadError}</div> : null}
    </div>
  );
}
