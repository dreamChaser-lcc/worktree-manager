import fs from 'node:fs';
import path from 'node:path';
import { executeGitCommand } from './git-executor.js';
import { ValidationError, ConflictError, NotFoundError } from './errors.js';
import { removeDirectoryTree } from './directory-remover.js';
import {
  isGitRepository,
  assertTargetPathAvailable,
  assertNotNestedInRepository,
  assertValidBranchName
} from './validators.js';

/**
 * 路径规范化比对基准：
 * 1. path.resolve 统一为绝对路径
 * 2. 已存在的路径用 realpathSync.native 展开 Windows 8.3 短路径(ADMINI~1)并统一盘符大小写，
 *    与 git 输出的长路径对齐；不存在的路径保留 resolve 结果。
 */
function normalizePathForComparison(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  try {
    return path.normalize(fs.realpathSync.native(resolvedPath));
  } catch {
    return path.normalize(resolvedPath);
  }
}

/** worktree 信息：路径 / 分支 / HEAD / 脏状态 / 是否主 worktree / 目录是否已失效 */
export async function listWorktrees(repoPath) {
  const porcelainOutput = await executeGitCommand(repoPath, ['worktree', 'list', '--porcelain']);
  const mainWorktreePath = await getMainWorktreePath(repoPath);

  const worktreeEntryList = [];
  let currentEntry = {};

  for (const rawLine of porcelainOutput.stdout.split('\n')) {
    const lineText = rawLine.trim();
    if (lineText === '') {
      if (currentEntry.path) {
        worktreeEntryList.push(currentEntry);
      }
      currentEntry = {};
      continue;
    }
    const [fieldName, ...fieldValueParts] = lineText.split(' ');
    const fieldValue = fieldValueParts.join(' ');
    if (fieldName === 'worktree') {
      currentEntry = { path: normalizePathForComparison(fieldValue) };
    } else if (fieldName === 'HEAD') {
      currentEntry.head = fieldValue;
    } else if (fieldName === 'branch') {
      currentEntry.branch = fieldValue.replace('refs/heads/', '');
    } else if (fieldName === 'detached') {
      currentEntry.detached = true;
    } else if (fieldName === 'bare') {
      currentEntry.bare = true;
    }
  }
  if (currentEntry.path) {
    worktreeEntryList.push(currentEntry);
  }

  // 逐个补充脏状态与失效标记（worktree 数量通常个位数，串行足够快）
  for (const worktreeEntry of worktreeEntryList) {
    worktreeEntry.isMain = worktreeEntry.path === mainWorktreePath;
    worktreeEntry.stale = !fs.existsSync(worktreeEntry.path);
    worktreeEntry.isDirty = false;
    if (!worktreeEntry.stale && !worktreeEntry.bare) {
      try {
        const statusResult = await executeGitCommand(worktreeEntry.path, ['status', '--porcelain']);
        worktreeEntry.isDirty = statusResult.stdout.trim() !== '';
      } catch {
        // 状态查询失败不阻塞列表展示
      }
    }
  }

  return worktreeEntryList;
}

/** 主 worktree 路径 = git 公共目录（主仓库 .git）所在目录 */
export async function getMainWorktreePath(repoPath) {
  const commonDirResult = await executeGitCommand(repoPath, [
    'rev-parse', '--path-format=absolute', '--git-common-dir'
  ]);
  // git 公共目录形如 <主仓库>/.git，取 dirname 即主 worktree 路径
  return normalizePathForComparison(path.dirname(commonDirResult.stdout.trim()));
}

/** 分支占用映射：branchName → 占用它的 worktree 路径 */
export async function getBranchOccupationMap(repoPath) {
  const worktreeEntryList = await listWorktrees(repoPath);
  const occupationMap = {};
  for (const worktreeEntry of worktreeEntryList) {
    if (worktreeEntry.branch) {
      occupationMap[worktreeEntry.branch] = worktreeEntry.path;
    }
  }
  return occupationMap;
}

/**
 * 创建 worktree。
 * branchMode: 'existing'（签出已有分支）| 'new'（基于 baseRef 新建分支）
 * 执行前置校验（仓库/路径/嵌套/占用/分支名），任一失败抛错且不留现场。
 */
export async function createWorktree({ repoPath, targetPath, branchMode, branchName, baseRef }) {
  if (!(await isGitRepository(repoPath))) {
    throw new ValidationError(`主目录不是有效 git 仓库: ${repoPath}`);
  }
  assertTargetPathAvailable(targetPath);
  assertNotNestedInRepository(repoPath, targetPath);
  assertValidBranchName(branchName);

  const branchOccupationMap = await getBranchOccupationMap(repoPath);

  if (branchMode === 'existing') {
    if (branchOccupationMap[branchName]) {
      throw new ConflictError(`分支 "${branchName}" 已被其他 worktree 签出: ${branchOccupationMap[branchName]}`, {
        details: { occupiedBy: branchOccupationMap[branchName] }
      });
    }
    await executeGitCommand(repoPath, ['worktree', 'add', targetPath, branchName]);
  } else if (branchMode === 'new') {
    const branchExists = await doesLocalBranchExist(repoPath, branchName);
    if (branchExists) {
      throw new ConflictError(`本地分支 "${branchName}" 已存在，不能重复创建`);
    }
    const addArguments = ['worktree', 'add', '-b', branchName, targetPath];
    if (baseRef) {
      addArguments.push(baseRef);
    }
    await executeGitCommand(repoPath, addArguments);
  } else {
    throw new ValidationError(`未知的分支模式: ${branchMode}`);
  }

  const headResult = await executeGitCommand(targetPath, ['rev-parse', 'HEAD']);
  return { path: normalizePathForComparison(targetPath), branch: branchName, head: headResult.stdout.trim() };
}

async function doesLocalBranchExist(repoPath, branchName) {
  const verifyResult = await executeGitCommand(
    repoPath,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
    { allowNonZeroExit: true }
  );
  return verifyResult.exitCode === 0;
}

/**
 * 删除 worktree（三道安全拦截：主 worktree 禁删 / 未提交修改需 force / 未合并提交提示）。
 * deleteDirectory（默认 true）：git 原生删除失败（Windows 上常见于 junction/被忽略文件
 * 导致 "Directory not empty"）时，回退为 junction 感知的手动目录清理 + prune 清记录。
 * 返回 { removed, directoryDeleted, unmergedCommitCount, defaultBranch }。
 */
export async function removeWorktree({ repoPath, targetPath, force, deleteDirectory = true }) {
  const normalizedTargetPath = normalizePathForComparison(targetPath);
  const mainWorktreePath = await getMainWorktreePath(repoPath);

  if (normalizedTargetPath === mainWorktreePath) {
    throw new ConflictError('主 worktree 不可删除', { details: { targetPath: normalizedTargetPath } });
  }

  const worktreeEntryList = await listWorktrees(repoPath);
  const targetEntry = worktreeEntryEntryByPath(worktreeEntryList, normalizedTargetPath);
  if (!targetEntry) {
    throw new NotFoundError(`目标路径不是已登记的 worktree: ${normalizedTargetPath}`);
  }

  let uncommittedFileList = [];
  const unmergedCommitCount = await getUnmergedCommitCount(repoPath, targetEntry.branch);

  if (!targetEntry.stale) {
    const statusResult = await executeGitCommand(normalizedTargetPath, ['status', '--porcelain']);
    uncommittedFileList = statusResult.stdout
      .split('\n')
      .map((lineText) => lineText.trim())
      .filter(Boolean);

    if (uncommittedFileList.length > 0 && !force) {
      throw new ConflictError(
        `worktree 存在 ${uncommittedFileList.length} 处未提交修改，需显式确认强制删除`,
        { details: { uncommittedFiles: uncommittedFileList, unmergedCommitCount } }
      );
    }
  }


  if (deleteDirectory) {
    // 安全路径（默认）：绝不把含链接的目录交给 git 递归删除——
    // 实测 git 2.46/Windows 的 worktree remove 会跟随 junction 删除目标内容，
    // 直接破坏共享主目录依赖。改为：先 junction 感知删除目录，再 prune 清记录。
    if (fs.existsSync(normalizedTargetPath)) {
      removeDirectoryTree(normalizedTargetPath);
    }
    await pruneWorktrees(repoPath);

    const remainingEntry = worktreeEntryEntryByPath(await listWorktrees(repoPath), normalizedTargetPath);
    if (remainingEntry && !remainingEntry.stale) {
      throw new ConflictError('worktree 目录已删除但 git 记录清理失败，请尝试 prune', {
        details: { targetPath: normalizedTargetPath }
      });
    }
  } else {
    // 用户显式关闭目录清理：走 git 原生删除（含其对链接目录的自身行为）
    const removeArguments = ['worktree', 'remove'];
    if (force) {
      removeArguments.push('--force');
    }
    removeArguments.push(normalizedTargetPath);
    await executeGitCommand(repoPath, removeArguments);
  }

  return {
    removed: true,
    directoryDeleted: deleteDirectory,
    unmergedCommitCount,
    defaultBranch: await detectDefaultBranch(repoPath)
  };
}

function worktreeEntryEntryByPath(worktreeEntryList, normalizedTargetPath) {
  return worktreeEntryList.find((entry) => entry.path === normalizedTargetPath) || null;
}

/** 探测默认分支：origin/HEAD → origin/main → origin/master → main → master，均无则 null */
export async function detectDefaultBranch(repoPath) {
  const symbolicResult = await executeGitCommand(
    repoPath,
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    { allowNonZeroExit: true }
  );
  if (symbolicResult.exitCode === 0 && symbolicResult.stdout.trim()) {
    return symbolicResult.stdout.trim().replace('origin/', '');
  }

  for (const candidateBranch of ['origin/main', 'origin/master', 'main', 'master']) {
    const verifyResult = await executeGitCommand(
      repoPath,
      ['rev-parse', '--verify', '--quiet', candidateBranch],
      { allowNonZeroExit: true }
    );
    if (verifyResult.exitCode === 0) {
      return candidateBranch.replace(/^origin\//, '');
    }
  }
  return null;
}

/** 分支领先默认分支的提交数；无法判定默认分支时返回 null */
export async function getUnmergedCommitCount(repoPath, branchName) {
  if (!branchName) {
    return null;
  }
  const defaultBranch = await detectDefaultBranch(repoPath);
  if (!defaultBranch || defaultBranch === branchName) {
    return null;
  }
  const countResult = await executeGitCommand(
    repoPath,
    ['rev-list', '--count', `${defaultBranch}..${branchName}`],
    { allowNonZeroExit: true }
  );
  return countResult.exitCode === 0 ? Number(countResult.stdout.trim()) : null;
}

/** 清理失效 worktree 记录，返回清理数量。
 *  实测（git 2.46 / Windows）：prune --verbose 的 "Removing worktrees/..." 输出在 stderr。
 */
export async function pruneWorktrees(repoPath) {
  const pruneResult = await executeGitCommand(repoPath, ['worktree', 'prune', '--verbose']);
  const prunedCount = pruneResult.stderr
    .split('\n')
    .map((lineText) => lineText.trim())
    .filter((lineText) => lineText.startsWith('Removing worktrees/')).length;
  return { prunedCount };
}
