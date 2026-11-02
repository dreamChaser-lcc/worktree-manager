import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { persistenceManager } from '../src/storage/persistence-manager.js';
import { createJob, appendJobLog, finishJob } from '../src/jobs/job-runner.js';
import { executeGitCommand } from '../src/core/git-executor.js';
import { startTestServer } from './helpers/test-server.js';
import { createFixtureRepository } from './helpers/fixture-repo.js';

const recordsTestRootDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wtm-records-'));
const fixtureRepository = await createFixtureRepository();

// 持久化注入临时目录：必须在首个请求前完成（覆盖数据目录/设置文件/默认目录，避免污染真实用户目录）
await persistenceManager.initialize({
  dataRootOverride: path.join(recordsTestRootDirectory, 'data'),
  settingsFilePath: path.join(recordsTestRootDirectory, 'settings.json'),
  defaultDataRootPath: path.join(recordsTestRootDirectory, 'default-data')
});

const serverInstance = await startTestServer(createApp());

async function requestJson(method, pathWithQuery, requestBody) {
  const requestOptions = { method, headers: { 'Content-Type': 'application/json' } };
  if (requestBody !== undefined) {
    requestOptions.body = JSON.stringify(requestBody);
  }
  const response = await fetch(`${serverInstance.baseUrl}${pathWithQuery}`, requestOptions);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function getJson(pathWithQuery) {
  return requestJson('GET', pathWithQuery);
}

function postJson(pathWithQuery, requestBody) {
  return requestJson('POST', pathWithQuery, requestBody);
}

function putJson(pathWithQuery, requestBody) {
  return requestJson('PUT', pathWithQuery, requestBody);
}

afterAll(async () => {
  await serverInstance.close();
  await fixtureRepository.cleanup();
  await fs.promises.rm(recordsTestRootDirectory, { recursive: true, force: true });
});

describe('记录类 API（最近主仓库 / 创建历史 / 任务持久化 / 设置）', () => {
  it('仓库校验成功后写入最近主仓库', async () => {
    const checkResult = await getJson(
      `/api/filesystem/repository-check?path=${encodeURIComponent(fixtureRepository.repoPath)}`
    );
    expect(checkResult.status).toBe(200);
    expect(checkResult.body.isGitRepository).toBe(true);

    const recentRepoResult = await getJson('/api/recent-repos');
    expect(recentRepoResult.status).toBe(200);
    const repoPathList = recentRepoResult.body.repositories.map((repository) => repository.repoPath);
    expect(repoPathList).toContain(fixtureRepository.repoPath);
    expect(recentRepoResult.body.lastUsedPath).toBe(fixtureRepository.repoPath);
  });

  it('创建成功写入历史记录（字段完整）', async () => {
    const targetPath = path.join(fixtureRepository.parentTempDir, 'history-wt-success');
    const createResult = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath,
      branchMode: 'existing',
      branchName: 'develop',
      dependencyStrategy: 'skip'
    });
    expect(createResult.status).toBe(200);

    const historyResult = await getJson('/api/worktree-history');
    expect(historyResult.status).toBe(200);
    const matchedRecord = historyResult.body.records.find((record) => record.targetPath === targetPath);
    expect(matchedRecord).toBeTruthy();
    expect(matchedRecord.outcome).toBe('success');
    expect(matchedRecord.repoPath).toBe(fixtureRepository.repoPath);
    expect(matchedRecord.branchName).toBe('develop');
    expect(matchedRecord.dependencyStrategy).toBe('skip');
    expect(matchedRecord.failureReason).toBeNull();
    expect(matchedRecord.createdAt).toBeTruthy();
    expect(matchedRecord.completedAt).toBeTruthy();
  });

  it('创建失败同样留痕并携带失败原因', async () => {
    const failedCreateResult = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: path.join(fixtureRepository.parentTempDir, 'history-wt-failed'),
      branchMode: 'new',
      branchName: 'bad branch!',
      dependencyStrategy: 'skip'
    });
    expect(failedCreateResult.status).toBe(400);

    const historyResult = await getJson('/api/worktree-history');
    const failedRecordList = historyResult.body.records.filter((record) => record.outcome === 'failed');
    expect(failedRecordList.length).toBeGreaterThan(0);
    expect(failedRecordList[0].failureReason).toContain('非法分支名');
    expect(failedRecordList[0].branchName).toBe('bad branch!');
  });

  it('任务元数据与日志持久化，可从持久层读取', async () => {
    const persistedJob = createJob('unit:persisted-task');
    appendJobLog(persistedJob, 'install-line-1');
    appendJobLog(persistedJob, 'install-line-2');
    finishJob(persistedJob, 'success', 0);
    // 落盘为异步动作，留出写入时间
    await new Promise((resolve) => setTimeout(resolve, 150));

    const taskListResult = await getJson('/api/tasks');
    expect(taskListResult.status).toBe(200);
    const matchedTask = taskListResult.body.tasks.find((task) => task.id === persistedJob.id);
    expect(matchedTask).toBeTruthy();
    expect(matchedTask.name).toBe('unit:persisted-task');
    expect(matchedTask.status).toBe('success');
    expect(matchedTask).not.toHaveProperty('logLines');

    const taskDetailResult = await getJson(`/api/tasks/${persistedJob.id}`);
    expect(taskDetailResult.status).toBe(200);
    expect(taskDetailResult.body.logLines).toEqual(['install-line-1', 'install-line-2']);

    // SSE 端点对终态任务推全量 history + end 后关闭（历史任务同格式）
    const logsResponse = await fetch(`${serverInstance.baseUrl}/api/tasks/${persistedJob.id}/logs`);
    const logsText = await logsResponse.text();
    expect(logsText).toContain('install-line-1');
    expect(logsText).toContain('event: end');
  });

  it('不存在的任务返回 404', async () => {
    const notFoundResult = await getJson('/api/tasks/no-such-id');
    expect(notFoundResult.status).toBe(404);
  });

  it('设置接口：非法目录修改被拒绝', async () => {
    const invalidResult = await putJson('/api/settings', { dataDirectory: 'relative/path' });
    expect(invalidResult.status).toBe(400);
  });

  it('设置接口：项目存放目录默认 D:\\project，可单独修改', async () => {
    const initialSettings = await getJson('/api/settings');
    expect(initialSettings.status).toBe(200);
    expect(initialSettings.body.projectDirectory).toBe('D:\\project');

    const nextProjectDirectory = path.join(recordsTestRootDirectory, 'custom-projects');
    const updateResult = await putJson('/api/settings', { projectDirectory: nextProjectDirectory });
    expect(updateResult.status).toBe(200);
    expect(updateResult.body.projectDirectory).toBe(path.resolve(nextProjectDirectory));
    expect(updateResult.body.notice).toContain('代码默认存储目录');

    const effectiveSettings = await getJson('/api/settings');
    expect(effectiveSettings.body.projectDirectory).toBe(path.resolve(nextProjectDirectory));
    expect(fs.existsSync(path.resolve(nextProjectDirectory))).toBe(true);

    const missingFieldResult = await putJson('/api/settings', {});
    expect(missingFieldResult.status).toBe(400);
  });

  it('设置接口：编辑器命令默认 code，可修改', async () => {
    const initialSettings = await getJson('/api/settings');
    expect(initialSettings.body.editorCommand).toBe('code');

    const updateResult = await putJson('/api/settings', { editorCommand: 'cursor' });
    expect(updateResult.status).toBe(200);
    expect(updateResult.body.editorCommand).toBe('cursor');
    expect(updateResult.body.notice).toContain('编辑器命令');

    const emptyResult = await putJson('/api/settings', { editorCommand: '  ' });
    expect(emptyResult.status).toBe(400);
  });

  it('编辑器探测：返回候选清单与当前命令', async () => {
    const detectResult = await getJson('/api/editors/installed');
    expect(detectResult.status).toBe(200);
    expect(detectResult.body.editors.length).toBeGreaterThanOrEqual(1);
    expect(
      detectResult.body.editors.every(
        (editorEntry) => typeof editorEntry.command === 'string' && typeof editorEntry.available === 'boolean'
      )
    ).toBe(true);
    expect(typeof detectResult.body.currentEditorCommand).toBe('string');
  });

  it('新建分支默认起点：无远程回退 null，有远程回退 origin/main 并支持从远程最新创建', async () => {
    // 无远程仓库 → baseRef 为 null
    const noRemoteResult = await getJson(
      `/api/branches/default-base?repoPath=${encodeURIComponent(fixtureRepository.repoPath)}`
    );
    expect(noRemoteResult.status).toBe(200);
    expect(noRemoteResult.body.baseRef).toBeNull();

    // 挂一个本地裸仓库作为 origin 并推送 main
    const bareRemotePath = path.join(recordsTestRootDirectory, 'origin-remote.git');
    await executeGitCommand(recordsTestRootDirectory, ['init', '--bare', 'origin-remote.git']);
    await executeGitCommand(fixtureRepository.repoPath, ['remote', 'add', 'origin', bareRemotePath]);
    await executeGitCommand(fixtureRepository.repoPath, ['push', 'origin', 'main']);
    await executeGitCommand(bareRemotePath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const withRemoteResult = await getJson(
      `/api/branches/default-base?repoPath=${encodeURIComponent(fixtureRepository.repoPath)}`
    );
    expect(withRemoteResult.status).toBe(200);
    expect(withRemoteResult.body.remoteName).toBe('origin');
    expect(withRemoteResult.body.baseRef).toBe('origin/main');

    // 从远程分支最新代码创建新分支 worktree（创建流程会先 fetch origin）
    const worktreeFromRemotePath = path.join(fixtureRepository.parentTempDir, 'wt-from-remote');
    const createWorktreeResult = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: worktreeFromRemotePath,
      branchMode: 'new',
      branchName: 'feature/from-remote',
      baseRef: 'origin/main',
      dependencyStrategy: 'skip'
    });
    expect(createWorktreeResult.status).toBe(200);
    const headResult = await executeGitCommand(worktreeFromRemotePath, ['rev-parse', '--verify', 'HEAD']);
    expect(headResult.stdout.trim()).not.toBe('');

    // upstream 已改写为同名远程分支：git push 不会再报"upstream 不匹配"
    const mergeConfigResult = await executeGitCommand(fixtureRepository.repoPath, [
      'config', 'branch.feature/from-remote.merge'
    ]);
    expect(mergeConfigResult.stdout.trim()).toBe('refs/heads/feature/from-remote');
    const remoteConfigResult = await executeGitCommand(fixtureRepository.repoPath, [
      'config', 'branch.feature/from-remote.remote'
    ]);
    expect(remoteConfigResult.stdout.trim()).toBe('origin');

    // 已有分支模式选择远程才有的分支（本地不存在）：自动 --track -b 从远程创建并签出
    await executeGitCommand(fixtureRepository.repoPath, ['push', 'origin', 'main:refs/heads/feature/remote-only']);
    const remoteOnlyWorktreePath = path.join(fixtureRepository.parentTempDir, 'wt-remote-only');
    const remoteOnlyResult = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: remoteOnlyWorktreePath,
      branchMode: 'existing',
      branchName: 'feature/remote-only',
      dependencyStrategy: 'skip'
    });
    expect(remoteOnlyResult.status).toBe(200);
    expect(fs.existsSync(remoteOnlyWorktreePath)).toBe(true);
    const headBranchResult = await executeGitCommand(remoteOnlyWorktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(headBranchResult.stdout.trim()).toBe('feature/remote-only');
  });

  it('设置接口：合法目录修改立即生效，数据自动迁移', async () => {
    const initialSettings = await getJson('/api/settings');
    expect(initialSettings.status).toBe(200);
    const originalDataDirectory = initialSettings.body.dataDirectory;
    expect(originalDataDirectory).toBe(path.join(recordsTestRootDirectory, 'data'));

    const nextDataDirectory = path.join(recordsTestRootDirectory, 'switched-data');
    const updateResult = await putJson('/api/settings', { dataDirectory: nextDataDirectory });
    expect(updateResult.status).toBe(200);
    expect(updateResult.body.dataDirectory).toBe(path.resolve(nextDataDirectory));
    expect(updateResult.body.notice).toContain('已自动迁移');

    const effectiveSettings = await getJson('/api/settings');
    expect(effectiveSettings.body.dataDirectory).toBe(path.resolve(nextDataDirectory));
    expect(fs.existsSync(path.join(nextDataDirectory, 'nedb'))).toBe(true);
    // 自动迁移：数据已搬到新目录，旧目录不再保留 nedb 库
    expect(fs.existsSync(path.join(originalDataDirectory, 'nedb', 'jobs.db'))).toBe(false);
  });
});
