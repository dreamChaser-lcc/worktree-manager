import React, { useEffect, useState } from 'react';
import { fetchWorktreeHistory, clearWorktreeHistory } from '../api/client.js';

function formatTimeText(isoText) {
  return isoText ? isoText.replace('T', ' ').slice(0, 19) : '—';
}

/** Worktree 创建历史区块：成功/失败均留痕，永久保留 + 手动确认清空 */
export function CreationHistoryPanel() {
  const [recordList, setRecordList] = useState([]);
  const [listError, setListError] = useState(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  async function refreshHistoryList() {
    try {
      const historyData = await fetchWorktreeHistory();
      setRecordList(historyData.records || []);
      setListError(null);
    } catch (loadError) {
      setListError(loadError.message);
    }
  }

  useEffect(() => {
    refreshHistoryList();
  }, []);

  async function handleClearConfirmed() {
    try {
      await clearWorktreeHistory();
      setConfirmingClear(false);
      await refreshHistoryList();
    } catch (clearError) {
      setListError(clearError.message);
    }
  }

  return (
    <div className="section-block">
      <div className="section-header">
        <span className="form-label">Worktree 创建历史</span>
        {recordList.length > 0 ? (
          confirmingClear ? (
            <span>
              <button type="button" className="button-danger" onClick={handleClearConfirmed}>
                确认清空
              </button>
              <button type="button" className="button-secondary" onClick={() => setConfirmingClear(false)}>
                取消
              </button>
            </span>
          ) : (
            <button type="button" className="button-secondary" onClick={() => setConfirmingClear(true)}>
              清空历史
            </button>
          )
        ) : null}
      </div>

      {listError ? <div className="alert-error">{listError}</div> : null}
      {recordList.length === 0 && !listError ? <div className="section-empty">暂无创建历史</div> : null}

      {recordList.length > 0 ? (
        <table className="record-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>主仓库</th>
              <th>分支</th>
              <th>目标路径</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {recordList.map((recordEntry) => (
              <tr key={recordEntry.id}>
                <td>{formatTimeText(recordEntry.completedAt)}</td>
                <td className="cell-path">{recordEntry.repoPath}</td>
                <td>{recordEntry.branchName}</td>
                <td className="cell-path">{recordEntry.targetPath}</td>
                <td>
                  {recordEntry.outcome === 'success' ? (
                    <span className="badge-status badge-clean">成功</span>
                  ) : (
                    <span>
                      <span className="badge-status badge-dirty">失败</span>
                      <div className="history-reason">{recordEntry.failureReason || '未知原因'}</div>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
