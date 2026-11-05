import fs from 'node:fs';
import path from 'node:path';
import { serverConfig } from '../config.js';

/**
 * 把主仓库中被 gitignore 的本地配置文件（.env 等）与本地工具目录（.husky 等）复制到新 worktree。
 * 白名单制：只处理 patterns / directoryNameList 命中的文件与目录，绝不搬运构建产物等大目录。
 * 文件支持精确文件名与单层通配（如 *.local）；目录为整棵递归复制、目标已存在时覆盖。
 * 命中不了就静默跳过，不算失败。
 */
export function copyIgnoredFiles({ repoPath, worktreePath, patterns, directoryNameList }) {
  const effectivePatterns = patterns && patterns.length > 0 ? patterns : serverConfig.defaultIgnoreFilePatterns;
  const effectiveDirectoryNameList =
    directoryNameList && directoryNameList.length > 0
      ? directoryNameList
      : serverConfig.defaultIgnoreDirectoryNames;
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

  // 目录白名单：整棵递归复制（.husky 内的钩子脚本需随 worktree 一起可用）
  const copiedDirectoryNameSet = new Set();
  for (const directoryName of effectiveDirectoryNameList) {
    const sourceDirectoryPath = path.join(repoPath, directoryName);
    if (!existsAsDirectory(sourceDirectoryPath)) {
      continue;
    }
    copyDirectoryTree(sourceDirectoryPath, path.join(worktreePath, directoryName));
    copiedDirectoryNameSet.add(directoryName);
  }

  return { copiedFiles: [...copiedFileNameSet], copiedDirectories: [...copiedDirectoryNameSet] };
}

function copySingleFile(sourceFilePath, targetFilePath) {
  fs.copyFileSync(sourceFilePath, targetFilePath);
}

/** 目录存在性判断：不存在或为同名文件时返回 false（同名文件不按目录处理） */
function existsAsDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

/** 递归复制目录，目标已存在时覆盖（语义对齐 Copy-Item -Recurse -Force） */
function copyDirectoryTree(sourceDirectoryPath, targetDirectoryPath) {
  fs.cpSync(sourceDirectoryPath, targetDirectoryPath, { recursive: true, force: true });
}

/** 把 "*.local" 这类单层通配编译为正则（不引第三方 glob 依赖） */
function compileSingleLevelWildcard(wildcardPattern) {
  const escapedPattern = wildcardPattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escapedPattern}$`);
}
