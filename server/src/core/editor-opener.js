import { spawn } from 'node:child_process';
import { serverConfig } from '../config.js';

/**
 * 用可配置的编辑器命令打开目录/文件（默认 code，即 VS Code）。
 * 命令含空格（如带空格的完整 exe 路径）时自动加引号，配合 shell 模式正确解析。
 * detached + unref：编辑器独立于服务进程存活。
 */
export function openDirectoryInEditor(targetPath, editorCommand) {
  let effectiveEditorCommand = editorCommand || serverConfig.defaultEditorCommand;
  const shouldQuote =
    process.platform === 'win32' && /\s/.test(effectiveEditorCommand) && !effectiveEditorCommand.startsWith('"');
  if (shouldQuote) {
    effectiveEditorCommand = `"${effectiveEditorCommand}"`;
  }

  const editorProcess = spawn(effectiveEditorCommand, [targetPath], {
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    windowsHide: true
  });
  editorProcess.unref();

  return { commandLine: effectiveEditorCommand, targetPath };
}
