import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { removeDirectoryTree } from '../src/core/directory-remover.js';
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  translateDirectoryRemoveError
} from '../src/core/worktree-manager.js';
import { applySharedDependencyLink } from '../src/core/dep-linker.js';
import { executeGitCommand } from '../src/core/git-executor.js';
import { createFixtureRepository, commitFileInRepository } from './helpers/fixture-repo.js';

const fixtureRepository = await createFixtureRepository();
const removalWorkspaceDirectory = path.join(fixtureRepository.parentTempDir, 'removal-workspace');
fs.mkdirSync(removalWorkspaceDirectory, { recursive: true });

// 主仓库：package-lock + node_modules（junction 共享目标）+ .gitignore 忽略 node_modules
fs.writeFileSync(
  path.join(fixtureRepository.repoPath, 'package-lock.json'),
  JSON.stringify({ name: 'fixture', lockfileVersion: 3 }),
  'utf8'
);
fs.writeFileSync(path.join(fixtureRepository.repoPath, '.gitignore'), 'node_modules/\n', 'utf8');
await commitFileInRepository(fixtureRepository.repoPath, '.gitignore', 'node_modules/\n', 'ignore node_modules');
const mainDemoPackagePath = path.join(fixtureRepository.repoPath, 'node_modules', 'demo-lib');
fs.mkdirSync(mainDemoPackagePath, { recursive: true });
fs.writeFileSync(path.join(mainDemoPackagePath, 'package.json'), '{"name":"demo-lib"}', 'utf8');

afterAll(async () => {
  await fixtureRepository.cleanup();
});

describe('removeDirectoryTree（junction 感知删除）', () => {
  it('含 junction 的目录被整体删除，链接目标内容完好', () => {
    const holderDirectory = path.join(removalWorkspaceDirectory, 'dir-with-junction');
    const linkedTargetDirectory = path.join(removalWorkspaceDirectory, 'junction-target');
    fs.mkdirSync(linkedTargetDirectory, { recursive: true });
    fs.writeFileSync(path.join(linkedTargetDirectory, 'keep.txt'), 'important', 'utf8');
    fs.mkdirSync(holderDirectory, { recursive: true });
    fs.writeFileSync(path.join(holderDirectory, 'normal.txt'), 'x', 'utf8');
    fs.symlinkSync(linkedTargetDirectory, path.join(holderDirectory, 'inner-link'), 'junction');

    removeDirectoryTree(holderDirectory);

    expect(fs.existsSync(holderDirectory)).toBe(false);
    // 链接目标不受影响
    expect(fs.existsSync(path.join(linkedTargetDirectory, 'keep.txt'))).toBe(true);
    fs.rmSync(linkedTargetDirectory, { recursive: true, force: true });
  });
});

describe('translateDirectoryRemoveError（占用类错误友好提示）', () => {
  it('EBUSY/EPERM/ENOTEMPTY/EACCES 翻译为带处理建议的 409 ConflictError', () => {
    for (const errorCode of ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']) {
      const rawError = Object.assign(new Error(`${errorCode}: resource busy or locked`), { code: errorCode });
      const friendlyError = translateDirectoryRemoveError(rawError, 'D:\\some\\worktree');
      expect(friendlyError.name).toBe('ConflictError');
      expect(friendlyError.httpStatus).toBe(409);
      // 提示必须可执行：告诉用户关闭占用程序，并保留原始错误便于排查
      expect(friendlyError.message).toContain('关闭');
      expect(friendlyError.message).toContain('prune');
      expect(friendlyError.message).toContain(errorCode);
      expect(friendlyError.details).toEqual({ targetPath: 'D:\\some\\worktree', errorCode });
    }
  });

  it('非占用类错误原样返回，不掩盖真实问题', () => {
    const rawError = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    expect(translateDirectoryRemoveError(rawError, 'D:\\x')).toBe(rawError);
  });
});

describe('removeWorktree 回退清理（git 原生删除失败的典型场景）', () => {
  it('junction + 被忽略文件导致 git 删除失败时，回退清理目录与记录且主仓库依赖完好', async () => {
    const sharedWorktreePath = path.join(removalWorkspaceDirectory, 'fallback-wt');
    const createdInfo = await createWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: sharedWorktreePath,
      branchMode: 'new',
      branchName: 'feature/fallback-removal'
    });
    applySharedDependencyLink({ repoPath: fixtureRepository.repoPath, worktreePath: createdInfo.path });

    // 此时 worktree 的 status 应该是干净的（node_modules 被 gitignore）
    const statusResult = await executeGitCommand(sharedWorktreePath, ['status', '--porcelain']);
    expect(statusResult.stdout.trim()).toBe('');

    // git 原生 remove 在 Windows 上会因 junction 报 "Directory not empty"（exit 255）
    const removalResult = await removeWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: sharedWorktreePath,
      force: false,
      deleteDirectory: true
    });

    expect(removalResult.removed).toBe(true);
    // 目录与 git 记录都已被清理
    expect(fs.existsSync(sharedWorktreePath)).toBe(false);
    const worktreeEntryList = await listWorktrees(fixtureRepository.repoPath);
    expect(worktreeEntryList.find((entry) => entry.branch === 'feature/fallback-removal')).toBeUndefined();
    // 关键安全断言：junction 目标（主仓库 node_modules）内容完好
    expect(fs.existsSync(path.join(mainDemoPackagePath, 'package.json'))).toBe(true);
  }, 30_000);

  it('deleteDirectory 缺省时同样走安全清理路径且主仓库依赖完好', async () => {
    const sharedWorktreePath = path.join(removalWorkspaceDirectory, 'default-path-wt');
    const createdInfo = await createWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: sharedWorktreePath,
      branchMode: 'new',
      branchName: 'feature/default-removal'
    });
    applySharedDependencyLink({ repoPath: fixtureRepository.repoPath, worktreePath: createdInfo.path });

    // 不传 deleteDirectory（走默认值 true）
    const removalResult = await removeWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: sharedWorktreePath,
      force: false
    });

    expect(removalResult.removed).toBe(true);
    expect(removalResult.directoryDeleted).toBe(true);
    expect(fs.existsSync(sharedWorktreePath)).toBe(false);
    // 主仓库 node_modules 深层内容完好（未被 git 删穿）
    expect(fs.existsSync(path.join(mainDemoPackagePath, 'package.json'))).toBe(true);
  }, 30_000);
});
