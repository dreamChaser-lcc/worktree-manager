import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isGitRepository,
  assertTargetPathAvailable,
  assertNotNestedInRepository,
  assertSameVolume,
  assertValidBranchName
} from '../src/core/validators.js';
import { ValidationError } from '../src/core/errors.js';
import { createFixtureRepository } from './helpers/fixture-repo.js';

const fixtureRepository = await createFixtureRepository();
const plainTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtm-plain-'));

afterAll(async () => {
  await fixtureRepository.cleanup();
  await fs.promises.rm(plainTempDir, { recursive: true, force: true });
});

describe('isGitRepository', () => {
  it('git 仓库返回 true', async () => {
    expect(await isGitRepository(fixtureRepository.repoPath)).toBe(true);
  });

  it('普通目录返回 false', async () => {
    expect(await isGitRepository(plainTempDir)).toBe(false);
  });

  it('不存在的路径返回 false', async () => {
    expect(await isGitRepository(path.join(plainTempDir, 'no-such-dir'))).toBe(false);
  });
});

describe('assertTargetPathAvailable', () => {
  it('不存在的路径通过', () => {
    expect(() => assertTargetPathAvailable(path.join(plainTempDir, 'new-dir'))).not.toThrow();
  });

  it('存在的空目录通过', () => {
    const emptyDir = path.join(plainTempDir, 'empty-dir');
    fs.mkdirSync(emptyDir);
    expect(() => assertTargetPathAvailable(emptyDir)).not.toThrow();
  });

  it('非空目录抛 ValidationError', () => {
    const nonEmptyDir = path.join(plainTempDir, 'non-empty-dir');
    fs.mkdirSync(nonEmptyDir);
    fs.writeFileSync(path.join(nonEmptyDir, 'some-file.txt'), 'content');
    expect(() => assertTargetPathAvailable(nonEmptyDir)).toThrow(ValidationError);
  });
});

describe('assertNotNestedInRepository', () => {
  it('外部路径通过', () => {
    const outsidePath = path.join(path.dirname(fixtureRepository.repoPath), 'outside-wt');
    expect(() => assertNotNestedInRepository(fixtureRepository.repoPath, outsidePath)).not.toThrow();
  });

  it('仓库内部路径抛 ValidationError', () => {
    const insidePath = path.join(fixtureRepository.repoPath, 'inner-wt');
    expect(() => assertNotNestedInRepository(fixtureRepository.repoPath, insidePath)).toThrow(ValidationError);
  });

  it('与主仓库同路径抛 ValidationError', () => {
    expect(() => assertNotNestedInRepository(fixtureRepository.repoPath, fixtureRepository.repoPath)).toThrow(ValidationError);
  });
});

describe('assertSameVolume', () => {
  it('同盘路径通过', () => {
    expect(() => assertSameVolume(fixtureRepository.repoPath, plainTempDir)).not.toThrow();
  });
});

describe('assertValidBranchName', () => {
  it.each(['feature-a', 'release/1.2.0', 'hotfix_2026'])('合法分支名 %s 通过', (branchName) => {
    expect(() => assertValidBranchName(branchName)).not.toThrow();
  });

  it.each(['', 'feature..a', 'a b', '-leading', 'trailing.', 'head.lock', 'a:b', '~tilde'])('非法分支名 %s 抛 ValidationError', (branchName) => {
    expect(() => assertValidBranchName(branchName)).toThrow(ValidationError);
  });
});
