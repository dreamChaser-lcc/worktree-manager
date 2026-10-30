import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertSameVolume } from './validators.js';
import { ValidationError } from './errors.js';

/** lockfile → 包管理器 检测规则（按顺序优先匹配） */
const LOCK_FILE_DETECTION_RULES = [
  { lockFileName: 'pnpm-lock.yaml', packageManagerName: 'pnpm' },
  { lockFileName: 'package-lock.json', packageManagerName: 'npm' },
  { lockFileName: 'yarn.lock', packageManagerName: 'yarn' }
];

/** 检测主仓库使用的包管理器；无任何已知 lockfile 时返回 null */
export function detectPackageManager(repoPath) {
  for (const detectionRule of LOCK_FILE_DETECTION_RULES) {
    if (fs.existsSync(path.join(repoPath, detectionRule.lockFileName))) {
      return detectionRule.packageManagerName;
    }
  }
  return null;
}

/** 按设计 D4 的策略矩阵给出默认推荐：pnpm → 独立安装，npm/yarn → junction 共享 */
export function recommendDependencyStrategy(packageManagerName) {
  if (packageManagerName === 'pnpm') {
    return 'install';
  }
  if (packageManagerName === 'npm' || packageManagerName === 'yarn') {
    return 'share';
  }
  return null;
}

/**
 * junction 共享：把主仓库 node_modules 以目录联接方式挂到 worktree。
 * 前置：主仓库 node_modules 存在；同磁盘卷；worktree 内无占用内容。
 */
export function applySharedDependencyLink({ repoPath, worktreePath }) {
  const mainNodeModulesPath = path.join(repoPath, 'node_modules');
  const worktreeNodeModulesPath = path.join(worktreePath, 'node_modules');

  if (!fs.existsSync(mainNodeModulesPath)) {
    throw new ValidationError(`主仓库尚未安装依赖(node_modules 不存在)，请先在主目录完成安装: ${mainNodeModulesPath}`);
  }
  if (!fs.statSync(mainNodeModulesPath).isDirectory()) {
    throw new ValidationError(`主仓库 node_modules 不是目录: ${mainNodeModulesPath}`);
  }
  assertSameVolume(repoPath, worktreePath);

  if (fs.existsSync(worktreeNodeModulesPath)) {
    const existingEntries = fs.readdirSync(worktreeNodeModulesPath);
    if (existingEntries.length > 0) {
      throw new ValidationError(`worktree 内已存在非空 node_modules，拒绝覆盖: ${worktreeNodeModulesPath}`);
    }
    fs.rmdirSync(worktreeNodeModulesPath);
  }

  fs.symlinkSync(mainNodeModulesPath, worktreeNodeModulesPath, 'junction');

  // 链接可读性自检：能列目录才算建链成功
  fs.readdirSync(worktreeNodeModulesPath);

  return { status: 'linked', linkPath: worktreeNodeModulesPath, targetPath: mainNodeModulesPath };
}

/**
 * 独立安装：在 worktree 内用对应包管理器安装依赖。
 * 返回子进程（由调用方消费输出流，如 job-runner），不在此等待完成。
 */
export function startIndependentInstall({ worktreePath, packageManagerName }) {
  const effectivePackageManager = packageManagerName || detectPackageManager(worktreePath);
  if (!effectivePackageManager) {
    throw new ValidationError('未检测到包管理器，无法独立安装（缺少 lockfile）');
  }

  const installArguments = effectivePackageManager === 'yarn' ? ['install'] : ['install'];
  const installProcess = spawn(effectivePackageManager, installArguments, {
    cwd: worktreePath,
    windowsHide: true,
    shell: process.platform === 'win32' // Windows 下 pnpm/npm 多为 .cmd，需要 shell 解析
  });

  return { installProcess, packageManagerName: effectivePackageManager, commandLine: `${effectivePackageManager} install` };
}
