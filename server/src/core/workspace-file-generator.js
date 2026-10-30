import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 需求任务工作区文件（.code-workspace）生成器。
 * 文件内容为 JSONC：头部注释标识由 worktree-manager 生成并注明需求/分支/任务 id，
 * folders 为各项目已关联 worktree 的绝对路径（仅收录真实存在的目录）。
 */
export function sanitizeWorkspaceFileName(branchName) {
  const safeName =
    String(branchName)
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace';
  return `${safeName}.code-workspace`;
}

function buildWorkspaceFileContent(requirementRecord, folderEntryList) {
  const headerCommentLines = [
    '// 由 worktree-manager 生成的工作区文件（需求任务标识）',
    ...(requirementRecord.requirementName ? [`// 需求名称: ${requirementRecord.requirementName}`] : []),
    `// 需求链接: ${requirementRecord.requirementUrl}`,
    `// 分支名称: ${requirementRecord.branchName}`,
    `// 任务ID: ${requirementRecord.id}`
  ];
  const workspaceDocument = {
    folders: folderEntryList,
    settings: {}
  };
  return `${headerCommentLines.join('\n')}\n${JSON.stringify(workspaceDocument, null, '\t')}\n`;
}

function isExistingDirectory(candidatePath) {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 依据需求记录生成工作区文件：
 * - 收录各项目已关联且真实存在的 worktree 目录（绝对路径、去重）
 * - 未关联或目录缺失的项目记入 excludedProjectList（不阻断生成）
 * 聚合目录模式（options.groupWorktreesByRequirement）下，文件与各 worktree 同放
 * <工作区目录>\<需求名称>\，folders 使用相对路径（整个需求目录可整体移动）。
 */
export async function generateWorkspaceFileForTask(requirementRecord, workspaceDirectoryPath, options = {}) {
  const groupWorktreesByRequirement = options.groupWorktreesByRequirement === true;
  const requirementDirectoryName = sanitizeWorkspaceFileName(
    requirementRecord.requirementName || requirementRecord.branchName
  ).replace(/\.code-workspace$/, '');
  const layoutDirectoryPath = groupWorktreesByRequirement
    ? path.join(workspaceDirectoryPath, requirementDirectoryName)
    : workspaceDirectoryPath;
  await fsp.mkdir(layoutDirectoryPath, { recursive: true });

  const includedPathList = [];
  const excludedProjectList = [];
  const seenPathSet = new Set();
  for (const projectEntry of requirementRecord.projectList || []) {
    const worktreePath = projectEntry.worktreePath;
    if (worktreePath && isExistingDirectory(worktreePath) && !seenPathSet.has(worktreePath)) {
      seenPathSet.add(worktreePath);
      includedPathList.push(worktreePath);
    } else {
      excludedProjectList.push({
        projectName: projectEntry.projectName,
        reason: !worktreePath ? '未关联 worktree' : 'worktree 目录不存在'
      });
    }
  }

  // 需求目录内的 worktree 用相对路径（整个需求目录可整体移动）；目录外的用绝对路径
  const folderEntryList = includedPathList.map((worktreePath) => {
    const relativePath = path.relative(layoutDirectoryPath, worktreePath);
    const isInsideLayoutDirectory = relativePath !== '' && !relativePath.startsWith('..');
    return { path: isInsideLayoutDirectory ? relativePath : worktreePath };
  });

  const workspaceFilePath = path.join(
    layoutDirectoryPath,
    sanitizeWorkspaceFileName(requirementRecord.branchName)
  );
  await fsp.writeFile(workspaceFilePath, buildWorkspaceFileContent(requirementRecord, folderEntryList), 'utf8');

  return { workspaceFilePath, includedPathList, excludedProjectList };
}
