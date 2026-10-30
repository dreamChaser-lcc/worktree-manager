import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkWorktreeDependencyStatus } from '../src/core/dependency-risk-checker.js';

const depCheckTestRootDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wtm-depcheck-'));

function createPackageJson(directoryPath, dependencies, devDependencies) {
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(
    path.join(directoryPath, 'package.json'),
    JSON.stringify({ dependencies, devDependencies }),
    'utf8'
  );
}

afterAll(async () => {
  await fs.promises.rm(depCheckTestRootDirectory, { recursive: true, force: true });
});

describe('依赖风险检查（dependency-risk-checker）', () => {
  it('junction 共享且依赖声明不一致 → 高风险并列出差异', () => {
    const mainRepoPath = path.join(depCheckTestRootDirectory, 'main');
    const worktreePath = path.join(depCheckTestRootDirectory, 'wt');
    createPackageJson(mainRepoPath, { 'lib-a': '^1.0.0', 'lib-b': '^2.0.0' }, { 'tool-x': '^1.0.0' });
    createPackageJson(worktreePath, { 'lib-a': '^2.0.0', 'lib-c': '^1.0.0' }, {});
    const mainNodeModulesPath = path.join(mainRepoPath, 'node_modules');
    fs.mkdirSync(mainNodeModulesPath, { recursive: true });
    fs.symlinkSync(mainNodeModulesPath, path.join(worktreePath, 'node_modules'), 'junction');

    const status = checkWorktreeDependencyStatus({ worktreePath, repoPath: mainRepoPath });
    expect(status.dependencyMode).toBe('shared');
    expect(status.riskLevel).toBe('high');
    const diffKeys = status.diffList.map((diffItem) => `${diffItem.section}:${diffItem.name}`);
    expect(diffKeys).toContain('dependencies:lib-a');
    expect(diffKeys).toContain('dependencies:lib-c');
    expect(diffKeys).toContain('devDependencies:tool-x');
    // 仅主目录声明（worktree 未声明）同样属于不一致
    expect(diffKeys).toContain('dependencies:lib-b');
  });

  it('junction 共享且声明一致 → 低风险无差异', () => {
    const mainRepoPath = path.join(depCheckTestRootDirectory, 'main-same');
    const worktreePath = path.join(depCheckTestRootDirectory, 'wt-same');
    createPackageJson(mainRepoPath, { 'lib-a': '^1.0.0' }, {});
    createPackageJson(worktreePath, { 'lib-a': '^1.0.0' }, {});
    const mainNodeModulesPath = path.join(mainRepoPath, 'node_modules');
    fs.mkdirSync(mainNodeModulesPath, { recursive: true });
    fs.symlinkSync(mainNodeModulesPath, path.join(worktreePath, 'node_modules'), 'junction');

    const status = checkWorktreeDependencyStatus({ worktreePath, repoPath: mainRepoPath });
    expect(status.riskLevel).toBe('low');
    expect(status.diffList).toEqual([]);
  });

  it('独立安装（真实 node_modules）→ 无共享风险', () => {
    const mainRepoPath = path.join(depCheckTestRootDirectory, 'main-ind');
    const worktreePath = path.join(depCheckTestRootDirectory, 'wt-ind');
    createPackageJson(mainRepoPath, { 'lib-a': '^1.0.0' }, {});
    createPackageJson(worktreePath, { 'lib-z': '^9.0.0' }, {});
    fs.mkdirSync(path.join(worktreePath, 'node_modules'), { recursive: true });

    const status = checkWorktreeDependencyStatus({ worktreePath, repoPath: mainRepoPath });
    expect(status.dependencyMode).toBe('independent');
    expect(status.riskLevel).toBe('none');
  });

  it('未安装依赖 → missing', () => {
    const mainRepoPath = path.join(depCheckTestRootDirectory, 'main-miss');
    const worktreePath = path.join(depCheckTestRootDirectory, 'wt-miss');
    createPackageJson(mainRepoPath, {}, {});
    createPackageJson(worktreePath, {}, {});

    const status = checkWorktreeDependencyStatus({ worktreePath, repoPath: mainRepoPath });
    expect(status.dependencyMode).toBe('missing');
    expect(status.riskMessage).toContain('未安装依赖');
  });
});
