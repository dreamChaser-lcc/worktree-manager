import React, { useEffect, useState } from 'react';
import { SearchableSelect } from './SearchableSelect.jsx';
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
  const [remoteBranchItemList, setRemoteBranchItemList] = useState([]);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!repoPath) {
      setBranchItemList([]);
      setRemoteBranchItemList([]);
      return;
    }
    fetchBranchOverview(repoPath)
      .then((overviewData) => {
        setBranchItemList(overviewData.branches);
        setRemoteBranchItemList(overviewData.remoteBranches || []);
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
          <SearchableSelect
            value={branchName}
            onChange={onBranchNameChange}
            placeholder="请选择分支"
            filterPlaceholder="输入筛选分支..."
            emptyText="无匹配分支"
            options={[
              ...branchItemList.map((branchItem) => ({
                value: branchItem.name,
                label: branchItem.occupiedBy
                  ? `${branchItem.name}（已被占用: ${branchItem.occupiedBy}）`
                  : branchItem.name,
                disabled: Boolean(branchItem.occupiedBy),
                group: '本地分支'
              })),
              ...remoteBranchItemList
                .map((remoteBranchName) => {
                  const localEquivalent = remoteBranchName.replace(/^[^/]+\//, '');
                  const occupiedBranch = branchItemList.find(
                    (branchItem) => branchItem.name === localEquivalent && branchItem.occupiedBy
                  );
                  return {
                    value: remoteBranchName,
                    label: occupiedBranch
                      ? `${remoteBranchName}（已被占用: ${occupiedBranch.occupiedBy}）`
                      : `${remoteBranchName}（远程，本地没有）`,
                    disabled: Boolean(occupiedBranch),
                    group: '远程分支（本地没有的）'
                  };
                })
                .filter(
                  (remoteOption) =>
                    !branchItemList.some(
                      (branchItem) => branchItem.name === remoteOption.value.replace(/^[^/]+\//, '')
                    )
                )
            ]}
          />
          <div className="form-hint">被其他 worktree 签出的分支已标注且不可选（git 限制：同一分支不能同时签出）；远程分支可直接选择，创建时自动建同名本地分支并跟踪远程，无需先在主目录 pull</div>
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
          <div className="base-ref-block">
            <label className="form-label">起点分支（新分支基于它创建）</label>
            <SearchableSelect
              value={
                remoteBranchItemList.includes(baseRef) ||
                branchItemList.some((branchItem) => branchItem.name === baseRef)
                  ? baseRef
                  : ''
              }
              onChange={onBaseRefChange}
              placeholder="请选择起点分支（或在下方的输入框手动填写 ref）"
              filterPlaceholder="输入筛选起点分支..."
              emptyText="无匹配分支"
              options={[
                ...remoteBranchItemList.map((remoteBranchName) => ({
                  value: remoteBranchName,
                  label: remoteBranchName,
                  group: '远程分支（最新代码）'
                })),
                ...branchItemList.map((branchItem) => ({
                  value: branchItem.name,
                  label: branchItem.occupiedBy
                    ? `${branchItem.name}（已被占用: ${branchItem.occupiedBy}）`
                    : branchItem.name,
                  group: '本地分支'
                }))
              ]}
            />
            <input
              className="form-input base-ref-input"
              type="text"
              placeholder="起点 ref（已默认远程最新分支，可下拉选择或手动输入；留空 = 当前 HEAD）"
              value={baseRef}
              onChange={(changeEvent) => onBaseRefChange(changeEvent.target.value)}
            />
          </div>
        </div>
      )}

      {loadError ? <div className="alert-error">{loadError}</div> : null}
    </div>
  );
}
