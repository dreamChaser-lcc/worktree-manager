import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { persistenceManager } from '../src/storage/persistence-manager.js';
import { convertRemoteUrlToWebUrl } from '../src/routes/requirement-task-routes.js';
import { executeGitCommand } from '../src/core/git-executor.js';
import { generateWorkspaceFileForTask } from '../src/core/workspace-file-generator.js';
import { startTestServer } from './helpers/test-server.js';
import { createFixtureRepository } from './helpers/fixture-repo.js';

const requirementTestRootDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wtm-reqtask-'));
const generatorTestRootDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wtm-wsgen-'));
const fixtureRepository = await createFixtureRepository();

await persistenceManager.initialize({
  dataRootOverride: path.join(requirementTestRootDirectory, 'data'),
  settingsFilePath: path.join(requirementTestRootDirectory, 'settings.json'),
  defaultDataRootPath: path.join(requirementTestRootDirectory, 'default-data')
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

/** 轮询任务直至落终态（success/failed/interrupted），超时抛错避免用例悬挂 */
async function waitForJobFinished(jobId) {
  const deadlineTimestamp = Date.now() + 15000;
  while (Date.now() < deadlineTimestamp) {
    const jobResult = await getJson(`/api/tasks/${jobId}`);
    if (jobResult.status === 200 && jobResult.body.status !== 'running') {
      return jobResult.body;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`任务未在预期时间内结束: ${jobId}`);
}

function buildRequirementPayload(overrides = {}) {
  return {
    requirementName: '【微赞+星享】【小蛋】直播任务支持区分不同路径玩法',
    requirementUrl: 'https://tapd.example.com/PRJ/detail/1001',
    branchName: 'feature/req-1001',
    projectList: [{ projectName: 'fixture-main', repoPath: fixtureRepository.repoPath, worktreePath: null }],
    reservedContent: '',
    ...overrides
  };
}

afterAll(async () => {
  await serverInstance.close();
  await fixtureRepository.cleanup();
  // 独立安装的 npm 进程可能仍占用临时目录（EBUSY），重试清理
  for (let cleanupAttempt = 0; cleanupAttempt < 6; cleanupAttempt += 1) {
    try {
      await fs.promises.rm(requirementTestRootDirectory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
  }
});

describe('需求任务 API', () => {
  it('创建 → 列表可见 → 更新 → 删除', async () => {
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload());
    expect(createResult.status).toBe(200);
    const createdTask = createResult.body.task;
    expect(createdTask.id).toBeTruthy();
    expect(createdTask.branchName).toBe('feature/req-1001');
    expect(createdTask.requirementName).toBe('【微赞+星享】【小蛋】直播任务支持区分不同路径玩法');
    expect(createdTask.createdAt).toBe(createdTask.updatedAt);

    const listResult = await getJson('/api/requirement-tasks');
    expect(listResult.status).toBe(200);
    expect(listResult.body.tasks.some((task) => task.id === createdTask.id)).toBe(true);

    const updateResult = await putJson(`/api/requirement-tasks/${createdTask.id}`, buildRequirementPayload({
      branchName: 'feature/req-1001-v2',
      projectList: [
        { projectName: 'fixture-main', repoPath: fixtureRepository.repoPath, worktreePath: null },
        { projectName: 'fixture-second', repoPath: 'D:\\repos\\second', worktreePath: null }
      ]
    }));
    expect(updateResult.status).toBe(200);
    expect(updateResult.body.task.branchName).toBe('feature/req-1001-v2');
    expect(updateResult.body.task.projectList.length).toBe(2);
    expect(updateResult.body.task.updatedAt >= createdTask.updatedAt).toBe(true);

    const deleteResult = await requestJson('DELETE', `/api/requirement-tasks/${createdTask.id}`);
    expect(deleteResult.status).toBe(200);
    expect(deleteResult.body.note).toContain('git 分支');

    // 软删除：记录保留且带 deletedAt；重复删除返回 409
    const listAfterDelete = await getJson('/api/requirement-tasks');
    const deletedRecord = listAfterDelete.body.tasks.find((task) => task.id === createdTask.id);
    expect(deletedRecord).toBeTruthy();
    expect(deletedRecord.deletedAt).toBeTruthy();
    const reDeleteResult = await requestJson('DELETE', `/api/requirement-tasks/${createdTask.id}`);
    expect(reDeleteResult.status).toBe(409);

    // 恢复：清除删除标记
    const restoreResult = await postJson(`/api/requirement-tasks/${createdTask.id}/restore`, {});
    expect(restoreResult.status).toBe(200);
    expect(restoreResult.body.task.deletedAt).toBeNull();
  });

  it('校验：缺分支名称/缺项目列表/项目缺主仓库路径 均返回 400', async () => {
    const missingBranchResult = await postJson('/api/requirement-tasks', buildRequirementPayload({ branchName: '' }));
    expect(missingBranchResult.status).toBe(400);

    const missingProjectResult = await postJson('/api/requirement-tasks', buildRequirementPayload({ projectList: [] }));
    expect(missingProjectResult.status).toBe(400);

    const missingRepoResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      projectList: [{ projectName: 'demo', repoPath: '', worktreePath: null }]
    }));
    expect(missingRepoResult.status).toBe(400);
  });

  it('更新不存在的需求任务返回 404', async () => {
    const updateResult = await putJson('/api/requirement-tasks/no-such-id', buildRequirementPayload());
    expect(updateResult.status).toBe(404);
  });

  it('创建 worktree 传 requirementTaskId 时自动挂载到主仓库匹配的项目条目', async () => {
    const createTaskResult = await postJson('/api/requirement-tasks', buildRequirementPayload());
    const createdTask = createTaskResult.body.task;

    const worktreeTargetPath = path.join(fixtureRepository.parentTempDir, 'req-attach-wt');
    const createWorktreeResult = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: worktreeTargetPath,
      branchMode: 'existing',
      branchName: 'develop',
      dependencyStrategy: 'skip',
      requirementTaskId: createdTask.id
    });
    expect(createWorktreeResult.status).toBe(200);
    expect(createWorktreeResult.body.requirementTaskAttach.attached).toBe(true);

    const listResult = await getJson('/api/requirement-tasks');
    const updatedTask = listResult.body.tasks.find((task) => task.id === createdTask.id);
    // os.tmpdir() 返回 8.3 短路径而服务端归一化为长路径，用 native realpath 对齐后比较
    expect(fs.realpathSync.native(path.resolve(updatedTask.projectList[0].worktreePath))).toBe(
      fs.realpathSync.native(path.resolve(worktreeTargetPath))
    );
  });

  it('关联不存在的需求任务时创建不受影响，返回 attached=false 与 warning', async () => {
    const worktreeTargetPath = path.join(fixtureRepository.parentTempDir, 'req-attach-miss-wt');
    const createWorktreeResult = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: worktreeTargetPath,
      branchMode: 'new',
      branchName: 'feature/orphan-attach',
      dependencyStrategy: 'skip',
      requirementTaskId: 'no-such-requirement'
    });
    expect(createWorktreeResult.status).toBe(200);
    expect(createWorktreeResult.body.requirementTaskAttach.attached).toBe(false);
    expect(createWorktreeResult.body.warnings.join('\n')).toContain('需求任务关联未完成');
  });
});

describe('git 远程链接转换（convertRemoteUrlToWebUrl）', () => {
  it('SSH 形式转为 https 网页链接', () => {
    expect(convertRemoteUrlToWebUrl('git@github.com:group/repo.git')).toBe('https://github.com/group/repo');
    expect(convertRemoteUrlToWebUrl('git@gitlab.example.com:team/app.git')).toBe(
      'https://gitlab.example.com/team/app'
    );
    expect(convertRemoteUrlToWebUrl('ssh://git@host.com:2222/group/repo.git')).toBe(
      'https://host.com/group/repo'
    );
  });

  it('http(s) 原样返回，本地路径与空值返回 null', () => {
    expect(convertRemoteUrlToWebUrl('https://git.example.com/g/r.git')).toBe('https://git.example.com/g/r.git');
    expect(convertRemoteUrlToWebUrl('D:\\repos\\local-remote')).toBeNull();
    expect(convertRemoteUrlToWebUrl(null)).toBeNull();
  });
});

describe('需求任务删除与恢复', () => {
  it('删除需求移除关联 worktree（分支保留），恢复按原路径重建', async () => {
    const createTaskResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/del-restore',
      generateWorkspace: false
    }));
    const createdTask = createTaskResult.body.task;

    // 主仓库预置 .husky：恢复重建目录时应一并复制过去（含 gitignore 的运行时子目录）
    fs.mkdirSync(path.join(fixtureRepository.repoPath, '.husky', '_'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRepository.repoPath, '.husky', 'pre-commit'), '#!/bin/sh\nnpm test\n', 'utf8');
    fs.writeFileSync(path.join(fixtureRepository.repoPath, '.husky', '_', 'husky.sh'), '#!/bin/sh\n', 'utf8');

    // 通过关联需求创建 worktree（新建分支 feature/del-restore）
    const worktreeTargetPath = path.join(fixtureRepository.parentTempDir, 'req-delete-wt');
    const createWorktreeResult = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: worktreeTargetPath,
      branchMode: 'new',
      branchName: 'feature/del-restore',
      dependencyStrategy: 'skip',
      requirementTaskId: createdTask.id
    });
    expect(createWorktreeResult.status).toBe(200);
    expect(fs.existsSync(worktreeTargetPath)).toBe(true);

    // 删除需求：worktree 与目录被移除，分支保留
    const deleteResult = await requestJson('DELETE', `/api/requirement-tasks/${createdTask.id}`);
    expect(deleteResult.status).toBe(200);
    expect(deleteResult.body.removedWorktreeList.length).toBe(1);
    expect(fs.existsSync(worktreeTargetPath)).toBe(false);
    const branchVerifyResult = await executeGitCommand(fixtureRepository.repoPath, [
      'rev-parse', '--verify', 'refs/heads/feature/del-restore'
    ]);
    expect(branchVerifyResult.stdout.trim()).not.toBe('');

    // 恢复：按原路径重建 worktree，清除删除标记
    const restoreResult = await postJson(`/api/requirement-tasks/${createdTask.id}/restore`, {});
    expect(restoreResult.status).toBe(200);
    expect(restoreResult.body.restoredWorktreeList.length).toBe(1);
    expect(fs.existsSync(worktreeTargetPath)).toBe(true);
    // 恢复时按创建流程的默认白名单复制忽略内容：.husky 整棵目录随重建目录一起可用
    expect(restoreResult.body.restoredWorktreeList[0].ignoredCopyText).toBe('.husky/');
    expect(fs.existsSync(path.join(worktreeTargetPath, '.husky', '_', 'husky.sh'))).toBe(true);
    expect(restoreResult.body.task.deletedAt).toBeNull();
    const listResult = await getJson('/api/requirement-tasks');
    const restoredTask = listResult.body.tasks.find((task) => task.id === createdTask.id);
    expect(restoredTask.deletedAt).toBeNull();
  });

  it('worktree 实际分支与需求分支不同时，按删除前实际分支恢复', async () => {
    // 先建一个与需求分支无关的 worktree（feature/other-branch）
    const otherWorktreePath = path.join(fixtureRepository.parentTempDir, 'req-lastbranch-wt');
    const createWorktreeResult = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: otherWorktreePath,
      branchMode: 'new',
      branchName: 'feature/other-branch',
      dependencyStrategy: 'skip'
    });
    expect(createWorktreeResult.status).toBe(200);

    // 需求分支填 ces（本地不存在），但项目关联的 worktree 实际在 feature/other-branch
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'ces-not-exist',
      generateWorkspace: false,
      projectList: [
        { projectName: 'fixture-main', repoPath: fixtureRepository.repoPath, worktreePath: otherWorktreePath }
      ]
    }));
    const createdTask = createResult.body.task;

    const deleteResult = await requestJson('DELETE', `/api/requirement-tasks/${createdTask.id}`);
    expect(deleteResult.status).toBe(200);
    expect(deleteResult.body.removedWorktreeList[0].branchName).toBe('feature/other-branch');

    const restoreResult = await postJson(`/api/requirement-tasks/${createdTask.id}/restore`, {});
    expect(restoreResult.status).toBe(200);
    expect(restoreResult.body.restoredWorktreeList[0].branchName).toBe('feature/other-branch');
    const headBranchResult = await executeGitCommand(otherWorktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(headBranchResult.stdout.trim()).toBe('feature/other-branch');
  });

  it('彻底删除：软删除后物理删除记录与工作区文件，不可再恢复', async () => {
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/permanent-del'
    }));
    const createdTask = createResult.body.task;
    expect(createdTask.workspaceFilePath).toBeTruthy();
    expect(fs.existsSync(createdTask.workspaceFilePath)).toBe(true);

    // 先软删除，再彻底删除
    const softDeleteResult = await requestJson('DELETE', `/api/requirement-tasks/${createdTask.id}`);
    expect(softDeleteResult.status).toBe(200);
    const permanentResult = await requestJson('DELETE', `/api/requirement-tasks/${createdTask.id}/permanent`);
    expect(permanentResult.status).toBe(200);
    expect(permanentResult.body.permanent).toBe(true);
    expect(fs.existsSync(createdTask.workspaceFilePath)).toBe(false);

    // 记录已物理删除：列表不可见、恢复返回 404
    const listResult = await getJson('/api/requirement-tasks');
    expect(listResult.body.tasks.some((task) => task.id === createdTask.id)).toBe(false);
    const restoreResult = await postJson(`/api/requirement-tasks/${createdTask.id}/restore`, {});
    expect(restoreResult.status).toBe(404);
  });

  it('删除需求：目录损坏（.git 丢失）的 worktree 也能删除成功', async () => {
    const createTaskResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/corrupt-del',
      generateWorkspace: false
    }));
    const createdTask = createTaskResult.body.task;

    const corruptWorktreePath = path.join(fixtureRepository.parentTempDir, 'req-corrupt-wt');
    const createWorktreeResult = await postJson('/api/worktrees/create', {
      repoPath: fixtureRepository.repoPath,
      targetPath: corruptWorktreePath,
      branchMode: 'new',
      branchName: 'feature/corrupt-del',
      dependencyStrategy: 'skip',
      requirementTaskId: createdTask.id
    });
    expect(createWorktreeResult.status).toBe(200);

    // 破坏现场：移除 .git 元数据，目录不再是 git 仓库（模拟半途而废的创建残留）
    fs.rmSync(path.join(corruptWorktreePath, '.git'), { force: true });

    const deleteResult = await requestJson('DELETE', `/api/requirement-tasks/${createdTask.id}`);
    expect(deleteResult.status).toBe(200);
    expect(fs.existsSync(corruptWorktreePath)).toBe(false);
  });

  it('默认保存后生成 .code-workspace：路径回填、文件含标识注释与已关联目录', async () => {
    // 仅关联主仓库、未建 worktree 的项目目录（应回退主仓库路径纳入工作区）
    const repoOnlyDirectoryPath = path.join(fixtureRepository.parentTempDir, 'repo-only-project');
    fs.mkdirSync(repoOnlyDirectoryPath, { recursive: true });

    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/ws-demo',
      projectList: [
        { projectName: 'fixture-main', repoPath: fixtureRepository.repoPath, worktreePath: fixtureRepository.repoPath },
        { projectName: 'repo-only', repoPath: repoOnlyDirectoryPath, worktreePath: null },
        { projectName: 'not-ready', repoPath: 'D:\\repos\\not-ready', worktreePath: null }
      ]
    }));
    expect(createResult.status).toBe(200);

    const workspaceResult = createResult.body.workspace;
    expect(workspaceResult).toBeTruthy();
    const workspaceFilePath = workspaceResult.workspaceFilePath;
    expect(workspaceFilePath).toContain('feature-ws-demo.code-workspace');
    expect(fs.existsSync(workspaceFilePath)).toBe(true);
    expect(createResult.body.task.workspaceFilePath).toBe(workspaceFilePath);

    // 仅关联项目（未建 worktree）回退主仓库目录纳入；主仓库路径不存在时记入排除清单并说明原因
    expect(workspaceResult.includedPathList).toContain(fixtureRepository.repoPath);
    expect(workspaceResult.includedPathList).toContain(repoOnlyDirectoryPath);
    expect(workspaceResult.excludedProjectList).toEqual([
      { projectName: 'not-ready', reason: '主仓库目录不存在' }
    ]);

    const fileContent = fs.readFileSync(workspaceFilePath, 'utf8');
    expect(fileContent).toContain('由 worktree-manager 生成');
    expect(fileContent).toContain('"folders"');
    // 文件为 JSONC：剥离注释行后解析，校验 folders 收录的 worktree 路径
    const jsonText = fileContent.split('\n').filter((lineText) => !lineText.trim().startsWith('//')).join('\n');
    const workspaceDocument = JSON.parse(jsonText);
    expect(workspaceDocument.folders.map((folder) => folder.path)).toContain(fixtureRepository.repoPath);
    expect(workspaceDocument.folders.map((folder) => folder.path)).toContain(repoOnlyDirectoryPath);
    expect(workspaceDocument.settings).toEqual({});
  });

  it('generateWorkspace=false 时不生成工作区文件', async () => {
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/no-ws',
      generateWorkspace: false
    }));
    expect(createResult.status).toBe(200);
    expect(createResult.body.workspace).toBeNull();
    expect(createResult.body.task.workspaceFilePath).toBeNull();
  });

  it('列表支持按时间范围筛选：命中当天、超出范围为空、非法日期被忽略', async () => {
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/time-filter',
      generateWorkspace: false
    }));
    expect(createResult.status).toBe(200);
    const createdTaskId = createResult.body.task.id;

    // 记录存的是 UTC ISO 字符串、列表也按该字符串展示日期，因此筛选日期同样是 UTC 日期前缀
    const todayDateText = new Date().toISOString().slice(0, 10);
    const sameDayResult = await getJson(
      `/api/requirement-tasks?status=all&page=1&pageSize=20&timeField=createdAt&startDate=${todayDateText}&endDate=${todayDateText}`
    );
    expect(sameDayResult.body.tasks.some((task) => task.id === createdTaskId)).toBe(true);

    const futureResult = await getJson(
      '/api/requirement-tasks?status=all&page=1&pageSize=20&timeField=createdAt&startDate=2999-01-01'
    );
    expect(futureResult.body.total).toBe(0);

    const pastResult = await getJson(
      '/api/requirement-tasks?status=all&page=1&pageSize=20&timeField=updatedAt&endDate=2000-01-01'
    );
    expect(pastResult.body.total).toBe(0);

    // 非法日期格式视为未传，不筛选也不报错
    const invalidDateResult = await getJson(
      '/api/requirement-tasks?status=all&page=1&pageSize=20&startDate=not-a-date'
    );
    expect(invalidDateResult.status).toBe(200);
    expect(invalidDateResult.body.total).toBeGreaterThan(0);
  });

  it('状态 tab 拆分：待提测排除测试中记录、已提测只含测试中、全部含已发布', async () => {
    const pendingTask = (await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/tab-pending',
      generateWorkspace: false
    }))).body.task;
    const testedTask = (await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/tab-tested',
      generateWorkspace: false
    }))).body.task;
    const publishedTask = (await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/tab-published',
      generateWorkspace: false
    }))).body.task;

    // 阶段标签为「待开发」的记录同样算待提测（待提测用排除法）
    const devTask = (await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/tab-dev',
      generateWorkspace: false
    }))).body.task;
    await postJson(`/api/requirement-tasks/${devTask.id}/stage`, { stageTag: '待开发' });
    await postJson(`/api/requirement-tasks/${testedTask.id}/stage`, { stageTag: '测试中' });
    await postJson(`/api/requirement-tasks/${publishedTask.id}/publish`, { published: true });

    async function fetchTaskIdSet(statusKey) {
      const listResult = await getJson(`/api/requirement-tasks?status=${statusKey}&page=1&pageSize=100`);
      return new Set(listResult.body.tasks.map((task) => task.id));
    }

    const pendingIdSet = await fetchTaskIdSet('pending-test');
    expect(pendingIdSet.has(pendingTask.id)).toBe(true);
    expect(pendingIdSet.has(devTask.id)).toBe(true);
    expect(pendingIdSet.has(testedTask.id)).toBe(false);
    expect(pendingIdSet.has(publishedTask.id)).toBe(false);

    const testedIdSet = await fetchTaskIdSet('tested');
    expect(testedIdSet.has(testedTask.id)).toBe(true);
    expect(testedIdSet.has(pendingTask.id)).toBe(false);

    const publishedIdSet = await fetchTaskIdSet('published');
    expect(publishedIdSet.has(publishedTask.id)).toBe(true);
    expect(publishedIdSet.has(testedTask.id)).toBe(false);

    const allIdSet = await fetchTaskIdSet('all');
    expect(allIdSet.has(pendingTask.id)).toBe(true);
    expect(allIdSet.has(testedTask.id)).toBe(true);
    expect(allIdSet.has(publishedTask.id)).toBe(true);

    // 阶段标签筛选：与状态 tab 取交集，unset 匹配未设置标签的记录
    const unsetStageResult = await getJson(
      '/api/requirement-tasks?status=pending-test&page=1&pageSize=100&stageTag=unset'
    );
    const unsetStageIdSet = new Set(unsetStageResult.body.tasks.map((task) => task.id));
    expect(unsetStageIdSet.has(pendingTask.id)).toBe(true);
    expect(unsetStageIdSet.has(devTask.id)).toBe(false);

    const waitDevStageResult = await getJson(
      `/api/requirement-tasks?status=pending-test&page=1&pageSize=100&stageTag=${encodeURIComponent('待开发')}`
    );
    const waitDevStageIdSet = new Set(waitDevStageResult.body.tasks.map((task) => task.id));
    expect(waitDevStageIdSet.has(devTask.id)).toBe(true);
    expect(waitDevStageIdSet.has(pendingTask.id)).toBe(false);
  });

  it('手动重新生成工作区文件', async () => {
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/ws-regen',
      generateWorkspace: false
    }));
    const createdTask = createResult.body.task;

    const regenerateResult = await postJson(`/api/requirement-tasks/${createdTask.id}/generate-workspace`, {});
    expect(regenerateResult.status).toBe(200);
    expect(regenerateResult.body.workspace.workspaceFilePath).toContain('feature-ws-regen.code-workspace');
    expect(fs.existsSync(regenerateResult.body.workspace.workspaceFilePath)).toBe(true);

    const listResult = await getJson('/api/requirement-tasks');
    const updatedTask = listResult.body.tasks.find((task) => task.id === createdTask.id);
    expect(updatedTask.workspaceFilePath).toBe(regenerateResult.body.workspace.workspaceFilePath);
  });

  it('独立安装无 lockfile 回退 npm 并断链；恢复共享重建 junction', async () => {
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/no-lock',
      generateWorkspace: false
    }));
    const createdTask = createResult.body.task;

    // 造一个 junction 共享状态的"worktree"目录（无 lockfile）
    const fakeWorktreePath = path.join(requirementTestRootDirectory, 'fake-wt-no-lock');
    const fakeMainModulesPath = path.join(requirementTestRootDirectory, 'fake-main-modules');
    fs.mkdirSync(fakeMainModulesPath, { recursive: true });
    fs.mkdirSync(fakeWorktreePath, { recursive: true });
    fs.symlinkSync(fakeMainModulesPath, path.join(fakeWorktreePath, 'node_modules'), 'junction');
    await putJson(`/api/requirement-tasks/${createdTask.id}`, buildRequirementPayload({
      branchName: 'feature/no-lock',
      projectList: [
        { projectName: 'fixture-main', repoPath: fixtureRepository.repoPath, worktreePath: fakeWorktreePath }
      ]
    }));

    // 独立安装：断开 junction，包管理器回退 npm（worktree 与主仓库都无 lockfile）
    const installResult = await postJson(`/api/requirement-tasks/${createdTask.id}/install-independent`, {
      worktreePath: fakeWorktreePath
    });
    expect(installResult.status).toBe(200);
    expect(installResult.body.packageManager).toBe('npm');
    expect(installResult.body.packageManagerSource).toBe('fallback');
    expect(installResult.body.junctionRemoved).toBe(true);
    expect(fs.existsSync(path.join(fakeWorktreePath, 'node_modules'))).toBe(false);

    // 默认安装任务仍在运行时会触发互斥锁，先等它结束再恢复共享
    await waitForJobFinished(installResult.body.jobId);

    // 恢复共享：重建 junction 指向主仓库 node_modules
    fs.mkdirSync(path.join(fixtureRepository.repoPath, 'node_modules'), { recursive: true });
    const restoreResult = await postJson(`/api/requirement-tasks/${createdTask.id}/restore-shared`, {
      worktreePath: fakeWorktreePath
    });
    expect(restoreResult.status).toBe(200);
    const restoredLinkStat = fs.lstatSync(path.join(fakeWorktreePath, 'node_modules'));
    expect(restoredLinkStat.isSymbolicLink()).toBe(true);
  });

  it('安装互斥：同 worktree 执行中禁止重复安装与恢复共享；自定义脚本按 custom 模式启动', async () => {
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/install-lock',
      generateWorkspace: false
    }));
    const createdTask = createResult.body.task;

    const fakeWorktreePath = path.join(requirementTestRootDirectory, 'fake-wt-install-lock');
    fs.mkdirSync(fakeWorktreePath, { recursive: true });
    await putJson(`/api/requirement-tasks/${createdTask.id}`, buildRequirementPayload({
      branchName: 'feature/install-lock',
      projectList: [
        { projectName: 'lock-fixture', repoPath: fixtureRepository.repoPath, worktreePath: fakeWorktreePath }
      ]
    }));

    // 自定义脚本：长跑任务占住执行窗口
    const customInstallResult = await postJson(`/api/requirement-tasks/${createdTask.id}/install-independent`, {
      worktreePath: fakeWorktreePath,
      customScript: 'node -e "setTimeout(function(){}, 3000)"'
    });
    expect(customInstallResult.status).toBe(200);
    expect(customInstallResult.body.installMode).toBe('custom');
    expect(customInstallResult.body.packageManagerSource).toBe('fallback');

    // 执行中重复触发（默认安装）→ 409
    const duplicateInstallResult = await postJson(`/api/requirement-tasks/${createdTask.id}/install-independent`, {
      worktreePath: fakeWorktreePath
    });
    expect(duplicateInstallResult.status).toBe(409);
    expect(duplicateInstallResult.body.error).toContain('已有安装任务执行中');

    // 执行中恢复共享 → 409
    const restoreDuringInstallResult = await postJson(`/api/requirement-tasks/${createdTask.id}/restore-shared`, {
      worktreePath: fakeWorktreePath
    });
    expect(restoreDuringInstallResult.status).toBe(409);

    // 任务结束后恢复共享放行
    await waitForJobFinished(customInstallResult.body.jobId);
    const restoreAfterResult = await postJson(`/api/requirement-tasks/${createdTask.id}/restore-shared`, {
      worktreePath: fakeWorktreePath
    });
    expect(restoreAfterResult.status).toBe(200);
  });

  it('恢复时主仓库已有依赖：自动重建共享链接（junction）', async () => {
    // 造一个真实 worktree（独立于 fixture 的常规流程，直接用 git 创建）
    const worktreePath = path.join(requirementTestRootDirectory, 'restore-dep-wt');
    await executeGitCommand(fixtureRepository.repoPath, [
      'worktree', 'add', '-b', 'feature/restore-dep', worktreePath
    ]);

    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/restore-dep',
      generateWorkspace: false,
      projectList: [{ projectName: 'restore-fixture', repoPath: fixtureRepository.repoPath, worktreePath }]
    }));
    const createdTask = createResult.body.task;

    // 删除：worktree 与目录被移除
    const deleteResult = await requestJson('DELETE', `/api/requirement-tasks/${createdTask.id}`);
    expect(deleteResult.status).toBe(200);
    expect(fs.existsSync(worktreePath)).toBe(false);

    // 主仓库装好依赖后恢复：worktree 重建且依赖自动共享
    fs.mkdirSync(path.join(fixtureRepository.repoPath, 'node_modules'), { recursive: true });
    const restoreResult = await postJson(`/api/requirement-tasks/${createdTask.id}/restore`, {});
    expect(restoreResult.status).toBe(200);
    expect(restoreResult.body.restoredWorktreeList.length).toBe(1);
    const restoredItem = restoreResult.body.restoredWorktreeList[0];
    expect(restoredItem.dependencyAction).toBe('shared');
    expect(restoredItem.dependencyReason).toContain('已重建共享依赖');
    const linkStat = fs.lstatSync(path.join(worktreePath, 'node_modules'));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  it('任务记录删除：运行中拒绝（409）；已结束可删且详情/日志一并清理', async () => {
    const fakeWorktreePath = path.join(requirementTestRootDirectory, 'fake-wt-task-delete');
    fs.mkdirSync(fakeWorktreePath, { recursive: true });
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/task-delete',
      generateWorkspace: false,
      projectList: [
        { projectName: 'delete-fixture', repoPath: fixtureRepository.repoPath, worktreePath: fakeWorktreePath }
      ]
    }));
    const createdTask = createResult.body.task;

    // 快速失败任务 → 落终态后可删除
    const failedInstallResult = await postJson(`/api/requirement-tasks/${createdTask.id}/install-independent`, {
      worktreePath: fakeWorktreePath,
      customScript: 'node -e "process.exit(1)"'
    });
    expect(failedInstallResult.status).toBe(200);
    const finishedJobId = failedInstallResult.body.jobId;
    await waitForJobFinished(finishedJobId);

    // 长任务执行中删除 → 409
    const runningInstallResult = await postJson(`/api/requirement-tasks/${createdTask.id}/install-independent`, {
      worktreePath: fakeWorktreePath,
      customScript: 'node -e "setTimeout(function(){}, 2500)"'
    });
    expect(runningInstallResult.status).toBe(200);
    const runningDeleteResult = await requestJson('DELETE', `/api/tasks/${runningInstallResult.body.jobId}`);
    expect(runningDeleteResult.status).toBe(409);
    await waitForJobFinished(runningInstallResult.body.jobId);

    // 已结束任务删除成功：详情 404（记录与日志一并清理）
    const deleteResult = await requestJson('DELETE', `/api/tasks/${finishedJobId}`);
    expect(deleteResult.status).toBe(200);
    expect(deleteResult.body.deleted).toBe(true);
    const detailAfterDelete = await getJson(`/api/tasks/${finishedJobId}`);
    expect(detailAfterDelete.status).toBe(404);

    // 重复删除 → 404
    const repeatDeleteResult = await requestJson('DELETE', `/api/tasks/${finishedJobId}`);
    expect(repeatDeleteResult.status).toBe(404);
  });

  it('分支定位：返回各主仓库 worktree 实时清单（含当前分支）', async () => {
    // 复用前面用例创建的 req-attach-wt（分支 develop 在此签出）
    const attachedWorktreePath = path.join(fixtureRepository.parentTempDir, 'req-attach-wt');
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'develop',
      generateWorkspace: false,
      projectList: [
        { projectName: 'fixture-main', repoPath: fixtureRepository.repoPath, worktreePath: attachedWorktreePath },
        { projectName: 'ghost', repoPath: 'D:\\not-exist-repo', worktreePath: null }
      ]
    }));
    const createdTask = createResult.body.task;

    const locateResult = await getJson(`/api/requirement-tasks/${createdTask.id}/locate`);
    expect(locateResult.status).toBe(200);
    expect(locateResult.body.branchName).toBe('develop');

    const firstLocate = locateResult.body.projectList[0];
    expect(firstLocate.worktreeList.length).toBeGreaterThan(0);
    // 关联 worktree 在清单中且当前分支为 develop（即与需求一致）
    const currentWorktreeEntry = firstLocate.worktreeList.find(
      (worktreeEntry) =>
        fs.realpathSync.native(path.resolve(worktreeEntry.path)) ===
        fs.realpathSync.native(path.resolve(attachedWorktreePath))
    );
    expect(currentWorktreeEntry).toBeTruthy();
    expect(currentWorktreeEntry.branch).toBe('develop');
    expect(currentWorktreeEntry.isDirty).toBe(false);
    // 清单中包含主仓库条目（isMain）
    expect(firstLocate.worktreeList.some((worktreeEntry) => worktreeEntry.isMain)).toBe(true);

    const secondLocate = locateResult.body.projectList[1];
    expect(secondLocate.worktreeList).toEqual([]);
    expect(secondLocate.locateError).toBeTruthy();
  });
});

describe('工作区文件生成器（聚合目录模式）', () => {
  function createWorktreeDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
    fs.writeFileSync(path.join(directoryPath, 'package.json'), '{}', 'utf8');
  }

  function buildGeneratorRecord(overrides = {}) {
    return {
      id: 'task-1',
      requirementName: '【小蛋】直播任务玩法',
      requirementUrl: 'https://tapd.example.com/1001',
      branchName: 'feature/ws-layout',
      projectList: [],
      ...overrides
    };
  }

  function readWorkspaceDocument(workspaceFilePath) {
    const fileContent = fs.readFileSync(workspaceFilePath, 'utf8');
    const jsonText = fileContent.split('\n').filter((lineText) => !lineText.trim().startsWith('//')).join('\n');
    return JSON.parse(jsonText);
  }

  it('聚合目录模式：文件与 worktree 同放需求目录，folders 使用相对路径', async () => {
    const workspaceDirectoryPath = path.join(generatorTestRootDirectory, 'workspaces');
    const requirementDirectoryPath = path.join(workspaceDirectoryPath, '【小蛋】直播任务玩法');
    const worktreeAdminPath = path.join(requirementDirectoryPath, 'admin-web');
    const worktreeAgentPath = path.join(requirementDirectoryPath, 'agentadmin');
    createWorktreeDirectory(worktreeAdminPath);
    createWorktreeDirectory(worktreeAgentPath);

    const result = await generateWorkspaceFileForTask(
      buildGeneratorRecord({
        projectList: [
          { projectName: 'admin', repoPath: 'D:\\repos\\admin-web', worktreePath: worktreeAdminPath },
          { projectName: 'vz', repoPath: 'D:\\repos\\agentadmin', worktreePath: worktreeAgentPath }
        ]
      }),
      workspaceDirectoryPath,
      { groupWorktreesByRequirement: true }
    );

    const expectedDirectory = path.join(workspaceDirectoryPath, '【小蛋】直播任务玩法');
    expect(path.dirname(result.workspaceFilePath)).toBe(expectedDirectory);
    expect(path.basename(result.workspaceFilePath)).toBe('feature-ws-layout.code-workspace');

    const workspaceDocument = readWorkspaceDocument(result.workspaceFilePath);
    expect(workspaceDocument.folders.map((folder) => folder.path)).toEqual(['admin-web', 'agentadmin']);
  });

  it('非聚合模式：文件放工作区根目录，folders 为绝对路径', async () => {
    const workspaceDirectoryPath = path.join(generatorTestRootDirectory, 'flat-workspaces');
    const worktreePath = path.join(generatorTestRootDirectory, 'elsewhere', 'admin-web');
    createWorktreeDirectory(worktreePath);

    const result = await generateWorkspaceFileForTask(
      buildGeneratorRecord({
        projectList: [{ projectName: 'admin', repoPath: 'D:\\repos\\admin-web', worktreePath }]
      }),
      workspaceDirectoryPath,
      { groupWorktreesByRequirement: false }
    );

    expect(path.dirname(result.workspaceFilePath)).toBe(path.resolve(workspaceDirectoryPath));
    const workspaceDocument = readWorkspaceDocument(result.workspaceFilePath);
    expect(path.resolve(workspaceDocument.folders[0].path)).toBe(path.resolve(worktreePath));
  });

  it('目录外的 worktree 用绝对路径，缺失的项目记入排除清单', async () => {
    const workspaceDirectoryPath = path.join(generatorTestRootDirectory, 'mixed-workspaces');
    const outsideWorktreePath = path.join(generatorTestRootDirectory, 'outside-tree');
    const repoOnlyDirectoryPath = path.join(generatorTestRootDirectory, 'repo-only-project');
    createWorktreeDirectory(outsideWorktreePath);
    createWorktreeDirectory(repoOnlyDirectoryPath);

    const result = await generateWorkspaceFileForTask(
      buildGeneratorRecord({
        projectList: [
          { projectName: 'outside', repoPath: 'D:\\repos\\x', worktreePath: outsideWorktreePath },
          { projectName: 'repo-only', repoPath: repoOnlyDirectoryPath, worktreePath: null },
          { projectName: 'missing', repoPath: 'D:\\repos\\y', worktreePath: null }
        ]
      }),
      workspaceDirectoryPath,
      { groupWorktreesByRequirement: true }
    );

    expect(result.excludedProjectList).toEqual([
      { projectName: 'missing', reason: '主仓库目录不存在' }
    ]);
    const workspaceDocument = readWorkspaceDocument(result.workspaceFilePath);
    expect(workspaceDocument.folders).toEqual([{ path: outsideWorktreePath }, { path: repoOnlyDirectoryPath }]);
  });
});
