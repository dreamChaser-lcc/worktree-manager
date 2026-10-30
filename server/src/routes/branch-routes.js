import Router from '@koa/router';
import { isGitRepository } from '../core/validators.js';
import { executeGitCommand } from '../core/git-executor.js';
import { getBranchOccupationMap } from '../core/worktree-manager.js';
import { detectPackageManager, recommendDependencyStrategy } from '../core/dep-linker.js';
import { ValidationError } from '../core/errors.js';

/** 分支列表（含 worktree 占用标注）与依赖策略推荐路由 */
export function registerBranchRoutes(router) {
  router.get('/api/branches', async (context) => {
    const repoPath = requireString(context.query.repoPath, '缺少 repoPath 参数');
    if (!(await isGitRepository(repoPath))) {
      throw new ValidationError(`主目录不是有效 git 仓库: ${repoPath}`);
    }

    const branchListResult = await executeGitCommand(repoPath, [
      'branch', '--format=%(refname:short)'
    ]);
    const occupationMap = await getBranchOccupationMap(repoPath);

    const branchItemList = branchListResult.stdout
      .split('\n')
      .map((branchName) => branchName.trim())
      .filter(Boolean)
      .map((branchName) => ({
        name: branchName,
        occupiedBy: occupationMap[branchName] || null
      }));

    const packageManagerName = detectPackageManager(repoPath);
    context.body = {
      branches: branchItemList,
      packageManager: packageManagerName,
      recommendedStrategy: recommendDependencyStrategy(packageManagerName)
    };
  });
}

function requireString(value, errorMessage) {
  if (!value) {
    throw new ValidationError(errorMessage);
  }
  return value;
}
