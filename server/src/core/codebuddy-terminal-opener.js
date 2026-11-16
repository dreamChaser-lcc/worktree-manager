import { execFile, execFileSync, execSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { resolveCodebuddyExecutable } from './codebuddy-cli-resolver.js';
import { ValidationError } from './errors.js';

const execFileAsync = promisify(execFile);

/**
 * 在指定目录新开一个可见终端窗口启动 CodeBuddy 交互式 TUI。
 *
 * 两种模式：
 * - resume：`--resume <sessionId>`，新起 TUI 但加载平台那段对话的完整上下文
 * - new：起一个全新的交互式会话
 *
 * 为什么不用 `codebuddy attach`：
 * 平台派发的 job 是 headless 的后台会话，attach 会打印
 * "This session has no attachable terminal - following its log instead"，
 * 只能 tail 日志、无法交互。要真 TUI 交互只能 --resume（进程是新的，但对话是同一个）。
 *
 * 实现约束（踩过的坑）：
 * 1. CodeBuddy 是 TUI，必须由 `start` 创建真实控制台窗口，直接 spawn 拿不到 TTY 会退化成无头进程；
 * 2. `start` 的第一个参数是窗口标题，必须传空串——传中文标题时 node 不会给无空格参数加引号，
 *    start 会把标题当成要执行的命令，弹出「Windows 找不到文件」；
 * 3. 不要用 `cmd /k "路径"` 的形式：cmd 对 /k 后带引号字符串有额外的引号剥离规则，嵌套引号容易解析错位。
 */

/**
 * 读取本机后台会话列表（codebuddy ps --json），失败返回空数组。
 * 注意必须用 execSync（shell 解析）：Windows 上 codebuddy 是 .CMD 包装脚本，
 * execFileSync 加 shell:true 时拿不到 stdout（会解析失败，表现为"永远没有会话在跑"）。
 */
function listBackgroundSessionList(executablePath) {
  try {
    const outputText = execSync(`"${executablePath}" ps --json`, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    // 输出前面可能混入 shell 提示行，从第一个 '[' 开始截取
    const jsonStartIndex = outputText.indexOf('[');
    const parsedOutput = JSON.parse(jsonStartIndex >= 0 ? outputText.slice(jsonStartIndex) : outputText);
    return Array.isArray(parsedOutput) ? parsedOutput : [];
  } catch {
    return [];
  }
}

/** 目录归一：去尾斜杠并统一小写，用于跨来源比较 */
function normalizeDirectoryPath(directoryPath) {
  return String(directoryPath || '')
    .trim()
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

/**
 * 列出指定目录（可传多个候选目录）下正在运行的 interactive 会话（不含历史）。
 * 用途有二：
 * 1. 平台实例未启动时兜底展示，让用户能复用正在跑的 TUI；
 * 2. 平台把网关改绑到已有进程（不再自起 serve 实例）。
 *
 * 不区分进程来源（平台 serve 实例或你手动开的 TUI）：只要 cwd 命中候选目录就算可复用，
 * 因为它们是同一份本地状态，任何一个都能当 API 网关。
 */
export function listRunningInteractiveSessions(directoryPaths) {
  // 见函数尾部实现
  return listInteractiveSessionsInDirectories(directoryPaths);
}

/**
 * 按 sessionId 反查该会话的工作目录（全量扫描 ps，不做目录过滤）。
 * ACP 的 session/load 必须传会话真实所在的 cwd，传错会加载出空会话，
 * 表现是 session/prompt 立刻返回 end_turn 但没有任何 agent 响应。
 */
export function findRunningSessionCwd(sessionId) {
  const executablePath = resolveCodebuddyExecutable();
  if (!executablePath || !sessionId) {
    return null;
  }
  const sessionList = listBackgroundSessionList(executablePath);
  const matchedSession = sessionList.find(
    (sessionEntry) => sessionEntry && sessionEntry.sessionId === sessionId
  );
  if (!matchedSession || !matchedSession.cwd) {
    return null;
  }
  return normalizeDirectoryPath(matchedSession.cwd);
}

function listInteractiveSessionsInDirectories(directoryPaths) {
  const executablePath = resolveCodebuddyExecutable();
  const directoryPathList = Array.isArray(directoryPaths) ? directoryPaths : [directoryPaths];
  const targetPathList = directoryPathList.map((directoryPath) => normalizeDirectoryPath(directoryPath)).filter(Boolean);
  if (!executablePath || targetPathList.length === 0) {
    return [];
  }
  const sessionList = listBackgroundSessionList(executablePath);
  return sessionList
    .filter(
      (sessionEntry) =>
        sessionEntry &&
        sessionEntry.kind === 'interactive' &&
        sessionEntry.sessionId &&
        targetPathList.includes(normalizeDirectoryPath(sessionEntry.cwd))
    )
    .map((sessionEntry) => ({
      id: sessionEntry.sessionId,
      name: `运行中的会话 ${String(sessionEntry.sessionId).slice(0, 8)}`,
      messageCount: 0,
      processId: sessionEntry.pid || null,
      sessionUrl: sessionEntry.url || null,
      createdAt: null,
      updatedAt: null,
      isRunning: true
    }));
}

/**
 * 查该 sessionId 是否已经有 interactive 会话在跑（说明 TUI 已开着）。
 * interactive 会话自带 HTTP 端点（url），能查到就说明用户已经开着那个终端窗口，
 * 再开一个会变成两个进程写同一段对话，所以要先复用/提示。
 */
export function findRunningInteractiveSession(executablePath, sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return null;
  }
  const sessionList = listBackgroundSessionList(executablePath);
  const matchedSession = sessionList.find(
    (sessionEntry) =>
      sessionEntry && sessionEntry.sessionId === normalizedSessionId && sessionEntry.kind === 'interactive'
  );
  if (!matchedSession) {
    return null;
  }
  return {
    pid: matchedSession.pid || null,
    url: matchedSession.url || null,
    cwd: matchedSession.cwd || null
  };
}

/**
 * 由平台 jobId 反查可续接的 sessionId：
 * 平台派发的 job 在 ps 里呈现为 name=job-<id>、meta.jobId=<id> 的后台会话。
 * 找不到（进程已退出）时返回 null，由调用方回退到新会话。
 */
export function resolveResumableSessionId(executablePath, jobId) {
  const normalizedJobId = String(jobId || '').trim();
  if (!normalizedJobId) {
    return null;
  }
  const sessionList = listBackgroundSessionList(executablePath);
  const matchedSession = sessionList.find(
    (sessionEntry) =>
      sessionEntry &&
      ((sessionEntry.meta && sessionEntry.meta.jobId === normalizedJobId) ||
        sessionEntry.name === `job-${normalizedJobId}`)
  );
  if (!matchedSession || !matchedSession.sessionId) {
    return null;
  }
  return matchedSession.sessionId;
}

/**
 * 把已打开的终端窗口激活到前台。
 *
 * 原理：Windows Terminal 的窗口标题就是当前会话名（形如 "⠧ Greeting and session start"），
 * 用 WScript.Shell.AppActivate 按标题激活。实测 AppActivate('完整会话名') 返回 True。
 *
 * 限制：只能把整个终端窗口提到前台，无法精确定位到某个标签页；
 * 若 TUI 正显示其它标题（长任务进度等），可能匹配失败，调用方应按「未找到」处理。
 */
export async function activateCodebuddyTerminalWindow(primaryWindowTitle, sessionName) {
  const normalizedPrimary = String(primaryWindowTitle || '').trim();
  const normalizedSessionName = String(sessionName || '').trim();
  if (!normalizedPrimary && !normalizedSessionName) {
    throw new ValidationError('缺少窗口标题，无法定位终端窗口');
  }
  if (process.platform !== 'win32') {
    throw new ValidationError('激活终端窗口仅支持 Windows');
  }
  // PowerShell 单引号字符串里，单引号需要写两次
  const escapedPrimary = normalizedPrimary.replace(/'/g, "''");
  const escapedSessionName = normalizedSessionName.replace(/'/g, "''");
  // 先按固定标题（WTM-xxx）匹配，再按会话名匹配——新会话只有前者可用
  const primaryMatch =
    escapedPrimary ? `if ($shell.AppActivate('${escapedPrimary}')) { 'ACTIVATED_NAME'; exit } ` : '';
  const sessionMatch = escapedSessionName
    ? `if ($shell.AppActivate('${escapedSessionName}')) { 'ACTIVATED_SESSION'; exit } `
    : '';
  const activateScript =
    `$shell = New-Object -ComObject WScript.Shell; ` +
    primaryMatch +
    sessionMatch +
    `$target = Get-Process WindowsTerminal,conhost,cmd -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ` +
    `if ($target -and $shell.AppActivate($target.Id)) { 'ACTIVATED_WINDOW' } else { 'NOT_FOUND' }`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', activateScript],
    { timeout: 10000, windowsHide: true }
  );
  const resultText = String(stdout || '').trim();
  if (resultText.includes('ACTIVATED_NAME')) {
    return { activated: true, strategy: 'window-title' };
  }
  if (resultText.includes('ACTIVATED_SESSION')) {
    return { activated: true, strategy: 'session' };
  }
  if (resultText.includes('ACTIVATED_WINDOW')) {
    return { activated: true, strategy: 'window' };
  }
  return { activated: false, strategy: 'none' };
}

/**
 * 关闭按标题匹配的终端窗口（停止实例后清理残留黑窗）。
 * 用 EnumWindows 找标题包含 windowTitle 的可见窗口，发 WM_CLOSE。
 */
export async function closeCodebuddyTerminalWindow(windowTitle) {
  const normalizedTitle = String(windowTitle || '').trim();
  if (!normalizedTitle || process.platform !== 'win32') {
    return { closed: false, reason: 'unsupported' };
  }
  const escapedTitle = normalizedTitle.replace(/'/g, "''");
  const closeScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WtmWindow {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
$script:targetHandle = [IntPtr]::Zero
$callback = [WtmWindow+EnumProc]{
  param($hWnd, $lParam)
  if ([WtmWindow]::IsWindowVisible($hWnd)) {
    $titleBuffer = New-Object System.Text.StringBuilder 512
    [void][WtmWindow]::GetWindowText($hWnd, $titleBuffer, 512)
    if ($titleBuffer.ToString() -like '*${escapedTitle}*') {
      $script:targetHandle = $hWnd
      return $false
    }
  }
  return $true
}
[void][WtmWindow]::EnumWindows($callback, [IntPtr]::Zero)
if ($script:targetHandle -ne [IntPtr]::Zero) {
  [void][WtmWindow]::SendMessage($script:targetHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  'CLOSED'
} else {
  'NOT_FOUND'
}
`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', closeScript],
      { timeout: 10000, windowsHide: true }
    );
    return { closed: String(stdout || '').includes('CLOSED') };
  } catch {
    return { closed: false };
  }
}

/**
 * 打开终端窗口并启动 codebuddy TUI。
 * resumeSessionId 由调用方提供（平台侧已记录），有值走 --resume 续接同一段上下文，否则起新会话。
 */
export function openCodebuddyTerminalWindow({ workingDirectoryPath, resumeSessionId, port }) {
  const resolvedDirectoryPath = String(workingDirectoryPath || '').trim();
  if (!resolvedDirectoryPath) {
    throw new ValidationError('缺少终端工作目录');
  }
  let directoryStat = null;
  try {
    directoryStat = fs.statSync(resolvedDirectoryPath);
  } catch {
    throw new ValidationError(`目录不存在: ${resolvedDirectoryPath}`);
  }
  if (!directoryStat.isDirectory()) {
    throw new ValidationError(`不是目录: ${resolvedDirectoryPath}`);
  }

  const executablePath = resolveCodebuddyExecutable();
  if (!executablePath) {
    throw new ValidationError('未找到 codebuddy 命令，请先安装 CodeBuddy CLI');
  }
  if (process.platform !== 'win32') {
    throw new ValidationError('当前系统暂不支持一键打开终端 CLI（仅实现 Windows）');
  }

  const normalizedSessionId = String(resumeSessionId || '').trim() || null;
  const normalizedPort = String(port || '').trim();
  const codebuddyArgumentList = [];
  if (normalizedPort) {
    codebuddyArgumentList.push('--port', normalizedPort);
  }
  if (normalizedSessionId) {
    codebuddyArgumentList.push('--resume', normalizedSessionId);
  }

  /**
   * 用 `wt -w new` 开独立窗口，而不是当前窗口的新标签页。
   * 原因：Windows Terminal 的窗口标题只反映「当前选中的标签」，
   * 多标签共用窗口时按会话名激活永远匹配不到，只能把整个窗口提起来、看不出变化。
   * 独立窗口下标题 = 该 TUI 的会话名，激活才能精确跳过去。
   */
  const launchProcess = spawn(
    'wt.exe',
    ['-w', 'new', 'cmd', '/c', executablePath, ...codebuddyArgumentList],
    {
      cwd: resolvedDirectoryPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    }
  );
  launchProcess.on('error', () => {
    // 启动失败由前端根据返回结果提示，这里只避免未捕获异常
  });
  launchProcess.unref();

  return {
    opened: true,
    mode: normalizedSessionId ? 'resume' : 'new',
    resumeSessionId: normalizedSessionId,
    workingDirectoryPath: resolvedDirectoryPath,
    executablePath
  };
}
