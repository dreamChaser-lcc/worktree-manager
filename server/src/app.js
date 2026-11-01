import Koa from 'koa';
import Router from '@koa/router';
import koaStatic from 'koa-static';
import koaBodyParser from 'koa-bodyparser';
import fs from 'node:fs';
import { serverConfig } from './config.js';
import { registerHealthRoutes } from './routes/health-routes.js';
import { registerFilesystemRoutes } from './routes/filesystem-routes.js';
import { registerBranchRoutes } from './routes/branch-routes.js';
import { registerWorktreeRoutes } from './routes/worktree-routes.js';
import { registerTaskRoutes } from './routes/task-routes.js';
import { registerRecordRoutes } from './routes/record-routes.js';
import { registerSettingsRoutes } from './routes/settings-routes.js';
import { registerRequirementTaskRoutes } from './routes/requirement-task-routes.js';
import { AppError } from './core/errors.js';

/** 组装 Koa 应用：路由注册 + 静态托管 + 统一错误处理 */
export function createApp() {
  const koaApplication = new Koa();
  const apiRouter = new Router({ prefix: '' });

  registerHealthRoutes(apiRouter);
  registerFilesystemRoutes(apiRouter);
  registerBranchRoutes(apiRouter);
  registerWorktreeRoutes(apiRouter);
  registerTaskRoutes(apiRouter);
  registerRecordRoutes(apiRouter);
  registerSettingsRoutes(apiRouter);
  registerRequirementTaskRoutes(apiRouter);

  koaApplication.use(async (context, next) => {
    try {
      await next();
    } catch (error) {
      const isKnownError = error instanceof AppError;
      context.status = isKnownError ? error.httpStatus : 500;
      context.body = {
        error: error.message || '服务器内部错误',
        details: isKnownError ? error.details : null
      };
      if (!isKnownError) {
        console.error('[worktree-manager] 未预期错误:', error);
      }
    }
  });

  koaApplication.use(koaBodyParser());
  koaApplication.use(apiRouter.routes());
  koaApplication.use(apiRouter.allowedMethods());

  // 前端构建产物存在时静态托管，否则提示先构建（桌面壳注入 WORKTREE_MANAGER_WEB_DIST 时打印实际路径便于排查）
  const webDistExists = fs.existsSync(serverConfig.webDistPath);
  console.log(
    `[worktree-manager] 前端静态目录: ${serverConfig.webDistPath} (存在: ${webDistExists})`
  );
  if (webDistExists) {
    koaApplication.use(koaStatic(serverConfig.webDistPath));
  } else {
    console.warn('[worktree-manager] 前端构建产物不存在，页面将不可用；请先执行 npm run build:web');
  }

  return koaApplication;
}
