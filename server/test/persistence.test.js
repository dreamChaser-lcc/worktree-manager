import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersistenceManager } from '../src/storage/persistence-manager.js';
import { resolveDataRootCandidates } from '../src/storage/data-root-resolver.js';

const storageTestRootDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wtm-storage-'));
let envSequence = 0;

/** 每个用例独立 home/默认目录，避免设置文件互相污染 */
function createIsolatedEnvironment() {
  envSequence += 1;
  const homeDirectoryPath = path.join(storageTestRootDirectory, `env-${envSequence}`, 'home');
  const defaultDataRootPath = path.join(storageTestRootDirectory, `env-${envSequence}`, 'default-data');
  fs.mkdirSync(homeDirectoryPath, { recursive: true });
  return { homeDirectoryPath, defaultDataRootPath };
}

function createTestManager(environment, extraOptions = {}) {
  return createPersistenceManager({
    homeDirectoryPath: environment.homeDirectoryPath,
    settingsFilePath: path.join(environment.homeDirectoryPath, '.worktree-manager', 'settings.json'),
    defaultDataRootPath: environment.defaultDataRootPath,
    ...extraOptions
  });
}

function buildJobSnapshot(jobId, overrides = {}) {
  return {
    id: jobId,
    name: 'unit:test-task',
    status: 'running',
    exitCode: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides
  };
}

afterAll(async () => {
  await fs.promises.rm(storageTestRootDirectory, { recursive: true, force: true });
});

describe('数据目录模式（app-data / standalone）', () => {
  it('切换到程序目录 data 后生效，切回独立目录沿用原目录；模式持久化到设置文件', async () => {
    const environment = createIsolatedEnvironment();
    const appDataDirectoryPath = path.join(storageTestRootDirectory, 'app-data-mode-test', 'app-data');
    const manager = createTestManager(environment, { appDataDirectoryPath });
    await manager.initialize();
    const standaloneDataRootPath = manager.getDataRootPath();
    expect(manager.getDataLocationMode()).toBe('standalone');

    // 切到程序目录下 data：立即生效并持久化
    await manager.changeDataLocationMode('app-data');
    expect(manager.getDataRootPath()).toBe(appDataDirectoryPath);
    expect(manager.getDataLocationMode()).toBe('app-data');

    // 重启（新实例读同一设置文件）：模式保持 app-data
    const restartedManager = createTestManager(environment, { appDataDirectoryPath });
    await restartedManager.initialize();
    expect(restartedManager.getDataLocationMode()).toBe('app-data');
    expect(restartedManager.getDataRootPath()).toBe(appDataDirectoryPath);

    // 切回独立目录：沿用切换前记录的原目录
    await restartedManager.changeDataLocationMode('standalone');
    expect(restartedManager.getDataLocationMode()).toBe('standalone');
    expect(restartedManager.getDataRootPath()).toBe(standaloneDataRootPath);
  });

  it('未知模式返回 400 语义错误', async () => {
    const environment = createIsolatedEnvironment();
    const manager = createTestManager(environment);
    await manager.initialize();
    await expect(manager.changeDataLocationMode('cloud')).rejects.toThrow('未知的数据目录模式');
  });

  it('切换数据目录时自动迁移记录数据与任务日志；workspaces 不迁移', async () => {
    const environment = createIsolatedEnvironment();
    const manager = createTestManager(environment);
    await manager.initialize();
    const oldDataRootPath = manager.getDataRootPath();

    // 写入记录与日志，造一个 workspaces 目录（应保留在旧目录不迁移）
    await manager.insertJobRecord(buildJobSnapshot('migrate-job', { status: 'success', exitCode: 0, finishedAt: new Date().toISOString() }));
    manager.appendJobLogLines('migrate-job', ['line-1']);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    const workspacesPath = path.join(oldDataRootPath, 'workspaces');
    fs.mkdirSync(workspacesPath, { recursive: true });
    fs.writeFileSync(path.join(workspacesPath, 'demo.code-workspace'), '{}', 'utf8');

    // 切换到新目录：记录与日志自动迁移，workspaces 留在原地，旧根目录被清理
    const newDataRootPath = path.join(storageTestRootDirectory, 'migrated-data');
    await manager.changeDataRoot(newDataRootPath);
    expect(manager.getDataRootPath()).toBe(path.resolve(newDataRootPath));

    const jobRecordList = await manager.listJobRecords();
    expect(jobRecordList.map((record) => record.id)).toContain('migrate-job');
    // nedb 需要重新加载句柄后可见；直接读日志文件验证迁移
    const migratedLogLines = await manager.readJobLogLines('migrate-job');
    expect(migratedLogLines).toEqual(['line-1']);
    expect(fs.existsSync(path.join(newDataRootPath, 'workspaces', 'demo.code-workspace'))).toBe(false);
    expect(fs.existsSync(path.join(oldDataRootPath, 'workspaces', 'demo.code-workspace'))).toBe(true);

    // 旧目录中的记录库已清理（nedb/job-logs 移除）
    expect(fs.existsSync(path.join(oldDataRootPath, 'nedb'))).toBe(false);
  });
});

describe('resolveDataRootCandidates（纯函数）', () => {
  it('配置值优先于默认值', () => {
    const candidateList = resolveDataRootCandidates({
      settingsDataDirectory: 'D:\\custom\\data',
      homeDirectoryPath: 'C:\\Users\\demo',
      defaultDataRootPath: 'D:\\softwares\\worktree-manager',
      directoryExists: () => true
    });
    expect(candidateList[0]).toEqual({ source: 'settings', dataRootPath: path.resolve('D:\\custom\\data') });
    expect(candidateList.length).toBe(2);
  });

  it('默认盘符存在时只有默认候选，不产生回退', () => {
    const candidateList = resolveDataRootCandidates({
      settingsDataDirectory: null,
      homeDirectoryPath: 'C:\\Users\\demo',
      defaultDataRootPath: 'D:\\softwares\\worktree-manager',
      directoryExists: () => true
    });
    expect(candidateList.length).toBe(1);
    expect(candidateList[0].source).toBe('default');
    expect(candidateList[0].available).toBe(true);
  });

  it('默认盘符缺失时追加用户目录回退候选', () => {
    const candidateList = resolveDataRootCandidates({
      settingsDataDirectory: null,
      homeDirectoryPath: 'C:\\Users\\demo',
      defaultDataRootPath: 'D:\\softwares\\worktree-manager',
      directoryExists: () => false
    });
    expect(candidateList.length).toBe(2);
    expect(candidateList[1].source).toBe('fallback');
    expect(candidateList[1].dataRootPath).toBe(path.join('C:\\Users\\demo', 'worktree-manager-data'));
  });

  it('相对路径配置不作为候选', () => {
    const candidateList = resolveDataRootCandidates({
      settingsDataDirectory: 'relative/path',
      homeDirectoryPath: 'C:\\Users\\demo',
      defaultDataRootPath: 'D:\\softwares\\worktree-manager',
      directoryExists: () => true
    });
    expect(candidateList.some((candidate) => candidate.source === 'settings')).toBe(false);
  });
});

describe('持久化管理器', () => {
  it('无配置时使用默认数据目录并重建 settings.json', async () => {
    const environment = createIsolatedEnvironment();
    const persistenceManagerInstance = createTestManager(environment);
    const resolvedDataRootPath = await persistenceManagerInstance.initialize();

    expect(resolvedDataRootPath).toBe(path.resolve(environment.defaultDataRootPath));
    expect(fs.existsSync(path.join(resolvedDataRootPath, 'nedb'))).toBe(true);
    expect(fs.existsSync(path.join(resolvedDataRootPath, 'job-logs'))).toBe(true);
    const settingsFilePath = path.join(environment.homeDirectoryPath, '.worktree-manager', 'settings.json');
    expect(JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'))).toEqual({});
    expect(persistenceManagerInstance.getDataRootPath()).toBe(resolvedDataRootPath);
  });

  it('任务记录跨"重启"（新实例）可查，终态可恢复为 interrupted', async () => {
    const environment = createIsolatedEnvironment();
    const firstManager = createTestManager(environment);
    await firstManager.initialize();

    const runningSnapshot = buildJobSnapshot('job-recover-1');
    await firstManager.insertJobRecord(runningSnapshot);

    // 模拟重启：新实例从同一数据目录加载
    const secondManager = createTestManager(environment);
    await secondManager.initialize();
    const foundRecord = await secondManager.findJobRecordById('job-recover-1');
    expect(foundRecord.status).toBe('running');
    expect(foundRecord).not.toHaveProperty('_id');

    const recoveredCount = await secondManager.markRunningJobsAsInterrupted(new Date().toISOString());
    expect(recoveredCount).toBe(1);
    const recoveredRecord = await secondManager.findJobRecordById('job-recover-1');
    expect(recoveredRecord.status).toBe('interrupted');
    expect(recoveredRecord.finishedAt).toBeTruthy();
    expect(await secondManager.markRunningJobsAsInterrupted(new Date().toISOString())).toBe(0);
  });

  it('任务日志追加后可整读，跨实例可读', async () => {
    const environment = createIsolatedEnvironment();
    const firstManager = createTestManager(environment);
    await firstManager.initialize();

    firstManager.appendJobLogLines('job-log-1', ['line-1', 'line-2']);
    firstManager.appendJobLogLines('job-log-1', ['line-3']);
    // 追加为异步串行队列，留出落盘时间
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(await firstManager.readJobLogLines('job-log-1')).toEqual(['line-1', 'line-2', 'line-3']);

    const secondManager = createTestManager(environment);
    await secondManager.initialize();
    expect(await secondManager.readJobLogLines('job-log-1')).toEqual(['line-1', 'line-2', 'line-3']);
    expect(await secondManager.readJobLogLines('job-not-exist')).toEqual([]);
  });

  it('最近主仓库 upsert 去重且 LRU-10 淘汰最久未用', async () => {
    const environment = createIsolatedEnvironment();
    const persistenceManagerInstance = createTestManager(environment);
    await persistenceManagerInstance.initialize();

    for (let index = 1; index <= 10; index += 1) {
      await persistenceManagerInstance.upsertRecentRepoPath(`D:\\repo-${index}`);
    }
    // 最旧的 repo-1 被再次使用后，repo-2 成为最旧
    await persistenceManagerInstance.upsertRecentRepoPath('D:\\repo-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await persistenceManagerInstance.upsertRecentRepoPath('D:\\repo-11');

    const recentRepoData = await persistenceManagerInstance.listRecentRepos();
    expect(recentRepoData.repositories.length).toBe(10);
    expect(recentRepoData.lastUsedPath).toBe('D:\\repo-11');
    const repoPathList = recentRepoData.repositories.map((repository) => repository.repoPath);
    expect(repoPathList).not.toContain('D:\\repo-2');
    expect(repoPathList).toContain('D:\\repo-1');
  });

  it('创建历史写入/倒序列出/清空', async () => {
    const environment = createIsolatedEnvironment();
    const persistenceManagerInstance = createTestManager(environment);
    await persistenceManagerInstance.initialize();

    await persistenceManagerInstance.insertWorktreeHistoryRecord({
      id: 'history-1', repoPath: 'D:\\repo', branchName: 'develop', targetPath: 'D:\\wt-1',
      dependencyStrategy: 'skip', outcome: 'success', failureReason: null, warnings: [],
      createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z'
    });
    await persistenceManagerInstance.insertWorktreeHistoryRecord({
      id: 'history-2', repoPath: 'D:\\repo', branchName: 'bad branch', targetPath: 'D:\\wt-2',
      dependencyStrategy: 'skip', outcome: 'failed', failureReason: '非法分支名', warnings: [],
      createdAt: '2026-01-02T00:00:00.000Z', completedAt: '2026-01-02T00:00:01.000Z'
    });

    const recordList = await persistenceManagerInstance.listWorktreeHistoryRecords();
    expect(recordList.length).toBe(2);
    expect(recordList[0].id).toBe('history-2');
    expect(recordList[0].outcome).toBe('failed');
    expect(recordList[0].failureReason).toBe('非法分支名');

    expect(await persistenceManagerInstance.clearWorktreeHistoryRecords()).toBe(2);
    expect(await persistenceManagerInstance.listWorktreeHistoryRecords()).toEqual([]);
  });

  it('切换数据目录立即生效、写回设置、记录数据自动迁移到新目录，新实例按设置解析', async () => {
    const environment = createIsolatedEnvironment();
    const firstManager = createTestManager(environment);
    const initialDataRootPath = await firstManager.initialize();
    await firstManager.insertJobRecord(buildJobSnapshot('job-in-old-root'));

    const nextDataRootPath = path.join(storageTestRootDirectory, `env-switch-${Date.now()}`, 'new-data');
    const effectiveDataRootPath = await firstManager.changeDataRoot(nextDataRootPath);
    expect(effectiveDataRootPath).toBe(path.resolve(nextDataRootPath));
    expect(firstManager.getDataRootPath()).toBe(path.resolve(nextDataRootPath));

    const settingsFilePath = path.join(environment.homeDirectoryPath, '.worktree-manager', 'settings.json');
    expect(JSON.parse(fs.readFileSync(settingsFilePath, 'utf8')).dataDirectory).toBe(path.resolve(nextDataRootPath));

    // 记录数据已自动迁移到新目录，当前实例可直接读到
    expect(await firstManager.findJobRecordById('job-in-old-root')).not.toBeNull();

    // 旧目录的记录库已清理
    expect(fs.existsSync(path.join(initialDataRootPath, 'nedb'))).toBe(false);

    // 新实例按设置值解析到新目录，迁移的数据可见
    const restartedManager = createTestManager(environment);
    expect(await restartedManager.initialize()).toBe(path.resolve(nextDataRootPath));
    expect(await restartedManager.findJobRecordById('job-in-old-root')).not.toBeNull();
  });

  it('非法目录切换抛 ValidationError', async () => {
    const environment = createIsolatedEnvironment();
    const persistenceManagerInstance = createTestManager(environment);
    await persistenceManagerInstance.initialize();
    await expect(persistenceManagerInstance.changeDataRoot('relative/path')).rejects.toThrow('绝对路径');
  });

  it('项目存放目录默认 D:\\project，修改写入设置文件且跨实例可读', async () => {
    const environment = createIsolatedEnvironment();
    const firstManager = createTestManager(environment);
    await firstManager.initialize();
    expect(firstManager.getProjectDirectoryPath()).toBe('D:\\project');

    const nextProjectDirectory = path.join(storageTestRootDirectory, 'my-projects');
    const effectiveProjectDirectory = await firstManager.changeProjectDirectory(nextProjectDirectory);
    expect(effectiveProjectDirectory).toBe(path.resolve(nextProjectDirectory));
    expect(fs.existsSync(path.resolve(nextProjectDirectory))).toBe(true);

    const settingsFilePath = path.join(environment.homeDirectoryPath, '.worktree-manager', 'settings.json');
    expect(JSON.parse(fs.readFileSync(settingsFilePath, 'utf8')).projectDirectory).toBe(
      path.resolve(nextProjectDirectory)
    );

    const restartedManager = createTestManager(environment);
    await restartedManager.initialize();
    expect(restartedManager.getProjectDirectoryPath()).toBe(path.resolve(nextProjectDirectory));

    await expect(firstManager.changeProjectDirectory('relative/path')).rejects.toThrow('绝对路径');
  });

  it('需求聚合目录模式默认开启，修改写入设置文件且跨实例可读', async () => {
    const environment = createIsolatedEnvironment();
    const firstManager = createTestManager(environment);
    await firstManager.initialize();
    expect(firstManager.getWorkspaceLayoutEnabled()).toBe(true);

    expect(await firstManager.changeWorkspaceLayout(false)).toBe(false);
    const settingsFilePath = path.join(environment.homeDirectoryPath, '.worktree-manager', 'settings.json');
    expect(JSON.parse(fs.readFileSync(settingsFilePath, 'utf8')).workspaceLayoutEnabled).toBe(false);

    const restartedManager = createTestManager(environment);
    await restartedManager.initialize();
    expect(restartedManager.getWorkspaceLayoutEnabled()).toBe(false);
    expect(await restartedManager.changeWorkspaceLayout(true)).toBe(true);
  });

  it('编辑器命令默认 code，修改写入设置文件且跨实例可读', async () => {
    const environment = createIsolatedEnvironment();
    const firstManager = createTestManager(environment);
    await firstManager.initialize();
    expect(firstManager.getEditorCommand()).toBe('code');

    expect(await firstManager.changeEditorCommand('cursor')).toBe('cursor');
    const settingsFilePath = path.join(environment.homeDirectoryPath, '.worktree-manager', 'settings.json');
    expect(JSON.parse(fs.readFileSync(settingsFilePath, 'utf8')).editorCommand).toBe('cursor');

    const restartedManager = createTestManager(environment);
    await restartedManager.initialize();
    expect(restartedManager.getEditorCommand()).toBe('cursor');

    await expect(firstManager.changeEditorCommand('   ')).rejects.toThrow('不能为空');
  });

  it('未初始化时全部存取为安全空操作', async () => {
    const persistenceManagerInstance = createTestManager(createIsolatedEnvironment());
    await persistenceManagerInstance.insertJobRecord(buildJobSnapshot('job-x'));
    expect(await persistenceManagerInstance.listJobRecords()).toEqual([]);
    expect(await persistenceManagerInstance.findJobRecordById('job-x')).toBeNull();
    expect(await persistenceManagerInstance.listRecentRepos()).toEqual({ repositories: [], lastUsedPath: null });
    expect(await persistenceManagerInstance.listWorktreeHistoryRecords()).toEqual([]);
    expect(await persistenceManagerInstance.readJobLogLines('job-x')).toEqual([]);
    expect(await persistenceManagerInstance.markRunningJobsAsInterrupted(new Date().toISOString())).toBe(0);
  });
});
