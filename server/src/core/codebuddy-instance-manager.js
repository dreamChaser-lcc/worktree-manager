import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { persistenceManager } from '../storage/persistence-manager.js';
import { resolveCodebuddyExecutable } from './codebuddy-cli-resolver.js';
import { listRunningInteractiveSessions } from './codebuddy-terminal-opener.js';
import { openWorkspaceInHerdr, resolveHerdrExecutable, startCodebuddyTuiInHerdrPane } from './herdr-opener.js';
import { NotFoundError, ValidationError } from './errors.js';

/**
 * CodeBuddy 实例管理：一个实例 = 一个 `codebuddy --serve` 常驻进程 = 一个固定端口。
 * 实例挂在需求任务上（taskId），进程工作目录取该需求的工作区聚合目录，
 * 由调用方决定派发 job 时绑到哪个具体 worktree。
 *
 * 持久化只存"我们起过的实例"，用于重启后接管；
 * 运行态以探活结果为准，不信任磁盘上的 state 字段。
 */

const INSTANCE_STATE_FILE_NAME = 'codebuddy-instances.json';
const INSTANCE_LOG_DIRECTORY_NAME = 'codebuddy-logs';
const DEFAULT_PORT_RANGE_START = 59000;
const DEFAULT_PORT_RANGE_END = 59099;
const INSTANCE_READY_TIMEOUT_MS = 40_000;
const INSTANCE_READY_POLL_INTERVAL_MS = 600;
const HEALTH_CHECK_TIMEOUT_MS = 2500;

const instanceMap = new Map();
let initialized = false;
let lastStateRefreshAt = 0;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 数据根目录下的实例状态文件路径（随数据目录走，便携模式即 <程序根>/data） */
function resolveInstanceStateFilePath() {
  return path.join(persistenceManager.getDataRootPath(), INSTANCE_STATE_FILE_NAME);
}

function resolveInstanceLogDirectoryPath() {
  return path.join(persistenceManager.getDataRootPath(), INSTANCE_LOG_DIRECTORY_NAME);
}

/** 从磁盘载入实例记录（不存在或损坏时按空处理，不阻断服务） */
async function loadInstanceStateFromDisk() {
  const stateFilePath = resolveInstanceStateFilePath();
  let stateText = '';
  try {
    stateText = await fsp.readFile(stateFilePath, 'utf8');
    // 兼容手工编辑/Windows 编辑器写入的 BOM，否则 JSON.parse 会失败并把实例当成空列表
    stateText = stateText.replace(/^\uFEFF/, '');
  } catch {
    return;
  }
  try {
    const stateJson = JSON.parse(stateText);
    const instanceList = Array.isArray(stateJson.instances) ? stateJson.instances : [];
    for (const instanceRecord of instanceList) {
      if (instanceRecord && instanceRecord.id && instanceRecord.port) {
        instanceMap.set(instanceRecord.id, {
          ...instanceRecord,
          stoppedByUser: instanceRecord.stoppedByUser === true,
          // 用户主动停止的不再探活；其余一律标记为待探活，由服务启动后的探活决定真实状态
          // （实例是 detached 进程，平台重启不影响它继续运行）
          state: instanceRecord.stoppedByUser ? 'stopped' : 'starting'
        });
      }
    }
  } catch {
    console.warn('[worktree-manager] codebuddy-instances.json 解析失败，按空实例列表处理');
  }
}

/** 把当前实例列表写回磁盘（写失败只告警，不影响内存状态） */
async function persistInstanceStateToDisk() {
  const stateFilePath = resolveInstanceStateFilePath();
  const instanceList = Array.from(instanceMap.values()).map((instanceRecord) => ({
    id: instanceRecord.id,
    taskId: instanceRecord.taskId,
    taskName: instanceRecord.taskName,
    label: instanceRecord.label,
    port: instanceRecord.port,
    instanceDirectoryPath: instanceRecord.instanceDirectoryPath,
    authToken: instanceRecord.authToken,
    jobId: instanceRecord.jobId || null,
    jobName: instanceRecord.jobName || null,
    // 对话的 sessionId：job 进程退出后仍可用 --resume 续接同一段上下文
    jobSessionId: instanceRecord.jobSessionId || null,
    // 当前 TUI 正在使用的会话（平台按它读写对话，与 job 机制并存）
    activeSessionId: instanceRecord.activeSessionId || null,
    // 会话通道：rest = 轻量（纯文本）；acp = 完整（模型/权限/图片/停止）
    sessionChannel: instanceRecord.sessionChannel === 'acp' ? 'acp' : 'rest',
    // 打开位置：window = 终端窗口（激活用 AppActivate）；herdr = herdr 工作区
    launchTarget: instanceRecord.launchTarget === 'herdr' ? 'herdr' : 'window',
    // true = 平台自己起的 serve 进程（可停止）；false = 复用你已打开的 TUI 进程（只能解绑）
    ownedByPlatform: instanceRecord.ownedByPlatform === true,
    // 区分「用户主动停止」与「探活失败的停止」：前者重载后不再探活
    stoppedByUser: instanceRecord.stoppedByUser === true,
    createdAt: instanceRecord.createdAt,
    lastActiveAt: instanceRecord.lastActiveAt || null
  }));
  try {
    await fsp.mkdir(path.dirname(stateFilePath), { recursive: true });
    await fsp.writeFile(stateFilePath, JSON.stringify({ instances: instanceList }, null, 2), 'utf8');
  } catch (writeError) {
    console.warn(`[worktree-manager] 写入 codebuddy 实例状态失败: ${writeError.message}`);
  }
}

/** 惰性初始化：首次访问时载入磁盘记录并刷新一次运行态 */
async function ensureInitialized() {
  if (initialized) {
    return;
  }
  await loadInstanceStateFromDisk();
  initialized = true;
  await refreshAllInstanceStates({ force: true });
}

/** 探测端口是否可绑定（用于分配前校验），已占用返回 false */
function isPortAvailable(portNumber) {
  return new Promise((resolve) => {
    const probeServer = net.createServer();
    probeServer.once('error', () => resolve(false));
    probeServer.once('listening', () => {
      probeServer.close(() => resolve(true));
    });
    probeServer.listen(portNumber, '127.0.0.1');
  });
}

/** 按端口反查监听进程 PID（Windows 用 netstat，其他平台返回 null 走 pid 字段兜底） */
function findListeningProcessId(portNumber) {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const netstatOutput = execFileSync('netstat', ['-ano'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    const matchedLine = netstatOutput
      .split(/\r?\n/)
      .find(
        (lineText) =>
          /LISTENING/i.test(lineText) &&
          new RegExp(`[:.]${portNumber}\\s`).test(lineText) &&
          /127\.0\.0\.1|\[::1\]|0\.0\.0\.0/.test(lineText)
      );
    if (!matchedLine) {
      return null;
    }
    const columnList = matchedLine.trim().split(/\s+/);
    const processId = Number(columnList[columnList.length - 1]);
    return Number.isFinite(processId) && processId > 0 ? processId : null;
  } catch {
    return null;
  }
}

/** 调用实例健康检查：能 200 且返回 data.status 视为就绪 */
export async function checkInstanceHealth(instanceRecord, timeoutMilliseconds = HEALTH_CHECK_TIMEOUT_MS) {
  if (!instanceRecord || !instanceRecord.port || !instanceRecord.authToken) {
    return false;
  }
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), timeoutMilliseconds);
  try {
    const healthResponse = await fetch(`http://127.0.0.1:${instanceRecord.port}/api/v1/health`, {
      headers: {
        'X-CodeBuddy-Request': '1',
        Authorization: `Bearer ${instanceRecord.authToken}`
      },
      signal: abortController.signal
    });
    if (!healthResponse.ok) {
      return false;
    }
    const healthBody = await healthResponse.json().catch(() => null);
    return Boolean(healthBody && healthBody.data && healthBody.data.status === 'ok');
  } catch {
    return false;
  } finally {
    clearTimeout(abortTimer);
  }
}

/** 刷新单个实例运行态：running 但探活失败 → error；stopped 不探活 */
async function refreshInstanceState(instanceRecord) {
  // 只有"用户主动停止"才不再探活；探活失败导致的 stopped 仍要复查，
  // 否则实例进程被外部拉起后平台会一直显示已停止（且记录没法自愈）
  if (instanceRecord.state === 'stopped' && instanceRecord.stoppedByUser) {
    return instanceRecord;
  }
  const healthy = await checkInstanceHealth(instanceRecord);
  if (healthy) {
    instanceRecord.state = 'running';
    instanceRecord.pid = findListeningProcessId(instanceRecord.port) || instanceRecord.pid || null;
    instanceRecord.lastError = null;
  } else if (instanceRecord.state === 'running' || instanceRecord.state === 'starting') {
    // 探活失败即视为进程不在（平台重启后接管失败的实例同样落到这里）
    instanceRecord.state = 'stopped';
    instanceRecord.pid = null;
    instanceRecord.lastError = '实例无响应（进程可能已退出）';
  }
  return instanceRecord;
}

/** 批量刷新（3 秒内重复调用直接返回缓存结果，避免前端轮询打爆实例） */
export async function refreshAllInstanceStates({ force = false } = {}) {
  await ensureInitializedWithoutRefresh();
  const nowTimestamp = Date.now();
  if (!force && nowTimestamp - lastStateRefreshAt < 3000) {
    return Array.from(instanceMap.values());
  }
  lastStateRefreshAt = nowTimestamp;
  const instanceList = Array.from(instanceMap.values());
  await Promise.all(instanceList.map((instanceRecord) => refreshInstanceState(instanceRecord)));
  return instanceList;
}

/** 内部用：只保证磁盘记录已载入，不触发探活（避免递归） */
async function ensureInitializedWithoutRefresh() {
  if (initialized) {
    return;
  }
  await loadInstanceStateFromDisk();
  initialized = true;
}

/** 从会话端点 URL 里取端口（形如 http://127.0.0.1:58902） */
function parseSessionUrlPort(urlText) {
  const matchedPort = String(urlText || '').match(/:(\d+)/);
  return matchedPort ? Number(matchedPort[1]) : null;
}

/**
 * 找一个可直接当网关的已有进程：该需求目录下正在运行的 CodeBuddy 会话（通常是 herdr/终端里的 TUI）。
 * 复用它的端口后，平台与终端共用同一条端口，不再额外起 serve 实例。
 */
function findReusableGatewaySession(candidateDirectoryList) {
  const runningSessionList = listRunningInteractiveSessions(candidateDirectoryList || []);
  const viableSession = runningSessionList.find((sessionEntry) => parseSessionUrlPort(sessionEntry.sessionUrl));
  if (!viableSession) {
    return null;
  }
  return {
    port: parseSessionUrlPort(viableSession.sessionUrl),
    processId: viableSession.processId || null,
    sessionId: viableSession.id,
    sessionUrl: viableSession.sessionUrl
  };
}

/** 选一个可用端口：优先用户指定，其次从端口池里挑第一个空闲且未被记录的 */
async function resolveInstancePort(requestedPort) {
  const usedPortSet = new Set(
    Array.from(instanceMap.values())
      .filter((instanceRecord) => instanceRecord.state !== 'stopped')
      .map((instanceRecord) => instanceRecord.port)
  );

  if (requestedPort !== undefined && requestedPort !== null && requestedPort !== '') {
    const portNumber = Number(requestedPort);
    if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535) {
      throw new ValidationError(`端口不合法：${requestedPort}（范围 1024-65535）`);
    }
    if (usedPortSet.has(portNumber)) {
      throw new ValidationError(`端口 ${portNumber} 已被本平台的其他实例占用，请换一个`);
    }
    const available = await isPortAvailable(portNumber);
    if (!available) {
      throw new ValidationError(`端口 ${portNumber} 已被其他程序占用，请换一个`);
    }
    return portNumber;
  }

  for (
    let candidatePort = DEFAULT_PORT_RANGE_START;
    candidatePort <= DEFAULT_PORT_RANGE_END;
    candidatePort += 1
  ) {
    if (usedPortSet.has(candidatePort)) {
      continue;
    }
    if (await isPortAvailable(candidatePort)) {
      return candidatePort;
    }
  }
  throw new ValidationError(`端口池 ${DEFAULT_PORT_RANGE_START}-${DEFAULT_PORT_RANGE_END} 已用尽`);
}

/** 列出全部实例（已按运行态刷新，供 overview 使用） */
export async function listCodebuddyInstances() {
  await ensureInitialized();
  return refreshAllInstanceStates();
}

/** 按 id 取实例（不存在抛 404） */
export async function getCodebuddyInstanceById(instanceId) {
  await ensureInitialized();
  const instanceRecord = instanceMap.get(instanceId);
  if (!instanceRecord) {
    throw new NotFoundError(`CodeBuddy 实例不存在: ${instanceId}`);
  }
  return instanceRecord;
}

/**
 * 按需求任务取实例：同一需求可能残留多条记录（重建/停止过），
 * 先刷新运行态再按「运行中优先、创建时间次之」挑选，避免拿到已停的旧记录。
 */
export async function findCodebuddyInstanceByTaskId(taskId) {
  await ensureInitialized();
  const matchedList = Array.from(instanceMap.values()).filter(
    (instanceRecord) => instanceRecord.taskId === taskId
  );
  if (matchedList.length === 0) {
    return null;
  }
  await Promise.all(matchedList.map((instanceRecord) => refreshInstanceState(instanceRecord)));
  const sortedList = matchedList.sort((firstRecord, secondRecord) => {
    const firstActive = firstRecord.state === 'running' || firstRecord.state === 'starting' ? 1 : 0;
    const secondActive = secondRecord.state === 'running' || secondRecord.state === 'starting' ? 1 : 0;
    if (firstActive !== secondActive) {
      return secondActive - firstActive;
    }
    return String(secondRecord.createdAt).localeCompare(String(firstRecord.createdAt));
  });
  return sortedList[0];
}

/**
 * 启动实例：校验端口 → spawn detached 进程 → 轮询健康检查直到就绪。
 * detached + unref 让实例活过平台重启；Windows 下必须经 cmd 调 .CMD 包装器。
 */
/**
 * TUI 窗口的固定标题。
 * 用途：新会话还没有会话名时，窗口标题无法靠会话名定位，用这个稳定标识兜底。
 */
export function buildInstanceWindowTitle(taskId) {
  const shortTaskId = String(taskId || '').replace(/-/g, '').slice(0, 6) || 'unknown';
  return `WTM-${shortTaskId}`;
}

export async function startCodebuddyInstance(startInput) {
  await ensureInitialized();

  const taskId = String(startInput.taskId || '').trim();
  if (!taskId) {
    throw new ValidationError('缺少 taskId');
  }
  const taskName = String(startInput.taskName || '').trim() || taskId;
  const instanceDirectoryPath = String(startInput.instanceDirectoryPath || '').trim();
  if (!instanceDirectoryPath) {
    throw new ValidationError('缺少实例工作目录');
  }
  if (!fs.existsSync(instanceDirectoryPath) || !fs.statSync(instanceDirectoryPath).isDirectory()) {
    throw new ValidationError(`实例工作目录不存在: ${instanceDirectoryPath}`);
  }

  const executablePath = resolveCodebuddyExecutable();
  if (!executablePath) {
    throw new ValidationError('未找到 codebuddy 命令，请先安装 CodeBuddy CLI');
  }

  /**
   * 续接策略（三选一）：
   * - specific：用显式传入的 resumeSessionId
   * - last：续接上次用过的那段会话（默认，来自实例记录的 activeSessionId）
   * - new：强制开新会话，不续接
   */
  const explicitSessionId = String(startInput.resumeSessionId || '').trim();
  const resumeMode = explicitSessionId ? 'specific' : startInput.resumeMode === 'new' ? 'new' : 'last';

  let inheritedJobId = null;
  let inheritedJobSessionId = resumeMode === 'specific' ? explicitSessionId : null;
  const existingInstance = await findCodebuddyInstanceByTaskId(taskId);
  if (existingInstance) {
    const refreshedInstance = await refreshInstanceState(existingInstance);
    // forceRestart=true 时即使已在运行也重建：用于「启动后改选要续接的会话」
    if (refreshedInstance.state === 'running' && startInput.forceRestart !== true) {
      return { instance: refreshedInstance, reused: true };
    }
    inheritedJobId = existingInstance.jobId || null;
    if (resumeMode === 'last') {
      // 优先用终端正在用的会话，其次退回旧 job 的会话。
      // `interactive-<pid>` 是 serve 进程的标识，不是对话会话——拿它去 --resume 会直接起不来（实测 40 秒超时）
      const recordedSessionId = String(existingInstance.activeSessionId || '').trim();
      const recordedJobSessionId = String(existingInstance.jobSessionId || '').trim();
      const isUsableSessionId = (candidateId) =>
        Boolean(candidateId) && !candidateId.startsWith('interactive-');
      const usableSessionId = isUsableSessionId(recordedSessionId) ? recordedSessionId : null;
      const usableJobSessionId = isUsableSessionId(recordedJobSessionId)
        ? recordedJobSessionId
        : null;
      inheritedJobSessionId = usableSessionId || usableJobSessionId || null;
    }
    // 残留记录（stopped/error）重新启动前先清理端口占用
    await stopCodebuddyInstance(existingInstance.id, { silentIfMissing: true });
  }

  const authToken = String(startInput.authToken || '').trim();

  // 优先复用该需求目录下已在跑的 CodeBuddy 进程（herdr/终端里的 TUI）：
  // 平台与终端共用同一条端口，不再额外起一个 serve 实例。
  if (startInput.preferReuseProcess !== false) {
    const reusableSession = findReusableGatewaySession(startInput.candidateDirectoryList);
    if (reusableSession) {
      const reusableInstance = {
        id: randomUUID(),
        taskId,
        taskName,
        label: String(startInput.label || '').trim(),
        port: reusableSession.port,
        authToken,
        instanceDirectoryPath,
        state: 'starting',
        stoppedByUser: false,
        // 不是平台拉起的进程，停止时只能解绑，不能杀
        ownedByPlatform: false,
        pid: reusableSession.processId,
        jobId: inheritedJobId,
        jobName: null,
        jobSessionId: inheritedJobSessionId || reusableSession.sessionId,
        // 复用已有进程时，它的会话就是平台要读写的那段对话
        activeSessionId: reusableSession.sessionId || inheritedJobSessionId || null,
        sessionChannel: startInput.sessionChannel === 'acp' ? 'acp' : 'rest',
        logFilePath: null,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        lastError: null
      };
      if (await checkInstanceHealth(reusableInstance)) {
        reusableInstance.state = 'running';
        instanceMap.set(reusableInstance.id, reusableInstance);
        await persistInstanceStateToDisk();
        return { instance: reusableInstance, reused: true, gatewaySource: 'reused-process' };
      }
    }
  }

  const portNumber = await resolveInstancePort(startInput.port);

  /**
   * 启动形态：
   * - 显式指定 serve → serve
   * - 会话通道是 acp → 强制 serve（无界面）
   *
   * 原因：ACP 的写入是 writer 独占的。如果实例同时是 TUI 窗口，那个 TUI 进程就是 writer 持有者，
   * 平台的 session/prompt 会被静默丢弃（实测返回 stopReason=end_turn 但 agent 毫无执行），
   * 权限确认（interruption_request）也只会推给 writer 持有者，平台永远收不到。
   * 所以 ACP 通道必须让平台独占 writer，不能同时开 TUI。
   */
  const launchMode =
    startInput.launchMode === 'serve' || startInput.sessionChannel === 'acp' ? 'serve' : 'tui';
  const logDirectoryPath = resolveInstanceLogDirectoryPath();
  await fsp.mkdir(logDirectoryPath, { recursive: true });
  const logFilePath = path.join(logDirectoryPath, `instance-${portNumber}.log`);
  const logFileDescriptor = fs.openSync(logFilePath, 'a');

  let childProcess = null;
  if (launchMode === 'tui') {
    // TUI 形态：一个进程同时提供「终端界面」和「HTTP API」（--port 对交互式同样生效，已实测）。
    const launchTarget = startInput.launchTarget === 'herdr' ? 'herdr' : 'window';
    // 会话续接按工作目录查找，优先落在 worktree 目录上
    const tuiWorkingDirectory =
      (Array.isArray(startInput.candidateDirectoryList) && startInput.candidateDirectoryList[0]) ||
      instanceDirectoryPath;

    if (launchTarget === 'herdr') {
      // 在 herdr 工作区里启动：复用它的窗格，平台仍通过同一个端口当网关
      const herdrExecutable = resolveHerdrExecutable();
      if (!herdrExecutable) {
        throw new ValidationError('未找到 herdr 可执行文件，无法在 herdr 中启动');
      }
      const workspaceResult = await openWorkspaceInHerdr({
        targetPath: instanceDirectoryPath,
        label: taskName,
        startServer: true
      });
      startCodebuddyTuiInHerdrPane({
        herdrExecutable: workspaceResult.herdrExecutable,
        workspaceId: workspaceResult.workspaceId,
        workingDirectoryPath: tuiWorkingDirectory,
        port: portNumber,
        sessionId: inheritedJobSessionId
      });
      // herdr 里没有可持有的子进程句柄，用空壳占位，就绪状态完全交给健康检查
      childProcess = { pid: null, unref() {}, on() {} };
      try {
        fs.appendFileSync(
          logFilePath,
          `[${new Date().toISOString()}] 在 herdr 工作区 ${workspaceResult.workspaceId} 启动 TUI：` +
            `codebuddy --port ${portNumber}${inheritedJobSessionId ? ` --resume ${inheritedJobSessionId}` : ''}` +
            ` (cwd: ${tuiWorkingDirectory})\n`
        );
      } catch {
        // 日志写失败不影响启动
      }
    } else {
      /**
       * 用 `wt -w new` 开独立终端窗口（而不是当前窗口的新标签页）。
       *
       * 原因：Windows Terminal 的窗口标题只反映「当前选中的标签」，多标签共用一个窗口时
       * 「激活已有窗口」永远匹配不到目标会话，只能把整个窗口提起来、视觉上毫无变化。
       * 独立窗口下标题 = 该 TUI 的会话名，激活才能精确跳过去。
       */
      const tuiArgumentList = [
        '-w',
        'new',
        // 显式指定起始目录：spawn 的 cwd 只作用于 wt 进程本身，
        // 它拉起的 cmd 会回到默认目录（C:\Windows\System32），TUI 就跑错地方了
        '-d',
        tuiWorkingDirectory,
        // 给窗口一个稳定标题：新会话还没有会话名时，激活就靠它定位
        '--title',
        buildInstanceWindowTitle(taskId),
        'cmd',
        '/c',
        executablePath,
        '--port',
        String(portNumber)
      ];
      if (inheritedJobSessionId) {
        // 记录里的会话可能已经被删（例如目录被清理），--resume-create-missing 让它退回新会话而不是直接退出
        tuiArgumentList.push('--resume', inheritedJobSessionId, '--resume-create-missing');
      }
      childProcess = spawn('wt.exe', tuiArgumentList, {
        cwd: tuiWorkingDirectory,
        detached: true,
        windowsHide: false,
        stdio: 'ignore'
      });
      try {
        fs.appendFileSync(
          logFilePath,
          `[${new Date().toISOString()}] TUI 启动：${executablePath} --port ${portNumber}${
            inheritedJobSessionId ? ` --resume ${inheritedJobSessionId}` : ''
          } (cwd: ${tuiWorkingDirectory})\n`
        );
      } catch {
        // 日志写失败不影响启动
      }
    }
  } else {
    const launchCommand = `"${executablePath}" --serve --port ${portNumber} --auth password`;
    // 整串交给 shell 执行：cmd /c 与参数数组组合时，node 会把命令行里的引号二次转义，
    // 导致 cmd 收到字面量引号而报"不是内部或外部命令"。
    childProcess = spawn(launchCommand, {
      cwd: instanceDirectoryPath,
      detached: true,
      windowsHide: true,
      shell: true,
      stdio: ['ignore', logFileDescriptor, logFileDescriptor]
    });
  }
  childProcess.unref();
  // 父进程不再持有日志句柄（子进程已继承），否则日志文件会被长期锁定
  try {
    fs.closeSync(logFileDescriptor);
  } catch {
    // 已关闭可忽略
  }

  let launchErrorMessage = null;
  childProcess.on('error', (spawnError) => {
    launchErrorMessage = `进程启动失败：${spawnError.message}`;
  });

  const instanceRecord = {
    id: randomUUID(),
    taskId,
    taskName,
    label: String(startInput.label || '').trim(),
    port: portNumber,
    instanceDirectoryPath,
    authToken,
    state: 'starting',
    stoppedByUser: false,
    // 平台自己拉起的进程，停止时可直接结束
    ownedByPlatform: true,
    pid: childProcess.pid || null,
    jobId: inheritedJobId,
    jobName: null,
    jobSessionId: inheritedJobSessionId,
    sessionChannel: startInput.sessionChannel === 'acp' ? 'acp' : 'rest',
    // 记录打开位置：terminal 走窗口激活，herdr 走 herdr focus
    launchTarget: startInput.launchTarget === 'herdr' ? 'herdr' : 'window',
    logFilePath,
    createdAt: new Date().toISOString(),
    lastActiveAt: null,
    lastError: null
  };
  instanceMap.set(instanceRecord.id, instanceRecord);

  const readyDeadline = Date.now() + INSTANCE_READY_TIMEOUT_MS;
  while (Date.now() < readyDeadline) {
    await delay(INSTANCE_READY_POLL_INTERVAL_MS);
    if (launchErrorMessage) {
      break;
    }
    if (await checkInstanceHealth(instanceRecord)) {
      instanceRecord.state = 'running';
      instanceRecord.pid = findListeningProcessId(portNumber) || instanceRecord.pid;
      instanceRecord.lastActiveAt = new Date().toISOString();
      // 补记该 TUI 的会话 sessionId：平台后续按 session 读写对话（不依赖 job）
      if (!instanceRecord.activeSessionId) {
        const runningSessionList = listRunningInteractiveSessions([
          ...(startInput.candidateDirectoryList || []),
          instanceDirectoryPath
        ]);
        const matchedSession =
          runningSessionList.find((sessionEntry) => sessionEntry.processId === instanceRecord.pid) ||
          runningSessionList[0];
        // 显式续接的会话优先；ps 里的 `interactive-<pid>` 是服务进程自己的标识，不是对话会话，必须排除
        const matchedSessionId =
          matchedSession && matchedSession.id && !String(matchedSession.id).startsWith('interactive-')
            ? matchedSession.id
            : null;
        instanceRecord.activeSessionId = inheritedJobSessionId || matchedSessionId;
      }
      // 清理同一需求下的历史残留记录，保持状态文件与页面列表干净
      for (const [candidateId, candidateRecord] of instanceMap) {
        if (candidateRecord.taskId === taskId && candidateId !== instanceRecord.id && candidateRecord.state === 'stopped') {
          instanceMap.delete(candidateId);
        }
      }
      await persistInstanceStateToDisk();
      return { instance: instanceRecord, reused: false };
    }
    // 进程提前退出（端口占用/命令异常）时不必等满超时。
    // TUI 模式经 `start` 拉起，cmd 会立即退出（退出码 0），不能据此判断失败。
    if (launchMode !== 'tui' && childProcess.exitCode !== null && childProcess.exitCode !== undefined) {
      launchErrorMessage = `实例进程提前退出（退出码 ${childProcess.exitCode}）`;
      break;
    }
  }

  instanceRecord.state = 'error';
  instanceRecord.lastError =
    launchErrorMessage || `启动超时（${INSTANCE_READY_TIMEOUT_MS / 1000} 秒内未就绪），详见 ${logFilePath}`;
  await persistInstanceStateToDisk();
  return { instance: instanceRecord, reused: false };
}

/** 停止实例：按端口反查 PID 后整棵进程树结束（避免残留 worker） */
export async function stopCodebuddyInstance(instanceId, options = {}) {
  await ensureInitialized();
  const instanceRecord = instanceMap.get(instanceId);
  if (!instanceRecord) {
    if (options.silentIfMissing) {
      return null;
    }
    throw new NotFoundError(`CodeBuddy 实例不存在: ${instanceId}`);
  }

  // 复用的是外部进程（herdr/终端里你自己开的 TUI）：只解绑，绝不动那个进程
  if (instanceRecord.ownedByPlatform === false) {
    instanceRecord.state = 'stopped';
    instanceRecord.stoppedByUser = true;
    instanceRecord.pid = null;
    instanceRecord.lastError = null;
    await persistInstanceStateToDisk();
    return { ...instanceRecord, detachedOnly: true };
  }

  const processId = findListeningProcessId(instanceRecord.port) || instanceRecord.pid;
  if (processId) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(processId), '/T', '/F'], {
          windowsHide: true,
          timeout: 15000,
          stdio: 'ignore'
        });
      } else {
        process.kill(processId, 'SIGTERM');
      }
    } catch {
      // 进程可能已退出，继续标记为 stopped
    }
  }

  instanceRecord.state = 'stopped';
  instanceRecord.stoppedByUser = true;
  instanceRecord.pid = null;
  instanceRecord.lastError = null;
  await persistInstanceStateToDisk();
  return instanceRecord;
}

/**
 * 记录实例当前跟踪的 job（首次派发/切换对话时更新，供 overview 展示）。
 * 同时保存 sessionId：终端续接（--resume）直接用它，不必依赖 job 进程是否还活着。
 */
export async function recordInstanceJob(instanceId, jobId, jobName, jobSessionId) {
  const instanceRecord = instanceMap.get(instanceId);
  if (!instanceRecord) {
    return;
  }
  instanceRecord.jobId = jobId || null;
  instanceRecord.jobName = jobName || null;
  instanceRecord.jobSessionId = jobSessionId || null;
  instanceRecord.lastActiveAt = new Date().toISOString();
  await persistInstanceStateToDisk();
}

/** 标记实例最近活跃时间（发指令、读流时调用） */
export function touchInstanceActivity(instanceRecord) {
  if (instanceRecord) {
    instanceRecord.lastActiveAt = new Date().toISOString();
  }
}
