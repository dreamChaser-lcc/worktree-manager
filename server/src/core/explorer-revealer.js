import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NotFoundError } from './errors.js';

/**
 * 在系统文件管理器中显示路径：
 * - Windows：文件用 explorer /select 定位并选中；目录直接打开
 * - macOS：open -R 定位
 * - Linux：打开父目录（xdg-open）
 */
export function revealInExplorer(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new NotFoundError(`路径不存在: ${resolvedPath}`);
  }

  if (process.platform === 'win32') {
    const isDirectory = fs.statSync(resolvedPath).isDirectory();
    const commandLine = isDirectory
      ? `explorer.exe "${resolvedPath}"`
      : `explorer.exe /select,"${resolvedPath}"`;
    spawn(commandLine, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return {
      revealed: true,
      targetPath: resolvedPath,
      mode: isDirectory ? 'open-directory' : 'select-file'
    };
  }

  if (process.platform === 'darwin') {
    spawn('open', ['-R', resolvedPath], { detached: true, stdio: 'ignore' }).unref();
    return { revealed: true, targetPath: resolvedPath, mode: 'reveal' };
  }

  const parentDirectory = path.dirname(resolvedPath);
  spawn('xdg-open', [parentDirectory], { detached: true, stdio: 'ignore' }).unref();
  return { revealed: true, targetPath: parentDirectory, mode: 'open-directory' };
}
