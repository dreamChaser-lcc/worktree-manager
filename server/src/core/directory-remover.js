import fs from 'node:fs';
import path from 'node:path';

/**
 * junction/symlink 感知的目录树删除。
 * 关键安全语义：遇到目录链接（junction/symlink）只 unlink 断开链接本身，
 * 绝不深入链接目标递归删除——保护共享主目录依赖（node_modules junction）的内容。
 * 全程使用 lstat 视角，不跟随任何链接。
 */
export function removeDirectoryTree(targetPath) {
  const entryStat = fs.lstatSync(targetPath);

  if (entryStat.isSymbolicLink()) {
    fs.unlinkSync(targetPath);
    return;
  }
  if (!entryStat.isDirectory()) {
    fs.unlinkSync(targetPath);
    return;
  }

  for (const entryName of fs.readdirSync(targetPath)) {
    removeDirectoryTree(path.join(targetPath, entryName));
  }
  fs.rmdirSync(targetPath);
}
