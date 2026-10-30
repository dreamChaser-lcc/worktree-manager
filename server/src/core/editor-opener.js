import { spawn } from 'node:child_process';
import { serverConfig } from '../config.js';

/**
 * 用可配置的编辑器命令打开目录（默认 code，即 VS Code）。
 * detached + unref：编辑器独立于服务进程存活。
 */
export function openDirectoryInEditor(targetPath, editorCommand) {
  const effectiveEditorCommand = editorCommand || serverConfig.defaultEditorCommand;

  const editorProcess = spawn(effectiveEditorCommand, [targetPath], {
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    windowsHide: true
  });
  editorProcess.unref();

  return { commandLine: effectiveEditorCommand, targetPath };
}
