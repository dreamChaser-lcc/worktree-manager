import Router from '@koa/router';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createWorktree, listWorktrees, removeWorktree, pruneWorktrees } from '../core/worktree-manager.js';
import { executeGitCommand } from '../core/git-executor.js';
import {
  applySharedDependencyLink,
  startIndependentInstall,
  detectPackageManager
} from '../core/dep-linker.js';
import { copyIgnoredFiles } from '../core/ignore-file-copier.js';
import { openDirectoryInEditor } from '../core/editor-opener.js';
import { startProcessJob } from '../jobs/job-runner.js';
import { persistenceManager } from '../storage/persistence-manager.js';
import { ValidationError } from '../core/errors.js';

/**
 * worktree 管理路由。创建流程按 design D8 编排：
 * 校验+git worktree add（原子边界）→ 依赖处理 → 复制忽略文件 → 打开编辑器。
 * git add 之后任何一步失败不回滚 worktree，仅报告失败步骤与补救提示。
 * 创建成败均写持久化历史（add-local-persistence），历史写失败不影响创建本身。
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
      ignoreFilePatterns,
      requirementTaskId
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

    const startedAtIso = new Date().toISOString();
    try {
      const createResultPayload = await executeCreationFlow({
        repoPath,
        targetPath,
        branchMode,
        branchName,
        baseRef,
        dependencyStrategy,
        shouldCopyIgnoredFiles: shouldCopyIgnoredFiles,
        shouldOpenInEditor: shouldOpenInEditor,
        editorCommand,
        ignoreFilePatterns,
        requirementTaskId: typeof requirementTaskId === 'string' ? requirementTaskId : '',
        startedAtIso
      });
      context.body = createResultPayload;
    } catch (createError) {
      // 失败也留痕：失败原因写入历史（写失败仅告警，不影响错误响应）
      recordCreationHistory({
        repoPath,
        branchName,
        targetPath,
        dependencyStrategy,
        startedAtIso,
        outcome: 'failed',
        failureReason: createError.message,
        warningList: []
      });
      throw createError;
    }
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
    // 未显式指定命令时使用设置中的编辑器命令（settings.json 的 editorCommand，默认 code）
    const editorCommand = context.request.body?.editorCommand || persistenceManager.getEditorCommand();
    context.body = openDirectoryInEditor(targetPath, editorCommand);
  });
}

function requireString(value, errorMessage) {
  if (!value) {
    throw new ValidationError(errorMessage);
  }
  return value;
}

/** 创建流程主体（design D8 编排）：校验+worktree add → 依赖处理 → 复制忽略文件 → 打开编辑器 */
async function executeCreationFlow(creationInput) {
  const {
    repoPath,
    targetPath,
    branchMode,
    branchName,
    baseRef,
    dependencyStrategy,
    shouldCopyIgnoredFiles,
    shouldOpenInEditor,
    editorCommand,
    ignoreFilePatterns,
    requirementTaskId,
    startedAtIso
  } = creationInput;

  const warningList = [];

  // 0. 新建分支且起点指向远程（如 origin/master）时，先拉取该远程最新，保证"从远程最新代码新建"
  if (branchMode === 'new' && baseRef) {
    const candidateRemoteName = baseRef.split('/')[0];
    try {
      const remoteResult = await executeGitCommand(repoPath, ['remote']);
      const remoteNameList = remoteResult.stdout
        .split(/\r?\n/)
        .map((remoteName) => remoteName.trim())
        .filter(Boolean);
      if (remoteNameList.includes(candidateRemoteName)) {
        try {
          await executeGitCommand(repoPath, ['fetch', candidateRemoteName, '--prune']);
        } catch (fetchError) {
          warningList.push(
            `远程 ${candidateRemoteName} 更新失败，将基于本地缓存的远程分支创建: ${fetchError.message}`
          );
        }
      }
    } catch {
      // 远程清单获取失败不阻断创建流程
    }
  }

  // 1. 原子边界：前置校验 + git worktree add
  const createdInfo = await createWorktree({ repoPath, targetPath, branchMode, branchName, baseRef });

  // 1.5 新建分支基于远程分支（如 origin/master）时，git 会把 upstream 自动设为起点远程分支，
  //     名字与新分支不一致会导致 git push 报"upstream 不匹配"。这里改写为同名远程分支
  //     （仅写本地 config，不联网、不创建远程分支；首次 git push 即可推上并自动建远程分支）
  if (branchMode === 'new') {
    try {
      const upstreamResult = await executeGitCommand(repoPath, ['rev-parse', '--abbrev-ref', `${branchName}@{upstream}`]);
      const upstreamName = upstreamResult.stdout.trim();
      const upstreamBranchName = upstreamName.includes('/') ? upstreamName.split('/').slice(1).join('/') : upstreamName;
      if (upstreamBranchName && upstreamBranchName !== branchName) {
        const upstreamRemoteName = upstreamName.split('/')[0];
        await executeGitCommand(repoPath, ['config', `branch.${branchName}.remote`, upstreamRemoteName]);
        await executeGitCommand(repoPath, ['config', `branch.${branchName}.merge`, `refs/heads/${branchName}`]);
      }
    } catch {
      // 无 upstream（起点为本地分支等）则不需要处理
    }
  }

  // 2. 依赖处理（失败不影响 worktree 本身，降级为 warning 返回）
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

  // 4. 打开编辑器（可选）：未显式指定命令时使用设置中的编辑器命令
  let editorResult = null;
  if (shouldOpenInEditor) {
    try {
      editorResult = openDirectoryInEditor(createdInfo.path, editorCommand || persistenceManager.getEditorCommand());
    } catch (editorError) {
      warningList.push(`打开编辑器失败: ${editorError.message}`);
    }
  }

  // 5. 留痕：成功历史写入持久层；写失败降级为 warning，不影响创建结果
  const historyWarningText = await recordCreationHistory({
    repoPath,
    branchName,
    targetPath,
    dependencyStrategy,
    startedAtIso,
    outcome: 'success',
    failureReason: null,
    warningList
  });
  if (historyWarningText) {
    warningList.push(historyWarningText);
  }

  // 6. 关联需求任务（可选）：把新 worktree 挂到需求中主仓库匹配的项目条目
  let requirementTaskAttach = null;
  if (requirementTaskId) {
    requirementTaskAttach = await attachWorktreeToRequirementTask(requirementTaskId, repoPath, createdInfo.path);
    if (!requirementTaskAttach.attached && requirementTaskAttach.message) {
      warningList.push(`需求任务关联未完成: ${requirementTaskAttach.message}`);
    }
  }

  return {
    worktree: createdInfo,
    dependencyResult,
    installJobId,
    ignoreFileCopyResult,
    editorResult,
    requirementTaskAttach,
    warnings: warningList
  };
}

/** 本地路径归一化：native realpath 展开短路径（8.3）并统一大小写/斜杠；不可达时退回 resolve */
function normalizeLocalPath(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  try {
    return path.normalize(fs.realpathSync.native(resolvedPath));
  } catch {
    return path.normalize(resolvedPath);
  }
}

/** 把新 worktree 写入需求任务中主仓库匹配的项目条目；尽力而为，不抛出（结果随响应返回） */
async function attachWorktreeToRequirementTask(requirementTaskId, repoPath, worktreePath) {
  try {
    const taskRecord = await persistenceManager.findRequirementTaskById(requirementTaskId);
    if (!taskRecord) {
      return { attached: false, message: '关联的需求任务不存在（可能已被删除）' };
    }
    const normalizedRepoPath = normalizeLocalPath(repoPath);
    // 与 core/normalizePathForComparison 同语义：native realpath 展开短路径并统一斜杠
    const normalizedWorktreePath = normalizeLocalPath(worktreePath);
    const matchedIndexList = [];
    const nextProjectList = (taskRecord.projectList || []).map((projectEntry, entryIndex) => {
      if (normalizeLocalPath(projectEntry.repoPath) === normalizedRepoPath) {
        matchedIndexList.push(entryIndex);
        return { ...projectEntry, worktreePath: normalizedWorktreePath };
      }
      return projectEntry;
    });
    if (matchedIndexList.length === 0) {
      return { attached: false, message: '需求任务中没有主仓库匹配的项目条目' };
    }
    await persistenceManager.updateRequirementTaskRecord(requirementTaskId, {
      projectList: nextProjectList,
      updatedAt: new Date().toISOString()
    });
    return { attached: true, message: `已关联到需求任务（${taskRecord.branchName}），并挂载到匹配的项目条目` };
  } catch (attachError) {
    return { attached: false, message: `关联写入失败: ${attachError.message}` };
  }
}

/** 写入创建历史记录；返回告警文案（成功返回 null），绝不抛出 */
async function recordCreationHistory(historyInput) {
  try {
    await persistenceManager.insertWorktreeHistoryRecord({
      id: randomUUID(),
      repoPath: historyInput.repoPath,
      branchName: historyInput.branchName,
      targetPath: historyInput.targetPath,
      dependencyStrategy: historyInput.dependencyStrategy,
      outcome: historyInput.outcome,
      failureReason: historyInput.failureReason,
      warnings: historyInput.warningList,
      createdAt: historyInput.startedAtIso,
      completedAt: new Date().toISOString()
    });
    return null;
  } catch (historyError) {
    const warningText = `创建历史记录写入失败: ${historyError.message}`;
    console.warn(`[storage] ${warningText}`);
    return warningText;
  }
}
