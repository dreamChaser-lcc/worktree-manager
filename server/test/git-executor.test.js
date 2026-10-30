import { describe, it, expect, afterAll } from 'vitest';
import { executeGitCommand } from '../src/core/git-executor.js';
import { GitCommandError } from '../src/core/errors.js';
import { createFixtureRepository } from './helpers/fixture-repo.js';

const fixtureRepository = await createFixtureRepository();

afterAll(async () => {
  await fixtureRepository.cleanup();
});

describe('executeGitCommand', () => {
  it('成功执行并返回 stdout', async () => {
    const result = await executeGitCommand(fixtureRepository.repoPath, ['rev-parse', '--is-inside-work-tree']);
    expect(result.stdout.trim()).toBe('true');
    expect(result.exitCode).toBe(0);
  });

  it('非零退出时抛出 GitCommandError 并携带 stderr', async () => {
    const failurePromise = executeGitCommand(fixtureRepository.repoPath, ['show', 'not-exist-ref-000']);
    await expect(failurePromise).rejects.toBeInstanceOf(GitCommandError);
    await failurePromise.catch((error) => {
      expect(error.exitCode).not.toBe(0);
      expect(error.stderr.length).toBeGreaterThan(0);
      expect(error.message).toContain('not-exist-ref-000');
    });
  });

  it('allowNonZeroExit 时不抛错', async () => {
    const result = await executeGitCommand(
      fixtureRepository.repoPath,
      ['show', 'not-exist-ref-000'],
      { allowNonZeroExit: true }
    );
    expect(result.exitCode).not.toBe(0);
  });

  it('命令超时抛出超时错误', async () => {
    // 用 shell 别名制造一个慢命令：!sleep 走 git 的 shell 别名机制
    await executeGitCommand(fixtureRepository.repoPath, ['config', 'alias.slowcommand', '!sleep 5']);

    const timeoutPromise = executeGitCommand(fixtureRepository.repoPath, ['slowcommand'], { timeoutMs: 800 });
    await expect(timeoutPromise).rejects.toBeInstanceOf(GitCommandError);
    await timeoutPromise.catch((error) => {
      expect(error.message).toContain('超时');
    });

    // 清理别名，避免影响其他测试
    await executeGitCommand(fixtureRepository.repoPath, ['config', '--unset', 'alias.slowcommand']);
  });
});
