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
