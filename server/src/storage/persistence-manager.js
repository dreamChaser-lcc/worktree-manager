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
  // 便携数据目录（<程序根>/data）可注入以便单测；默认取服务配置
  let appDataDirectoryPath = managerOptions.appDataDirectoryPath || serverConfig.appDataDirectoryPath;

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

  /**
   * 按日期前缀过滤需求任务记录（起止日期均为 YYYY-MM-DD，含端点，可只给单边）。
   * 记录存的是 ISO 时间字符串，列表展示也取其日期前缀，因此按字符串比较即与展示一致。
   * 时间字段默认按创建时间（与前端默认一致），仅显式传 updatedAt 时按更新时间。
   */
  function filterRequirementTaskByDateRange(recordList, { timeField, startDate, endDate }) {
    if (!startDate && !endDate) {
      return recordList;
    }
    const effectiveTimeField = timeField === 'updatedAt' ? 'updatedAt' : 'createdAt';
    return recordList.filter((record) => {
      const recordDateText = String(record[effectiveTimeField] || '').slice(0, 10);
      if (!recordDateText) {
        return false;
      }
      if (startDate && recordDateText < startDate) {
        return false;
      }
      if (endDate && recordDateText > endDate) {
        return false;
      }
      return true;
    });
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

    // 数据目录模式（settings.dataLocationMode）：'app-data' = 程序目录下 data（优先于独立目录链）；
    // 缺省/'standalone' = 现状解析链（自定义 dataDirectory → 默认 → 用户目录回退）。测试注入 dataRootOverride 时始终最优先。
    const useAppDataLocation = !dataRootOverride && settingsCache.dataLocationMode === 'app-data';
    const candidateList = [];
    if (useAppDataLocation) {
      candidateList.push({ source: 'app-data', dataRootPath: appDataDirectoryPath });
    }
    candidateList.push(
      ...resolveDataRootCandidates({
        settingsDataDirectory: dataRootOverride || settingsCache.dataDirectory,
        homeDirectoryPath,
        defaultDataRootPath
      })
    );

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

  /** 切换数据根目录：自动迁移记录数据（nedb 记录库 + 任务日志）到新目录后原子提交并写回设置；显式自定义目录即独立目录模式 */
  async function changeDataRoot(newDataRootPath) {
    if (!newDataRootPath || typeof newDataRootPath !== 'string' || !path.isAbsolute(newDataRootPath)) {
      throw new ValidationError(`数据目录必须为绝对路径: ${newDataRootPath}`);
    }
    const normalizedDataRootPath = await switchDataRootWithMigration(newDataRootPath);
    initialized = true;
    settingsCache = { ...settingsCache, dataDirectory: normalizedDataRootPath, dataLocationMode: 'standalone' };
    try {
      await writeSettingsFile(settingsFilePath, settingsCache);
    } catch (persistSettingError) {
      warnStorageError('设置文件写入失败（本次目录切换已生效，但重启后不保留）', persistSettingError);
    }
    return currentDataRootPath;
  }

  /** 需要随数据目录迁移的记录类子目录；workspaces 不迁移——聚合模式下它是 worktree 代码现场，移动会破坏 git worktree 关联 */
  const MIGRATABLE_DATA_DIRECTORY_NAME_LIST = ['nedb', 'job-logs'];

  /** 把旧数据根的记录类数据复制到新数据根（复制而非移动，源在切换成功后再清理）；目标已存在的同名文件跳过不覆盖 */
  async function copyRecordDataToNewDataRoot(oldDataRootPath, newDataRootPath) {
    for (const directoryName of MIGRATABLE_DATA_DIRECTORY_NAME_LIST) {
      const sourceDirectoryPath = path.join(oldDataRootPath, directoryName);
      try {
        await fs.access(sourceDirectoryPath);
      } catch {
        continue; // 源子目录不存在则跳过
      }
      await fs.cp(sourceDirectoryPath, path.join(newDataRootPath, directoryName), {
        recursive: true,
        force: false
      });
    }
  }

  /** 切换成功后清理旧目录中已迁移的记录数据；旧根目录非空（如含 workspaces）则保留现场 */
  async function cleanupMigratedDataRoot(oldDataRootPath) {
    try {
      for (const directoryName of MIGRATABLE_DATA_DIRECTORY_NAME_LIST) {
        await fs.rm(path.join(oldDataRootPath, directoryName), { recursive: true, force: true });
      }
      await fs.rmdir(oldDataRootPath);
    } catch (cleanupError) {
      warnStorageError(`旧数据目录未能完全清理（不影响使用，可手动删除）: ${oldDataRootPath}`, cleanupError);
    }
  }

  /**
   * 数据根目录切换统一入口（changeDataRoot / changeDataLocationMode 共用）：
   * 1. 先把旧目录的记录数据复制到新目录（此时旧库仍在服务、新库未打开，复制无冲突）
   * 2. 打开新目录的库（加载迁移过来的数据）
   * 3. 成功后清理旧目录中已迁移的记录数据；打开失败时清理半成品复制内容并保持旧库可用
   */
  async function switchDataRootWithMigration(targetDataRootPath) {
    const normalizedTargetPath = path.resolve(targetDataRootPath);
    const oldDataRootPath = currentDataRootPath;
    const sameDataRoot =
      oldDataRootPath &&
      path.resolve(oldDataRootPath).toLowerCase() === normalizedTargetPath.toLowerCase();
    if (sameDataRoot) {
      return currentDataRootPath;
    }

    if (oldDataRootPath) {
      try {
        await fs.mkdir(normalizedTargetPath, { recursive: true });
        await copyRecordDataToNewDataRoot(oldDataRootPath, normalizedTargetPath);
      } catch (copyError) {
        // 迁移失败立即中止切换：旧目录与新库均不受影响，删除半成品复制内容
        await fs.rm(normalizedTargetPath, { recursive: true, force: true }).catch(() => {});
        throw new ValidationError(`数据迁移失败，已中止切换（原目录数据不受影响）: ${copyError.message}`);
      }
    }

    try {
      await openStores(normalizedTargetPath);
    } catch (openError) {
      if (oldDataRootPath) {
        await fs.rm(normalizedTargetPath, { recursive: true, force: true }).catch(() => {});
      }
      throw new ValidationError(`目标数据目录不可用: ${openError.message}`);
    }

    if (oldDataRootPath) {
      await cleanupMigratedDataRoot(oldDataRootPath);
    }
    return normalizedTargetPath;
  }

  /** 当前数据目录模式：'app-data'（程序目录下 data）| 'standalone'（独立/默认目录，缺省） */
  function getDataLocationMode() {
    return settingsCache.dataLocationMode === 'app-data' ? 'app-data' : 'standalone';
  }

  /** 切换数据目录模式：自动迁移记录数据后立即生效；dataDirectory 记录值保留，切回独立模式时沿用 */
  async function changeDataLocationMode(newMode) {
    if (newMode !== 'app-data' && newMode !== 'standalone') {
      throw new ValidationError(`未知的数据目录模式: ${newMode}`);
    }
    if (newMode === getDataLocationMode()) {
      return currentDataRootPath;
    }
    let targetDataRootPath;
    if (newMode === 'app-data') {
      targetDataRootPath = appDataDirectoryPath;
    } else {
      // 切回独立模式：沿用此前记录的自定义目录，无记录时取默认解析链首选
      const standaloneCandidateList = resolveDataRootCandidates({
        settingsDataDirectory: settingsCache.dataDirectory,
        homeDirectoryPath,
        defaultDataRootPath
      });
      targetDataRootPath = standaloneCandidateList[0].dataRootPath;
    }
    await switchDataRootWithMigration(targetDataRootPath);
    initialized = true;
    settingsCache = { ...settingsCache, dataLocationMode: newMode };
    try {
      await writeSettingsFile(settingsFilePath, settingsCache);
    } catch (persistSettingError) {
      warnStorageError('设置文件写入失败（本次模式切换已生效，但重启后不保留）', persistSettingError);
    }
    return currentDataRootPath;
  }

  function getDataRootPath() {
    return currentDataRootPath;
  }

  /** settings.json 记录的自定义数据目录（可能为空 = 未自定义）；与实际生效目录区分，供设置页输入框回填 */
  function getConfiguredDataDirectory() {
    const configuredPath = settingsCache.dataDirectory;
    return configuredPath && typeof configuredPath === 'string' ? configuredPath : '';
  }

  /** 便携数据目录路径（<程序根>/data），供设置页展示 */
  function getAppDataDirectoryPath() {
    return appDataDirectoryPath;
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

  /** 删除单条任务记录；返回删除条数（0 = 记录不存在） */
  async function deleteJobRecord(jobId) {
    if (!initialized) return 0;
    try {
      const removedCount = await jobsDatastore.removeAsync({ id: jobId }, {});
      return removedCount ?? 0;
    } catch (deleteError) {
      warnStorageError(`任务记录删除失败(${jobId})`, deleteError);
      return 0;
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

  /** 删除任务日志文件（记录清理时一并清理）；文件不存在视为已删除 */
  async function deleteJobLogFile(jobId) {
    if (!initialized) return;
    // 丢弃可能残留的串行写队列句柄，避免删除后又被补写重建
    jobLogWriterMap.delete(jobId);
    try {
      await fs.rm(path.join(jobLogsDirectoryPath, `${jobId}.jsonl`), { force: true });
    } catch (deleteError) {
      warnStorageError(`任务日志文件删除失败(${jobId})`, deleteError);
    }
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

  async function listRequirementTaskRecords(listOptions = {}) {
    if (!initialized) return [];
    const { status = 'all', page, pageSize, timeField, startDate, endDate } = listOptions;
    try {
      let recordList = await requirementTasksDatastore.findAsync({}).sort({ updatedAt: -1 }).execAsync();
      recordList = recordList.map(stripInternalId);
      if (status === 'unpublished') {
        recordList = recordList.filter((record) => !record.publishedAt);
        // 拖拽排序优先（sortOrder 升序），未排序的按更新时间排在其后
        recordList.sort((firstRecord, secondRecord) => {
          const firstOrder = typeof firstRecord.sortOrder === 'number' ? firstRecord.sortOrder : Number.MAX_SAFE_INTEGER;
          const secondOrder = typeof secondRecord.sortOrder === 'number' ? secondRecord.sortOrder : Number.MAX_SAFE_INTEGER;
          if (firstOrder !== secondOrder) {
            return firstOrder - secondOrder;
          }
          return String(secondRecord.updatedAt || '').localeCompare(String(firstRecord.updatedAt || ''));
        });
      } else if (status === 'published') {
        recordList = recordList.filter((record) => Boolean(record.publishedAt));
      }
      // 时间范围过滤（在分页之前，保证 total 与筛选结果一致）
      recordList = filterRequirementTaskByDateRange(recordList, { timeField, startDate, endDate });
      const total = recordList.length;
      const pageNumber = Math.max(1, Number(page) || 1);
      const pageSizeNumber = Math.max(1, Number(pageSize) || 20);
      const pagedRecordList = recordList.slice((pageNumber - 1) * pageSizeNumber, pageNumber * pageSizeNumber);
      return { records: pagedRecordList, total };
    } catch (listError) {
      warnStorageError('需求任务列表查询失败', listError);
      return { records: [], total: 0 };
    }
  }

  /** 设置阶段标签（待开发/开发中/测试中，null 清除） */
  async function setRequirementTaskStage(taskId, stageTag) {
    if (!initialized) return null;
    return updateRequirementTaskRecord(taskId, { stageTag: stageTag || null, updatedAt: new Date().toISOString() });
  }

  /** 拖拽排序：按 orderedIds 顺序写入 sortOrder（未列出记录 sortOrder 置空排在后面） */
  async function reorderRequirementTasks(orderedIds) {
    if (!initialized) return 0;
    let updatedCount = 0;
    for (let orderIndex = 0; orderIndex < orderedIds.length; orderIndex += 1) {
      const updatedRecord = await updateRequirementTaskRecord(orderedIds[orderIndex], {
        sortOrder: orderIndex,
        updatedAt: new Date().toISOString()
      });
      if (updatedRecord) updatedCount += 1;
    }
    return updatedCount;
  }

  /** 设置/清除需求任务的发布标记（publishedAt：ISO 时间或 null） */
  async function setRequirementTaskPublished(taskId, published) {
    if (!initialized) return null;
    const publishedAt = published ? new Date().toISOString() : null;
    return updateRequirementTaskRecord(taskId, { publishedAt, updatedAt: publishedAt });
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
    getConfiguredDataDirectory,
    getAppDataDirectoryPath,
    getDataLocationMode,
    changeDataLocationMode,
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
    deleteJobRecord,
    deleteJobLogFile,
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
    setRequirementTaskPublished,
    setRequirementTaskStage,
    reorderRequirementTasks,
    deleteRequirementTaskRecord
  };
}

/** 应用级单例：进程内共享；测试可通过 initialize(initOptions) 注入临时路径 */
export const persistenceManager = createPersistenceManager();
