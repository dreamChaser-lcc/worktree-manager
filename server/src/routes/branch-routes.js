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
    const remoteBranchResult = await executeGitCommand(repoPath, [
      'branch', '-r', '--format=%(refname:short)'
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

    // 远程分支（排除 origin/HEAD 符号链接），供"起点分支"下拉选择
    const remoteBranchItemList = remoteBranchResult.stdout
      .split('\n')
      .map((branchName) => branchName.trim())
      .filter(Boolean)
      .filter((branchName) => !branchName.endsWith('/HEAD'));

    const packageManagerName = detectPackageManager(repoPath);
    context.body = {
      branches: branchItemList,
      remoteBranches: remoteBranchItemList,
      packageManager: packageManagerName,
      recommendedStrategy: recommendDependencyStrategy(packageManagerName)
    };
  });

  // 新建分支的默认起点：优先远程默认分支（origin/HEAD → origin/master → origin/main），无远程则回退当前 HEAD
  router.get('/api/branches/default-base', async (context) => {
    const repoPath = requireString(context.query.repoPath, '缺少 repoPath 参数');
    if (!(await isGitRepository(repoPath))) {
      throw new ValidationError(`主目录不是有效 git 仓库: ${repoPath}`);
    }

    const remoteResult = await executeGitCommand(repoPath, ['remote']);
    const remoteNameList = remoteResult.stdout.split(/\r?\n/).map((remoteName) => remoteName.trim()).filter(Boolean);
    if (remoteNameList.length === 0) {
      context.body = { baseRef: null, remoteName: null, message: '未配置远程仓库，将基于当前 HEAD 创建' };
      return;
    }

    const preferredRemoteName = remoteNameList.includes('origin') ? 'origin' : remoteNameList[0];

    // 远程 HEAD 符号链接指向的分支（克隆时自动记录）
    try {
      const headResult = await executeGitCommand(repoPath, [
        'symbolic-ref', `refs/remotes/${preferredRemoteName}/HEAD`
      ]);
      const baseRef = headResult.stdout.trim().replace('refs/remotes/', '');
      if (baseRef) {
        context.body = { baseRef, remoteName: preferredRemoteName };
        return;
      }
    } catch {
      // 符号链接不存在（如直接 push 出来的裸仓库），走候选分支回退
    }

    for (const candidateBranchName of ['master', 'main']) {
      try {
        await executeGitCommand(repoPath, [
          'rev-parse', '--verify', '--quiet', `refs/remotes/${preferredRemoteName}/${candidateBranchName}`
        ]);
        context.body = { baseRef: `${preferredRemoteName}/${candidateBranchName}`, remoteName: preferredRemoteName };
        return;
      } catch {
        // 候选分支不存在，尝试下一个
      }
    }

    context.body = {
      baseRef: null,
      remoteName: preferredRemoteName,
      message: '无法确定远程默认分支，将基于当前 HEAD 创建'
    };
  });
}

function requireString(value, errorMessage) {
  if (!value) {
    throw new ValidationError(errorMessage);
  }
  return value;
}
