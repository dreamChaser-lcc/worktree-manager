import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Datastore from '@seald-io/nedb';
import { serverConfig } from '../config.js';
import { ValidationError } from '../core/errors.js';
import { resolveDataRootCandidates, DEFAULT_DATA_ROOT_PATH, DEFAULT_PROJECT_DIRECTORY_PATH } from './data-root-resolver.js';
import { readSettingsFile, writeSettingsFile } from './settings-store.js';
import { createJobLogFileWriter, readJobLogFile } from './job-log-writer.js';

/** 最近主仓库保留条数（超出淘汰最久未用，见 add-local-persistence design D6） */
const RECENT_REPO_LIMIT = 10;

/** 数据库文件被占用时的加载重试参数（EPERM/EBUSY 多为双实例或杀毒扫描的瞬时锁） */
const LOAD_RETRY_MAX_ATTEMPTS = 3;
const LOAD_RETRY_BASE_DELAY_MS = 400;

/**
 * 持久化管理器：集中持有三个 nedb 库（任务元数据 / 创建历史 / 最近主仓库）
 * 与任务日志目录，负责数据目录解析、设置文件读写与运行期目录切换。
 *
 * 降级语义（add-local-persistence design Risks）：存取类失败只告警不抛出，
 * 未初始化时全部存取为安全空操作，持久化故障不阻断业务主流程。
 * 切换数据目录属于显式用户操作，目标不可用时抛 ValidationError 由路由转 400。
 */
export function createPersistenceManager(managerOptions = {}) {
  let homeDirectoryPath = managerOptions.homeDirectoryPath || os.homedir();
  let settingsFilePath =
    managerOptions.settingsFilePath || path.join(homeDirectoryPath, '.worktree-manager', 'settings.json');
  let defaultDataRootPath = managerOptions.defaultDataRootPath || DEFAULT_DATA_ROOT_PATH;
  let dataRootOverride = managerOptions.dataRootOverride || null;

  let initialized = false;
  let currentDataRootPath = null;
  let settingsCache = {};
  let jobsDatastore = null;
  let worktreeHistoryDatastore = null;
  let recentReposDatastore = null;
  let requirementTasksDatastore = null;
  let jobLogsDirectoryPath = null;
  const jobLogWriterMap = new Map();

  function warnStorageError(scopeText, error) {
    console.warn(`[storage] ${scopeText}: ${error ? error.message : ''}`);
  }

  function stripInternalId(document) {
    if (!document) {
      return document;
    }
    const { _id, ...publicDocument } = document;
    return publicDocument;
  }

  /** 文件被占用（双实例/杀毒扫描等瞬时锁）时判断是否值得重试 */
  function isTransientFileError(error) {
    const errorCode = error && error.code;
    return errorCode === 'EPERM' || errorCode === 'EBUSY' || errorCode === 'EACCES';
  }

  async function loadStoreWithRetry(datastore, storeLabel) {
    for (let attempt = 1; attempt <= LOAD_RETRY_MAX_ATTEMPTS; attempt += 1) {
      try {
        await datastore.loadDatabaseAsync();
        return;
      } catch (loadError) {
        if (attempt === LOAD_RETRY_MAX_ATTEMPTS || !isTransientFileError(loadError)) {
          throw loadError;
        }
        warnStorageError(`库文件被占用(${storeLabel})，${LOAD_RETRY_BASE_DELAY_MS * attempt}ms 后重试`, loadError);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, LOAD_RETRY_BASE_DELAY_MS * attempt));
      }
    }
  }

  async function openStores(dataRootPath) {
    const nedbDirectoryPath = path.join(dataRootPath, 'nedb');
    const nextJobLogsDirectoryPath = path.join(dataRootPath, 'job-logs');
    await fs.mkdir(nedbDirectoryPath, { recursive: true });
    await fs.mkdir(nextJobLogsDirectoryPath, { recursive: true });

    const nextJobsDatastore = new Datastore({ filename: path.join(nedbDirectoryPath, 'jobs.db') });
    const nextHistoryDatastore = new Datastore({ filename: path.join(nedbDirectoryPath, 'worktree-history.db') });
    const nextRecentReposDatastore = new Datastore({ filename: path.join(nedbDirectoryPath, 'recent-repos.db') });
    const nextRequirementTasksDatastore = new Datastore({ filename: path.join(nedbDirectoryPath, 'requirement-tasks.db') });
    await loadStoreWithRetry(nextJobsDatastore, 'jobs');
    await loadStoreWithRetry(nextHistoryDatastore, 'worktree-history');
    await loadStoreWithRetry(nextRecentReposDatastore, 'recent-repos');
    await loadStoreWithRetry(nextRequirementTasksDatastore, 'requirement-tasks');
    await nextRecentReposDatastore.ensureIndexAsync({ fieldName: 'repoPath', unique: true });

    jobsDatastore = nextJobsDatastore;
    worktreeHistoryDatastore = nextHistoryDatastore;
    recentReposDatastore = nextRecentReposDatastore;
    requirementTasksDatastore = nextRequirementTasksDatastore;
    jobLogsDirectoryPath = nextJobLogsDirectoryPath;
    currentDataRootPath = dataRootPath;
  }

  /**
   * 初始化：读设置 → 解析数据目录候选 → 创建目录并打开库。
   * initOptions 允许首调前覆盖路径（测试注入临时目录用）。
   * 全部候选失败时保持未初始化（持久化降级为内存模式），不抛出。
   */
  async function initialize(initOptions = {}) {
    if (initialized) {
      return currentDataRootPath;
    }
    if (initOptions.homeDirectoryPath) homeDirectoryPath = initOptions.homeDirectoryPath;
    if (initOptions.settingsFilePath) settingsFilePath = initOptions.settingsFilePath;
    if (initOptions.defaultDataRootPath) defaultDataRootPath = initOptions.defaultDataRootPath;
    if (initOptions.dataRootOverride) dataRootOverride = initOptions.dataRootOverride;

    const loadedSettings = await readSettingsFile(settingsFilePath);
    settingsCache = loadedSettings || {};
    if (loadedSettings === null) {
      // 缺失/损坏：按默认规则重建配置文件（业务数据在数据目录，不受影响）
      settingsCache = {};
      try {
        await writeSettingsFile(settingsFilePath, settingsCache);
      } catch (rebuildError) {
        warnStorageError(`设置文件重建失败(${settingsFilePath})`, rebuildError);
      }
    }

    // 项目存放目录默认值尽力创建，保证目录选择器首次定位可用
    try {
      await fs.mkdir(getProjectDirectoryPath(), { recursive: true });
    } catch (projectDirectoryError) {
      warnStorageError(`项目存放目录创建失败(${getProjectDirectoryPath()})`, projectDirectoryError);
    }

    const candidateList = resolveDataRootCandidates({
      settingsDataDirectory: dataRootOverride || settingsCache.dataDirectory,
      homeDirectoryPath,
      defaultDataRootPath
    });

    for (const candidate of candidateList) {
      try {
        await openStores(candidate.dataRootPath);
        initialized = true;
        if (candidate.source !== 'settings' && settingsCache.dataDirectory && !dataRootOverride) {
          warnStorageError(
            `配置的数据目录不可用，已回退到 ${candidate.source} 目录`,
            new Error(`原配置: ${settingsCache.dataDirectory}`)
          );
        }
        return currentDataRootPath;
      } catch (candidateError) {
        warnStorageError(`数据目录候选不可用(${candidate.source}: ${candidate.dataRootPath})`, candidateError);
      }
    }

    warnStorageError(
      '所有候选数据目录均不可用。常见原因：另一个 worktree-manager 实例正在运行并占用数据库文件；或杀毒软件/同步盘正在扫描。为避免看到空数据后误操作，本次启动中止。',
      new Error('无可用数据目录')
    );
    return null;
  }

  /** 切换数据根目录：新库就绪后原子提交并写回设置。旧数据保留原目录不迁移（design D3） */
  async function changeDataRoot(newDataRootPath) {
    if (!newDataRootPath || typeof newDataRootPath !== 'string' || !path.isAbsolute(newDataRootPath)) {
      throw new ValidationError(`数据目录必须为绝对路径: ${newDataRootPath}`);
    }
    const normalizedDataRootPath = path.resolve(newDataRootPath);
    try {
      await openStores(normalizedDataRootPath);
    } catch (openError) {
      throw new ValidationError(`目标数据目录不可用: ${openError.message}`);
    }
    initialized = true;
    settingsCache = { ...settingsCache, dataDirectory: normalizedDataRootPath };
    try {
      await writeSettingsFile(settingsFilePath, settingsCache);
    } catch (persistSettingError) {
      warnStorageError('设置文件写入失败（本次目录切换已生效，但重启后不保留）', persistSettingError);
    }
    return currentDataRootPath;
  }

  function getDataRootPath() {
    return currentDataRootPath;
  }

  /** 代码默认存储目录：settings.json 记录值优先，否则默认 D:\project（目录选择器起始定位用） */
  function getProjectDirectoryPath() {
    const configuredPath = settingsCache.projectDirectory;
    if (configuredPath && typeof configuredPath === 'string' && path.isAbsolute(configuredPath)) {
      return configuredPath;
    }
    return DEFAULT_PROJECT_DIRECTORY_PATH;
  }

  /** 工作区文件目录：settings.json 记录值优先，否则默认数据根目录下的 workspaces 子目录 */
  function getWorkspaceDirectoryPath() {
    const configuredPath = settingsCache.workspaceDirectory;
    if (configuredPath && typeof configuredPath === 'string' && path.isAbsolute(configuredPath)) {
      return configuredPath;
    }
    return path.join(getDataRootPath() || DEFAULT_PROJECT_DIRECTORY_PATH, 'workspaces');
  }

  /** 编辑器命令：settings.json 记录值优先，否则取服务配置默认值（code = VS Code） */
  function getEditorCommand() {
    const configuredCommand = settingsCache.editorCommand;
    if (configuredCommand && typeof configuredCommand === 'string' && configuredCommand.trim()) {
      return configuredCommand.trim();
    }
    return serverConfig.defaultEditorCommand;
  }

  /** 修改编辑器命令（打开目录/工作区文件所用，如 code / cursor）；失败抛 ValidationError */
  async function changeEditorCommand(newEditorCommand) {
    if (!newEditorCommand || typeof newEditorCommand !== 'string' || !newEditorCommand.trim()) {
      throw new ValidationError('编辑器命令不能为空');
    }
    settingsCache = { ...settingsCache, editorCommand: newEditorCommand.trim() };
    try {
      await writeSettingsFile(settingsFilePath, settingsCache);
    } catch (persistSettingError) {
      warnStorageError('设置文件写入失败（本次编辑器命令修改已生效，但重启后不保留）', persistSettingError);
    }
    return getEditorCommand();
  }

  /** 修改工作区文件目录：校验绝对路径且可创建，写回设置文件；失败抛 ValidationError */
  async function changeWorkspaceDirectory(newWorkspaceDirectoryPath) {
    if (
      !newWorkspaceDirectoryPath ||
      typeof newWorkspaceDirectoryPath !== 'string' ||
      !path.isAbsolute(newWorkspaceDirectoryPath)
    ) {
      throw new ValidationError(`工作区文件目录必须为绝对路径: ${newWorkspaceDirectoryPath}`);
    }
    const normalizedWorkspaceDirectoryPath = path.resolve(newWorkspaceDirectoryPath);
    try {
      await fs.mkdir(normalizedWorkspaceDirectoryPath, { recursive: true });
    } catch (createError) {
      throw new ValidationError(`工作区文件目录不可用: ${createError.message}`);
    }
    settingsCache = { ...settingsCache, workspaceDirectory: normalizedWorkspaceDirectoryPath };
    try {
      await writeSettingsFile(settingsFilePath, settingsCache);
    } catch (persistSettingError) {
      warnStorageError('设置文件写入失败（本次工作区目录修改已生效，但重启后不保留）', persistSettingError);
    }
    return normalizedWorkspaceDirectoryPath;
  }

  /** 需求聚合目录模式：worktree 代码与工作区文件同放 <工作区目录>\<需求名称>\ 下，默认开启 */
  function getWorkspaceLayoutEnabled() {
    return settingsCache.workspaceLayoutEnabled !== false;
  }

  async function changeWorkspaceLayout(enabledFlag) {
    settingsCache = { ...settingsCache, workspaceLayoutEnabled: enabledFlag === true };
    try {
      await writeSettingsFile(settingsFilePath, settingsCache);
    } catch (persistSettingError) {
      warnStorageError('设置文件写入失败（本次布局修改已生效，但重启后不保留）', persistSettingError);
    }
    return getWorkspaceLayoutEnabled();
  }

  /** 修改项目存放目录：校验绝对路径且可创建，写回设置文件；失败抛 ValidationError */
  async function changeProjectDirectory(newProjectDirectoryPath) {
    if (!newProjectDirectoryPath || typeof newProjectDirectoryPath !== 'string' || !path.isAbsolute(newProjectDirectoryPath)) {
      throw new ValidationError(`代码默认存储目录必须为绝对路径: ${newProjectDirectoryPath}`);
    }
    const normalizedProjectDirectoryPath = path.resolve(newProjectDirectoryPath);
    try {
      await fs.mkdir(normalizedProjectDirectoryPath, { recursive: true });
    } catch (createError) {
      throw new ValidationError(`代码默认存储目录不可用: ${createError.message}`);
    }
    settingsCache = { ...settingsCache, projectDirectory: normalizedProjectDirectoryPath };
    try {
      await writeSettingsFile(settingsFilePath, settingsCache);
    } catch (persistSettingError) {
      warnStorageError('设置文件写入失败（本次项目目录修改已生效，但重启后不保留）', persistSettingError);
    }
    return normalizedProjectDirectoryPath;
  }

  /* ── 任务元数据（jobs.db） ─────────────────────────── */

  async function insertJobRecord(jobSnapshot) {
    if (!initialized) return;
    try {
      await jobsDatastore.insertAsync({ ...jobSnapshot });
    } catch (insertError) {
      warnStorageError(`任务记录写入失败(${jobSnapshot.id})`, insertError);
    }
  }

  async function updateJobRecord(jobSnapshot) {
    if (!initialized) return;
    try {
      await jobsDatastore.updateAsync(
        { id: jobSnapshot.id },
        {
          $set: {
            status: jobSnapshot.status,
            exitCode: jobSnapshot.exitCode,
            finishedAt: jobSnapshot.finishedAt
          }
        },
        {}
      );
    } catch (updateError) {
      warnStorageError(`任务终态更新失败(${jobSnapshot.id})`, updateError);
    }
  }

  async function findJobRecordById(jobId) {
    if (!initialized) return null;
    try {
      return stripInternalId(await jobsDatastore.findOneAsync({ id: jobId }));
    } catch (findError) {
      warnStorageError(`任务记录查询失败(${jobId})`, findError);
      return null;
    }
  }

  async function listJobRecords() {
    if (!initialized) return [];
    try {
      const recordList = await jobsDatastore.findAsync({}).sort({ createdAt: -1 }).execAsync();
      return recordList.map(stripInternalId);
    } catch (listError) {
      warnStorageError('任务记录列表查询失败', listError);
      return [];
    }
  }

  /** 崩溃恢复：遗留 running → interrupted，finishedAt 取扫描时刻；返回受影响条数 */
  async function markRunningJobsAsInterrupted(interruptedAtIso) {
    if (!initialized) return 0;
    try {
      const updateResult = await jobsDatastore.updateAsync(
        { status: 'running' },
        { $set: { status: 'interrupted', finishedAt: interruptedAtIso } },
        { multi: true }
      );
      return updateResult.numAffected ?? 0;
    } catch (recoverError) {
      warnStorageError('崩溃任务恢复失败', recoverError);
      return 0;
    }
  }

  /* ── 任务日志文件（job-logs/<jobId>.jsonl） ────────── */

  function appendJobLogLines(jobId, lineTextList) {
    if (!initialized || !lineTextList || lineTextList.length === 0) return;
    let logWriter = jobLogWriterMap.get(jobId);
    if (!logWriter) {
      logWriter = createJobLogFileWriter(path.join(jobLogsDirectoryPath, `${jobId}.jsonl`));
      jobLogWriterMap.set(jobId, logWriter);
    }
    logWriter.appendLines(lineTextList);
  }

  async function readJobLogLines(jobId) {
    if (!initialized) return [];
    return readJobLogFile(path.join(jobLogsDirectoryPath, `${jobId}.jsonl`));
  }

  /* ── 创建历史（worktree-history.db） ───────────────── */

  /** 写入失败向调用方抛出（由业务路由决定降级方式：响应 warning 或仅告警） */
  async function insertWorktreeHistoryRecord(historyRecord) {
    if (!initialized) return;
    await worktreeHistoryDatastore.insertAsync({ ...historyRecord });
  }

  async function listWorktreeHistoryRecords() {
    if (!initialized) return [];
    try {
      const recordList = await worktreeHistoryDatastore.findAsync({}).sort({ createdAt: -1 }).execAsync();
      return recordList.map(stripInternalId);
    } catch (listError) {
      warnStorageError('创建历史查询失败', listError);
      return [];
    }
  }

  async function clearWorktreeHistoryRecords() {
    if (!initialized) return 0;
    // removeAsync 直接返回删除条数（区别于 updateAsync 的 { numAffected }）
    const removedCount = await worktreeHistoryDatastore.removeAsync({}, { multi: true });
    return removedCount ?? 0;
  }

  /* ── 最近主仓库（recent-repos.db，LRU-10） ─────────── */

  async function upsertRecentRepoPath(repoPath) {
    if (!initialized || !repoPath) return;
    try {
      await recentReposDatastore.updateAsync(
        { repoPath },
        { $set: { repoPath, lastUsedAt: new Date().toISOString() } },
        { upsert: true }
      );
      await trimRecentRepos();
    } catch (upsertError) {
      warnStorageError(`最近主仓库记录失败(${repoPath})`, upsertError);
    }
  }

  async function trimRecentRepos() {
    const sortedList = await recentReposDatastore.findAsync({}).sort({ lastUsedAt: -1 }).execAsync();
    if (sortedList.length <= RECENT_REPO_LIMIT) {
      return;
    }
    const outdatedIdList = sortedList.slice(RECENT_REPO_LIMIT).map((document) => document._id);
    await recentReposDatastore.removeAsync({ _id: { $in: outdatedIdList } }, { multi: true });
  }

  async function listRecentRepos() {
    if (!initialized) return { repositories: [], lastUsedPath: null };
    try {
      const sortedList = await recentReposDatastore.findAsync({}).sort({ lastUsedAt: -1 }).execAsync();
      return {
        repositories: sortedList.map((document) => ({
          repoPath: document.repoPath,
          lastUsedAt: document.lastUsedAt
        })),
        lastUsedPath: sortedList.length > 0 ? sortedList[0].repoPath : null
      };
    } catch (listError) {
      warnStorageError('最近主仓库列表查询失败', listError);
      return { repositories: [], lastUsedPath: null };
    }
  }

  /* ── 需求任务（requirement-tasks.db） ───────────────── */

  async function insertRequirementTaskRecord(taskRecord) {
    if (!initialized) return;
    await requirementTasksDatastore.insertAsync({ ...taskRecord });
  }

  /** 按条目整体替换可变字段；返回更新后的记录（不存在返回 null） */
  async function updateRequirementTaskRecord(taskId, mutableFields) {
    if (!initialized) return null;
    const updateResult = await requirementTasksDatastore.updateAsync(
      { id: taskId },
      { $set: { ...mutableFields } },
      { returnUpdatedDocs: true }
    );
    return stripInternalId(updateResult.affectedDocuments ?? null);
  }

  async function findRequirementTaskById(taskId) {
    if (!initialized) return null;
    return stripInternalId(await requirementTasksDatastore.findOneAsync({ id: taskId }));
  }

  async function listRequirementTaskRecords() {
    if (!initialized) return [];
    try {
      const recordList = await requirementTasksDatastore.findAsync({}).sort({ updatedAt: -1 }).execAsync();
      return recordList.map(stripInternalId);
    } catch (listError) {
      warnStorageError('需求任务列表查询失败', listError);
      return [];
    }
  }

  async function deleteRequirementTaskRecord(taskId) {
    if (!initialized) return 0;
    const removedCount = await requirementTasksDatastore.removeAsync({ id: taskId }, {});
    return removedCount ?? 0;
  }

  return {
    initialize,
    changeDataRoot,
    getDataRootPath,
    getProjectDirectoryPath,
    changeProjectDirectory,
    getWorkspaceDirectoryPath,
    changeWorkspaceDirectory,
    getWorkspaceLayoutEnabled,
    changeWorkspaceLayout,
    getEditorCommand,
    changeEditorCommand,
    insertJobRecord,
    updateJobRecord,
    findJobRecordById,
    listJobRecords,
    markRunningJobsAsInterrupted,
    appendJobLogLines,
    readJobLogLines,
    insertWorktreeHistoryRecord,
    listWorktreeHistoryRecords,
    clearWorktreeHistoryRecords,
    upsertRecentRepoPath,
    listRecentRepos,
    insertRequirementTaskRecord,
    updateRequirementTaskRecord,
    findRequirementTaskById,
    listRequirementTaskRecords,
    deleteRequirementTaskRecord
  };
}

/** 应用级单例：进程内共享；测试可通过 initialize(initOptions) 注入临时路径 */
export const persistenceManager = createPersistenceManager();
