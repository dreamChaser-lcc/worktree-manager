import fs from 'node:fs';
import path from 'node:path';
import { executeGitCommand } from './git-executor.js';
import { ValidationError } from './errors.js';

/** 目录是否是有效 git 仓库（工作树） */
export async function isGitRepository(dirPath) {
  try {
    const result = await executeGitCommand(dirPath, ['rev-parse', '--is-inside-work-tree']);
    return result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** 断言目录存在且是目录，否则抛 ValidationError */
export function assertDirectoryExists(dirPath, descriptionText) {
  if (!fs.existsSync(dirPath)) {
    throw new ValidationError(`${descriptionText}不存在: ${dirPath}`);
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    throw new ValidationError(`${descriptionText}不是目录: ${dirPath}`);
  }
}

/**
 * 断言目标路径可用于创建 worktree：
 * 不存在，或存在但为空目录。
 */
export function assertTargetPathAvailable(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  const remainingEntries = fs.readdirSync(targetPath);
  if (remainingEntries.length > 0) {
    throw new ValidationError(`目标路径已存在且非空: ${targetPath}`);
  }
}

/**
 * 断言目标路径不在主仓库工作目录内部。
 * 嵌套 worktree 会持续污染主仓库的 git status，必须拒绝。
 */
export function assertNotNestedInRepository(repoPath, targetPath) {
  const resolvedRepoPath = path.resolve(repoPath);
  const resolvedTargetPath = path.resolve(targetPath);

  if (resolvedTargetPath === resolvedRepoPath) {
    throw new ValidationError('目标路径不能与主仓库目录相同');
  }

  const relativePath = path.relative(resolvedRepoPath, resolvedTargetPath);
  const isTargetInsideRepo = relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
  if (isTargetInsideRepo) {
    throw new ValidationError(`目标路径位于主仓库内部，会污染 git 状态: ${resolvedTargetPath}`);
  }
}

/**
 * 断言两个路径位于同一磁盘卷（junction/硬链接均要求同卷）。
 */
export function assertSameVolume(firstPath, secondPath) {
  const firstRoot = path.parse(path.resolve(firstPath)).root.toLowerCase();
  const secondRoot = path.parse(path.resolve(secondPath)).root.toLowerCase();
  if (firstRoot !== secondRoot) {
    throw new ValidationError(`主仓库与目标路径不在同一磁盘卷(${firstRoot} 与 ${secondRoot})，无法建立链接`);
  }
}

/**
 * 校验分支名合法性（对齐 git check-ref-format 的常用规则子集）。
 */
export function assertValidBranchName(branchName) {
  const invalidReasonList = [];

  if (!branchName || branchName.trim() === '') {
    invalidReasonList.push('分支名不能为空');
  }
  if (/^\//.test(branchName) || /\/$/.test(branchName) || branchName.includes('//')) {
    invalidReasonList.push('分支名不能以斜杠开头/结尾或包含连续斜杠');
  }
  if (branchName.endsWith('.') || branchName.endsWith('.lock')) {
    invalidReasonList.push('分支名不能以点或 .lock 结尾');
  }
  if (branchName.includes('..')) {
    invalidReasonList.push('分支名不能包含连续两点');
  }
  if (/[\s~^:?*[\\\u007f]/.test(branchName)) {
    invalidReasonList.push('分支名包含非法字符（空格、~、^、:、?、*、[、\\ 等）');
  }
  if (/^-/.test(branchName)) {
    invalidReasonList.push('分支名不能以短横线开头');
  }

  if (invalidReasonList.length > 0) {
    throw new ValidationError(`非法分支名 "${branchName}": ${invalidReasonList.join('；')}`);
  }
}
