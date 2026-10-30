import React, { useEffect, useState } from 'react';
import { fetchTaskList, fetchTaskDetail, deleteTaskRecord } from '../api/client.js';
import { usePendingActions } from '../utils/usePendingActions.js';

const TASK_STATUS_LABEL_MAP = {
  running: '执行中',
  success: '成功',
  failed: '失败',
  interrupted: '已中断'
};

function taskBadgeClassName(statusText) {
  if (statusText === 'success') {
    return 'badge-status badge-clean';
  }
  if (statusText === 'failed') {
    return 'badge-status badge-dirty';
  }
  if (statusText === 'interrupted') {
    return 'badge-status badge-interrupted';
  }
  return 'badge-status badge-occupied';
}

function formatTimeText(isoText) {
  return isoText ? isoText.replace('T', ' ').slice(0, 19) : '—';
}

/** 任务记录面板：内存任务 + 持久化历史合并展示，可查看任意任务的完整日志，已结束任务可删除记录 */
export function TaskHistoryPanel() {
  const [taskList, setTaskList] = useState([]);
  const [listError, setListError] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [detailError, setDetailError] = useState(null);
  // 刷新 / 日志详情加载 / 记录删除 的 pending 状态（按钮 spinner 与禁用）
  const refreshPending = usePendingActions();
  const detailPending = usePendingActions();
  const deletePending = usePendingActions();

  async function refreshTaskList() {
    await refreshPending.run('task-list-refresh', async () => {
      try {
        const listData = await fetchTaskList();
        setTaskList(listData.tasks || []);
        setListError(null);
      } catch (loadError) {
        setListError(loadError.message);
      }
    });
  }

  useEffect(() => {
    refreshTaskList();
  }, []);

  /** 查看任务日志：再次点击同一任务的「查看日志」或点面板「收起」均可收起 */
  async function handleViewTask(taskEntry) {
    if (selectedTask && selectedTask.id === taskEntry.id) {
      setSelectedTask(null);
      return;
    }
    await detailPending.run(`task-detail:${taskEntry.id}`, async () => {
      setSelectedTask(null);
      setDetailError(null);
      try {
        setSelectedTask(await fetchTaskDetail(taskEntry.id));
      } catch (detailLoadError) {
        setDetailError(detailLoadError.message);
      }
    });
  }

  /** 删除单条任务记录（仅已结束任务；运行中由后端拦截）；删的是当前展开日志时一并收起 */
  async function handleDeleteTask(taskEntry) {
    await deletePending.run(`task-delete:${taskEntry.id}`, async () => {
      try {
        await deleteTaskRecord(taskEntry.id);
        setListError(null);
        if (selectedTask && selectedTask.id === taskEntry.id) {
          setSelectedTask(null);
        }
        await refreshTaskList();
      } catch (deleteTaskError) {
        setListError(deleteTaskError.message);
      }
    });
  }

  return (
    <div>
      <div className="list-toolbar">
        <button
          type="button"
          className="button-secondary"
          disabled={refreshPending.isPending('task-list-refresh')}
          onClick={refreshTaskList}
        >
          {refreshPending.isPending('task-list-refresh') ? (
            <span>
              <span className="button-spinner" />
              刷新中...
            </span>
          ) : (
            '刷新'
          )}
        </button>
      </div>

      {listError ? <div className="alert-error">{listError}</div> : null}
      {taskList.length === 0 && !listError ? <div className="section-empty">暂无任务记录</div> : null}

      {taskList.length > 0 ? (
        <table className="record-table">
          <thead>
            <tr>
              <th>任务</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>结束时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {taskList.map((taskEntry) => (
              <tr key={taskEntry.id}>
                <td>{taskEntry.name}</td>
                <td>
                  <span className={taskBadgeClassName(taskEntry.status)}>
                    {TASK_STATUS_LABEL_MAP[taskEntry.status] || taskEntry.status}
                  </span>
                </td>
                <td>{formatTimeText(taskEntry.createdAt)}</td>
                <td>{formatTimeText(taskEntry.finishedAt)}</td>
                <td>
                  <div className="cell-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={detailPending.isPending(`task-detail:${taskEntry.id}`)}
                      onClick={() => handleViewTask(taskEntry)}
                    >
                      {detailPending.isPending(`task-detail:${taskEntry.id}`) ? (
                        <span>
                          <span className="button-spinner" />
                          加载中...
                        </span>
                      ) : selectedTask && selectedTask.id === taskEntry.id ? (
                        '收起日志'
                      ) : (
                        '查看日志'
                      )}
                    </button>
                    <button
                      type="button"
                      className="button-danger"
                      disabled={
                        taskEntry.status === 'running' || deletePending.isPending(`task-delete:${taskEntry.id}`)
                      }
                      onClick={() => handleDeleteTask(taskEntry)}
                    >
                      {deletePending.isPending(`task-delete:${taskEntry.id}`) ? (
                        <span>
                          <span className="button-spinner" />
                          删除中...
                        </span>
                      ) : (
                        '删除'
                      )}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {detailError ? <div className="alert-error">{detailError}</div> : null}

      {selectedTask ? (
        <div className="task-detail-panel">
          <div className="task-log-header">
            <span className="form-label">任务日志：{selectedTask.name}</span>
            <span className={taskBadgeClassName(selectedTask.status)}>
              {TASK_STATUS_LABEL_MAP[selectedTask.status] || selectedTask.status}
            </span>
            <button type="button" className="button-secondary" onClick={() => setSelectedTask(null)}>
              收起
            </button>
          </div>
          <pre className="task-log-view">{(selectedTask.logLines || []).join('\n')}</pre>
        </div>
      ) : null}
    </div>
  );
}
