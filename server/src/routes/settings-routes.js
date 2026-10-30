import Router from '@koa/router';
import { spawnSync } from 'node:child_process';
import { persistenceManager } from '../storage/persistence-manager.js';
import { ValidationError } from '../core/errors.js';

/**
 * 常见编辑器 CLI 候选清单（label 用于界面展示）。
 * 注意区分：buddycn = CodeBuddy IDE 的启动命令；
 * codebuddy = npm 包 @tencent-ai/codebuddy-code（CodeBuddy Code 命令行工具，非 IDE）。
 */
const KNOWN_EDITOR_CANDIDATE_LIST = [
  { command: 'code', label: 'VS Code' },
  { command: 'code-insiders', label: 'VS Code 预览版' },
  { command: 'cursor', label: 'Cursor' },
  { command: 'buddycn', label: 'CodeBuddy IDE' },
  { command: 'codebuddy', label: 'CodeBuddy Code CLI' },
  { command: 'windsurf', label: 'Windsurf' },
  { command: 'trae', label: 'Trae' }
];

/** 用 where/which 探测候选编辑器是否已安装（仅读探测，不做任何启动） */
function detectInstalledEditorList() {
  const lookupExecutable = process.platform === 'win32' ? 'where' : 'which';
  return KNOWN_EDITOR_CANDIDATE_LIST.map((editorCandidate) => {
    let available = false;
    try {
      const detectResult = spawnSync(lookupExecutable, [editorCandidate.command], { stdio: 'ignore' });
      available = detectResult.status === 0;
    } catch {
      available = false;
    }
    return { ...editorCandidate, available };
  });
}

/**
 * 设置路由：查看与修改数据根目录、项目存放目录。
 * 数据目录修改立即生效（重建存储实例），历史数据保留原目录不迁移；
 * 项目存放目录作为目录选择器的默认起始定位。
 */
export function registerSettingsRoutes(router) {
  // 已安装编辑器探测：供设置页下拉选择"用什么打开"
  router.get('/api/editors/installed', (context) => {
    context.body = {
      editors: detectInstalledEditorList(),
      currentEditorCommand: persistenceManager.getEditorCommand()
    };
  });

  router.get('/api/settings', async (context) => {
    context.body = {
      dataDirectory: persistenceManager.getDataRootPath(),
      dataDirectoryResolved: Boolean(persistenceManager.getDataRootPath()),
      // 独立目录模式下 settings.json 记录的自定义目录（可能为空 = 使用默认解析）；供输入框回填，与生效目录区分
      configuredDataDirectory: persistenceManager.getConfiguredDataDirectory(),
      dataLocationMode: persistenceManager.getDataLocationMode(),
      appDataDirectoryPath: persistenceManager.getAppDataDirectoryPath(),
      projectDirectory: persistenceManager.getProjectDirectoryPath(),
      workspaceDirectory: persistenceManager.getWorkspaceDirectoryPath(),
      workspaceLayoutEnabled: persistenceManager.getWorkspaceLayoutEnabled(),
      editorCommand: persistenceManager.getEditorCommand()
    };
  });

  router.put('/api/settings', async (context) => {
    const requestData = context.request.body || {};
    const dataDirectoryInput = typeof requestData.dataDirectory === 'string' ? requestData.dataDirectory.trim() : '';
    const dataLocationModeInput =
      requestData.dataLocationMode === 'app-data' || requestData.dataLocationMode === 'standalone'
        ? requestData.dataLocationMode
        : '';
    const projectDirectoryInput =
      typeof requestData.projectDirectory === 'string' ? requestData.projectDirectory.trim() : '';
    const workspaceDirectoryInput =
      typeof requestData.workspaceDirectory === 'string' ? requestData.workspaceDirectory.trim() : '';
    const editorCommandInput = typeof requestData.editorCommand === 'string' ? requestData.editorCommand.trim() : '';
    const workspaceLayoutEnabled =
      typeof requestData.workspaceLayoutEnabled === 'boolean' ? requestData.workspaceLayoutEnabled : null;
    if (
      !dataDirectoryInput &&
      !dataLocationModeInput &&
      !projectDirectoryInput &&
      !workspaceDirectoryInput &&
      !editorCommandInput &&
      workspaceLayoutEnabled === null
    ) {
      throw new ValidationError('缺少可修改的设置项');
    }

    try {
      // 数据目录模式先行（app-data 切换 / standalone 恢复）；随后同请求的自定义目录会以 standalone 语义覆盖
      if (dataLocationModeInput) {
        await persistenceManager.changeDataLocationMode(dataLocationModeInput);
      }
      if (dataDirectoryInput) {
        await persistenceManager.changeDataRoot(dataDirectoryInput);
      }
      if (projectDirectoryInput) {
        await persistenceManager.changeProjectDirectory(projectDirectoryInput);
      }
      if (workspaceDirectoryInput) {
        await persistenceManager.changeWorkspaceDirectory(workspaceDirectoryInput);
      }
      if (editorCommandInput) {
        await persistenceManager.changeEditorCommand(editorCommandInput);
      }
      if (workspaceLayoutEnabled !== null) {
        await persistenceManager.changeWorkspaceLayout(workspaceLayoutEnabled);
      }
    } catch (changeError) {
      if (changeError instanceof ValidationError) {
        throw changeError;
      }
      throw new ValidationError(`设置修改失败: ${changeError.message}`);
    }

    const noticeList = [];
    if (dataLocationModeInput === 'app-data') {
      noticeList.push(
        '数据目录已切换到程序目录下 data，记录与任务日志已自动迁移（worktree 代码目录不迁移，已创建的 worktree 不受影响）。'
      );
    }
    if (dataLocationModeInput === 'standalone' && !dataDirectoryInput) {
      noticeList.push(
        '已切回独立数据目录（沿用此前记录的自定义目录或默认目录），记录与任务日志已自动迁移；worktree 代码目录不迁移。'
      );
    }
    if (dataDirectoryInput) {
      noticeList.push(
        '数据目录已切换，记录与任务日志已自动迁移到新目录（worktree 代码目录不迁移，已创建的 worktree 不受影响）。'
      );
    }
    if (projectDirectoryInput) {
      noticeList.push('代码默认存储目录已生效，目录选择器将默认定位到该目录。');
    }
    if (workspaceDirectoryInput) {
      noticeList.push('工作区文件目录已生效，新生成的工作区文件将保存到该目录。');
    }
    if (editorCommandInput) {
      noticeList.push('编辑器命令已生效，"打开"操作将使用该命令。');
    }
    context.body = {
      dataDirectory: persistenceManager.getDataRootPath(),
      dataLocationMode: persistenceManager.getDataLocationMode(),
      appDataDirectoryPath: persistenceManager.getAppDataDirectoryPath(),
      projectDirectory: persistenceManager.getProjectDirectoryPath(),
      workspaceDirectory: persistenceManager.getWorkspaceDirectoryPath(),
      workspaceLayoutEnabled: persistenceManager.getWorkspaceLayoutEnabled(),
      editorCommand: persistenceManager.getEditorCommand(),
      notice: noticeList.join(' ')
    };
  });
}
