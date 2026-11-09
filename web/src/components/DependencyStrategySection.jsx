import React from 'react';

/**
 * 依赖策略区：共享主目录（目录链接）/ 独立安装 / 不处理 三选一。
 * 默认选独立安装：目录链接共享依赖操作系统允许普通权限进程遍历该链接，
 * 部分 Windows 安全更新后会拒绝遍历（链接建得出但读不到内容），只有这类环境才适合选共享。
 */
const STRATEGY_LABEL_MAP = {
  share: '共享主目录依赖（目录链接，秒级、零磁盘；需系统权限支持）',
  install: '独立安装（用包管理器缓存/store，依赖隔离）',
  skip: '不处理（稍后自行安装）'
};

export function DependencyStrategySection({ packageManager, recommendedStrategy, strategy, onStrategyChange }) {
  const missingLockfile = packageManager === null;

  return (
    <div className="form-row">
      <label className="form-label">依赖处理</label>

      {missingLockfile ? (
        <div className="alert-warning">
          未检测到 lockfile（package-lock.json / yarn.lock / pnpm-lock.yaml）。
          若选择共享主目录，请先确认主目录已完成一次依赖安装。
        </div>
      ) : null}

      {['share', 'install', 'skip'].map((strategyKey) => (
        <label key={strategyKey} className="radio-label strategy-radio">
          <input
            type="radio"
            name="dependencyStrategy"
            checked={strategy === strategyKey}
            onChange={() => onStrategyChange(strategyKey)}
          />
          {STRATEGY_LABEL_MAP[strategyKey]}
          {recommendedStrategy === strategyKey ? <span className="badge-recommended">推荐</span> : null}
        </label>
      ))}

      {strategy === 'share' ? (
        <div className="strategy-hint">
          共享模式需要在 worktree 内建立指向主目录的目录链接，依赖系统允许当前权限遍历该链接。
          若系统拒绝（表现为链接建好但读不到依赖、报 UNKNOWN 或 ERROR_UNTRUSTED_MOUNT_POINT），
          请改用「独立安装」。依赖版本以主目录为准：分支上升级依赖不会生效；
          请勿在此 worktree 内执行 install（会写穿链接、改写主目录依赖）。
        </div>
      ) : null}
      {strategy === 'install' ? (
        <div className="strategy-hint">
          独立安装将作为后台任务执行，创建完成后可在日志面板查看进度。
        </div>
      ) : null}
    </div>
  );
}
