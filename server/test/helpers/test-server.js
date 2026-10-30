import { once } from 'node:events';

/**
 * 测试辅助：启动随机端口的服务实例并等待监听就绪。
 * 返回 { serverInstance, baseUrl, close }，close 保证清理干净。
 */
export async function startTestServer(koaApplication) {
  const serverInstance = koaApplication.listen(0, '127.0.0.1');
  await once(serverInstance, 'listening');
  const listenPort = serverInstance.address().port;

  return {
    serverInstance,
    listenPort,
    baseUrl: `http://127.0.0.1:${listenPort}`,
    close: () => new Promise((resolve) => serverInstance.close(resolve))
  };
}
