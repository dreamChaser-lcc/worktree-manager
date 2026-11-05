import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyIgnoredFiles } from '../src/core/ignore-file-copier.js';
import { createFixtureRepository } from './helpers/fixture-repo.js';

const fixtureRepository = await createFixtureRepository();
const targetDirectory = path.join(fixtureRepository.parentTempDir, 'copy-target');
fs.mkdirSync(targetDirectory, { recursive: true });

// 主仓库预置被忽略的本地配置文件
fs.writeFileSync(path.join(fixtureRepository.repoPath, '.env'), 'API_BASE=/api', 'utf8');
fs.writeFileSync(path.join(fixtureRepository.repoPath, '.env.local'), 'DEBUG=1', 'utf8');
fs.writeFileSync(path.join(fixtureRepository.repoPath, 'settings.local'), 'x=1', 'utf8');
fs.writeFileSync(path.join(fixtureRepository.repoPath, 'README.md'), '# not ignored', 'utf8');
// 主仓库预置 .husky 目录：含普通钩子脚本与被 gitignore 的运行时子目录（husky v9 结构）
fs.mkdirSync(path.join(fixtureRepository.repoPath, '.husky', '_'), { recursive: true });
fs.writeFileSync(path.join(fixtureRepository.repoPath, '.husky', 'pre-commit'), '#!/bin/sh\nnpm test\n', 'utf8');
fs.writeFileSync(path.join(fixtureRepository.repoPath, '.husky', '_', 'husky.sh'), '#!/bin/sh\n', 'utf8');

afterAll(async () => {
  await fixtureRepository.cleanup();
});

describe('copyIgnoredFiles', () => {
  it('默认白名单命中 .env/.env.local/*.local，其余不复制', () => {
    const copyResult = copyIgnoredFiles({
      repoPath: fixtureRepository.repoPath,
      worktreePath: targetDirectory
    });

    expect(copyResult.copiedFiles.sort()).toEqual(['.env', '.env.local', 'settings.local']);
    expect(fs.readFileSync(path.join(targetDirectory, '.env'), 'utf8')).toBe('API_BASE=/api');
    expect(fs.existsSync(path.join(targetDirectory, 'README.md'))).toBe(false);
  });

  it('白名单文件不存在时静默跳过', () => {
    const emptyRepoDirectory = path.join(fixtureRepository.parentTempDir, 'empty-copy-repo');
    fs.mkdirSync(emptyRepoDirectory);

    const copyResult = copyIgnoredFiles({
      repoPath: emptyRepoDirectory,
      worktreePath: targetDirectory
    });

    expect(copyResult.copiedFiles).toEqual([]);
    expect(copyResult.copiedDirectories).toEqual([]);
  });

  it('.husky 目录整棵递归复制（含子目录），目标已有内容时覆盖', () => {
    const huskyTargetDirectory = path.join(fixtureRepository.parentTempDir, 'copy-target-husky');
    // 目标预置过期钩子脚本与残缺子目录，验证 -Force 覆盖语义
    fs.mkdirSync(path.join(huskyTargetDirectory, '.husky', '_'), { recursive: true });
    fs.writeFileSync(path.join(huskyTargetDirectory, '.husky', 'pre-commit'), 'stale', 'utf8');

    const copyResult = copyIgnoredFiles({
      repoPath: fixtureRepository.repoPath,
      worktreePath: huskyTargetDirectory
    });

    expect(copyResult.copiedDirectories).toEqual(['.husky']);
    expect(fs.readFileSync(path.join(huskyTargetDirectory, '.husky', 'pre-commit'), 'utf8')).toContain('npm test');
    expect(fs.existsSync(path.join(huskyTargetDirectory, '.husky', '_', 'husky.sh'))).toBe(true);
  });

  it('自定义白名单生效', () => {
    const customTargetDirectory = path.join(fixtureRepository.parentTempDir, 'copy-target-custom');
    fs.mkdirSync(customTargetDirectory);

    const copyResult = copyIgnoredFiles({
      repoPath: fixtureRepository.repoPath,
      worktreePath: customTargetDirectory,
      patterns: ['README.md']
    });

    expect(copyResult.copiedFiles).toEqual(['README.md']);
    expect(fs.existsSync(path.join(customTargetDirectory, '.env'))).toBe(false);
  });
});
