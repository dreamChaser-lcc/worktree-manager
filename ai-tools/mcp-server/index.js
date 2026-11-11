#!/usr/bin/env node
/**
 * worktree-manager MCP server（stdio）。
 *
 * 作用：把本地 worktree-manager 平台（默认 http://127.0.0.1:5210）的能力暴露成 MCP 工具，
 * 让 AI agent 能用「建需求任务 / 查状态 / 打开 herdr 终端」这类动作替代手工点表单。
 *
 * 设计约束：
 * - 只封装创建与查询类操作；删除需求、删除 worktree 等破坏性接口不开放给 agent。
 * - 依赖策略默认 install（独立安装），避免共享目录链接在部分 Windows 环境不可用。
 * - branchName 必须由用户提供，工具描述里明确禁止 agent 自行编造。
 * - 日志一律走 stderr，stdout 留给 MCP 协议。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** 平台 API 根地址（可用 WORKTREE_MANAGER_API 覆盖） */
const API_BASE_URL = (process.env.WORKTREE_MANAGER_API || 'http://127.0.0.1:5210').replace(/\/+$/, '');

/** 普通接口超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30000;
/** 打开 herdr 可能要先拉起服务并等待就绪，单独放宽 */
const HERDR_TIMEOUT_MS = 90000;

/** 调平台 HTTP 接口：非 2xx 一律抛错，错误文本带上接口返回的 message */
async function callApi(method, requestPath, requestBody, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${requestPath}`, {
      method,
      headers: requestBody ? { 'Content-Type': 'application/json' } : undefined,
      body: requestBody ? JSON.stringify(requestBody) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (requestError) {
    if (requestError.name === 'TimeoutError') {
      throw new Error(`请求超时：${method} ${requestPath}`);
    }
    throw new Error(
      `无法连接 worktree-manager 平台（${API_BASE_URL}）。请确认服务已启动（双击项目根目录的 start.bat），再重试。原始错误：${requestError.message}`
    );
  }

  const responseText = await response.text();
  let responseBody = null;
  if (responseText) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = { rawText: responseText };
    }
  }

  if (!response.ok) {
    const messageText =
      (responseBody && (responseBody.message || responseBody.error)) || responseText || `HTTP ${response.status}`;
    throw new Error(`接口失败（${response.status}）：${messageText}`);
  }
  return responseBody;
}

/** 统一的成功返回：给 agent 读的纯文本 */
function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

/** 统一的失败返回 */
function errorResult(error) {
  const messageText = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: messageText }] };
}

/** 拉全部需求任务（用于按 id 查找，平台没有单任务查询端点） */
async function fetchAllRequirementTasks() {
  const listData = await callApi('GET', '/api/requirement-tasks?status=all&page=1&pageSize=500');
  return (listData && listData.tasks) || [];
}

/** 按 id 找任务；找不到时给出可读错误 */
async function requireTaskById(taskId) {
  const taskList = await fetchAllRequirementTasks();
  const matchedTask = taskList.find((task) => task.id === taskId);
  if (!matchedTask) {
    throw new Error(`未找到需求任务：${taskId}`);
  }
  return matchedTask;
}

/** 任务摘要文本（创建/查询共用） */
function formatTaskSummary(taskEntry) {
  const projectLineList = (taskEntry.projectList || []).map((projectEntry) => {
    const worktreeText = projectEntry.worktreePath ? projectEntry.worktreePath : '（未关联 worktree）';
    return `  - ${projectEntry.projectName}：${worktreeText}`;
  });

  return [
    `需求任务「${taskEntry.requirementName || '(未命名)'}」`,
    `  taskId：${taskEntry.id}`,
    `  分支：${taskEntry.branchName || '(未设置)'}`,
    `  工作区文件：${taskEntry.workspaceFilePath || '(未生成)'}`,
    `  阶段标签：${taskEntry.stageTag || '(未设置)'}`,
    `  发布状态：${taskEntry.publishedAt ? '已发布' : '未发布'}`,
    '  涉及项目：',
    ...(projectLineList.length > 0 ? projectLineList : ['  （无）'])
  ].join('\n');
}

const mcpServer = new McpServer({
  name: 'worktree-manager',
  version: '0.1.0'
});

mcpServer.tool(
  'create_requirement_task',
  [
    '创建一条需求任务：写需求记录 → 为每个项目建 git worktree → 按依赖策略安装/共享依赖 → 生成 .code-workspace 工作区文件。',
    '调用前必须确认：用户已给出需求名称、开发分支名、至少一个主仓库绝对路径。',
    '重要：branchName 必须由用户明确提供，禁止自行编造或猜测；用户没给就先问。',
    '依赖策略默认 install（每个 worktree 独立安装，耗时几分钟但隔离最稳）；用户明确要求省时间才用 share。'
  ].join('\n'),
  {
    requirementName: z.string().min(1).describe('需求标题，例如「【微赞+星享】【惠康】客服支持语音转文字」'),
    branchName: z
      .string()
      .min(1)
      .describe('开发分支名，例如 lifachao/1103_add_feature。必须来自用户输入，不要自行编造'),
    projectList: z
      .array(
        z.object({
          repoPath: z.string().min(1).describe('主仓库绝对路径，例如 D:\\project\\userlive'),
          projectName: z.string().optional().describe('项目名，不填则取目录名')
        })
      )
      .min(1)
      .describe('涉及的项目主仓库列表，至少一个'),
    requirementUrl: z.string().optional().describe('需求链接（TAPD 等），可选'),
    dependencyStrategy: z
      .enum(['install', 'share', 'skip'])
      .optional()
      .describe('依赖策略：install=独立安装（默认）、share=共享主目录目录链接、skip=不处理'),
    generateWorkspace: z.boolean().optional().describe('是否生成 .code-workspace 工作区文件，默认 true'),
    stageTag: z.enum(['待开发', '开发中', '测试中']).optional().describe('阶段标签，可选'),
    allowDuplicate: z
      .boolean()
      .optional()
      .describe('默认 false：先按「需求名 + 分支名」查重，已存在则直接返回已有任务，不重复创建')
  },
  async (toolArguments) => {
    try {
      if (!toolArguments.allowDuplicate) {
        const existingTaskList = await fetchAllRequirementTasks();
        const duplicatedTask = existingTaskList.find(
          (taskEntry) =>
            taskEntry.requirementName === toolArguments.requirementName &&
            taskEntry.branchName === toolArguments.branchName
        );
        if (duplicatedTask) {
          return textResult(
            [
              '已存在同名同分支的需求任务，未重复创建（如需强制新建请传 allowDuplicate=true）：',
              formatTaskSummary(duplicatedTask)
            ].join('\n')
          );
        }
      }

      const createResult = await callApi('POST', '/api/requirement-tasks', {
        requirementName: toolArguments.requirementName,
        requirementUrl: toolArguments.requirementUrl,
        branchName: toolArguments.branchName,
        projectList: toolArguments.projectList,
        dependencyStrategy: toolArguments.dependencyStrategy || 'install',
        generateWorkspace: toolArguments.generateWorkspace !== false
      });

      const createdTask = (createResult && createResult.task) || null;
      if (!createdTask) {
        return textResult(`创建请求已提交，但接口未返回任务详情。原始响应：${JSON.stringify(createResult)}`);
      }

      // 阶段标签不是创建接口的参数，需要单独调一次
      if (toolArguments.stageTag) {
        try {
          await callApi('POST', `/api/requirement-tasks/${createdTask.id}/stage`, {
            stageTag: toolArguments.stageTag
          });
          createdTask.stageTag = toolArguments.stageTag;
        } catch (stageError) {
          console.error('[worktree-manager-mcp] 设置阶段标签失败：', stageError.message);
        }
      }

      const warningTextList = [];
      if (createResult.requirementTaskAttach && createResult.requirementTaskAttach.warning) {
        warningTextList.push(createResult.requirementTaskAttach.warning);
      }
      const attachSkipped = createResult.attached === false;
      if (attachSkipped && createResult.warning) {
        warningTextList.push(createResult.warning);
      }

      return textResult(
        [
          '已创建需求任务：',
          formatTaskSummary(createdTask),
          warningTextList.length > 0 ? `\n注意：${warningTextList.join('；')}` : '',
          '\n依赖安装若是 install 策略会在后台执行，进度可在平台「任务记录」查看。',
          '需要立刻开工可以继续调用 open_in_herdr。'
        ]
          .filter(Boolean)
          .join('\n')
      );
    } catch (createError) {
      return errorResult(createError);
    }
  }
);

mcpServer.tool(
  'list_requirement_tasks',
  '按发布状态 / 阶段标签 / 创建时间范围查询需求任务列表。用于回答「最近有哪些需求」「有哪些在测试中」这类问题。',
  {
    status: z
      .enum(['pending-test', 'tested', 'published', 'all'])
      .optional()
      .describe('发布状态 tab：pending-test=待提测（默认口径）、tested=已提测、published=已发布、all=全部'),
    stageTag: z
      .enum(['待开发', '开发中', '测试中', 'unset'])
      .optional()
      .describe('阶段标签过滤；unset 表示未设置标签'),
    startDate: z.string().optional().describe('创建日期下限，YYYY-MM-DD'),
    endDate: z.string().optional().describe('创建日期上限，YYYY-MM-DD'),
    page: z.number().int().min(1).optional().describe('页码，默认 1'),
    pageSize: z.number().int().min(1).max(200).optional().describe('每页条数，默认 20')
  },
  async (toolArguments) => {
    try {
      const queryParams = new URLSearchParams({
        status: toolArguments.status || 'all',
        page: String(toolArguments.page || 1),
        pageSize: String(toolArguments.pageSize || 20)
      });
      if (toolArguments.stageTag) {
        queryParams.set('stageTag', toolArguments.stageTag);
      }
      if (toolArguments.startDate) {
        queryParams.set('startDate', toolArguments.startDate);
      }
      if (toolArguments.endDate) {
        queryParams.set('endDate', toolArguments.endDate);
      }

      const listData = await callApi('GET', `/api/requirement-tasks?${queryParams.toString()}`);
      const taskList = (listData && listData.tasks) || [];

      if (taskList.length === 0) {
        return textResult('没有符合条件的需求任务。');
      }

      const taskLineList = taskList.map((taskEntry) => {
        const stageText = taskEntry.stageTag || '未设置';
        const publishText = taskEntry.publishedAt ? '已发布' : '未发布';
        const createdText = String(taskEntry.createdAt || '').replace('T', ' ').slice(0, 16);
        return `- ${taskEntry.requirementName || '(未命名)'} | ${taskEntry.branchName || '-'} | ${stageText} / ${publishText} | 创建 ${createdText} | taskId=${taskEntry.id}`;
      });

      return textResult(
        [`共 ${listData.total ?? taskList.length} 条（本页 ${taskList.length} 条）：`, ...taskLineList].join('\n')
      );
    } catch (listError) {
      return errorResult(listError);
    }
  }
);

mcpServer.tool(
  'get_requirement_status',
  '查看单个需求任务的实时状态：各项目 worktree 当前所在分支、是否有未提交修改、依赖是共享还是独立安装。',
  {
    taskId: z.string().min(1).describe('需求任务 id')
  },
  async (toolArguments) => {
    try {
      const taskEntry = await requireTaskById(toolArguments.taskId);

      const statusPartList = [formatTaskSummary(taskEntry)];

      try {
        const locateData = await callApi(
          'GET',
          `/api/requirement-tasks/${toolArguments.taskId}/locate`
        );
        const locateProjectList = (locateData && locateData.projectList) || [];
        if (locateProjectList.length > 0) {
          statusPartList.push('\n分支定位：');
          locateProjectList.forEach((locateEntry, projectIndex) => {
            if (locateEntry.locateError) {
              statusPartList.push(`  - 项目 ${projectIndex + 1}：查询失败（${locateEntry.locateError}）`);
              return;
            }
            const worktreeLineList = (locateEntry.worktreeList || []).map((worktreeEntry) => {
              const dirtyText = worktreeEntry.isDirty ? ' [有未提交修改]' : '';
              const mainText = worktreeEntry.isMain ? ' [主仓库]' : '';
              return `      ${worktreeEntry.path} → ${worktreeEntry.branch || '(detached)'}${mainText}${dirtyText}`;
            });
            statusPartList.push(`  - 项目 ${projectIndex + 1}：`, ...worktreeLineList);
          });
        }
      } catch (locateError) {
        statusPartList.push(`\n分支定位查询失败：${locateError.message}`);
      }

      try {
        const dependencyData = await callApi(
          'GET',
          `/api/requirement-tasks/${toolArguments.taskId}/dependency-check`
        );
        const dependencyProjectList = (dependencyData && dependencyData.projectList) || [];
        if (dependencyProjectList.length > 0) {
          statusPartList.push('\n依赖状态：');
          dependencyProjectList.forEach((dependencyEntry) => {
            statusPartList.push(
              `  - ${dependencyEntry.projectName}：${dependencyEntry.dependencyMode}（${dependencyEntry.riskMessage || '无风险提示'}）`
            );
          });
        }
      } catch (dependencyError) {
        statusPartList.push(`\n依赖状态查询失败：${dependencyError.message}`);
      }

      return textResult(statusPartList.join('\n'));
    } catch (statusError) {
      return errorResult(statusError);
    }
  }
);

mcpServer.tool(
  'open_in_herdr',
  '在 herdr 终端里打开该需求的工作区（工作目录为工作区文件所在目录）。工作区已存在时只切换焦点，不会重复创建；herdr 服务未运行时会返回提示，需要用户确认后再调用带 startServer=true。',
  {
    taskId: z.string().min(1).describe('需求任务 id'),
    startServer: z
      .boolean()
      .optional()
      .describe('herdr 服务未运行时是否直接启动它。仅当用户明确同意启动时才传 true')
  },
  async (toolArguments) => {
    try {
      const taskEntry = await requireTaskById(toolArguments.taskId);
      if (!taskEntry.workspaceFilePath) {
        throw new Error(
          '该需求还没有工作区文件。可以先调用平台「重新生成工作区文件」，或直接用 create_requirement_task 创建时带上 generateWorkspace=true。'
        );
      }

      const openResult = await callApi(
        'POST',
        '/api/filesystem/open-herdr',
        {
          targetPath: taskEntry.workspaceFilePath,
          label: taskEntry.requirementName,
          startServer: Boolean(toolArguments.startServer)
        },
        HERDR_TIMEOUT_MS
      );

      if (openResult && openResult.needsServerStart) {
        return textResult(
          [
            'herdr 服务当前未运行，尚未打开终端。',
            `目录：${openResult.targetPath}`,
            '请向用户确认是否启动 herdr：确认后再次调用本工具并传 startServer=true。'
          ].join('\n')
        );
      }

      const actionTextMap = {
        launched: '已启动 herdr 终端',
        activated: '已切到已有的 herdr 窗口',
        existing: 'herdr 窗口已就绪'
      };
      const actionText = actionTextMap[openResult.clientAction] || '';
      return textResult(
        [
          openResult.created
            ? `已在 herdr 新建工作区「${openResult.label}」`
            : `已切换到 herdr 工作区「${openResult.label}」`,
          actionText ? `（${actionText}）` : '',
          `目录：${openResult.targetPath}`,
          `workspaceId：${openResult.workspaceId || '(未知)'}`
        ]
          .filter(Boolean)
          .join('\n')
      );
    } catch (openError) {
      return errorResult(openError);
    }
  }
);

mcpServer.tool(
  'close_herdr_workspace',
  '关闭该需求在 herdr 里的工作区（终端内运行的进程会一并结束）。属于破坏性操作，仅在用户明确要求关闭时调用。',
  {
    taskId: z.string().min(1).describe('需求任务 id')
  },
  async (toolArguments) => {
    try {
      const taskEntry = await requireTaskById(toolArguments.taskId);
      if (!taskEntry.workspaceFilePath) {
        throw new Error('该需求没有工作区文件，无需关闭 herdr 工作区。');
      }

      const closeResult = await callApi('POST', '/api/filesystem/close-herdr', {
        targetPath: taskEntry.workspaceFilePath,
        label: taskEntry.requirementName
      });

      if (closeResult.closedCount > 0) {
        return textResult(`已关闭 herdr 工作区「${closeResult.label}」（${closeResult.closedCount} 个终端）。`);
      }
      return textResult(closeResult.message || '未找到可关闭的 herdr 工作区。');
    } catch (closeError) {
      return errorResult(closeError);
    }
  }
);

mcpServer.tool(
  'check_git_repository',
  '校验一个目录是否为 git 仓库，并返回当前分支。创建需求任务前可先用它确认 repoPath 有效。',
  {
    repoPath: z.string().min(1).describe('要校验的目录绝对路径')
  },
  async (toolArguments) => {
    try {
      const checkData = await callApi(
        'GET',
        `/api/filesystem/repository-check?path=${encodeURIComponent(toolArguments.repoPath)}`
      );
      if (!checkData.isGitRepository) {
        return textResult(
          `目录不是 git 仓库：${checkData.path}${checkData.checkError ? `（${checkData.checkError}）` : ''}`
        );
      }
      return textResult(`是 git 仓库：${checkData.path}\n当前分支：${checkData.currentBranch || '(未知)'}`);
    } catch (checkError) {
      return errorResult(checkError);
    }
  }
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
console.error(`[worktree-manager-mcp] 已启动，平台地址：${API_BASE_URL}`);
