import Router from '@koa/router';
import { persistenceManager } from '../storage/persistence-manager.js';
import { ValidationError } from '../core/errors.js';

/**
 * 记录查询路由：最近主仓库、worktree 创建历史。
 * 持久层未初始化时返回空集（持久化降级模式）。
 */
export function registerRecordRoutes(router) {
  router.get('/api/recent-repos', async (context) => {
    context.body = await persistenceManager.listRecentRepos();
  });

  router.get('/api/worktree-history', async (context) => {
    context.body = { records: await persistenceManager.listWorktreeHistoryRecords() };
  });

  router.delete('/api/worktree-history', async (context) => {
    const removedCount = await persistenceManager.clearWorktreeHistoryRecords();
    context.body = { removedCount };
  });
}

/** 供测试或后续扩展使用：显式触发一次最近主仓库记录 */
export async function recordRecentRepoUsage(repoPath) {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new ValidationError('缺少 repoPath');
  }
  await persistenceManager.upsertRecentRepoPath(repoPath);
}
