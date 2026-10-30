import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from '../config.js';

/**
 * 把主仓库中被 gitignore 的本地配置文件（.env 等）复制到新 worktree。
 * 白名单制：只处理 patterns 命中的文件，绝不搬运构建产物等大目录。
 * 支持精确文件名与单层通配（如 *.local）。命中不了就静默跳过，不算失败。
 */
export function copyIgnoredFiles({ repoPath, worktreePath, patterns }) {
  const effectivePatterns = patterns && patterns.length > 0 ? patterns : serverConfig.defaultIgnoreFilePatterns;
  // 用 Set 去重：同一文件可能同时命中精确规则与通配规则
  const copiedFileNameSet = new Set();

  for (const ignorePattern of effectivePatterns) {
    if (ignorePattern.includes('*')) {
      const patternRegex = compileSingleLevelWildcard(ignorePattern);
      for (const repoEntryName of fs.readdirSync(repoPath)) {
        if (!patternRegex.test(repoEntryName) || copiedFileNameSet.has(repoEntryName)) {
          continue;
        }
        const repoEntryPath = path.join(repoPath, repoEntryName);
        if (fs.statSync(repoEntryPath).isFile()) {
          copySingleFile(repoEntryPath, path.join(worktreePath, repoEntryName));
          copiedFileNameSet.add(repoEntryName);
        }
      }
    } else {
      if (copiedFileNameSet.has(ignorePattern)) {
        continue;
      }
      const sourceFilePath = path.join(repoPath, ignorePattern);
      if (fs.existsSync(sourceFilePath) && fs.statSync(sourceFilePath).isFile()) {
        copySingleFile(sourceFilePath, path.join(worktreePath, ignorePattern));
        copiedFileNameSet.add(ignorePattern);
      }
    }
  }

  return { copiedFiles: [...copiedFileNameSet] };
}

function copySingleFile(sourceFilePath, targetFilePath) {
  fs.copyFileSync(sourceFilePath, targetFilePath);
}

/** 把 "*.local" 这类单层通配编译为正则（不引第三方 glob 依赖） */
function compileSingleLevelWildcard(wildcardPattern) {
  const escapedPattern = wildcardPattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escapedPattern}$`);
}
