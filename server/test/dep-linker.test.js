import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectPackageManager,
  recommendDependencyStrategy,
  applySharedDependencyLink,
  startIndependentInstall
} from '../src/core/dep-linker.js';
import { createWorktree } from '../src/core/worktree-manager.js';
import { ValidationError } from '../src/core/errors.js';
import { createFixtureRepository } from './helpers/fixture-repo.js';

const fixtureRepository = await createFixtureRepository();
const worktreeParentDir = path.join(fixtureRepository.parentTempDir, 'link-worktrees');
fs.mkdirSync(worktreeParentDir, { recursive: true });

// 主仓库准备 npm lockfile + 一个最小 node_modules（不真实安装，手工造依赖目录）
fs.writeFileSync(
  path.join(fixtureRepository.repoPath, 'package-lock.json'),
  JSON.stringify({ name: 'fixture', lockfileVersion: 3 }),
  'utf8'
);
const mainDemoPackagePath = path.join(fixtureRepository.repoPath, 'node_modules', 'demo-lib');
fs.mkdirSync(mainDemoPackagePath, { recursive: true });
fs.writeFileSync(path.join(mainDemoPackagePath, 'package.json'), '{"name":"demo-lib","version":"1.0.0"}', 'utf8');
fs.writeFileSync(path.join(mainDemoPackagePath, 'index.js'), 'module.exports = "demo";', 'utf8');

const createdWorktreePathList = [];
async function createLinkedWorktree(folderName, branchName) {
  const createdInfo = await createWorktree({
    repoPath: fixtureRepository.repoPath,
    targetPath: path.join(worktreeParentDir, folderName),
    branchMode: 'new',
    branchName
  });
  createdWorktreePathList.push(createdInfo.path);
  return createdInfo.path;
}

afterAll(async () => {
  await fixtureRepository.cleanup();
});

describe('detectPackageManager / recommendDependencyStrategy', () => {
  it('pnpm-lock → pnpm → 推荐独立安装', () => {
    const probeDir = path.join(fixtureRepository.parentTempDir, 'probe-pnpm');
    fs.mkdirSync(probeDir);
    fs.writeFileSync(path.join(probeDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf8');
    expect(detectPackageManager(probeDir)).toBe('pnpm');
    expect(recommendDependencyStrategy('pnpm')).toBe('install');
  });

  it('package-lock → npm → 默认推荐独立安装（共享需系统权限支持，不再默认推荐）', () => {
    expect(detectPackageManager(fixtureRepository.repoPath)).toBe('npm');
    expect(recommendDependencyStrategy('npm')).toBe('install');
    expect(recommendDependencyStrategy('yarn')).toBe('install');
  });

  it('yarn.lock → yarn', () => {
    const probeDir = path.join(fixtureRepository.parentTempDir, 'probe-yarn');
    fs.mkdirSync(probeDir);
    fs.writeFileSync(path.join(probeDir, 'yarn.lock'), '', 'utf8');
    expect(detectPackageManager(probeDir)).toBe('yarn');
  });

  it('无 lockfile → null → 无推荐', () => {
    const probeDir = path.join(fixtureRepository.parentTempDir, 'probe-none');
    fs.mkdirSync(probeDir);
    expect(detectPackageManager(probeDir)).toBeNull();
    expect(recommendDependencyStrategy(null)).toBeNull();
  });
});

describe('applySharedDependencyLink', () => {
  it('junction 建链成功且 worktree 内可读取主仓库依赖', async () => {
    const worktreePath = await createLinkedWorktree('share-ok-wt', 'feature/share-ok');

    const linkResult = applySharedDependencyLink({
      repoPath: fixtureRepository.repoPath,
      worktreePath
    });
    expect(linkResult.status).toBe('linked');

    const demoPackageManifest = fs.readFileSync(
      path.join(worktreePath, 'node_modules', 'demo-lib', 'package.json'),
      'utf8'
    );
    expect(demoPackageManifest).toContain('demo-lib');
  });

  it('主仓库缺少 node_modules 时拒绝', async () => {
    const emptyRepoWorktreePath = await createLinkedWorktree('share-missing-wt', 'feature/share-missing');

    // 用一个没有 node_modules 的假仓库目录验证
    const fakeRepoPath = path.join(fixtureRepository.parentTempDir, 'fake-repo-no-modules');
    fs.mkdirSync(fakeRepoPath);
    expect(() =>
      applySharedDependencyLink({ repoPath: fakeRepoPath, worktreePath: emptyRepoWorktreePath })
    ).toThrow(ValidationError);
  });

  it('worktree 内已有非空 node_modules 时拒绝覆盖', async () => {
    const worktreePath = await createLinkedWorktree('share-conflict-wt', 'feature/share-conflict');
    fs.mkdirSync(path.join(worktreePath, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'node_modules', 'blocker.txt'), 'x', 'utf8');

    expect(() =>
      applySharedDependencyLink({ repoPath: fixtureRepository.repoPath, worktreePath })
    ).toThrow(ValidationError);
  });
});

describe('startIndependentInstall', () => {
  it('本地 file 依赖安装成功并生成 node_modules', async () => {
    const worktreePath = await createLinkedWorktree('install-ok-wt', 'feature/install-ok');
    // 用本地 file 依赖验证安装真实发生（离线、快速）
    const localDemoPackagePath = path.join(worktreePath, 'local-demo-lib');
    fs.mkdirSync(localDemoPackagePath, { recursive: true });
    fs.writeFileSync(path.join(localDemoPackagePath, 'package.json'), '{"name":"local-demo-lib","version":"1.0.0"}', 'utf8');
    fs.writeFileSync(path.join(localDemoPackagePath, 'index.js'), 'module.exports = "local";', 'utf8');
    fs.writeFileSync(
      path.join(worktreePath, 'package.json'),
      JSON.stringify({
        name: 'install-fixture',
        version: '1.0.0',
        dependencies: { 'local-demo-lib': 'file:./local-demo-lib' }
      }),
      'utf8'
    );

    const { installProcess } = startIndependentInstall({ worktreePath, packageManagerName: 'npm' });

    const exitCode = await new Promise((resolve, reject) => {
      installProcess.on('error', reject);
      installProcess.on('close', resolve);
    });
    expect(exitCode).toBe(0);
    const installedPackageManifest = fs.readFileSync(
      path.join(worktreePath, 'node_modules', 'local-demo-lib', 'package.json'),
      'utf8'
    );
    expect(installedPackageManifest).toContain('local-demo-lib');
  }, 60_000);

  it('未检测到包管理器时拒绝', async () => {
    const worktreePath = await createLinkedWorktree('install-missing-wt', 'feature/install-missing');
    expect(() => startIndependentInstall({ worktreePath, packageManagerName: null })).toThrow(ValidationError);
  });
});
