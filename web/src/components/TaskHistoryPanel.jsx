import React, { useEffect, useState } from 'react';
import { fetchTaskList, fetchTaskDetail } from '../api/client.js';

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

/** 任务记录面板：内存任务 + 持久化历史合并展示，可查看任意任务的完整日志 */
export function TaskHistoryPanel() {
  const [taskList, setTaskList] = useState([]);
  const [listError, setListError] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [detailError, setDetailError] = useState(null);

  async function refreshTaskList() {
    try {
      const listData = await fetchTaskList();
      setTaskList(listData.tasks || []);
      setListError(null);
    } catch (loadError) {
      setListError(loadError.message);
    }
  }

  useEffect(() => {
    refreshTaskList();
  }, []);

  async function handleViewTask(taskEntry) {
    setSelectedTask(null);
    setDetailError(null);
    try {
      setSelectedTask(await fetchTaskDetail(taskEntry.id));
    } catch (detailLoadError) {
      setDetailError(detailLoadError.message);
    }
  }

  return (
    <div>
      <div className="list-toolbar">
        <button type="button" className="button-secondary" onClick={refreshTaskList}>
          刷新
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
                  <button type="button" className="button-secondary" onClick={() => handleViewTask(taskEntry)}>
                    查看日志
                  </button>
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
          </div>
          <pre className="task-log-view">{(selectedTask.logLines || []).join('\n')}</pre>
        </div>
      ) : null}
    </div>
  );
}
