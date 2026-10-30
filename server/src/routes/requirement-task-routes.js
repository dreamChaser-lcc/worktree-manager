import Router from '@koa/router';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { persistenceManager } from '../storage/persistence-manager.js';
import { generateWorkspaceFileForTask } from '../core/workspace-file-generator.js';
import { listWorktrees, removeWorktree, createWorktree, normalizePathForComparison } from '../core/worktree-manager.js';
import { executeGitCommand } from '../core/git-executor.js';
import { detectPackageManager } from '../core/dep-linker.js';
import { checkWorktreeDependencyStatus } from '../core/dependency-risk-checker.js';
import { startProcessJob } from '../jobs/job-runner.js';
import { ValidationError, NotFoundError, ConflictError } from '../core/errors.js';

/**
 * 需求任务路由：以需求为维度维护分支与多项目 worktree 的关联列表。
 * 保存时可生成 .code-workspace 工作区文件（generateWorkspace 默认开启），
 * 也可通过 generate-workspace 端点手动重新生成。
 */
export function registerRequirementTaskRoutes(router) {
  router.get('/api/requirement-tasks', async (context) => {
    context.body = { tasks: await persistenceManager.listRequirementTaskRecords() };
  });

  router.post('/api/requirement-tasks', async (context) => {
    const requestBody = context.request.body || {};
    const taskInput = normalizeRequirementTaskInput(requestBody);
    const timestampIso = new Date().toISOString();
    const taskRecord = {
      id: randomUUID(),
      ...taskInput,
      workspaceFilePath: null,
      createdAt: timestampIso,
      updatedAt: timestampIso
    };
    await persistenceManager.insertRequirementTaskRecord(taskRecord);

    let workspaceResult = null;
    if (requestBody.generateWorkspace !== false) {
      workspaceResult = await generateAndAttachWorkspace(taskRecord);
      taskRecord.workspaceFilePath = workspaceResult ? workspaceResult.workspaceFilePath : null;
    }

    context.body = { task: taskRecord, workspace: workspaceResult };
  });

  router.put('/api/requirement-tasks/:taskId', async (context) => {
    const taskId = context.params.taskId;
    const existingRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!existingRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }
    const requestBody = context.request.body || {};
    const taskInput = normalizeRequirementTaskInput(requestBody);
    const updatedRecord = await persistenceManager.updateRequirementTaskRecord(taskId, {
      ...taskInput,
      updatedAt: new Date().toISOString()
    });

    let workspaceResult = null;
    if (requestBody.generateWorkspace !== false) {
      workspaceResult = await generateAndAttachWorkspace(updatedRecord);
      updatedRecord.workspaceFilePath = workspaceResult ? workspaceResult.workspaceFilePath : null;
    }

    context.body = { task: updatedRecord, workspace: workspaceResult };
  });

  // 手动重新生成工作区文件
  router.post('/api/requirement-tasks/:taskId/generate-workspace', async (context) => {
    const taskId = context.params.taskId;
    const existingRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!existingRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }
    const workspaceResult = await generateAndAttachWorkspace(existingRecord);
    context.body = { workspace: workspaceResult };
  });

  // 分支定位：逐项目返回该主仓库的 worktree 实时清单（含各自当前分支），
  // 由前端计算关联 worktree 当前分支、是否与需求分支一致、需求分支签出位置
  router.get('/api/requirement-tasks/:taskId/locate', async (context) => {
    const taskId = context.params.taskId;
    const taskRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!taskRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }

    const projectLocateList = [];
    for (const projectEntry of taskRecord.projectList || []) {
      const locateEntry = {
        projectName: projectEntry.projectName,
        repoPath: projectEntry.repoPath,
        worktreePath: projectEntry.worktreePath,
        worktreeList: [],
        gitRemoteUrl: null,
        gitWebUrl: null,
        locateError: null
      };
      if (projectEntry.repoPath) {
        try {
          const worktreeEntryList = await listWorktrees(projectEntry.repoPath);
          locateEntry.worktreeList = worktreeEntryList.map((worktreeEntry) => ({
            path: worktreeEntry.path,
            branch: worktreeEntry.branch,
            isMain: worktreeEntry.isMain,
            isDirty: worktreeEntry.isDirty,
            stale: worktreeEntry.stale
          }));
        } catch (locateError) {
          locateEntry.locateError = locateError.message;
        }
        const gitRemoteUrl = await readProjectRemoteUrl(projectEntry.repoPath);
        locateEntry.gitRemoteUrl = gitRemoteUrl;
        locateEntry.gitWebUrl = convertRemoteUrlToWebUrl(gitRemoteUrl);
      }
      projectLocateList.push(locateEntry);
    }

    context.body = { branchName: taskRecord.branchName, projectList: projectLocateList };
  });

  // 依赖检查：逐项目判断 tree 依赖与主目录是否一致，共享且声明不一致即高风险
  router.get('/api/requirement-tasks/:taskId/dependency-check', async (context) => {
    const taskId = context.params.taskId;
    const taskRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!taskRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }

    const projectDependencyList = [];
    for (const projectEntry of taskRecord.projectList || []) {
      if (!projectEntry.worktreePath) {
        projectDependencyList.push({
          projectName: projectEntry.projectName,
          worktreePath: null,
          dependencyMode: 'none',
          packageManager: null,
          riskLevel: 'none',
          riskMessage: '未关联 worktree',
          diffList: []
        });
        continue;
      }
      let dependencyStatus;
      try {
        dependencyStatus = checkWorktreeDependencyStatus({
          worktreePath: projectEntry.worktreePath,
          repoPath: projectEntry.repoPath
        });
      } catch (checkError) {
        dependencyStatus = {
          dependencyMode: 'unknown',
          packageManager: null,
          riskLevel: 'none',
          riskMessage: `检查失败: ${checkError.message}`,
          diffList: []
        };
      }
      projectDependencyList.push({
        projectName: projectEntry.projectName,
        worktreePath: projectEntry.worktreePath,
        ...dependencyStatus
      });
    }

    context.body = { projectList: projectDependencyList };
  });

  // 独立安装：对指定项目的 worktree 执行独立依赖安装（异步任务，SSE 可查）
  router.post('/api/requirement-tasks/:taskId/install-independent', async (context) => {
    const taskId = context.params.taskId;
    const taskRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!taskRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }

    const requestBody = context.request.body || {};
    const targetWorktreePath = requestBody.worktreePath;
    if (!targetWorktreePath || typeof targetWorktreePath !== 'string') {
      throw new ValidationError('缺少 worktreePath');
    }
    const matchedProjectEntry = (taskRecord.projectList || []).find(
      (projectEntry) => projectEntry.worktreePath === targetWorktreePath
    );
    if (!matchedProjectEntry) {
      throw new ValidationError(`该项目未关联此 worktree: ${targetWorktreePath}`);
    }

    const packageManagerName = detectPackageManager(targetWorktreePath);
    if (!packageManagerName) {
      throw new ValidationError(
        `未检测到包管理器（worktree 缺少 lockfile），无法独立安装: ${targetWorktreePath}`
      );
    }

    // 若 node_modules 是共享 junction，先只断开链接本身（不删主目录内容），避免 install 写穿主目录
    let junctionRemoved = false;
    const nodeModulesPath = path.join(targetWorktreePath, 'node_modules');
    try {
      const nodeModulesLinkStat = fs.lstatSync(nodeModulesPath);
      if (nodeModulesLinkStat.isSymbolicLink()) {
        fs.rmdirSync(nodeModulesPath);
        junctionRemoved = true;
      }
    } catch {
      // 不存在或删除失败时按原状继续（真实目录不会被删除）
    }

    const { job } = startProcessJob({
      jobName: `install-independent:${matchedProjectEntry.projectName}`,
      command: packageManagerName,
      commandArguments: ['install'],
      cwd: targetWorktreePath
    });

    context.body = {
      jobId: job.id,
      packageManager: packageManagerName,
      worktreePath: targetWorktreePath,
      junctionRemoved
    };
  });

  // 删除需求任务（软删除）：移除关联 worktree 与其文件目录，git 分支（本地/远程）一律保留；
  // 删除前记录每个 worktree 当时的实际分支（lastBranch），供恢复按原分支重建
  router.delete('/api/requirement-tasks/:taskId', async (context) => {
    const taskId = context.params.taskId;
    const taskRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!taskRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }
    if (taskRecord.deletedAt) {
      throw new ConflictError('该需求任务已处于删除状态，可直接点击恢复');
    }

    const { removedWorktreeList, failedList, branchAtRemovalMap } = await removeTaskWorktrees(taskRecord, {
      recordBranch: true
    });

    if (failedList.length > 0) {
      // 存在失败（如未提交修改被拦截）：中止删除，保留现场供用户处理
      context.status = 409;
      context.body = {
        error: '部分关联 worktree 删除失败，已中止本次需求删除（分支与现场均已保留）',
        details: { failedList, removedWorktreeList }
      };
      return;
    }

    // 把删除前的实际分支写回项目条目（lastBranch），恢复时按它重建
    const nextProjectList = (taskRecord.projectList || []).map((projectEntry) => ({
      ...projectEntry,
      lastBranch: branchAtRemovalMap[projectEntry.worktreePath] || projectEntry.lastBranch || null
    }));

    // 删除工作区文件（生成物，恢复时会自动重新生成）；需求目录若已空则一并移除
    let workspaceFileDeleted = false;
    if (taskRecord.workspaceFilePath) {
      try {
        fs.rmSync(taskRecord.workspaceFilePath, { force: true });
        workspaceFileDeleted = true;
      } catch {
        workspaceFileDeleted = false;
      }
      try {
        fs.rmdirSync(path.dirname(taskRecord.workspaceFilePath));
      } catch {
        // 目录非空（还有其他文件）则保留
      }
    }

    await persistenceManager.updateRequirementTaskRecord(taskId, {
      deletedAt: new Date().toISOString(),
      projectList: nextProjectList
    });
    context.body = {
      removedWorktreeList,
      workspaceFileDeleted,
      note: '已删除关联 worktree 及其文件目录与工作区文件；git 分支（本地与远程）均已保留，可通过恢复重建 worktree'
    };
  });

  // 彻底删除：移除关联 worktree 与目录、删除工作区文件后，物理删除任务记录（不可恢复；git 分支保留）
  router.delete('/api/requirement-tasks/:taskId/permanent', async (context) => {
    const taskId = context.params.taskId;
    const taskRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!taskRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }

    const { removedWorktreeList, failedList } = await removeTaskWorktrees(taskRecord);
    if (failedList.length > 0) {
      context.status = 409;
      context.body = {
        error: '部分关联 worktree 删除失败，已中止彻底删除（现场已保留）',
        details: { failedList, removedWorktreeList }
      };
      return;
    }

    let workspaceFileDeleted = false;
    if (taskRecord.workspaceFilePath) {
      try {
        fs.rmSync(taskRecord.workspaceFilePath, { force: true });
        workspaceFileDeleted = true;
      } catch {
        workspaceFileDeleted = false;
      }
    }

    const removedCount = await persistenceManager.deleteRequirementTaskRecord(taskId);
    if (removedCount === 0) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }
    context.body = {
      permanent: true,
      removedWorktreeList,
      workspaceFileDeleted,
      note: '已彻底删除：任务记录、关联 worktree 与文件目录、工作区文件均已移除；git 分支（本地与远程）均已保留'
    };
  });

  // 恢复：按删除前记录的主仓库/目标路径/需求分支重建 worktree（目录会重新生成）
  router.post('/api/requirement-tasks/:taskId/restore', async (context) => {
    const taskId = context.params.taskId;
    const taskRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!taskRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }
    if (!taskRecord.deletedAt) {
      throw new ValidationError('该需求任务未处于删除状态，无需恢复');
    }

    const restoredWorktreeList = [];
    const skippedWorktreeList = [];
    const failedList = [];
    for (const projectEntry of taskRecord.projectList || []) {
      if (!projectEntry.worktreePath || !projectEntry.repoPath) {
        continue;
      }
      // 优先按删除前该 worktree 的实际分支重建；没有记录时回退需求分支
      const recreateBranchName = projectEntry.lastBranch || taskRecord.branchName;
      try {
        // 已存在于 worktree 清单中视为恢复完成（重复恢复幂等）
        const worktreeEntryList = await listWorktrees(projectEntry.repoPath);
        const alreadyRestored = worktreeEntryList.some(
          (worktreeEntry) => worktreeEntry.branch === recreateBranchName
        );
        if (alreadyRestored) {
          skippedWorktreeList.push({
            projectName: projectEntry.projectName,
            worktreePath: projectEntry.worktreePath,
            branchName: recreateBranchName
          });
          continue;
        }
        await createWorktree({
          repoPath: projectEntry.repoPath,
          targetPath: projectEntry.worktreePath,
          branchMode: 'existing',
          branchName: recreateBranchName
        });
        restoredWorktreeList.push({
          projectName: projectEntry.projectName,
          worktreePath: projectEntry.worktreePath,
          branchName: recreateBranchName
        });
      } catch (restoreError) {
        failedList.push({
          projectName: projectEntry.projectName,
          worktreePath: projectEntry.worktreePath,
          branchName: recreateBranchName,
          reason: `${restoreError.message}（重建分支: ${recreateBranchName}）`
        });
      }
    }

    if (failedList.length > 0) {
      context.status = 409;
      context.body = {
        error: '部分 worktree 恢复失败，请核对失败原因后重试',
        details: { failedList, restoredWorktreeList, skippedWorktreeList }
      };
      return;
    }

    const updatedRecord = await persistenceManager.updateRequirementTaskRecord(taskId, {
      deletedAt: null,
      updatedAt: new Date().toISOString()
    });

    let workspaceResult = null;
    try {
      workspaceResult = await generateAndAttachWorkspace(updatedRecord);
    } catch (workspaceError) {
      workspaceResult = { error: `工作区文件重新生成失败: ${workspaceError.message}` };
    }

    context.body = { task: updatedRecord, restoredWorktreeList, skippedWorktreeList, workspace: workspaceResult };
  });
}

/** 移除需求任务关联的全部 worktree（含文件目录）；返回移除/失败清单，可选记录删除前实际分支 */
async function removeTaskWorktrees(taskRecord, options = {}) {
  const recordBranch = options.recordBranch === true;
  const removedWorktreeList = [];
  const failedList = [];
  const branchAtRemovalMap = {};

  for (const projectEntry of taskRecord.projectList || []) {
    if (!projectEntry.worktreePath) {
      continue;
    }
    if (recordBranch) {
      // 删除前记录该 worktree 当时的实际签出分支（可能与需求分支不同）
      try {
        const worktreeEntryList = await listWorktrees(projectEntry.repoPath);
        const matchedWorktreeEntry = worktreeEntryList.find((worktreeEntry) =>
          normalizePathForComparison(worktreeEntry.path) === normalizePathForComparison(projectEntry.worktreePath)
        );
        if (matchedWorktreeEntry) {
          branchAtRemovalMap[projectEntry.worktreePath] = matchedWorktreeEntry.branch || null;
        }
      } catch {
        // 清单读取失败不阻断删除，lastBranch 留空由恢复流程回退需求分支
      }
    }
    try {
      await removeWorktree({
        repoPath: projectEntry.repoPath,
        targetPath: projectEntry.worktreePath,
        force: false,
        deleteDirectory: true
      });
      removedWorktreeList.push({
        projectName: projectEntry.projectName,
        worktreePath: projectEntry.worktreePath,
        branchName: branchAtRemovalMap[projectEntry.worktreePath] || null
      });
    } catch (removeError) {
      // 目标已不是登记中的 worktree（此前已删除）视为成功
      if (removeError instanceof NotFoundError) {
        removedWorktreeList.push({
          projectName: projectEntry.projectName,
          worktreePath: projectEntry.worktreePath,
          branchName: branchAtRemovalMap[projectEntry.worktreePath] || null
        });
        continue;
      }
      failedList.push({
        projectName: projectEntry.projectName,
        worktreePath: projectEntry.worktreePath,
        reason: removeError.message
      });
    }
  }

  return { removedWorktreeList, failedList, branchAtRemovalMap };
}

/** 生成工作区文件并把路径写回需求记录；返回 workspace 结果对象（内容可能含排除项说明） */
async function generateAndAttachWorkspace(taskRecord) {
  const workspaceResult = await generateWorkspaceFileForTask(taskRecord, persistenceManager.getWorkspaceDirectoryPath(), {
    groupWorktreesByRequirement: persistenceManager.getWorkspaceLayoutEnabled()
  });
  await persistenceManager.updateRequirementTaskRecord(taskRecord.id, {
    workspaceFilePath: workspaceResult.workspaceFilePath
  });
  return workspaceResult;
}

/** 读取项目远程仓库地址：优先 origin，否则第一个远程；无远程返回 null */
async function readProjectRemoteUrl(repoPath) {
  try {
    const remoteResult = await executeGitCommand(repoPath, ['remote']);
    const remoteNameList = remoteResult.stdout
      .split(/\r?\n/)
      .map((remoteName) => remoteName.trim())
      .filter(Boolean);
    if (remoteNameList.length === 0) {
      return null;
    }
    const preferredRemoteName = remoteNameList.includes('origin') ? 'origin' : remoteNameList[0];
    const urlResult = await executeGitCommand(repoPath, ['remote', 'get-url', preferredRemoteName]);
    const remoteUrl = urlResult.stdout.trim();
    return remoteUrl || null;
  } catch {
    return null;
  }
}

/**
 * 把 git 远程地址转换为可点击的网页链接：
 * SSH 形式（git@host:group/repo.git）→ https://host/group/repo；
 * http(s) 原样返回；本地路径等无法转换的返回 null。
 */
export function convertRemoteUrlToWebUrl(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') {
    return null;
  }
  // 兼容 git@host:path 与 ssh://git@host:port/path 两种形式（端口不带入网页链接）
  const sshMatch = remoteUrl.match(/^(?:ssh:\/\/)?git@([^:/]+?)(?::\d+)?[/:](.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }
  if (/^https?:\/\//.test(remoteUrl)) {
    return remoteUrl;
  }
  return null;
}

/** 校验并规范化表单输入：需求链接/分支名称/至少一个项目（名称+主仓库路径），需求名称与预留字段可选 */
function normalizeRequirementTaskInput(requestBody) {
  const requirementNameText = typeof requestBody.requirementName === 'string' ? requestBody.requirementName.trim() : '';
  const requirementUrlText = requireNonEmptyText(requestBody.requirementUrl, '需求链接');
  const branchNameText = requireNonEmptyText(requestBody.branchName, '分支名称');
  const reservedContentText =
    typeof requestBody.reservedContent === 'string' ? requestBody.reservedContent.trim() : '';

  const rawProjectList = Array.isArray(requestBody.projectList) ? requestBody.projectList : [];
  if (rawProjectList.length === 0) {
    throw new ValidationError('至少需要一个涉及项目');
  }
  const projectList = rawProjectList.map((projectEntry, entryIndex) => ({
    projectName: requireNonEmptyText(projectEntry.projectName, `第 ${entryIndex + 1} 个项目的名称`),
    repoPath: requireNonEmptyText(projectEntry.repoPath, `第 ${entryIndex + 1} 个项目的主仓库路径`),
    worktreePath:
      typeof projectEntry.worktreePath === 'string' && projectEntry.worktreePath.trim() !== ''
        ? projectEntry.worktreePath.trim()
        : null
  }));

  return {
    requirementName: requirementNameText,
    requirementUrl: requirementUrlText,
    branchName: branchNameText,
    projectList,
    reservedContent: reservedContentText
  };
}

function requireNonEmptyText(value, fieldLabel) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${fieldLabel}不能为空`);
  }
  return value.trim();
}
