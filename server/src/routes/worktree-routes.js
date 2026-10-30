import Router from '@koa/router';
import { createWorktree, listWorktrees, removeWorktree, pruneWorktrees } from '../core/worktree-manager.js';
import {
  applySharedDependencyLink,
  startIndependentInstall,
  detectPackageManager
} from '../core/dep-linker.js';
import { copyIgnoredFiles } from '../core/ignore-file-copier.js';
import { openDirectoryInEditor } from '../core/editor-opener.js';
import { startProcessJob } from '../jobs/job-runner.js';
import { ValidationError } from '../core/errors.js';

/**
 * worktree 管理路由。创建流程按 design D8 编排：
 * 校验+git worktree add（原子边界）→ 依赖处理 → 复制忽略文件 → 打开编辑器。
 * git add 之后任何一步失败不回滚 worktree，仅报告失败步骤与补救提示。
 */
export function registerWorktreeRoutes(router) {
  router.get('/api/worktrees', async (context) => {
    const repoPath = requireString(context.query.repoPath, '缺少 repoPath 参数');
    context.body = { worktrees: await listWorktrees(repoPath) };
  });

  router.post('/api/worktrees/create', async (context) => {
    const createRequest = context.request.body || {};
    const {
      repoPath,
      targetPath,
      branchMode,
      branchName,
      baseRef,
      dependencyStrategy,
      copyIgnoredFiles: shouldCopyIgnoredFiles,
      openInEditor: shouldOpenInEditor,
      editorCommand,
      ignoreFilePatterns
    } = createRequest;

    requireString(repoPath, '缺少 repoPath');
    requireString(targetPath, '缺少 targetPath');
    if (!['existing', 'new'].includes(branchMode)) {
      throw new ValidationError(`branchMode 必须为 existing 或 new: ${branchMode}`);
    }
    requireString(branchName, '缺少 branchName');
    if (!['share', 'install', 'skip'].includes(dependencyStrategy)) {
      throw new ValidationError(`dependencyStrategy 必须为 share/install/skip: ${dependencyStrategy}`);
    }

    // 1. 原子边界：前置校验 + git worktree add
    const createdInfo = await createWorktree({ repoPath, targetPath, branchMode, branchName, baseRef });

    // 2. 依赖处理（失败不影响 worktree 本身，降级为 warning 返回）
    const warningList = [];
    let dependencyResult = { status: 'skipped' };
    let installJobId = null;

    if (dependencyStrategy === 'share') {
      try {
        dependencyResult = applySharedDependencyLink({ repoPath, worktreePath: createdInfo.path });
      } catch (dependencyError) {
        dependencyResult = { status: 'failed', message: dependencyError.message };
        warningList.push(`依赖共享失败: ${dependencyError.message}`);
      }
    } else if (dependencyStrategy === 'install') {
      const packageManagerName = detectPackageManager(repoPath) || detectPackageManager(createdInfo.path);
      if (!packageManagerName) {
        dependencyResult = { status: 'failed', message: '未检测到包管理器(缺少 lockfile)，无法独立安装' };
        warningList.push(dependencyResult.message);
      } else {
        const { job } = startProcessJob({
          jobName: `install:${branchName}`,
          command: packageManagerName,
          commandArguments: ['install'],
          cwd: createdInfo.path
        });
        installJobId = job.id;
        dependencyResult = { status: 'installing', packageManager: packageManagerName };
      }
    }

    // 3. 复制忽略文件（可选）：从主仓库复制到新 worktree
    let ignoreFileCopyResult = { copiedFiles: [], skipped: true };
    if (shouldCopyIgnoredFiles) {
      try {
        ignoreFileCopyResult = { ...copyIgnoredFiles({
          repoPath,
          worktreePath: createdInfo.path,
          patterns: ignoreFilePatterns
        }), skipped: false };
      } catch (copyError) {
        warningList.push(`忽略文件复制失败: ${copyError.message}`);
      }
    }

    // 4. 打开编辑器（可选）
    let editorResult = null;
    if (shouldOpenInEditor) {
      try {
        editorResult = openDirectoryInEditor(createdInfo.path, editorCommand);
      } catch (editorError) {
        warningList.push(`打开编辑器失败: ${editorError.message}`);
      }
    }

    context.body = {
      worktree: createdInfo,
      dependencyResult,
      installJobId,
      ignoreFileCopyResult,
      editorResult,
      warnings: warningList
    };
  });

  router.delete('/api/worktrees', async (context) => {
    const repoPath = requireString(context.query.repoPath, '缺少 repoPath 参数');
    const targetPath = requireString(context.query.targetPath, '缺少 targetPath 参数');
    const force = context.query.force === '1' || context.query.force === 'true';
    // 默认开启目录清理回退；显式传 0/false 关闭（仅 git 原生删除）
    const deleteDirectory = context.query.deleteDirectory !== '0' && context.query.deleteDirectory !== 'false';

    const removalResult = await removeWorktree({ repoPath, targetPath, force, deleteDirectory });
    context.body = removalResult;
  });

  router.post('/api/worktrees/prune', async (context) => {
    const repoPath = requireString(context.request.body?.repoPath, '缺少 repoPath');
    context.body = await pruneWorktrees(repoPath);
  });

  router.post('/api/worktrees/open-editor', async (context) => {
    const targetPath = requireString(context.request.body?.targetPath, '缺少 targetPath');
    context.body = openDirectoryInEditor(targetPath, context.request.body?.editorCommand);
  });
}

function requireString(value, errorMessage) {
  if (!value) {
    throw new ValidationError(errorMessage);
  }
  return value;
}
