import fs from 'node:fs';
import path from 'node:path';
import { detectPackageManager } from './dep-linker.js';

/** 读取 package.json 的 dependencies / devDependencies；文件缺失或损坏返回 null */
function readPackageDependencies(packageJsonPath) {
  try {
    const parsedPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return {
      dependencies: parsedPackage.dependencies || {},
      devDependencies: parsedPackage.devDependencies || {}
    };
  } catch {
    return null;
  }
}

/** 比较两组依赖声明，返回不一致条目（含仅单侧声明的情况） */
function diffDependencyMaps(worktreeDependencyMap, mainDependencyMap) {
  const dependencyNameSet = new Set([
    ...Object.keys(worktreeDependencyMap),
    ...Object.keys(mainDependencyMap)
  ]);
  const diffList = [];
  for (const dependencyName of dependencyNameSet) {
    if (worktreeDependencyMap[dependencyName] !== mainDependencyMap[dependencyName]) {
      diffList.push({
        name: dependencyName,
        worktreeVersion: worktreeDependencyMap[dependencyName] || null,
        mainVersion: mainDependencyMap[dependencyName] || null
      });
    }
  }
  return diffList;
}

/**
 * 检查 worktree 依赖状态与共享风险：
 * - shared：node_modules 为链接（junction 共享主目录）→ 核对 package.json 声明差异，
 *   不一致即为高风险（实际使用的是主目录已安装版本，与 worktree 代码声明可能不符）
 * - independent：真实 node_modules → 独立安装，无共享风险
 * - missing：未安装依赖
 * 返回 { dependencyMode, packageManager, riskLevel, riskMessage, diffList }。
 */
export function checkWorktreeDependencyStatus({ worktreePath, repoPath }) {
  const status = {
    dependencyMode: 'unknown',
    packageManager: detectPackageManager(worktreePath),
    riskLevel: 'none',
    riskMessage: '',
    diffList: []
  };

  let nodeModulesStat = null;
  const nodeModulesPath = path.join(worktreePath, 'node_modules');
  try {
    nodeModulesStat = fs.lstatSync(nodeModulesPath);
  } catch {
    nodeModulesStat = null;
  }

  if (!nodeModulesStat) {
    status.dependencyMode = 'missing';
    status.riskMessage = 'worktree 未安装依赖（无 node_modules）';
    return status;
  }

  status.dependencyMode = nodeModulesStat.isSymbolicLink() ? 'shared' : 'independent';

  if (status.dependencyMode === 'independent') {
    status.riskMessage = '独立安装依赖，无共享风险';
    return status;
  }

  // shared：junction 共享主目录依赖，核对 package.json 声明一致性
  const worktreePackage = readPackageDependencies(path.join(worktreePath, 'package.json'));
  const mainPackage = readPackageDependencies(path.join(repoPath, 'package.json'));
  if (!worktreePackage || !mainPackage) {
    status.riskLevel = 'low';
    status.riskMessage = 'junction 共享主目录依赖（package.json 读取失败，无法核对一致性）';
    return status;
  }

  status.diffList = [
    ...diffDependencyMaps(worktreePackage.dependencies, mainPackage.dependencies).map((diffItem) => ({
      section: 'dependencies',
      ...diffItem
    })),
    ...diffDependencyMaps(worktreePackage.devDependencies, mainPackage.devDependencies).map((diffItem) => ({
      section: 'devDependencies',
      ...diffItem
    }))
  ];

  if (status.diffList.length > 0) {
    status.riskLevel = 'high';
    status.riskMessage = `共享主目录依赖，但 worktree 的 package.json 与主目录有 ${status.diffList.length} 处依赖声明不一致，实际运行使用的是主目录已安装版本`;
  } else {
    status.riskLevel = 'low';
    status.riskMessage = 'junction 共享主目录依赖（与主目录声明一致）';
  }
  return status;
}
