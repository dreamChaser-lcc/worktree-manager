import Router from '@koa/router';
import fs from 'node:fs';
import path from 'node:path';
import { isGitRepository } from '../core/validators.js';
import { executeGitCommand } from '../core/git-executor.js';
import { revealInExplorer } from '../core/explorer-revealer.js';
import { openWorkspaceInHerdr, closeWorkspaceInHerdr } from '../core/herdr-opener.js';
import { persistenceManager } from '../storage/persistence-manager.js';
import { NotFoundError, ValidationError } from '../core/errors.js';

/** 目录浏览与 git 仓库校验路由：支撑前端目录选择器 */
export function registerFilesystemRoutes(router) {
  // Windows 盘符探测（A-Z 逐个探测存在性）
  router.get('/api/filesystem/drives', async (context) => {
    if (process.platform !== 'win32') {
      context.body = { drives: [{ name: '/', path: path.parse(process.cwd()).root }] };
      return;
    }

    const driveEntryList = [];
    for (let driveCharCode = 65; driveCharCode <= 90; driveCharCode += 1) {
      const drivePath = `${String.fromCharCode(driveCharCode)}:\\`;
      if (fs.existsSync(drivePath)) {
        driveEntryList.push({ name: `${String.fromCharCode(driveCharCode)}:`, path: drivePath });
      }
    }
    context.body = { drives: driveEntryList };
  });

  // 列出目录下的子目录
  router.get('/api/filesystem/directory', async (context) => {
    const targetDirectoryPath = requireValidDirectory(context.query.path);

    const parentPath = path.dirname(targetDirectoryPath);
    const directoryEntryList = [];
    for (const entryName of fs.readdirSync(targetDirectoryPath)) {
      const entryPath = path.join(targetDirectoryPath, entryName);
      let isEntryDirectory = false;
      try {
        isEntryDirectory = fs.statSync(entryPath).isDirectory();
      } catch {
        continue; // 无权限等异常条目直接跳过
      }
      if (isEntryDirectory) {
        directoryEntryList.push({ name: entryName, path: entryPath });
      }
    }
    directoryEntryList.sort((firstEntry, secondEntry) => firstEntry.name.localeCompare(secondEntry.name));

    const atDriveRoot = parentPath === targetDirectoryPath;
    context.body = {
      currentPath: targetDirectoryPath,
      parentPath: atDriveRoot ? null : parentPath,
      directories: directoryEntryList
    };
  });

  // 在系统文件管理器中显示路径（文件则定位选中，目录则直接打开）
  router.post('/api/filesystem/reveal', async (context) => {
    const targetPath = context.request.body?.targetPath;
    if (!targetPath || typeof targetPath !== 'string') {
      throw new ValidationError('缺少 targetPath');
    }
    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new NotFoundError(`路径不存在: ${resolvedPath}`);
    }
    context.body = revealInExplorer(resolvedPath);
  });

  // 在 herdr 里打开（或复用）工作区：工作目录指向 targetPath（传 .code-workspace 文件时取其所在目录）
  router.post('/api/filesystem/open-herdr', async (context) => {
    const targetPath = context.request.body?.targetPath;
    const label = context.request.body?.label;
    const startServer = Boolean(context.request.body?.startServer);
    if (!targetPath || typeof targetPath !== 'string') {
      throw new ValidationError('缺少 targetPath');
    }
    context.body = await openWorkspaceInHerdr({ targetPath, label, startServer });
  });

  // 关闭该需求在 herdr 里的工作区（删掉对应终端，窗格进程一并结束）
  router.post('/api/filesystem/close-herdr', async (context) => {
    const targetPath = context.request.body?.targetPath;
    const label = context.request.body?.label;
    if (!targetPath || typeof targetPath !== 'string') {
      throw new ValidationError('缺少 targetPath');
    }
    context.body = closeWorkspaceInHerdr({ targetPath, label });
  });

  // 实时校验所选目录是否为 git 仓库
  router.get('/api/filesystem/repository-check', async (context) => {
    const targetDirectoryPath = requireValidDirectory(context.query.path);

    const repositoryExists = await isGitRepository(targetDirectoryPath);
    let currentBranchName = null;
    if (repositoryExists) {
      try {
        const branchResult = await executeGitCommand(targetDirectoryPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
        currentBranchName = branchResult.stdout.trim();
      } catch {
        currentBranchName = null;
      }
      // 校验通过视为一次使用：写入最近主仓库记录（LRU-10，内部已捕获异常）
      persistenceManager.upsertRecentRepoPath(targetDirectoryPath);
    }
    context.body = { path: targetDirectoryPath, isGitRepository: repositoryExists, currentBranch: currentBranchName };
  });
}

function requireValidDirectory(queryPath) {
  if (!queryPath) {
    throw new ValidationError('缺少 path 参数');
  }
  const resolvedPath = path.resolve(queryPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new NotFoundError(`路径不存在: ${resolvedPath}`);
  }
  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new ValidationError(`路径不是目录: ${resolvedPath}`);
  }
  return resolvedPath;
}
