import Router from '@koa/router';

/** 健康检查路由：用于探活与启动验证 */
export function registerHealthRoutes(router) {
  router.get('/api/health', (context) => {
    context.body = { ok: true, service: 'worktree-manager' };
  });
}
