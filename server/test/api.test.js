import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { startTestServer } from './helpers/test-server.js';
import { createFixtureRepository, commitFileInRepository } from './helpers/fixture-repo.js';

const fixtureRepository = await createFixtureRepository();
// 第二个干净 fixture：无 node_modules / 无 lockfile，专测依赖缺失场景
const bareRepository = await createFixtureRepository();
// 主仓库预置 tracked 的 package.json，保证 worktree 内 install 有对象
await commitFileInRepository(
  fixtureRepository.repoPath,
  'package.json',
  JSON.stringify({ name: 'fixture-app', version: '1.0.0', dependencies: {} }),
  'add package.json for install job'
);

// API 测试专用目录：worktree 与伪造主仓库 node_modules 都放这里
const apiWorkspaceDirectory = path.join(fixtureRepository.parentTempDir, 'api-workspace');
fs.mkdirSync(apiWorkspaceDirectory, { recursive: true });

// 主仓库预置 npm lockfile 与最小 node_modules（供 share 流程）
fs.writeFileSync(
  path.join(fixtureRepository.repoPath, 'package-lock.json'),
  JSON.stringify({ name: 'fixture', lockfileVersion: 3 }),
  'utf8'
);
const mainDemoPackagePath = path.join(fixtureRepository.repoPath, 'node_modules', 'demo-lib');
fs.mkdirSync(mainDemoPackagePath, { recursive: true });
fs.writeFileSync(path.join(mainDemoPackagePath, 'package.json'), '{"name":"demo-lib"}', 'utf8');
fs.writeFileSync(path.join(fixtureRepository.repoPath, '.env'), 'API_BASE=/api', 'utf8');

const serverInstance = await startTestServer(createApp());

function buildWorktreePath(folderName) {
  return path.join(apiWorkspaceDirectory, folderName);
}

async function getJson(pathWithQuery) {
  const response = await fetch(`${serverInstance.baseUrl}${pathWithQuery}`);
  return { status: response.status, body: await response.json() };
}

async function postJson(pathWithQuery, requestBody) {
  const response = await fetch(`${serverInstance.baseUrl}${pathWithQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  return { status: response.status, body: await response.json() };
}

/** 读取 SSE 直到 end 事件（或超时），返回收集到的事件列表 */
async function readSseUntilEnd(sseUrl, timeoutMs = 30_000) {
  const collectedEventList = [];
  const response = await fetch(sseUrl);
  const responseBody = response.body.getReader();
  const decoder = new TextDecoder();
  let bufferedText = '';

  const timeoutHandle = setTimeout(() => {
    throw new Error('SSE 读取超时');
  }, timeoutMs);

  try {
    for (;;) {
      const { done, value } = await responseBody.read();
      if (done) {
        break;
      }
      bufferedText += decoder.decode(value, { stream: true });
      let separatorIndex = bufferedText.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const rawEventText = bufferedText.slice(0, separatorIndex);
        bufferedText = bufferedText.slice(separatorIndex + 2);
        const eventNameMatch = rawEventText.match(/^event: (.+)$/m);
        const dataMatch = rawEventText.match(/^data: (.+)$/m);
        collectedEventList.push({
          event: eventNameMatch ? eventNameMatch[1] : null,
          data: dataMatch ? JSON.parse(dataMatch[1]) : null
        });
        separatorIndex = bufferedText.indexOf('\n\n');
      }
      if (collectedEventList.some((collectedEvent) => collectedEvent.event === 'end')) {
        break;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
  return collectedEventList;
}

/** 轮询任务直到离开 running 状态 */
async function waitForJobCompletion(jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await getJson(`/api/tasks/${jobId}`);
    if (body.status !== 'running') {
      return body;
    }
    if (Date.now() > deadline) {
      throw new Error('任务超时未完成');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

afterAll(async () => {
  await serverInstance.close();
  await fixtureRepository.cleanup();
  await bareRepository.cleanup();
});

describe('目录浏览 API', () => {
  it('drives 返回盘符列表', async () => {
    const { status, body } = await getJson('/api/filesystem/drives');
    expect(status).toBe(200);
    expect(body.drives.length).toBeGreaterThan(0);
  });

  it('directory 返回子目录与父路径', async () => {
    const queryPath = encodeURIComponent(fixtureRepository.parentTempDir);
    const { body } = await getJson(`/api/filesystem/directory?path=${queryPath}`);
    expect(body.currentPath.toLowerCase()).toContain('wtm-fixture');
    expect(Array.isArray(body.directories)).toBe(true);
    expect(body.parentPath).toBeTruthy();
  });

  it('directory 对不存在的路径返回 404', async () => {
    const queryPath = encodeURIComponent(path.join(fixtureRepository.parentTempDir, 'no-such-dir'));
    const { status } = await getJson(`/api/filesystem/directory?path=${queryPath}`);
    expect(status).toBe(404);
  });

  it('repository-check 区分 git 仓库与普通目录', async () => {
    const repoQuery = encodeURIComponent(fixtureRepository.repoPath);
    const repoCheck = await getJson(`/api/filesystem/repository-check?path=${repoQuery}`);
    expect(repoCheck.body.isGitRepository).toBe(true);
    expect(repoCheck.body.currentBranch).toBe('main');

    const plainQuery = encodeURIComponent(apiWorkspaceDirectory);
    const plainCheck = await getJson(`/api/filesystem/repository-check?path=${plainQuery}`);
    expect(plainCheck.body.isGitRepository).toBe(false);
  });
});

describe('分支列表 API', () => {
  it('返回分支、占用标注与依赖策略推荐', async () => {
    const { status, body } = await getJson(`/api/branches?repoPath=${encodeURIComponent(fixtureRepository.repoPath)}`);
    expect(status).toBe(200);

    const mainBranch = body.branches.find((branchItem) => branchItem.name === 'main');
    expect(mainBranch.occupiedBy).toBeTruthy(); // main 签出在主 worktree
    const developBranch = body.branches.find((branchItem) => branchItem.name === 'develop');
    expect(developBranch.occupiedBy).toBeNull();

    expect(body.packageManager).toBe('npm');
    expect(body.recommendedStrategy).toBe('share');
  });

  it('非 git 仓库返回 400', async () => {
    const { status } = await getJson(`/api/branches?repoPath=${encodeURIComponent(apiWorkspaceDirectory)}`);
    expect(status).toBe(400);
  });
});

describe('worktree 创建 API', () => {
  it('share 策略全流程成功并建立 junction', async () => {
    const response = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: buildWorktreePath('api-share-wt'),
      branchMode: 'existing',
      branchName: 'develop',
      dependencyStrategy: 'share',
      copyIgnoredFiles: true,
      openInEditor: false
    });

    expect(response.status).toBe(200);
    expect(response.body.worktree.branch).toBe('develop');
    expect(response.body.dependencyResult.status).toBe('linked');

    // junction 生效：worktree 内可读取主仓库依赖
    const linkedManifest = fs.readFileSync(
      path.join(buildWorktreePath('api-share-wt'), 'node_modules', 'demo-lib', 'package.json'),
      'utf8'
    );
    expect(linkedManifest).toContain('demo-lib');

    // 忽略文件已复制
    expect(fs.existsSync(path.join(buildWorktreePath('api-share-wt'), '.env'))).toBe(true);
  });

  it('share 但主仓库无 node_modules 时创建成功且带失败警告', async () => {
    const response = await postJson('/api/worktrees/create', {
      repoPath: bareRepository.repoPath,
      targetPath: buildWorktreePath('api-share-missing-wt'),
      branchMode: 'new',
      branchName: 'feature/api-share-missing',
      dependencyStrategy: 'share',
      copyIgnoredFiles: false,
      openInEditor: false
    });
    expect(response.status).toBe(200);
    expect(response.body.worktree).toBeTruthy();
    expect(response.body.dependencyResult.status).toBe('failed');
    expect(response.body.warnings.length).toBeGreaterThan(0);
  });

  it('install 策略返回任务 id 且任务最终成功', async () => {
    const response = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: buildWorktreePath('api-install-wt'),
      branchMode: 'new',
      branchName: 'feature/api-install',
      dependencyStrategy: 'install',
      copyIgnoredFiles: false,
      openInEditor: false
    });

    expect(response.status).toBe(200);
    expect(response.body.dependencyResult.status).toBe('installing');
    expect(response.body.installJobId).toBeTruthy();

    const finishedJob = await waitForJobCompletion(response.body.installJobId);
    expect(finishedJob.status).toBe('success');
    expect(finishedJob.logLines.length).toBeGreaterThan(0);
  });

  it('分支被占用时返回 409 与占用位置', async () => {
    const response = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: buildWorktreePath('api-occupied-wt'),
      branchMode: 'existing',
      branchName: 'main',
      dependencyStrategy: 'skip',
      copyIgnoredFiles: false,
      openInEditor: false
    });
    expect(response.status).toBe(409);
    expect(response.body.details.occupiedBy).toBeTruthy();
  });

  it('参数缺失返回 400', async () => {
    const response = await postJson('/api/worktrees/create', { repoPath: fixtureRepository.repoPath });
    expect(response.status).toBe(400);
  });
});

describe('worktree 列表 / 删除 / prune API', () => {
  it('列表包含已创建的 worktree 与脏状态', async () => {
    const dirtyWorktreePath = buildWorktreePath('api-dirty-wt');
    await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: dirtyWorktreePath,
      branchMode: 'new',
      branchName: 'feature/api-dirty',
      dependencyStrategy: 'skip',
      copyIgnoredFiles: false,
      openInEditor: false
    });
    fs.writeFileSync(path.join(dirtyWorktreePath, 'README.md'), '# dirty\n', 'utf8');

    const { body } = await getJson(`/api/worktrees?repoPath=${encodeURIComponent(fixtureRepository.repoPath)}`);
    const dirtyEntry = body.worktrees.find((entry) => entry.branch === 'feature/api-dirty');
    expect(dirtyEntry.isDirty).toBe(true);
  });

  it('脏 worktree 删除被 409 拦截并列出修改，force 后删除成功', async () => {
    const dirtyWorktreePath = buildWorktreePath('api-dirty-wt');
    const encodedRepo = encodeURIComponent(fixtureRepository.repoPath);
    const encodedTarget = encodeURIComponent(dirtyWorktreePath);

    const blockedResponse = await fetch(
      `${serverInstance.baseUrl}/api/worktrees?repoPath=${encodedRepo}&targetPath=${encodedTarget}&force=false`,
      { method: 'DELETE' }
    );
    const blockedBody = await blockedResponse.json();
    expect(blockedResponse.status).toBe(409);
    expect(blockedBody.details.uncommittedFiles.length).toBeGreaterThan(0);
    expect(blockedBody.details).toHaveProperty('unmergedCommitCount');

    const forcedResponse = await fetch(
      `${serverInstance.baseUrl}/api/worktrees?repoPath=${encodedRepo}&targetPath=${encodedTarget}&force=true`,
      { method: 'DELETE' }
    );
    expect(forcedResponse.status).toBe(200);
    expect(fs.existsSync(dirtyWorktreePath)).toBe(false);
  });

  it('主 worktree 删除被拒绝', async () => {
    const response = await fetch(
      `${serverInstance.baseUrl}/api/worktrees?repoPath=${encodeURIComponent(fixtureRepository.repoPath)}&targetPath=${encodeURIComponent(fixtureRepository.repoPath)}`,
      { method: 'DELETE' }
    );
    expect(response.status).toBe(409);
  });

  it('prune 清理手动删除的 worktree 记录', async () => {
    const staleWorktreePath = buildWorktreePath('api-stale-wt');
    await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: staleWorktreePath,
      branchMode: 'new',
      branchName: 'feature/api-stale',
      dependencyStrategy: 'skip',
      copyIgnoredFiles: false,
      openInEditor: false
    });
    await commitFileInRepository(fixtureRepository.repoPath, 'api-touch.txt', 'x', 'touch for prune');

    fs.rmSync(staleWorktreePath, { recursive: true, force: true });
    const { body } = await postJson('/api/worktrees/prune', { repoPath: fixtureRepository.repoPath });
    expect(body.prunedCount).toBeGreaterThanOrEqual(1);
  });
});

describe('任务 SSE 日志流', () => {
  it('收到 history 与 end 事件', async () => {
    const response = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: buildWorktreePath('api-sse-wt'),
      branchMode: 'new',
      branchName: 'feature/api-sse',
      dependencyStrategy: 'install',
      copyIgnoredFiles: false,
      openInEditor: false
    });
    const { installJobId } = response.body;

    const collectedEventList = await readSseUntilEnd(`${serverInstance.baseUrl}/api/tasks/${installJobId}/logs`);
    const eventNames = collectedEventList.map((collectedEvent) => collectedEvent.event);
    expect(eventNames[0]).toBe('history');
    expect(eventNames).toContain('end');

    const endEvent = collectedEventList.find((collectedEvent) => collectedEvent.event === 'end');
    expect(['success', 'failed']).toContain(endEvent.data.status);
  });

  it('不存在的任务返回 404', async () => {
    const { status } = await getJson('/api/tasks/not-exist-job');
    expect(status).toBe(404);
  });
});
