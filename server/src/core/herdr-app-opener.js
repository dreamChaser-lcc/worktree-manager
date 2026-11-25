import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from '../config.js';
import { ValidationError } from './errors.js';

/**
 * herdr app（PC 客户端）有一套自己的 CLI，专门用来驱动界面：
 *   herdr-app ls                        → spaces > tabs > terminals（含 folder / active）
 *   herdr-app do space.select --id <id> → 切换到指定 space
 *   herdr-app do space.new --folder <p> → 新建 space（不传 name 时用目录名）
 * 而 hc（herdr-core）只管终端进程，不负责窗口布局——两者分工明确。
 *
 * 本模块只调用 herdr-app，不碰 TUI 的 herdr.exe，也不直接改终端 label。
 */

/** 在 PATH 上定位命令；未命中时静默返回 null */
function locateOnPath(commandText) {
  try {
    const locateResult = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [commandText], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const candidateList = String(locateResult)
      .split(/\r?\n/)
      .map((lineText) => lineText.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    return candidateList[0] || null;
  } catch {
    return null;
  }
}

/** 从正在运行的进程路径反推可执行文件位置（安装位置不固定时最可靠） */
function resolveFromRunningProcess(processName) {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const processPath = String(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-Process -Name ${processName} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path`
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
      )
    ).trim();
    return processPath && fs.existsSync(processPath) ? processPath : null;
  } catch {
    return null;
  }
}

/** 读开始菜单快捷方式的 TargetPath（herdr app 安装后会建这个快捷方式） */
function resolveFromStartMenuShortcut() {
  if (process.platform !== 'win32') {
    return null;
  }
  const shortcutPath = path.join(
    process.env.APPDATA || '',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Herdr.lnk'
  );
  if (!shortcutPath || !fs.existsSync(shortcutPath)) {
    return null;
  }
  try {
    const targetPath = String(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(New-Object -ComObject WScript.Shell).CreateShortcut('${shortcutPath.replace(/'/g, "''")}').TargetPath`
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
      )
    ).trim();
    return targetPath && fs.existsSync(targetPath) ? targetPath : null;
  } catch {
    return null;
  }
}

/**
 * 定位 herdr app 可执行文件：
 * 配置项 → 运行中的进程 → PATH → 开始菜单快捷方式 → 常见安装目录。
 */
export function resolveHerdrAppExecutable() {
  const configuredCommand = String(serverConfig.herdrAppCommand || '').trim();
  if (configuredCommand) {
    if (path.isAbsolute(configuredCommand) && fs.existsSync(configuredCommand)) {
      return configuredCommand;
    }
    const locatedPath = locateOnPath(configuredCommand);
    if (locatedPath) {
      return locatedPath;
    }
  }

  const runningProcessPath = resolveFromRunningProcess('herdr-app');
  if (runningProcessPath) {
    return runningProcessPath;
  }

  const pathCandidate = locateOnPath('herdr-app');
  if (pathCandidate) {
    return pathCandidate;
  }

  const shortcutTarget = resolveFromStartMenuShortcut();
  if (shortcutTarget) {
    return shortcutTarget;
  }

  const defaultInstallPath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'herdr-app', 'herdr-app.exe');
  return fs.existsSync(defaultInstallPath) ? defaultInstallPath : null;
}

/** 目录归一：传进来是文件（.code-workspace）时取其所在目录 */
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

/** 路径比较：大小写、斜杠方向、尾随分隔符都不敏感 */
function normalizePathForCompare(directoryPath) {
  return path
    .resolve(String(directoryPath || ''))
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

/**
 * 读 GUI 当前布局（spaces > tabs > terminals）。
 * 读不到说明窗口没开——`herdr-app ls` 连的是运行中的窗口，不会自己拉起一个。
 */
function readAppLayout(appExecutable) {
  try {
    const layoutText = execFileSync(appExecutable, ['ls'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const layoutRecord = JSON.parse(layoutText);
    return Array.isArray(layoutRecord.spaces) ? layoutRecord : null;
  } catch {
    return null;
  }
}

/** 执行 `herdr-app do <命令> ...` */
function runAppCommand(appExecutable, commandName, argumentList) {
  try {
    execFileSync(appExecutable, ['do', commandName, ...argumentList], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return true;
  } catch (commandError) {
    const rawMessage = String(commandError.stderr || commandError.stdout || commandError.message || '').trim();
    throw new ValidationError(`herdr app 命令执行失败（${commandName}）：${rawMessage || '未知错误'}`);
  }
}

/** 启动 herdr app（GUI 应用，直接 spawn 即可，不需要控制台窗口） */
function launchHerdrApp(appExecutable) {
  const appProcess = spawn(appExecutable, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  appProcess.unref();
}

/** 轮询等待布局可读（窗口起来后才连得上） */
async function waitForAppLayout(appExecutable, timeoutMs) {
  const pollIntervalMs = 800;
  const maxAttemptCount = Math.ceil(timeoutMs / pollIntervalMs) + 1;
  for (let attemptIndex = 0; attemptIndex < maxAttemptCount; attemptIndex += 1) {
    const layoutRecord = readAppLayout(appExecutable);
    if (layoutRecord) {
      return layoutRecord;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}

/** 找出带窗口的 herdr app 进程 id（用于把客户端切到前台） */
function findHerdrAppWindowProcessId() {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const listOutput = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-Process -Name herdr-app -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty Id"
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const trimmedText = String(listOutput || '').trim();
    return trimmedText ? Number(trimmedText) : null;
  } catch {
    return null;
  }
}

/**
 * 把 herdr app 窗口拉到前台。
 * `space.select` / `space.new` 只改 GUI 内部视图，窗口可能仍被其他应用盖住，这里再置前一次。
 */
function activateHerdrAppWindow(windowProcessId) {
  if (process.platform !== 'win32' || !windowProcessId) {
    return false;
  }
  const scriptText = [
    "Add-Type -Namespace WtmNative -Name User32 -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);'",
    `$target = Get-Process -Id ${windowProcessId} -ErrorAction SilentlyContinue`,
    'if (-not $target) { Write-Output "no-process"; exit 0 }',
    '$handle = $target.MainWindowHandle',
    'if ($handle -eq 0) { Write-Output "no-window"; exit 0 }',
    'if ([WtmNative.User32]::IsIconic($handle)) { [void][WtmNative.User32]::ShowWindow($handle, 9) }',
    '[void][WtmNative.User32]::SetForegroundWindow($handle)',
    'Write-Output "ok"'
  ].join('; ');

  try {
    const resultText = String(
      execFileSync('powershell.exe', ['-NoProfile', '-Command', scriptText], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    ).trim();
    return resultText === 'ok';
  } catch {
    return false;
  }
}

/**
 * 关闭该工作区目录对应的 space（space 内的终端会一并结束）。
 * 只按 folder 精确匹配，不会动其他 space。
 */
export function closeSpaceInHerdrApp({ targetPath }) {
  const appExecutable = resolveHerdrAppExecutable();
  if (!appExecutable) {
    throw new ValidationError(
      '未找到 herdr app 客户端（herdr-app.exe）。请确认已安装 Herdr 桌面客户端，或在设置里配置其路径。'
    );
  }

  const resolvedTargetPath = resolveDirectoryTarget(targetPath);
  const targetPathText = normalizePathForCompare(resolvedTargetPath);

  const layoutRecord = readAppLayout(appExecutable);
  if (!layoutRecord) {
    throw new ValidationError('herdr app 未运行（读不到界面布局），无需关闭。');
  }

  const matchedSpace = (layoutRecord.spaces || []).find(
    (spaceEntry) => !spaceEntry.machine && normalizePathForCompare(spaceEntry.folder) === targetPathText
  );

  if (!matchedSpace) {
    return {
      closed: false,
      message: '未找到与该目录对应的 herdr app space（可能已经关闭）'
    };
  }

  // 统计终端数量，便于提示影响范围
  let terminalCount = 0;
  for (const tabEntry of matchedSpace.tabs || []) {
    terminalCount += (tabEntry.terminals || []).length;
  }

  runAppCommand(appExecutable, 'space.close', ['--id', matchedSpace.id, '--confirmed', 'true']);

  return {
    closed: true,
    spaceId: matchedSpace.id,
    spaceName: matchedSpace.name,
    terminalCount
  };
}

/** 确保 app 在运行并能读到布局；返回 { layoutRecord, appStarted } */
async function ensureAppLayout(appExecutable) {
  const currentLayout = readAppLayout(appExecutable);
  if (currentLayout) {
    return { layoutRecord: currentLayout, appStarted: false };
  }

  launchHerdrApp(appExecutable);
  const startedLayout = await waitForAppLayout(appExecutable, 25000);
  if (!startedLayout) {
    throw new ValidationError('herdr app 启动超时（25 秒内未就绪）。请手动打开 Herdr 客户端后重试。');
  }
  return { layoutRecord: startedLayout, appStarted: true };
}

/** 在布局里找 folder 匹配的本地 space */
function findSpaceByDirectory(layoutRecord, resolvedTargetPath) {
  const targetPathText = normalizePathForCompare(resolvedTargetPath);
  return ((layoutRecord && layoutRecord.spaces) || []).find(
    (spaceEntry) => !spaceEntry.machine && normalizePathForCompare(spaceEntry.folder) === targetPathText
  );
}

/**
 * 确保目标目录在 herdr app 里有对应 space 并处于显示状态：
 * 已有 → space.select；没有 → space.new（GUI 按目录名命名）。
 */
async function ensureSpaceForDirectory(appExecutable, resolvedTargetPath) {
  const { layoutRecord, appStarted } = await ensureAppLayout(appExecutable);

  const spaceList = layoutRecord.spaces || [];
  const matchedSpace = findSpaceByDirectory(layoutRecord, resolvedTargetPath);

  if (matchedSpace) {
    runAppCommand(appExecutable, 'space.select', ['--id', matchedSpace.id]);
    return {
      spaceCreated: false,
      appStarted,
      spaceId: matchedSpace.id,
      spaceName: matchedSpace.name,
      spaceFolder: matchedSpace.folder || resolvedTargetPath,
      spaceCount: spaceList.length
    };
  }

  runAppCommand(appExecutable, 'space.new', ['--folder', resolvedTargetPath]);

  // 新建后布局是异步更新的，稍等一下再读回新 space 的信息
  await new Promise((resolve) => setTimeout(resolve, 900));
  const updatedLayout = readAppLayout(appExecutable);
  const createdSpace = ((updatedLayout && updatedLayout.spaces) || []).find(
    (spaceEntry) => !spaceEntry.machine && normalizePathForCompare(spaceEntry.folder) === targetPathText
  );

  return {
    spaceCreated: true,
    appStarted,
    spaceId: (createdSpace && createdSpace.id) || null,
    spaceName: (createdSpace && createdSpace.name) || path.basename(resolvedTargetPath),
    spaceFolder: resolvedTargetPath,
    spaceCount: ((updatedLayout && updatedLayout.spaces) || []).length
  };
}

/**
 * 在 herdr app 里打开该需求的工作区：
 * - 已有 folder 相同的 space → space.select 切过去（不新建、不改名）；
 * - 没有 → space.new 建一个（不传 name，GUI 会用目录名命名），并立即显示。
 */
export async function openInHerdrApp({ targetPath, label, taskId }) {
  const appExecutable = resolveHerdrAppExecutable();
  if (!appExecutable) {
    throw new ValidationError(
      '未找到 herdr app 客户端（herdr-app.exe）。请确认已安装 Herdr 桌面客户端，或在设置里配置其路径。'
    );
  }

  const resolvedTargetPath = resolveDirectoryTarget(targetPath);
  const spaceResult = await ensureSpaceForDirectory(appExecutable, resolvedTargetPath);
  const windowActivated = activateHerdrAppWindow(findHerdrAppWindowProcessId());

  return {
    created: spaceResult.spaceCreated,
    selected: true,
    appStarted: spaceResult.appStarted,
    windowActivated,
    spaceId: spaceResult.spaceId,
    spaceName: spaceResult.spaceName,
    targetPath: spaceResult.spaceFolder,
    spaceCount: spaceResult.spaceCount,
    appExecutable
  };
}

/**
 * 在 herdr app 里为指定目录启动一个带命令的 tab（供 CodeBuddy 实例等使用）。
 * 先确保该目录的 space 存在并选中，再用 tab.new 指定 argv 起终端。
 * argv 以 JSON 对象整体传给 `do`，避免 Windows 命令行下多层引号转义出错。
 */
export async function startCommandInHerdrApp({
  workingDirectoryPath,
  spaceDirectoryPath,
  argumentList,
  tabName
}) {
  const appExecutable = resolveHerdrAppExecutable();
  if (!appExecutable) {
    throw new ValidationError(
      '未找到 herdr app 客户端（herdr-app.exe）。请确认已安装 Herdr 桌面客户端，或在设置里配置其路径。'
    );
  }

  // 终端 cwd（codebuddy 要在 worktree 里跑，--resume 按工作目录找会话）与
  // space 归属目录（需求聚合目录，决定侧边栏里的 space 名）通常不是同一个
  const resolvedDirectoryPath = resolveDirectoryTarget(workingDirectoryPath);
  const resolvedSpaceDirectory = spaceDirectoryPath
    ? resolveDirectoryTarget(spaceDirectoryPath)
    : resolvedDirectoryPath;
  const normalizedArgumentList = Array.isArray(argumentList) ? argumentList : [];
  const normalizedTabName = tabName ? String(tabName).slice(0, 40) : null;

  const { layoutRecord, appStarted } = await ensureAppLayout(appExecutable);
  const matchedSpace = findSpaceByDirectory(layoutRecord, resolvedSpaceDirectory);

  let spaceCreated = false;
  let spaceId = null;
  let spaceName = '';

  if (matchedSpace) {
    spaceId = matchedSpace.id;
    spaceName = matchedSpace.name;
  } else {
    // 先按需求目录建 space（名字取目录名），终端稍后用 tab.new 指定自己的 cwd
    runAppCommand(appExecutable, 'space.new', [JSON.stringify({ folder: resolvedSpaceDirectory })]);
    spaceCreated = true;

    await new Promise((resolve) => setTimeout(resolve, 900));
    const createdSpace = findSpaceByDirectory(readAppLayout(appExecutable), resolvedSpaceDirectory);
    spaceId = (createdSpace && createdSpace.id) || null;
    spaceName = (createdSpace && createdSpace.name) || path.basename(resolvedSpaceDirectory);
  }

  // 明确指定 folder：默认会跟随当前聚焦终端，可能落到错误目录
  const tabCommand = { folder: resolvedDirectoryPath, argv: normalizedArgumentList };
  if (normalizedTabName) {
    tabCommand.name = normalizedTabName;
  }
  if (spaceId) {
    tabCommand.space = spaceId;
  }
  runAppCommand(appExecutable, 'tab.new', [JSON.stringify(tabCommand)]);

  const windowActivated = activateHerdrAppWindow(findHerdrAppWindowProcessId());

  return {
    opened: true,
    appStarted,
    windowActivated,
    spaceId,
    spaceName,
    spaceCreated,
    tabName: normalizedTabName,
    targetPath: resolvedDirectoryPath,
    appExecutable
  };
}
