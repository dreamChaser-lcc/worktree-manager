import React from 'react';

/**
 * 终端会话选择弹窗：列出该需求 worktree 下的历史会话，选一个续接，或开新会话。
 * 之所以要选：`codebuddy --resume` 的会话按目录作用域查找，
 * 拿别的目录的 sessionId 续接会报 "No conversation found with session ID"。
 */

/** 时间戳（毫秒，可能是浮点）→ 相对时间文案 */
function formatRelativeTime(timestampValue) {
  const milliseconds = Number(timestampValue);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '';
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1000));
  if (elapsedSeconds < 60) {
    return '刚刚';
  }
  if (elapsedSeconds < 3600) {
    return `${Math.floor(elapsedSeconds / 60)} 分钟前`;
  }
  if (elapsedSeconds < 86400) {
    return `${Math.floor(elapsedSeconds / 3600)} 小时前`;
  }
  return `${Math.floor(elapsedSeconds / 86400)} 天前`;
}

export function CodebuddySessionPickerDialog({
  taskName,
  sessionList,
  loading,
  loadingMessage,
  instanceRunning,
  pickerMode = 'terminal',
  launchTarget = 'window',
  port = '',
  resumeMode = 'last',
  currentSessionId = '',
  sessionChannel = 'rest',
  onLaunchTargetChange,
  onPortChange,
  onResumeModeChange,
  onSessionChannelChange,
  onSelectSession,
  onClose
}) {
  const isLaunchMode = pickerMode === 'launch';
  const isHerdrMode = pickerMode === 'herdr';
  const isSwitchMode = pickerMode === 'switch';
  const dialogTitle = isLaunchMode
    ? '启动 CodeBuddy 实例'
    : isSwitchMode
      ? '选择要切换的会话'
      : isHerdrMode
        ? '选择要在 herdr 中打开的会话'
        : '选择要打开的终端会话';

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div
        className="picker-dialog codebuddy-session-dialog"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="picker-toolbar">
          <span className="picker-current-path" title={taskName}>
            {dialogTitle}
          </span>
          <button type="button" className="button-secondary" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="codebuddy-session-hint">{taskName}</div>

        {isLaunchMode ? (
          <div className="codebuddy-launch-options">
            <div className="codebuddy-launch-row">
              <span className="form-label codebuddy-launch-label">启动位置</span>
              <label className="radio-label">
                <input
                  type="radio"
                  checked={launchTarget === 'window'}
                  onChange={() => onLaunchTargetChange('window')}
                />
                终端 CLI（独立窗口）
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  checked={launchTarget === 'herdr'}
                  onChange={() => onLaunchTargetChange('herdr')}
                />
                herdr 工作区
              </label>
            </div>
            <div className="codebuddy-launch-row">
              <span className="form-label codebuddy-launch-label">端口</span>
              <input
                className="form-input codebuddy-port-input"
                value={port}
                placeholder="留空自动分配（59000 起）"
                onChange={(changeEvent) => onPortChange(changeEvent.target.value.replace(/[^0-9]/g, ''))}
              />
              <span className="form-hint codebuddy-launch-hint">
                平台与终端共用这一条端口，启动后只会有这一个进程
              </span>
            </div>
            <div className="codebuddy-launch-row">
              <span className="form-label codebuddy-launch-label">续接方式</span>
              <label className="radio-label">
                <input
                  type="radio"
                  checked={resumeMode === 'last'}
                  onChange={() => onResumeModeChange('last')}
                />
                续接上次会话
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  checked={resumeMode === 'switch'}
                  onChange={() => onResumeModeChange('switch')}
                />
                启动后选择会话
              </label>
            </div>
            <div className="codebuddy-launch-row">
              <span className="form-label codebuddy-launch-label">会话通道</span>
              <label className="radio-label">
                <input
                  type="radio"
                  checked={sessionChannel === 'rest'}
                  onChange={() => onSessionChannelChange('rest')}
                />
                轻量（纯文本）
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  checked={sessionChannel === 'acp'}
                  onChange={() => onSessionChannelChange('acp')}
                />
                完整（模型 / 权限 / 停止）
              </label>
            </div>
          </div>
        ) : null}

        {isLaunchMode ? (
          // 启动前还没有实例，列不出历史会话；这里只负责确认启动配置
          <div className="codebuddy-launch-footer">
            <span className="form-hint codebuddy-launch-footer-hint">
              启动后可在面板里随时「新建会话」或「切换会话」
            </span>
            <button type="button" className="button-primary" onClick={() => onSelectSession(null)}>
              启动
            </button>
          </div>
        ) : (
          <>
            {!instanceRunning && !loading ? (
              <div className="alert-warning">
                {loadingMessage || '实例未运行，暂时读不到历史会话；仍可以新建会话'}
              </div>
            ) : null}

            <div className="picker-list codebuddy-session-list">
              {/* 切换会话时不再提供"新建会话"：面板上已有独立按钮，避免两种意图混在一起 */}
              {!isSwitchMode ? (
                <button type="button" className="codebuddy-session-item" onClick={() => onSelectSession(null)}>
                  <span className="codebuddy-session-item-title">＋ 新建会话</span>
                  <span className="codebuddy-session-item-meta">
                    {isHerdrMode ? '在 herdr 工作区里启动一个全新对话' : '在该 worktree 目录启动一个全新对话'}
                  </span>
                </button>
              ) : null}

              {loading ? (
                <div className="picker-item-empty">正在读取历史会话…</div>
              ) : (
                (sessionList || []).map((sessionEntry) => {
                  const isCurrentSession = Boolean(currentSessionId) && sessionEntry.id === currentSessionId;
                  return (
                    <button
                      key={sessionEntry.id}
                      type="button"
                      className={
                        isCurrentSession
                          ? 'codebuddy-session-item codebuddy-session-item-current'
                          : 'codebuddy-session-item'
                      }
                      onClick={() => onSelectSession(sessionEntry.id)}
                    >
                      <span className="codebuddy-session-item-title">
                        {sessionEntry.name}
                        {isCurrentSession ? <span className="codebuddy-current-badge">当前</span> : null}
                      </span>
                      <span className="codebuddy-session-item-meta">
                        {sessionEntry.isRunning ? '运行中' : `${sessionEntry.messageCount} 条消息`}
                        {sessionEntry.updatedAt ? ` · ${formatRelativeTime(sessionEntry.updatedAt)}` : ''}
                        <span className="codebuddy-session-item-id">{sessionEntry.id.slice(0, 8)}</span>
                      </span>
                    </button>
                  );
                })
              )}

              {!loading && (sessionList || []).length === 0 ? (
                <div className="picker-item-empty">
                  {instanceRunning ? '该目录下还没有历史会话' : '启动实例后可查看历史会话'}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
