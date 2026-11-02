import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from '../config.js';

/** 用 where.exe 列出命令在 PATH 上的全部匹配（.exe / .cmd / .bat 等） */
function locateCommandCandidates(commandText) {
  try {
    const whereResult = execFileSync('where.exe', [commandText], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    return whereResult
      .split(/\r?\n/)
      .map((lineText) => lineText.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 解析 .cmd/.bat 包装器的真实目标：
 * 批处理内容形如 "%~dp0..\XXX.exe" "%~dp0..\resources\app\out\cli.js" %*，
 * 把 %~dp0 替换为批处理所在目录后得到绝对的 exe 与前置参数（如 cli.js）。
 */
function resolveBatchFileTarget(batchFilePath) {
  const batchDirectory = path.dirname(batchFilePath);
  let batchContent = '';
  try {
    batchContent = fs.readFileSync(batchFilePath, 'utf8');
  } catch {
    return null;
  }
  const exeReference = batchContent.match(/"([^"]*\.exe)"/i);
  if (!exeReference) {
    return null;
  }
  const exePath = path.resolve(exeReference[1].replace(/%~dp0/gi, batchDirectory + path.sep));
  // 注意：不照搬批处理里的 cli.js 前置参数——那是配合 ELECTRON_RUN_AS_NODE=1 的 CLI 调用约定；
  // 我们直接启动 GUI 打开目录/工作区（与用户双击文件的行为一致），cli.js 会被当成普通文件打开
  return { exe: exePath, prefixArguments: [] };
}

/**
 * 把编辑器命令解析为可直接 spawn 的可执行文件（绕过 cmd 与批处理的二重解析）：
 * - 命令是绝对 exe 路径 → 直接使用
 * - 命令是 PATH 上的 .exe → 直接使用
 * - 命令是 .cmd/.bat 包装器 → 解析出真实 exe 与前置参数（如 buddycn → CodeBuddy CN.exe + cli.js）
 * 解析失败返回 null（调用方回退到 shell 引号方案）。
 */
export function resolveEditorExecutable(editorCommand) {
  if (path.isAbsolute(editorCommand)) {
    return { exe: editorCommand, prefixArguments: [] };
  }
  const candidateList = locateCommandCandidates(editorCommand);
  if (candidateList.length === 0) {
    return null;
  }
  const directExe = candidateList.find((candidate) => /\.exe$/i.test(candidate));
  const batchFile = candidateList.find((candidate) => /\.cmd$|\.bat$/i.test(candidate));
  if (directExe) {
    return { exe: directExe, prefixArguments: [] };
  }
  if (!batchFile) {
    return null;
  }
  return resolveBatchFileTarget(batchFile);
}

/** 回退方案：Windows shell 模式下命令与路径整体加引号 */
export function buildEditorSpawnCommand(targetPath, editorCommand) {
  let commandText = editorCommand;
  let argumentText = targetPath;

  if (process.platform === 'win32') {
    if (!commandText.startsWith('"')) {
      commandText = `"${commandText}"`;
    }
    argumentText = `"${targetPath}"`;
  }

  return { commandText, argumentText };
}

/**
 * 用可配置的编辑器命令打开目录/文件（默认 code，即 VS Code）。
 * detached + unref：编辑器独立于服务进程存活。
 */
export function openDirectoryInEditor(targetPath, editorCommand) {
  const effectiveEditorCommand = editorCommand || serverConfig.defaultEditorCommand;

  if (process.platform === 'win32') {
    // 优先解析真实 exe 直接启动（路径里的 & ( ) 【】 空格全部安全）
    const resolvedEditor = resolveEditorExecutable(effectiveEditorCommand);
    if (resolvedEditor) {
      const editorProcess = spawn(
        resolvedEditor.exe,
        [...resolvedEditor.prefixArguments, targetPath],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      editorProcess.unref();
      return {
        commandLine: [resolvedEditor.exe, ...resolvedEditor.prefixArguments, targetPath].join(' '),
        targetPath
      };
    }
  }

  // 回退：shell 模式（命令与路径整体加引号）
  const { commandText, argumentText } = buildEditorSpawnCommand(targetPath, effectiveEditorCommand);
  const editorProcess = spawn(commandText, [argumentText], {
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    windowsHide: true
  });
  editorProcess.unref();

  return { commandLine: commandText + ' ' + argumentText, targetPath };
}
