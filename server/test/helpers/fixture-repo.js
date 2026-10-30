import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeGitCommand } from '../../src/core/git-executor.js';

/**
 * 创建带初始提交的真实临时 git 仓库，供集成测试使用。
 * 返回 { repoPath, cleanup }，cleanup 删除整个临时目录。
 */
export async function createFixtureRepository() {
  const parentTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wtm-fixture-'));
  const repoPath = path.join(parentTempDir, 'fixture-repo');
  await fs.promises.mkdir(repoPath);

  await executeGitCommand(parentTempDir, ['init', '-b', 'main', path.basename(repoPath)]);
  await configureFixtureIdentity(repoPath);
  await commitFileInRepository(repoPath, 'README.md', '# fixture\n', 'init commit');
  // 预置一个未被任何 worktree 签出的分支，供"签出已有分支"用例使用
  await executeGitCommand(repoPath, ['branch', 'develop', 'main']);

  return {
    repoPath,
    parentTempDir,
    cleanup: () => fs.promises.rm(parentTempDir, { recursive: true, force: true })
  };
}

/** 提交一个文件到指定仓库（自动 add + commit） */
export async function commitFileInRepository(repoPath, fileName, fileContent, commitMessage) {
  await fs.promises.writeFile(path.join(repoPath, fileName), fileContent, 'utf8');
  await executeGitCommand(repoPath, ['add', fileName]);
  await executeGitCommand(repoPath, ['commit', '-m', commitMessage]);
}

async function configureFixtureIdentity(repoPath) {
  await executeGitCommand(repoPath, ['config', 'user.email', 'fixture@test.local']);
  await executeGitCommand(repoPath, ['config', 'user.name', 'Fixture Tester']);
}
