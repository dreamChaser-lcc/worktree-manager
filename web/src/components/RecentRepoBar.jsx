import React from 'react';

/**
 * 最近主仓库快捷切换条：数据来自服务端使用记录（LRU-10），
 * 选中即通过 onRepoPathChange 全局切换（创建页与管理页共享）。
 */
export function RecentRepoBar({ repoPath, recentRepoList, onRepoPathChange }) {
  if (!recentRepoList || recentRepoList.length === 0) {
    return null;
  }
  const isCurrentPathInList = recentRepoList.some((repoEntry) => repoEntry.repoPath === repoPath);

  function handleSelect(changeEvent) {
    const selectedPath = changeEvent.target.value;
    if (selectedPath) {
      onRepoPathChange(selectedPath);
    }
  }

  return (
    <div className="recent-repo-bar">
      <label className="form-label" htmlFor="recent-repo-select">最近主仓库</label>
      <select
        id="recent-repo-select"
        className="form-input recent-repo-select"
        value={isCurrentPathInList ? repoPath : ''}
        onChange={handleSelect}
      >
        <option value="">切换到历史主仓库...</option>
        {recentRepoList.map((repoEntry) => (
          <option key={repoEntry.repoPath} value={repoEntry.repoPath}>
            {repoEntry.repoPath}
          </option>
        ))}
      </select>
    </div>
  );
}
