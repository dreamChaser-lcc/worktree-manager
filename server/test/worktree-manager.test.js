import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  listWorktrees,
  getBranchOccupationMap,
  createWorktree,
  removeWorktree,
  pruneWorktrees,
  getUnmergedCommitCount
} from '../src/core/worktree-manager.js';
import { ValidationError, ConflictError, NotFoundError } from '../src/core/errors.js';
import { createFixtureRepository, commitFileInRepository } from './helpers/fixture-repo.js';

const fixtureRepository = await createFixtureRepository();
// 每个 worktree 创建在 fixture 仓库同级目录（fixture 仓库父目录下），用后统一清理
const worktreeParentDir = path.join(fixtureRepository.parentTempDir, 'worktrees');
fs.mkdirSync(worktreeParentDir, { recursive: true });

const worktreePathList = [];
function buildWorktreePath(folderName) {
  const worktreePath = path.join(worktreeParentDir, folderName);
  worktreePathList.push(worktreePath);
  return worktreePath;
}

afterAll(async () => {
  await fixtureRepository.cleanup();
});

describe('createWorktree', () => {
  it('使用已有分支创建成功', async () => {
    const createdInfo = await createWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: buildWorktreePath('existing-branch-wt'),
      branchMode: 'existing',
      branchName: 'develop'
    });
    expect(createdInfo.branch).toBe('develop');
    expect(fs.existsSync(createdInfo.path)).toBe(true);
  });

  it('新建分支创建成功', async () => {
    const createdInfo = await createWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: buildWorktreePath('new-branch-wt'),
      branchMode: 'new',
      branchName: 'feature/demo'
    });
    expect(createdInfo.branch).toBe('feature/demo');
    const branchListResult = await import('../src/core/git-executor.js').then((module) =>
      module.executeGitCommand(fixtureRepository.repoPath, ['branch', '--list', 'feature/demo'])
    );
    expect(branchListResult.stdout).toContain('feature/demo');
  });

  it('目标路径非空时拒绝', async () => {
    const occupiedPath = buildWorktreePath('occupied-path');
    fs.mkdirSync(occupiedPath, { recursive: true });
    fs.writeFileSync(path.join(occupiedPath, 'blocker.txt'), 'x');

    await expect(
      createWorktree({
        repoPath: fixtureRepository.repoPath,
        targetPath: occupiedPath,
        branchMode: 'new',
        branchName: 'feature/x'
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('目标路径嵌套在主仓库内部时拒绝', async () => {
    await expect(
      createWorktree({
        repoPath: fixtureRepository.repoPath,
        targetPath: path.join(fixtureRepository.repoPath, 'inner-wt'),
        branchMode: 'new',
        branchName: 'feature/nested'
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('主目录不是 git 仓库时拒绝', async () => {
    const plainDir = path.join(fixtureRepository.parentTempDir, 'plain-dir');
    fs.mkdirSync(plainDir, { recursive: true });

    await expect(
      createWorktree({
        repoPath: plainDir,
        targetPath: buildWorktreePath('from-plain-dir'),
        branchMode: 'new',
        branchName: 'feature/y'
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('分支已被其他 worktree 占用时拒绝', async () => {
    await expect(
      createWorktree({
        repoPath: fixtureRepository.repoPath,
        targetPath: buildWorktreePath('occupied-branch-wt'),
        branchMode: 'existing',
        branchName: 'main'
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('listWorktrees / getBranchOccupationMap', () => {
  it('列出全部 worktree 并正确标注主 worktree 与分支', async () => {
    const worktreeEntryList = await listWorktrees(fixtureRepository.repoPath);
    expect(worktreeEntryList.length).toBe(3);

    const mainEntry = worktreeEntryList.find((entry) => entry.isMain);
    expect(mainEntry.branch).toBe('main');

    const featureEntry = worktreeEntryList.find((entry) => entry.branch === 'feature/demo');
    expect(featureEntry).toBeTruthy();
    expect(featureEntry.isMain).toBe(false);
    expect(featureEntry.isDirty).toBe(false);
  });

  it('脏状态识别：修改文件后 isDirty 变 true', async () => {
    const featureWorktreePath = buildWorktreePath('existing-branch-wt');
    fs.writeFileSync(path.join(featureWorktreePath, 'README.md'), '# modified\n', 'utf8');

    const worktreeEntryList = await listWorktrees(fixtureRepository.repoPath);
    const featureEntry = worktreeEntryList.find((entry) => entry.branch === 'develop');
    expect(featureEntry).toBeTruthy();
    expect(featureEntry.isDirty).toBe(true);
  });

  it('分支占用映射正确', async () => {
    const occupationMap = await getBranchOccupationMap(fixtureRepository.repoPath);
    expect(occupationMap['main']).toBeTruthy();
    expect(occupationMap['feature/demo']).toBeTruthy();
  });
});

describe('removeWorktree', () => {
  it('主 worktree 禁止删除', async () => {
    await expect(
      removeWorktree({ repoPath: fixtureRepository.repoPath, targetPath: fixtureRepository.repoPath, force: false })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('未登记路径删除报 NotFound', async () => {
    await expect(
      removeWorktree({ repoPath: fixtureRepository.repoPath, targetPath: path.join(worktreeParentDir, 'ghost'), force: false })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('脏 worktree 未强删时拦截并列出修改', async () => {
    const dirtyWorktreePath = buildWorktreePath('existing-branch-wt');

    const dirtyRemovalPromise = removeWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: dirtyWorktreePath,
      force: false
    });
    await expect(dirtyRemovalPromise).rejects.toBeInstanceOf(ConflictError);
    await dirtyRemovalPromise.catch((error) => {
      expect(error.details.uncommittedFiles.length).toBeGreaterThan(0);
    });

    // 强制删除成功
    const removalResult = await removeWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: dirtyWorktreePath,
      force: true
    });
    expect(removalResult.removed).toBe(true);
    expect(fs.existsSync(dirtyWorktreePath)).toBe(false);
  });

  it('干净 worktree 直接删除成功', async () => {
    const cleanWorktreePath = buildWorktreePath('clean-wt');
    await createWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: cleanWorktreePath,
      branchMode: 'new',
      branchName: 'feature/clean-delete'
    });

    const removalResult = await removeWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: cleanWorktreePath,
      force: false
    });
    expect(removalResult.removed).toBe(true);
  });

  it('未合并提交数正确统计', async () => {
    const aheadWorktreePath = buildWorktreePath('ahead-wt');
    await createWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: aheadWorktreePath,
      branchMode: 'new',
      branchName: 'feature/ahead'
    });
    await commitFileInRepository(aheadWorktreePath, 'ahead.txt', 'a', 'ahead commit');

    const unmergedCount = await getUnmergedCommitCount(fixtureRepository.repoPath, 'feature/ahead');
    // fixture 仓库 origin 不存在，回退到本地 main
    expect(unmergedCount).toBe(1);

    await removeWorktree({ repoPath: fixtureRepository.repoPath, targetPath: aheadWorktreePath, force: false });
  });
});

describe('pruneWorktrees', () => {
  it('手动删除目录后 prune 清理 1 条记录，再次 prune 为 0', async () => {
    const staleWorktreePath = buildWorktreePath('stale-wt');
    await createWorktree({
      repoPath: fixtureRepository.repoPath,
      targetPath: staleWorktreePath,
      branchMode: 'new',
      branchName: 'feature/stale'
    });
    await fs.promises.rm(staleWorktreePath, { recursive: true, force: true });

    const firstPruneResult = await pruneWorktrees(fixtureRepository.repoPath);
    expect(firstPruneResult.prunedCount).toBe(1);

    const secondPruneResult = await pruneWorktrees(fixtureRepository.repoPath);
    expect(secondPruneResult.prunedCount).toBe(0);
  });
});
