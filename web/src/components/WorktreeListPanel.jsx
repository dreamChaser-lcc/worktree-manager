import React, { useEffect, useState } from 'react';
import { DirectoryPicker } from './DirectoryPicker.jsx';
import {
  fetchWorktreeList,
  removeWorktree,
  pruneWorktreeRecords,
  fetchRepositoryCheck,
  openDirectoryInEditor
} from '../api/client.js';

/** Worktree 管理面板：列表展示、删除（安全拦截）、prune、打开编辑器 */
export function WorktreeListPanel() {
  const [repoPath, setRepoPath] = useState('');
  const [repositoryValid, setRepositoryValid] = useState(false);
  const [worktreeList, setWorktreeList] = useState([]);
  const [listError, setListError] = useState(null);
  const [actionMessage, setActionMessage] = useState(null);
  // 删除拦截弹层状态：null=关闭；否则携带未提交文件与未合并数量
  const [deleteConfirmState, setDeleteConfirmState] = useState(null);
  // 同时删除磁盘目录（安全模式默认开启：链接只断开，不删共享依赖内容）
  const [deleteDirectoryChoice, setDeleteDirectoryChoice] = useState(true);

  useEffect(() => {
    setRepositoryValid(false);
    setWorktreeList([]);
    if (!repoPath) {
      return;
    }
    fetchRepositoryCheck(repoPath)
      .then((checkData) => setRepositoryValid(checkData.isGitRepository))
      .catch(() => setRepositoryValid(false));
  }, [repoPath]);

  async function refreshWorktreeList() {
    try {
      const listData = await fetchWorktreeList(repoPath);
      setWorktreeList(listData.worktrees);
      setListError(null);
    } catch (refreshError) {
      setListError(refreshError.message);
    }
  }

  useEffect(() => {
    if (repositoryValid) {
      refreshWorktreeList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, repositoryValid]);

  async function handleDeleteClick(worktreeEntry) {
    setActionMessage(null);
    if (worktreeEntry.isDirty) {
      // 脏 worktree：先请求一次拿到拦截详情（未提交清单）再弹层确认
      try {
        await removeWorktree(repoPath, worktreeEntry.path, false, deleteDirectoryChoice);
        // 未被拦截（列表时点后已变干净）：已直接删除，刷新即可
        await refreshWorktreeList();
      } catch (blockedError) {
        if (blockedError.status === 409) {
          setDeleteConfirmState({
            worktreeEntry,
            uncommittedFiles: (blockedError.details && blockedError.details.uncommittedFiles) || [],
            unmergedCommitCount:
              blockedError.details && blockedError.details.unmergedCommitCount !== null
                ? blockedError.details.unmergedCommitCount
                : null
          });
        } else {
          setActionMessage({ type: 'error', text: blockedError.message });
        }
      }
      return;
    }

    // 干净 worktree：统一确认弹层
    setDeleteConfirmState({ worktreeEntry, uncommittedFiles: [], unmergedCommitCount: null });
  }

  async function performRemove(targetPath, force) {
    try {
      const removalResult = await removeWorktree(repoPath, targetPath, force, deleteDirectoryChoice);
      setActionMessage({
        type: 'success',
        text:
          removalResult.unmergedCommitCount !== null && removalResult.unmergedCommitCount > 0
            ? `已删除（目录已一并清理）。注意：分支仍有 ${removalResult.unmergedCommitCount} 个未合并提交。`
            : '已删除（目录已一并清理）。'
      });
    } catch (removeError) {
      setActionMessage({ type: 'error', text: removeError.message });
    }
    setDeleteConfirmState(null);
    await refreshWorktreeList();
  }

  async function handlePruneClick() {
    try {
      const pruneResult = await pruneWorktreeRecords(repoPath);
      setActionMessage({ type: 'success', text: `prune 完成，清理了 ${pruneResult.prunedCount} 条失效记录。` });
      await refreshWorktreeList();
    } catch (pruneError) {
      setActionMessage({ type: 'error', text: pruneError.message });
    }
  }

  async function handleOpenEditorClick(worktreeEntry) {
    try {
      await openDirectoryInEditor(worktreeEntry.path);
      setActionMessage({ type: 'success', text: '已请求编辑器打开该目录。' });
    } catch (editorError) {
      setActionMessage({ type: 'error', text: editorError.message });
    }
  }

  return (
    <div>
      <DirectoryPicker
        label="选择主仓库"
        value={repoPath}
        onChange={(selectedPath) => {
          setRepoPath(selectedPath);
          setActionMessage(null);
        }}
        hintText="选择后展示该仓库全部 worktree"
      />

      {repoPath && !repositoryValid ? <div className="alert-error">该目录不是有效 git 仓库</div> : null}
      {listError ? <div className="alert-error">{listError}</div> : null}
      {actionMessage ? (
        <div className={actionMessage.type === 'error' ? 'alert-error' : 'alert-success'}>{actionMessage.text}</div>
      ) : null}

      {repositoryValid ? (
        <div>
          <div className="list-toolbar">
            <button type="button" className="button-secondary" onClick={refreshWorktreeList}>
              刷新
            </button>
            <button type="button" className="button-secondary" onClick={handlePruneClick}>
              prune 清理失效记录
            </button>
          </div>

          <table className="worktree-table">
            <thead>
              <tr>
                <th>路径</th>
                <th>分支</th>
                <th>HEAD</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {worktreeList.map((worktreeEntry) => (
                <tr key={worktreeEntry.path}>
                  <td className="cell-path">{worktreeEntry.path}</td>
                  <td>{worktreeEntry.branch || '(detached)'}</td>
                  <td>{(worktreeEntry.head || '').slice(0, 7)}</td>
                  <td>
                    {worktreeEntry.isMain ? <span className="badge-main">主 worktree</span> : null}
                    {worktreeEntry.stale ? <span className="badge-dirty">目录已失效</span> : null}
                    {worktreeEntry.isDirty && !worktreeEntry.stale ? <span className="badge-dirty">有未提交修改</span> : null}
                    {!worktreeEntry.isMain && !worktreeEntry.isDirty && !worktreeEntry.stale ? <span className="badge-clean">干净</span> : null}
                  </td>
                  <td>
                    {!worktreeEntry.isMain ? (
                      <div className="cell-actions">
                        <button type="button" className="button-secondary" onClick={() => handleOpenEditorClick(worktreeEntry)}>
                          打开
                        </button>
                        <button type="button" className="button-danger" onClick={() => handleDeleteClick(worktreeEntry)}>
                          删除
                        </button>
                      </div>
                    ) : (
                      <span className="form-hint">不可删除</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {deleteConfirmState ? (
        <div className="picker-overlay" onClick={() => setDeleteConfirmState(null)}>
          <div className="picker-dialog" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <div className="form-label">删除确认</div>

            {deleteConfirmState.uncommittedFiles.length > 0 ? (
              <div className="alert-warning">
                该 worktree 存在 {deleteConfirmState.uncommittedFiles.length} 处未提交修改，强制删除将丢弃这些修改：
                <pre className="conflict-file-view">{deleteConfirmState.uncommittedFiles.join('\n')}</pre>
                {deleteConfirmState.unmergedCommitCount !== null && deleteConfirmState.unmergedCommitCount > 0 ? (
                  <div>另外：分支还有 {deleteConfirmState.unmergedCommitCount} 个未合并提交（删除 worktree 不影响分支）。</div>
                ) : null}
              </div>
            ) : (
              <div className="form-hint">即将删除：{deleteConfirmState.worktreeEntry.path}</div>
            )}

            <label className="radio-label">
              <input
                type="checkbox"
                checked={deleteDirectoryChoice}
                onChange={(changeEvent) => setDeleteDirectoryChoice(changeEvent.target.checked)}
              />
              同时删除磁盘目录
            </label>
            {deleteDirectoryChoice ? (
              <div className="strategy-hint">
                安全模式：目录链接（如共享的主目录 node_modules）只会断开链接本身，不会删除主目录里的依赖内容。
              </div>
            ) : (
              <div className="alert-warning">
                将改用 git 原生删除：Windows 上 git 可能跟随目录链接删掉共享的主目录依赖内容，遇到被占用文件还会失败并残留目录。
              </div>
            )}

            <div className="picker-footer">
              <button type="button" className="button-secondary" onClick={() => setDeleteConfirmState(null)}>
                取消
              </button>
              <button
                type="button"
                className={deleteConfirmState.uncommittedFiles.length > 0 ? 'button-danger' : 'button-primary'}
                onClick={() => performRemove(deleteConfirmState.worktreeEntry.path, deleteConfirmState.uncommittedFiles.length > 0)}
              >
                {deleteConfirmState.uncommittedFiles.length > 0 ? '确认强制删除' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
