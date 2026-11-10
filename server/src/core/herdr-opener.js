import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverConfig } from '../config.js';
import { ValidationError } from './errors.js';

/** 调 herdr CLI 并把 JSON 输出解析为对象（herdr 的 workspace 类命令默认输出单行 JSON） */
function runHerdrJson(herdrExecutable, argumentList) {
  let outputText = '';
  try {
    outputText = execFileSync(herdrExecutable, argumentList, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
  } catch (execError) {
    throw new ValidationError(`调用 herdr 失败：${execError.message}`);
  }

  try {
    return JSON.parse(outputText);
  } catch {
    throw new ValidationError(`无法解析 herdr 输出：${String(outputText).slice(0, 200)}`);
  }
}

/** 在 PATH 上定位命令（Windows 用 where.exe，其他平台用 which）；未命中时静默返回 null */
function locateOnPath(commandText) {
  try {
    const locateResult = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [commandText], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      // 未命中时 where.exe 会把提示写到 stderr，这里吞掉避免污染服务日志
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const candidateList = locateResult
      .split(/\r?\n/)
      .map((lineText) => lineText.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    return candidateList[0] || null;
  } catch {
    return null;
  }
}

/**
 * 在 herdr 自管安装目录里挑最新版本的可执行文件。
 * 官方 standalone 安装落在 ~/.herdr/packages/standalone/releases/<版本>-<target>/herdr.exe。
 */
function locateInHerdrHome() {
  const releasesDirectory = path.join(os.homedir(), '.herdr', 'packages', 'standalone', 'releases');
  const executableName = process.platform === 'win32' ? 'herdr.exe' : 'herdr';

  let releaseNameList = [];
  try {
    releaseNameList = fs
      .readdirSync(releasesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  // 目录名形如 0.9.5-x86_64-pc-windows-msvc，按数字序倒排取最高版本
  const sortedReleaseList = [...releaseNameList].sort((firstRelease, secondRelease) =>
    secondRelease.localeCompare(firstRelease, undefined, { numeric: true })
  );
  for (const releaseName of sortedReleaseList) {
    const candidatePath = path.join(releasesDirectory, releaseName, executableName);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

/**
 * 解析 herdr 可执行文件：配置项 → PATH → herdr 自管安装目录。
 * 用户机器上 herdr 不在 PATH（通过安装器落在 ~/.herdr 下），所以必须带这条回退。
 */
export function resolveHerdrExecutable() {
  const configuredCommand = String(serverConfig.herdrCommand || '').trim();
  if (configuredCommand) {
    if (path.isAbsolute(configuredCommand)) {
      if (fs.existsSync(configuredCommand)) {
        return configuredCommand;
      }
    } else {
      const locatedPath = locateOnPath(configuredCommand);
      if (locatedPath) {
        return locatedPath;
      }
    }
  }

  const pathCandidate = locateOnPath('herdr');
  if (pathCandidate) {
    return pathCandidate;
  }

  return locateInHerdrHome();
}

/** 查询 herdr 服务是否在运行（CLI 走 socket 调常驻 server，server 没起时命令会失败） */
export function checkHerdrServerStatus(herdrExecutable) {
  try {
    const statusText = execFileSync(herdrExecutable, ['status', 'server'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000
    });
    return {
      running: /status:\s*running/i.test(statusText),
      detail: String(statusText).trim()
    };
  } catch {
    return { running: false, detail: '' };
  }
}

/**
 * 找到带可见窗口的 herdr 客户端进程 id。
 * herdr 是 client/server 结构：常驻 server 是 headless 的（MainWindowTitle 为空），
 * 只有 TUI 客户端才有窗口，所以要靠 MainWindowHandle 区分。
 */
function findHerdrWindowProcessId() {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const listOutput = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-Process -Name herdr -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty Id'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const trimmedText = String(listOutput || '').trim();
    return trimmedText ? Number(trimmedText) : null;
  } catch {
    return null;
  }
}

/** 把已有 herdr 窗口切到前台（成功返回 true） */
function activateHerdrWindow(windowProcessId) {
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate(${windowProcessId})`],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 新开一个控制台窗口运行 herdr。
 * 用 `cmd /c start` 而不是直接 spawn：herdr 是 TUI，直接 spawn 拿不到 TTY 会退化为无头进程，
 * 必须由 start 创建一个新控制台窗口；工作目录交给 cwd 指定，避免命令行引号转义问题。
 */
function launchHerdrTerminal(herdrExecutable, startDirectoryPath) {
  const commandProcess = spawn('cmd.exe', ['/c', 'start', '', herdrExecutable], {
    cwd: startDirectoryPath,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  commandProcess.unref();
}

/** 轮询等待 herdr server 就绪（新开终端启动 TUI 时，server 需要几百毫秒到几秒才起来） */
async function waitForHerdrServer(herdrExecutable, timeoutMs) {
  const pollIntervalMs = 600;
  const maxAttemptCount = Math.ceil(timeoutMs / pollIntervalMs) + 1;
  for (let attemptIndex = 0; attemptIndex < maxAttemptCount; attemptIndex += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (checkHerdrServerStatus(herdrExecutable).running) {
      // server 就绪后再等一拍，让终端客户端完成连接
      await new Promise((resolve) => setTimeout(resolve, 900));
      return true;
    }
  }
  return false;
}

/**
 * 确保 herdr 有一个可见的终端窗口：
 * - 已有窗口 → 切到前台（activated）；
 * - 只有 headless server → 新开终端窗口跑客户端（launched）。
 * 没有这一步，工作区只存在于 server 内存里，用户看不到任何界面。
 */
function ensureHerdrClientWindow(herdrExecutable, startDirectoryPath) {
  if (process.platform !== 'win32') {
    return 'unsupported';
  }

  const windowProcessId = findHerdrWindowProcessId();
  if (windowProcessId && activateHerdrWindow(windowProcessId)) {
    return 'activated';
  }

  launchHerdrTerminal(herdrExecutable, startDirectoryPath);
  return 'launched';
}

/** 目标路径归一：传进来是文件（.code-workspace）时取其所在目录 */
function resolveDirectoryTarget(targetPath) {
  const resolvedPath = path.resolve(String(targetPath || '').trim());
  let pathStat = null;
  try {
    pathStat = fs.statSync(resolvedPath);
  } catch {
    throw new ValidationError(`路径不存在: ${resolvedPath}`);
  }
  return pathStat.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
}

/** 工作区标签：优先用需求名，过长截断，避免侧边栏撑坏 */
function normalizeWorkspaceLabel(labelText, fallbackDirectoryPath) {
  const trimmedText = String(labelText || '').trim();
  const baseText = trimmedText || path.basename(fallbackDirectoryPath);
  return baseText.length > 40 ? `${baseText.slice(0, 40)}…` : baseText;
}

/**
 * 在 herdr 里打开（或复用）一个工作区，工作目录指向 targetPath。
 * 幂等策略：herdr 的 workspace 列表只暴露 label、不含 cwd，因此按 label 匹配——
 * 命中同 label 工作区时只做 focus，不重复创建。
 * 创建前先确保有可见的终端窗口，否则工作区只存在于 headless server 内存里，用户看不到界面。
 */
export async function openWorkspaceInHerdr({ targetPath, label, startServer = false }) {
  const herdrExecutable = resolveHerdrExecutable();
  if (!herdrExecutable) {
    throw new ValidationError(
      '未找到 herdr 可执行文件。请确认已安装 herdr，或在设置里配置 herdr 命令路径（支持在 PATH 上或填写绝对路径）。'
    );
  }

  const resolvedTargetPath = resolveDirectoryTarget(targetPath);
  const effectiveLabel = normalizeWorkspaceLabel(label, resolvedTargetPath);
  const serverStatus = checkHerdrServerStatus(herdrExecutable);

  // 服务没起时先问一句：调用方未确认启动就直接返回标记，由前端弹窗确认
  if (!serverStatus.running && !startServer) {
    return {
      needsServerStart: true,
      label: effectiveLabel,
      targetPath: resolvedTargetPath,
      herdrExecutable
    };
  }

  let justStartedServer = false;
  if (!serverStatus.running && startServer) {
    launchHerdrTerminal(herdrExecutable, resolvedTargetPath);
    justStartedServer = true;
    const serverReady = await waitForHerdrServer(herdrExecutable, 20000);
    if (!serverReady) {
      throw new ValidationError('herdr 启动超时（20 秒内未就绪）。请手动在终端执行 herdr 后再试。');
    }
  }

  // 已运行但没有可见窗口时补一个终端；刚由本流程启动的终端已经在了，跳过避免开第二个窗口
  let clientAction = justStartedServer ? 'launched' : 'existing';
  if (!justStartedServer) {
    clientAction = ensureHerdrClientWindow(herdrExecutable, resolvedTargetPath);
    if (clientAction === 'launched') {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const listResult = runHerdrJson(herdrExecutable, ['workspace', 'list']);
  const workspaceList = (listResult && listResult.result && listResult.result.workspaces) || [];
  const matchedWorkspace = workspaceList.find((workspace) => workspace.label === effectiveLabel);

  if (matchedWorkspace) {
    try {
      execFileSync(herdrExecutable, ['workspace', 'focus', matchedWorkspace.workspace_id], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000
      });
    } catch {
      // 聚焦失败不影响结论（工作区已存在，用户可手动切换）
    }
    return {
      created: false,
      clientAction,
      workspaceId: matchedWorkspace.workspace_id,
      label: effectiveLabel,
      targetPath: resolvedTargetPath,
      herdrExecutable
    };
  }

  const createResult = runHerdrJson(herdrExecutable, [
    'workspace',
    'create',
    '--cwd',
    resolvedTargetPath,
    '--label',
    effectiveLabel,
    '--focus'
  ]);
  const createdWorkspace = (createResult && createResult.result && createResult.result.workspace) || {};

  return {
    created: true,
    clientAction,
    workspaceId: createdWorkspace.workspace_id || null,
    label: effectiveLabel,
    targetPath: resolvedTargetPath,
    herdrExecutable
  };
}

/**
 * 关闭该需求在 herdr 里的工作区（等价于删掉对应终端，工作区内的窗格进程会一并结束）。
 * 与打开时的幂等策略一致：按 label 匹配；重名工作区会被一并关闭，返回实际关闭数量。
 */
export function closeWorkspaceInHerdr({ targetPath, label }) {
  const herdrExecutable = resolveHerdrExecutable();
  if (!herdrExecutable) {
    throw new ValidationError(
      '未找到 herdr 可执行文件。请确认已安装 herdr，或在设置里配置 herdr 命令路径（支持在 PATH 上或填写绝对路径）。'
    );
  }

  const resolvedTargetPath = resolveDirectoryTarget(targetPath);
  const serverStatus = checkHerdrServerStatus(herdrExecutable);
  if (!serverStatus.running) {
    throw new ValidationError('herdr 服务未运行，无需关闭（工作区已随服务一起消失）。');
  }

  const effectiveLabel = normalizeWorkspaceLabel(label, resolvedTargetPath);

  const listResult = runHerdrJson(herdrExecutable, ['workspace', 'list']);
  const workspaceList = (listResult && listResult.result && listResult.result.workspaces) || [];
  const matchedList = workspaceList.filter((workspace) => workspace.label === effectiveLabel);

  if (matchedList.length === 0) {
    return {
      closedCount: 0,
      label: effectiveLabel,
      targetPath: resolvedTargetPath,
      message: '未找到同名 herdr 工作区（可能已经关闭）'
    };
  }

  let closedCount = 0;
  for (const matchedWorkspace of matchedList) {
    try {
      runHerdrJson(herdrExecutable, ['workspace', 'close', matchedWorkspace.workspace_id]);
      closedCount += 1;
    } catch {
      // 单个工作区关闭失败不影响其余，最后按实际数量回报
    }
  }

  return {
    closedCount,
    matchedCount: matchedList.length,
    label: effectiveLabel,
    targetPath: resolvedTargetPath
  };
}
