import { createApp } from './app.js';
import { serverConfig } from './config.js';

const koaApplication = createApp();

// 显式绑定 127.0.0.1：服务只对本机可见
koaApplication.listen(serverConfig.port, serverConfig.host, () => {
  console.log(`[worktree-manager] 服务已启动: http://${serverConfig.host}:${serverConfig.port}`);
  console.log('[worktree-manager] 仅监听本机回环地址，局域网不可访问');
});
