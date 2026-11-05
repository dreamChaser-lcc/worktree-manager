import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 需求任务工作区文件（.code-workspace）生成器。
 * 文件内容为 JSONC：头部注释标识由 worktree-manager 生成并注明需求/分支/任务 id，
 * folders 为各项目纳入工作区的目录：已关联 worktree 用 worktree 目录，
 * 仅关联项目（尚未建 worktree）或 worktree 目录缺失时回退主仓库目录；仅收录真实存在的目录。
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

/** 排除原因文案：区分"未关联 worktree"与"路径不存在"，便于用户知道该补哪一步 */
function buildExcludedProjectReason(projectEntry) {
  const hasRepoPath = Boolean(projectEntry.repoPath);
  if (!projectEntry.worktreePath) {
    return hasRepoPath ? '主仓库目录不存在' : '未设置主仓库路径';
  }
  return hasRepoPath ? 'worktree 与主仓库目录均不存在' : 'worktree 目录不存在且未设置主仓库路径';
}

/**
 * 依据需求记录生成工作区文件：
 * - 已关联且真实存在的 worktree 目录优先收录；仅关联项目（未建 worktree）或 worktree 目录缺失时，
 *   回退主仓库目录，保证"只关联了主仓库的项目"也能进工作区（绝对路径、按路径去重）
 * - 主仓库路径也未配置或目录不存在时记入 excludedProjectList（不阻断生成）
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
    const worktreeDirectoryAvailable =
      Boolean(projectEntry.worktreePath) && isExistingDirectory(projectEntry.worktreePath);
    // 优先用已关联且存在的 worktree；否则回退主仓库目录（"仅关联项目、暂不建 worktree"也能进工作区）
    const folderPath = worktreeDirectoryAvailable ? projectEntry.worktreePath : projectEntry.repoPath;
    if (!folderPath || !isExistingDirectory(folderPath)) {
      excludedProjectList.push({
        projectName: projectEntry.projectName,
        reason: buildExcludedProjectReason(projectEntry)
      });
      continue;
    }
    if (seenPathSet.has(folderPath)) {
      excludedProjectList.push({ projectName: projectEntry.projectName, reason: '目录与其他项目重复' });
      continue;
    }
    seenPathSet.add(folderPath);
    includedPathList.push(folderPath);
  }

  // 需求目录内的目录用相对路径（整个需求目录可整体移动）；目录外的用绝对路径
  const folderEntryList = includedPathList.map((folderPath) => {
    const relativePath = path.relative(layoutDirectoryPath, folderPath);
    const isInsideLayoutDirectory = relativePath !== '' && !relativePath.startsWith('..');
    return { path: isInsideLayoutDirectory ? relativePath : folderPath };
  });

  const workspaceFilePath = path.join(
    layoutDirectoryPath,
    sanitizeWorkspaceFileName(requirementRecord.branchName)
  );
  await fsp.writeFile(workspaceFilePath, buildWorkspaceFileContent(requirementRecord, folderEntryList), 'utf8');

  return { workspaceFilePath, includedPathList, excludedProjectList };
}
