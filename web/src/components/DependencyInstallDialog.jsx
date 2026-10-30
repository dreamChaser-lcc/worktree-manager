import React, { useState } from 'react';

/**
 * 独立安装选项弹窗：默认按包管理器 install 执行（与原有行为一致），
 * 也可填写自定义安装脚本（留空走默认），脚本在该 worktree 目录下以 shell 执行。
 * 输入收集与发起解耦：确认时通过 onConfirmInstall(customScriptText) 交由父组件发请求。
 */
export function DependencyInstallDialog({
  projectName,
  worktreePath,
  packageManagerName,
  submitting,
  onCancel,
  onConfirmInstall
}) {
  const [customScriptText, setCustomScriptText] = useState('');
  const defaultCommandText = packageManagerName
    ? `${packageManagerName} install`
    : '自动检测（worktree lockfile → 主仓库 lockfile → npm 兜底）';

  return (
    <div className="picker-overlay" onClick={onCancel}>
      <div className="picker-dialog" onClick={(clickEvent) => clickEvent.stopPropagation()}>
        <div className="picker-toolbar">
          <span className="picker-current-path">独立安装 — {projectName}</span>
          <button type="button" className="button-secondary" onClick={onCancel}>
            关闭
          </button>
        </div>

        <div className="form-row">
          <span className="form-label">worktree</span>
          <div className="settings-current-path">{worktreePath}</div>
          <div className="form-hint">
            默认安装命令：{defaultCommandText}；若 node_modules 为共享链接会先断开再安装。
          </div>
        </div>

        <div className="form-row">
          <label className="form-label">自定义安装脚本（可选）</label>
          <textarea
            className="reserved-textarea"
            value={customScriptText}
            onChange={(changeEvent) => setCustomScriptText(changeEvent.target.value)}
            placeholder="留空则执行默认安装。示例：pnpm install --frozen-lockfile"
          />
          <div className="form-hint">脚本将替换默认命令，在该 worktree 目录下以 shell 执行，支持多行。</div>
        </div>

        <div className="picker-footer">
          <button type="button" className="button-secondary" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={submitting}
            onClick={() => onConfirmInstall(customScriptText)}
          >
            {submitting ? '启动中...' : '开始安装'}
          </button>
        </div>
      </div>
    </div>
  );
}
