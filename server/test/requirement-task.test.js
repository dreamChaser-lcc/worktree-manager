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
  await fs.promises.rm(requirementTestRootDirectory, { recursive: true, force: true });
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
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/ws-demo',
      projectList: [
        { projectName: 'fixture-main', repoPath: fixtureRepository.repoPath, worktreePath: fixtureRepository.repoPath },
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

    // 未关联 worktree 的项目被排除并说明原因
    expect(workspaceResult.includedPathList).toContain(fixtureRepository.repoPath);
    expect(workspaceResult.excludedProjectList).toEqual([
      { projectName: 'not-ready', reason: '未关联 worktree' }
    ]);

    const fileContent = fs.readFileSync(workspaceFilePath, 'utf8');
    expect(fileContent).toContain('由 worktree-manager 生成');
    expect(fileContent).toContain('"folders"');
    // 文件为 JSONC：剥离注释行后解析，校验 folders 收录的 worktree 路径
    const jsonText = fileContent.split('\n').filter((lineText) => !lineText.trim().startsWith('//')).join('\n');
    const workspaceDocument = JSON.parse(jsonText);
    expect(workspaceDocument.folders.map((folder) => folder.path)).toContain(fixtureRepository.repoPath);
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

  it('独立安装：worktree 缺少 lockfile 时返回 400', async () => {
    const createResult = await postJson('/api/requirement-tasks', buildRequirementPayload({
      branchName: 'feature/no-lock',
      generateWorkspace: false
    }));
    const createdTask = createResult.body.task;

    // 造一个无 lockfile 的目录作为关联 worktree
    const fakeWorktreePath = path.join(requirementTestRootDirectory, 'fake-wt-no-lock');
    fs.mkdirSync(fakeWorktreePath, { recursive: true });
    await putJson(`/api/requirement-tasks/${createdTask.id}`, buildRequirementPayload({
      branchName: 'feature/no-lock',
      projectList: [
        { projectName: 'fixture-main', repoPath: fixtureRepository.repoPath, worktreePath: fakeWorktreePath }
      ]
    }));

    const installResult = await postJson(`/api/requirement-tasks/${createdTask.id}/install-independent`, {
      worktreePath: fakeWorktreePath
    });
    expect(installResult.status).toBe(400);
    expect(installResult.body.error).toContain('未检测到包管理器');
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
    createWorktreeDirectory(outsideWorktreePath);

    const result = await generateWorkspaceFileForTask(
      buildGeneratorRecord({
        projectList: [
          { projectName: 'outside', repoPath: 'D:\\repos\\x', worktreePath: outsideWorktreePath },
          { projectName: 'missing', repoPath: 'D:\\repos\\y', worktreePath: null }
        ]
      }),
      workspaceDirectoryPath,
      { groupWorktreesByRequirement: true }
    );

    expect(result.excludedProjectList).toEqual([
      { projectName: 'missing', reason: '未关联 worktree' }
    ]);
    const workspaceDocument = readWorkspaceDocument(result.workspaceFilePath);
    expect(workspaceDocument.folders).toEqual([{ path: outsideWorktreePath }]);
  });
});
