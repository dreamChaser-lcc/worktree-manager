import React from 'react';
import { SearchableSelect } from './SearchableSelect.jsx';

/**
 * 最近主仓库快捷切换条：数据来自服务端使用记录（LRU-10），
 * 选中即通过 onRepoPathChange 全局切换（创建页与管理页共享）。
 * 下拉支持输入筛选（SearchableSelect）。
 */
export function RecentRepoBar({ repoPath, recentRepoList, onRepoPathChange }) {
  if (!recentRepoList || recentRepoList.length === 0) {
    return null;
  }
  const isCurrentPathInList = recentRepoList.some((repoEntry) => repoEntry.repoPath === repoPath);

  return (
    <div className="recent-repo-bar">
      <label className="form-label">最近主仓库</label>
      <SearchableSelect
        value={isCurrentPathInList ? repoPath : ''}
        onChange={(selectedPath) => {
          if (selectedPath) {
            onRepoPathChange(selectedPath);
          }
        }}
        placeholder="切换到历史主仓库..."
        filterPlaceholder="输入筛选仓库路径..."
        emptyText="无匹配仓库"
        options={recentRepoList.map((repoEntry) => ({
          value: repoEntry.repoPath,
          label: repoEntry.repoPath
        }))}
      />
    </div>
  );
}
