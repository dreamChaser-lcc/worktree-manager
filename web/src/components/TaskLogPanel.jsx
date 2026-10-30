import React, { useEffect, useRef, useState } from 'react';

/**
 * 任务日志面板：SSE 订阅任务日志，实时滚动展示，落终态后关闭连接。
 */
export function TaskLogPanel({ jobId, title }) {
  const [logLines, setLogLines] = useState([]);
  const [taskStatus, setTaskStatus] = useState('running');
  const logViewReference = useRef(null);

  useEffect(() => {
    if (!jobId) {
      return undefined;
    }
    const eventSource = new EventSource(`/api/tasks/${jobId}/logs`);

    eventSource.addEventListener('history', (historyEvent) => {
      setLogLines(JSON.parse(historyEvent.data));
    });
    eventSource.addEventListener('append', (appendEvent) => {
      const appendedLines = JSON.parse(appendEvent.data);
      setLogLines((previousLines) => [...previousLines, ...appendedLines]);
    });
    eventSource.addEventListener('end', (endEvent) => {
      const endPayload = JSON.parse(endEvent.data);
      setTaskStatus(endPayload.status);
      eventSource.close();
    });
    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => eventSource.close();
  }, [jobId]);

  useEffect(() => {
    // 新日志到达时滚动到底部
    if (logViewReference.current) {
      logViewReference.current.scrollTop = logViewReference.current.scrollHeight;
    }
  }, [logLines]);

  if (!jobId) {
    return null;
  }

  return (
    <div className="task-log-panel">
      <div className="task-log-header">
        <span className="form-label">{title || '后台任务日志'}</span>
        <span className={taskStatus === 'success' ? 'server-badge server-badge-online' : taskStatus === 'failed' ? 'server-badge server-badge-offline' : 'server-badge badge-running'}>
          {taskStatus === 'success' ? '成功' : taskStatus === 'failed' ? '失败' : '执行中'}
        </span>
      </div>
      <pre className="task-log-view" ref={logViewReference}>
        {logLines.join('\n')}
      </pre>
    </div>
  );
}
