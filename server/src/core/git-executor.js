import { spawn } from 'node:child_process';
import { serverConfig } from '../config.js';
import { GitCommandError } from './errors.js';

/**
 * 统一的 git 命令执行入口。
 * 所有 git 调用都走 `git -C <repoPath> ...`，避免依赖进程工作目录。
 * 返回 stdout 字符串；非零退出或超时抛出 GitCommandError。
 *
 * @param {string} repoPath 仓库或任意 git 工作目录
 * @param {string[]} gitArguments git 子命令与参数（不含 "git" 本身）
 * @param {{ timeoutMs?: number, allowNonZeroExit?: boolean }} options
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function executeGitCommand(repoPath, gitArguments, options = {}) {
  const timeoutMs = options.timeoutMs ?? serverConfig.gitCommandTimeoutMs;
  const allowNonZeroExit = options.allowNonZeroExit ?? false;

  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['-C', repoPath, ...gitArguments], {
      windowsHide: true,
      // 中文输出按 UTF-8 解析
      env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C.UTF-8' }
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let hasTimedOut = false;

    const timeoutHandle = setTimeout(() => {
      hasTimedOut = true;
      gitProcess.kill();
    }, timeoutMs);

    gitProcess.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
    });
    gitProcess.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
    });

    gitProcess.on('error', (spawnError) => {
      clearTimeout(timeoutHandle);
      reject(new GitCommandError(`无法启动 git 进程: ${spawnError.message}`, { stderr: stderrBuffer }));
    });

    gitProcess.on('close', (exitCode) => {
      clearTimeout(timeoutHandle);

      if (hasTimedOut) {
        reject(new GitCommandError(`git 命令执行超时(${timeoutMs}ms): git ${gitArguments.join(' ')}`, {
          exitCode,
          stderr: stderrBuffer
        }));
        return;
      }

      if (exitCode !== 0 && !allowNonZeroExit) {
        reject(new GitCommandError(
          `git 命令执行失败(exit ${exitCode}): git ${gitArguments.join(' ')}\n${stderrBuffer.trim()}`,
          { exitCode, stderr: stderrBuffer }
        ));
        return;
      }

      resolve({ stdout: stdoutBuffer, stderr: stderrBuffer, exitCode });
    });
  });
}
