import { createApp } from './app.js';
import { serverConfig } from './config.js';
import { persistenceManager } from './storage/persistence-manager.js';
import { recoverInterruptedJobs } from './jobs/job-runner.js';
// 触发热重启标记

// 持久化初始化与崩溃恢复：数据目录不可用时直接中止启动（避免静默降级成内存模式后"看不到旧数据"）
try {
  const effectiveDataRootPath = await persistenceManager.initialize();
  if (effectiveDataRootPath) {
    console.log(`[worktree-manager] 持久化数据目录: ${effectiveDataRootPath}`);
    const recoveredJobCount = await recoverInterruptedJobs();
    if (recoveredJobCount > 0) {
      console.log(`[worktree-manager] 已将 ${recoveredJobCount} 个遗留运行中任务标记为中断(interrupted)`);
    }
  } else {
    console.error(
      '[worktree-manager] 数据目录不可用，服务启动中止。常见原因：另一个 worktree-manager 实例正在运行（请先关闭它），或杀毒软件/同步盘正在占用数据库文件。'
    );
    process.exit(1);
  }
} catch (startupError) {
  console.error(
    `[worktree-manager] 持久化初始化失败，服务启动中止: ${startupError.message}。常见原因：另一个实例正在运行，请先关闭后再启动。`
  );
  process.exit(1);
}

const koaApplication = createApp();

// 显式绑定 127.0.0.1（或环境变量指定地址）：服务只对本机/内网可见
const koaServer = koaApplication.listen(serverConfig.port, serverConfig.host, () => {
  console.log(`[worktree-manager] 服务已启动: http://${serverConfig.host}:${serverConfig.port}`);
  console.log('[worktree-manager] 数据目录与端口同一时间只允许一个实例使用，请勿重复启动');
});

koaServer.on('error', (listenError) => {
  if (listenError.code === 'EADDRINUSE') {
    console.error(
      `[worktree-manager] 端口 ${serverConfig.port} 已被占用：很可能另一个 worktree-manager 实例正在运行，请先关闭旧实例（可在任务管理器结束 node 进程，或执行 netstat -ano | findstr ${serverConfig.port} 找到占用进程）。`
    );
    process.exit(1);
  }
  throw listenError;
});
