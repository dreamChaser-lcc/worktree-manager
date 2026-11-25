import path from 'node:path';
import { persistenceManager } from '../storage/persistence-manager.js';
import {
  describeCodebuddyEnvironment,
  readCodebuddyGatewayToken,
  resolveCodebuddyExecutable
} from '../core/codebuddy-cli-resolver.js';
import {
  buildInstanceWindowTitle,
  findCodebuddyInstanceByTaskId,
  getCodebuddyInstanceById,
  listCodebuddyInstances,
  recordInstanceJob,
  startCodebuddyInstance,
  stopCodebuddyInstance,
  touchInstanceActivity
} from '../core/codebuddy-instance-manager.js';
import {
  dispatchCodebuddyJob,
  getCodebuddyJobTranscript,
  getCodebuddySessionHistory,
  listCodebuddyJobs,
  listCodebuddySessions,
  openCodebuddyJobStream,
  replyCodebuddyJob,
  replyCodebuddySession,
  stopCodebuddyJob
} from '../core/codebuddy-gateway-client.js';
import {
  cancelAcpSession,
  disconnectAcp,
  loadAcpSession,
  openAcpPromptStream,
  resolveAcpInterruption,
  setAcpMode,
  setAcpModel
} from '../core/codebuddy-acp-client.js';
import {
  activateCodebuddyTerminalWindow,
  closeCodebuddyTerminalWindow,
  findRunningInteractiveSession,
  findRunningSessionCwd,
  listRunningInteractiveSessions,
  openCodebuddyTerminalWindow,
  resolveResumableSessionId
} from '../core/codebuddy-terminal-opener.js';
import { openInHerdrApp } from '../core/herdr-app-opener.js';
import { NotFoundError, ValidationError } from '../core/errors.js';

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * CodeBuddy 工作台路由：把「需求任务 → 实例 → job(对话)」三层串起来。
 * 实例进程由本服务以 detached 方式拉起，平台重启不影响实例存活；
 * 前端只跟本服务通信，绝不直接访问实例端口（避免 CORS 与密码外泄）。
 */
export function registerCodebuddyRoutes(router) {
  // 环境探测：CLI 是否安装、网关密码是否可读
  router.get('/api/codebuddy/environment', async (context) => {
    context.body = describeCodebuddyEnvironment();
  });

  // 总览：需求任务 + 实例 + 当前 job 摘要，一次拿全（前端轮询入口）
  router.get('/api/codebuddy/overview', async (context) => {
    const environment = describeCodebuddyEnvironment();
    const rawInstanceList = await listCodebuddyInstances();
    // 同一需求可能残留历史记录（异常/已停止），只保留一条：运行中最优先，其次创建时间最新
    const instanceByTaskMap = new Map();
    for (const instanceRecord of rawInstanceList) {
      const existingRecord = instanceByTaskMap.get(instanceRecord.taskId);
      if (!existingRecord) {
        instanceByTaskMap.set(instanceRecord.taskId, instanceRecord);
        continue;
      }
      const existingActive = existingRecord.state === 'running' || existingRecord.state === 'starting';
      const currentActive = instanceRecord.state === 'running' || instanceRecord.state === 'starting';
      if (currentActive && !existingActive) {
        instanceByTaskMap.set(instanceRecord.taskId, instanceRecord);
      } else if (currentActive === existingActive && String(instanceRecord.createdAt) > String(existingRecord.createdAt)) {
        instanceByTaskMap.set(instanceRecord.taskId, instanceRecord);
      }
    }
    const instanceList = Array.from(instanceByTaskMap.values());
    const taskListResult = await persistenceManager.listRequirementTaskRecords({
      status: 'all',
      page: 1,
      pageSize: 500
    });
    // 持久层返回 { records, total }（分页对象），这里只取当前页记录组装展示字段
    const requirementTaskList = (taskListResult.records || []).map((taskRecord) => ({
      id: taskRecord.id,
      requirementName: taskRecord.requirementName,
      requirementUrl: taskRecord.requirementUrl,
      branchName: taskRecord.branchName,
      stageTag: taskRecord.stageTag || null,
      publishedAt: taskRecord.publishedAt || null,
      workspaceFilePath: taskRecord.workspaceFilePath || null,
      projectList: (taskRecord.projectList || []).map((projectEntry) => ({
        projectName: projectEntry.projectName,
        repoPath: projectEntry.repoPath,
        worktreePath: projectEntry.worktreePath || null
      })),
      updatedAt: taskRecord.updatedAt
    }));

    const serializedInstanceList = [];
    for (const instanceRecord of instanceList) {
      let jobList = [];
      if (instanceRecord.state === 'running') {
        try {
          jobList = await listCodebuddyJobs(instanceRecord);
        } catch {
          // 实例刚起或正在重启：job 列表失败不影响 overview
          jobList = [];
        }
      }
      // 只认实例自己记录的那个 job；没有就留空，
      // 绝不能拿列表里最后一个顶上——那会把「新实例」错挂到某个历史对话上。
      const trackedJob = instanceRecord.jobId
        ? jobList.find((jobEntry) => jobEntry.id === instanceRecord.jobId) || null
        : null;
      serializedInstanceList.push({
        id: instanceRecord.id,
        taskId: instanceRecord.taskId,
        taskName: instanceRecord.taskName,
        label: instanceRecord.label || '',
        port: instanceRecord.port,
        state: instanceRecord.state,
        pid: instanceRecord.pid || null,
        // false 表示复用的是你已打开的 TUI 进程（停止时只解绑，不杀进程）
        ownedByPlatform: instanceRecord.ownedByPlatform !== false,
        instanceDirectoryPath: instanceRecord.instanceDirectoryPath,
        jobId: instanceRecord.jobId || null,
        jobName: instanceRecord.jobName || null,
        // 当前会话：前端按它拉 history / 发 reply（session 机制）
        activeSessionId: instanceRecord.activeSessionId || null,
        // rest = 轻量输入框；acp = 完整输入框（模型/权限/图片/停止）
        sessionChannel: instanceRecord.sessionChannel === 'acp' ? 'acp' : 'rest',
        lastActiveAt: instanceRecord.lastActiveAt || null,
        lastError: instanceRecord.lastError || null,
        logFilePath: instanceRecord.logFilePath || null,
        webUiUrl: instanceRecord.authToken
          ? `http://127.0.0.1:${instanceRecord.port}/?password=${encodeURIComponent(instanceRecord.authToken)}`
          : null,
        currentJob: trackedJob
          ? {
              id: trackedJob.id,
              name: trackedJob.name || '',
              state: trackedJob.state,
              status: trackedJob.status || null,
              tempo: trackedJob.tempo || null,
              detail: trackedJob.detail || '',
              alive: Boolean(trackedJob.alive),
              settled: Boolean(trackedJob.settled),
              updatedAt: trackedJob.updatedAt || null
            }
          : null,
        jobList: jobList.map((jobEntry) => ({
          id: jobEntry.id,
          name: jobEntry.name || '',
          state: jobEntry.state,
          status: jobEntry.status || null,
          detail: jobEntry.detail || '',
          updatedAt: jobEntry.updatedAt || null
        }))
      });
    }

    context.body = {
      environment,
      instanceList: serializedInstanceList,
      requirementTaskList
    };
  });

  // 在 herdr 打开该需求的工作区；传 sessionId 时顺带把该会话在工作区面板里续接起来
  router.post('/api/codebuddy/open-herdr', async (context) => {
    const requestBody = context.request.body || {};
    const taskId = String(requestBody.taskId || '').trim();
    if (!taskId) {
      throw new ValidationError('缺少 taskId');
    }
    const taskRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!taskRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }

    const requestedSessionId = String(requestBody.sessionId || '').trim();

    // 平台实例已在运行（它本身就是带端口的 TUI）：不再新起任何进程
    const runningInstance = await findCodebuddyInstanceByTaskId(taskId);
    if (runningInstance && runningInstance.state === 'running') {
      const herdrExecutable = resolveHerdrExecutable();
      const paneInfo = findHerdrPaneByWorkingDirectory(herdrExecutable, runningInstance.instanceDirectoryPath);
      if (paneInfo) {
        focusHerdrWorkspace(herdrExecutable, paneInfo.workspaceId);
        context.body = {
          reused: true,
          mode: 'focus-herdr',
          workspaceId: paneInfo.workspaceId,
          paneId: paneInfo.paneId,
          port: runningInstance.port
        };
        return;
      }
      context.body = {
        reused: true,
        mode: 'running-in-window',
        port: runningInstance.port,
        processId: runningInstance.pid
      };
      return;
    }

    // 该会话已有独立 TUI 在跑：能定位到 herdr 面板就聚焦过去，否则只回报进程信息，不再新起进程
    if (requestedSessionId) {
      const runningSession = findRunningInteractiveSession(resolveCodebuddyExecutable(), requestedSessionId);
      if (runningSession) {
        const herdrExecutable = resolveHerdrExecutable();
        const paneInfo = findHerdrPaneByWorkingDirectory(herdrExecutable, runningSession.cwd);
        if (paneInfo) {
          focusHerdrWorkspace(herdrExecutable, paneInfo.workspaceId);
          context.body = {
            reused: true,
            mode: 'focus-herdr',
            sessionId: requestedSessionId,
            workspaceId: paneInfo.workspaceId,
            paneId: paneInfo.paneId
          };
          return;
        }
        context.body = {
          reused: true,
          mode: 'running-elsewhere',
          sessionId: requestedSessionId,
          sessionUrl: runningSession.url,
          processId: runningSession.pid,
          workingDirectoryPath: runningSession.cwd
        };
        return;
      }
    }

    // 工作区文件优先（herdr 取其所在目录作为工作目录），没有则回退需求聚合目录
    const herdrTargetPath = taskRecord.workspaceFilePath || resolveRequirementDirectoryPath(taskRecord);
    const openResult = await openWorkspaceInHerdr({
      targetPath: herdrTargetPath,
      label: taskRecord.requirementName,
      startServer: requestBody.startServer === true
    });
    if (openResult.needsServerStart) {
      context.body = openResult;
      return;
    }

    // 选定会话时：先切到会话所属 worktree 目录，再在工作区面板里续接（--resume 按目录查找会话）
    let commandResult = null;
    if (requestedSessionId) {
      const jobWorkingDirectory = resolveDefaultJobCwd(taskRecord);
      if (!jobWorkingDirectory) {
        context.body = { ...openResult, commandError: '该需求下没有可用的 worktree 或主仓库目录' };
        return;
      }
      try {
        commandResult = resumeCodebuddyInHerdrPane({
          herdrExecutable: openResult.herdrExecutable,
          workspaceId: openResult.workspaceId,
          workingDirectoryPath: jobWorkingDirectory,
          sessionId: requestedSessionId
        });
      } catch (commandError) {
        context.body = { ...openResult, commandError: commandError.message };
        return;
      }
    }

    context.body = { ...openResult, commandResult };
  });

  // 历史会话列表：供「终端 CLI」选择一个会话续接（按该需求 worktree 目录过滤，避免跨目录找不到）
  router.get('/api/codebuddy/tasks/:taskId/sessions', async (context) => {
    const taskId = context.params.taskId;
    const taskRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!taskRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }
    const jobCwd = resolveDefaultJobCwd(taskRecord) || resolveRequirementDirectoryPath(taskRecord);
    const instanceRecord = await findCodebuddyInstanceByTaskId(taskId);
    if (!instanceRecord || instanceRecord.state !== 'running') {
      // 兜底：实例没起来时用本机会话进程列表，至少让用户能复用正在跑的 TUI
      const runningSessionList = listRunningInteractiveSessions(jobCwd);
      context.body = {
        instanceRunning: false,
        jobCwd,
        sessionList: runningSessionList,
        message:
          runningSessionList.length > 0
            ? '实例未运行：仅列出当前正在运行的会话；完整历史需启动实例后查看'
            : '实例未运行：启动实例后才能列出该目录下的历史会话'
      };
      return;
    }

    const sessionList = await listCodebuddySessions(instanceRecord, jobCwd);
    context.body = {
      instanceRunning: true,
      jobCwd,
      sessionList: sessionList.map((sessionEntry) => ({
        id: sessionEntry.id,
        name: sessionEntry.name || '（未命名会话）',
        messageCount: sessionEntry.messageCount || 0,
        createdAt: sessionEntry.createdAt || null,
        updatedAt: sessionEntry.updatedAt || null
      }))
    };
  });

  // 会话对话历史（session 机制）：平台与 TUI 用同一 sessionId，读到的就是同一段对话
  router.get('/api/codebuddy/instances/:instanceId/sessions/:sessionId/history', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const sessionId = context.params.sessionId;
    const runningSession = findRunningInteractiveSession(resolveCodebuddyExecutable(), sessionId);
    // 只有「不是本实例那个进程」的终端才算占用：
    // 实例本身就是一个 TUI 时，平台往它的会话里写是允许的（同一段对话，只是终端界面不实时刷新）
    const occupiedByOtherTerminal =
      Boolean(runningSession) && (!instanceRecord.pid || runningSession.pid !== instanceRecord.pid);
    const historyResult = await getCodebuddySessionHistory(instanceRecord, sessionId);
    context.body = {
      sessionId,
      sessionName: historyResult.sessionName,
      occupiedByTerminal: occupiedByOtherTerminal,
      terminalProcessId: occupiedByOtherTerminal ? runningSession.pid : null,
      requestList: historyResult.requestList.map((entry) => ({
        userInput: entry.userInput || '',
        finalReply: entry.finalReply || ''
      }))
    };
  });

  // 向会话发消息（session 机制）：不需要 job，直接续在这段对话上
  router.post('/api/codebuddy/instances/:instanceId/sessions/:sessionId/reply', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const sessionId = context.params.sessionId;
    const replyText = String((context.request.body || {}).text || '').trim();
    if (!replyText) {
      throw new ValidationError('指令不能为空');
    }
    // 别的终端正在使用这段对话时拒绝写入：两个 interactive 前端同时写会互相覆盖。
    // 本实例自身的 TUI 不算（平台往自己的会话里写是设计允许的）。
    const runningSession = findRunningInteractiveSession(resolveCodebuddyExecutable(), sessionId);
    const occupiedByOtherTerminal =
      Boolean(runningSession) && (!instanceRecord.pid || runningSession.pid !== instanceRecord.pid);
    if (occupiedByOtherTerminal) {
      throw new ValidationError(
        `另一个终端正在使用这段对话（进程 ${runningSession.pid}），请先在那边操作，或关闭该终端后再从平台发送`
      );
    }
    const replyResult = await replyCodebuddySession(instanceRecord, sessionId, replyText);
    touchInstanceActivity(instanceRecord);
    context.body = { delivered: Boolean(replyResult && replyResult.delivered), sessionId };
  });

  // ===== ACP 通道（完整输入框：模型/权限模式/图片/停止） =====

  // 建立连接并加载会话，返回下拉框所需的 models / modes / configOptions
  router.post('/api/codebuddy/instances/:instanceId/acp/connect', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const requestBody = context.request.body || {};
    const sessionId = String(requestBody.sessionId || instanceRecord.activeSessionId || '').trim();
    if (!sessionId) {
      throw new ValidationError('缺少会话 ID，无法建立 ACP 会话');
    }
    // 必须用会话真实的 cwd：传错会加载出空会话，prompt 静默返回 end_turn
    const sessionCwd = findRunningSessionCwd(sessionId) || instanceRecord.instanceDirectoryPath;
    const loadResult = await loadAcpSession(instanceRecord, sessionId, sessionCwd);
    touchInstanceActivity(instanceRecord);
    context.body = {
      sessionId: loadResult.sessionId,
      models: loadResult.models,
      modes: loadResult.modes,
      configOptions: loadResult.configOptions
    };
  });

  // 发送消息：直接透传上游 SSE（sessionUpdate 通知 + 最后的 result）
  router.post('/api/codebuddy/instances/:instanceId/acp/prompt', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const requestBody = context.request.body || {};
    const sessionId = String(requestBody.sessionId || instanceRecord.activeSessionId || '').trim();
    const promptPartList = Array.isArray(requestBody.prompt) ? requestBody.prompt : [];
    if (!sessionId) {
      throw new ValidationError('缺少会话 ID');
    }
    if (promptPartList.length === 0) {
      throw new ValidationError('消息内容为空');
    }

    const acpStreamResponse = await openAcpPromptStream(instanceRecord, sessionId, promptPartList);
    touchInstanceActivity(instanceRecord);

    context.status = 200;
    context.respond = false;
    const responseBody = context.res;
    responseBody.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    responseBody.flushHeaders();

    const upstreamReader = acpStreamResponse.body.getReader();
    let streamClosed = false;
    const closeStream = () => {
      if (streamClosed) {
        return;
      }
      streamClosed = true;
      if (!responseBody.writableEnded) {
        responseBody.end();
      }
    };
    context.req.on('close', () => {
      upstreamReader.cancel().catch(() => {});
      closeStream();
    });

    try {
      while (true) {
        const { done, value } = await upstreamReader.read();
        if (done) {
          break;
        }
        if (!responseBody.writableEnded && value) {
          responseBody.write(Buffer.from(value));
        }
      }
    } catch (streamError) {
      if (!responseBody.writableEnded) {
        responseBody.write(
          `event: codebuddy-error\ndata: ${JSON.stringify({ message: streamError.message })}\n\n`
        );
      }
    } finally {
      closeStream();
    }
  });

  // 停止当前生成
  router.post('/api/codebuddy/instances/:instanceId/acp/cancel', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const requestBody = context.request.body || {};
    const sessionId = String(requestBody.sessionId || instanceRecord.activeSessionId || '').trim();
    if (!sessionId) {
      throw new ValidationError('缺少会话 ID');
    }
    const cancelResult = await cancelAcpSession(instanceRecord, sessionId);
    context.body = { cancelled: true, result: cancelResult || null };
  });

  // 响应工具权限请求（interruption_request）：允许 / 全部允许 / 拒绝
  router.post('/api/codebuddy/instances/:instanceId/acp/interruption', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const requestBody = context.request.body || {};
    const sessionId = String(requestBody.sessionId || instanceRecord.activeSessionId || '').trim();
    const toolCallId = String(requestBody.toolCallId || '').trim();
    const decision = ['allow', 'deny', 'allowAll'].includes(requestBody.decision)
      ? requestBody.decision
      : 'deny';
    if (!sessionId || !toolCallId) {
      throw new ValidationError('缺少会话 ID 或 toolCallId');
    }
    await resolveAcpInterruption(
      instanceRecord,
      sessionId,
      toolCallId,
      decision,
      requestBody.feedback ? String(requestBody.feedback) : ''
    );
    context.body = { resolved: true, toolCallId, decision };
  });

  // 切换模型 / 权限模式
  router.post('/api/codebuddy/instances/:instanceId/acp/model', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const requestBody = context.request.body || {};
    const sessionId = String(requestBody.sessionId || instanceRecord.activeSessionId || '').trim();
    const modelId = String(requestBody.modelId || '').trim();
    if (!sessionId || !modelId) {
      throw new ValidationError('缺少会话 ID 或模型 ID');
    }
    await setAcpModel(instanceRecord, sessionId, modelId);
    context.body = { sessionId, modelId };
  });

  router.post('/api/codebuddy/instances/:instanceId/acp/mode', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const requestBody = context.request.body || {};
    const sessionId = String(requestBody.sessionId || instanceRecord.activeSessionId || '').trim();
    const modeId = String(requestBody.modeId || '').trim();
    if (!sessionId || !modeId) {
      throw new ValidationError('缺少会话 ID 或模式 ID');
    }
    await setAcpMode(instanceRecord, sessionId, modeId);
    context.body = { sessionId, modeId };
  });

  // 断开 ACP 连接（实例停止时也会自动断开）
  router.delete('/api/codebuddy/instances/:instanceId/acp', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    await disconnectAcp(instanceRecord);
    context.body = { disconnected: true };
  });

  // 打开终端 CLI：在需求的工作目录弹出独立终端窗口启动 TUI。
  // 传 jobId 且能定位到会话时用 --resume 续接那段对话（同一上下文，进程独立）；
  // 否则起一个新的交互式会话。
  router.post('/api/codebuddy/open-terminal', async (context) => {
    const requestBody = context.request.body || {};
    const taskId = String(requestBody.taskId || '').trim();
    if (!taskId) {
      throw new ValidationError('缺少 taskId');
    }
    const taskRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!taskRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }
    // 优先落到 worktree（写代码的地方），没有 worktree 时回退需求聚合目录
    const terminalDirectoryPath = resolveDefaultJobCwd(taskRecord) || resolveRequirementDirectoryPath(taskRecord);

    // 续接目标只认两处：用户显式选择的 sessionId，或按 jobId 从本机在跑的会话里反查。
    // 不读实例记录里的 jobSessionId——它可能指向已退出的进程，容易续接到别处或直接失败。
    let resumeSessionId = String(requestBody.sessionId || '').trim() || null;
    if (!resumeSessionId && requestBody.jobId) {
      resumeSessionId = resolveResumableSessionId(resolveCodebuddyExecutable(), requestBody.jobId);
    }

    // 平台实例已在运行：它本身就是一个带端口的 TUI 窗口，直接复用，绝不再起第二个进程
    const existingInstance = await findCodebuddyInstanceByTaskId(taskId);
    if (existingInstance && existingInstance.state === 'running') {
      context.body = {
        opened: false,
        reused: true,
        mode: 'instance-running',
        sessionId: resumeSessionId,
        port: existingInstance.port,
        processId: existingInstance.pid,
        workingDirectoryPath: terminalDirectoryPath
      };
      return;
    }

    // 该会话已有独立 TUI 在跑（非平台实例）：同样不新开
    if (resumeSessionId) {
      const runningSession = findRunningInteractiveSession(resolveCodebuddyExecutable(), resumeSessionId);
      if (runningSession) {
        context.body = {
          opened: false,
          reused: true,
          mode: 'already-running',
          sessionId: resumeSessionId,
          sessionUrl: runningSession.url,
          processId: runningSession.pid,
          workingDirectoryPath: terminalDirectoryPath
        };
        return;
      }
    }

    // 没有任何在跑的进程：由平台起一个 TUI，端口由平台分配/指定，并登记为实例网关
    const tokenResult = readCodebuddyGatewayToken();
    if (!tokenResult.token) {
      throw new ValidationError(`无法读取 CodeBuddy 网关密码：${tokenResult.reason}`);
    }
    const startResult = await startCodebuddyInstance({
      taskId,
      taskName: taskRecord.requirementName,
      authToken: tokenResult.token,
      instanceDirectoryPath: resolveRequirementDirectoryPath(taskRecord),
      candidateDirectoryList: [terminalDirectoryPath, resolveRequirementDirectoryPath(taskRecord)],
      preferReuseProcess: false,
      resumeSessionId,
      port: requestBody.port
    });
    context.body = {
      opened: true,
      reused: startResult.reused,
      mode: startResult.reused ? 'instance-running' : 'started-tui',
      sessionId: resumeSessionId,
      port: startResult.instance.port,
      processId: startResult.instance.pid,
      workingDirectoryPath: terminalDirectoryPath
    };
  });

  // 启动实例：按需求任务定位工作目录，端口可由用户指定
  router.post('/api/codebuddy/instances', async (context) => {
    const requestBody = context.request.body || {};
    const taskId = String(requestBody.taskId || '').trim();
    if (!taskId) {
      throw new ValidationError('缺少 taskId');
    }

    const taskRecord = await persistenceManager.findRequirementTaskById(taskId);
    if (!taskRecord) {
      throw new NotFoundError(`需求任务不存在: ${taskId}`);
    }

    const tokenResult = readCodebuddyGatewayToken();
    if (!tokenResult.token) {
      throw new ValidationError(
        `无法读取 CodeBuddy 网关密码：${tokenResult.reason}。请先在终端执行一次 codebuddy --serve 生成密码。`
      );
    }

    const instanceDirectoryPath = resolveRequirementDirectoryPath(taskRecord);
    // 复用候选目录：优先 worktree（TUI 通常 cd 到那里），再兜底需求聚合目录
    const candidateDirectoryList = [resolveDefaultJobCwd(taskRecord), instanceDirectoryPath].filter(Boolean);
    const startResult = await startCodebuddyInstance({
      taskId,
      taskName: taskRecord.requirementName,
      label: requestBody.label,
      port: requestBody.port,
      authToken: tokenResult.token,
      instanceDirectoryPath,
      candidateDirectoryList,
      // window = 独立终端窗口；herdr = 在 herdr 工作区里启动
      launchTarget: requestBody.launchTarget,
      resumeSessionId: requestBody.sessionId,
      // last = 续接上次会话（默认）；new = 强制新会话
      resumeMode: requestBody.resumeMode,
      // rest = 轻量通道（纯文本，共用会话）；acp = 完整通道（模型/权限/图片/停止）
      sessionChannel: requestBody.sessionChannel,
      // true 时即便实例在跑也按新配置重建（改选续接会话 / 新建会话的场景）
      forceRestart: requestBody.forceRestart === true
    });

    context.body = {
      instance: {
        id: startResult.instance.id,
        taskId: startResult.instance.taskId,
        port: startResult.instance.port,
        state: startResult.instance.state,
        pid: startResult.instance.pid,
        ownedByPlatform: startResult.instance.ownedByPlatform !== false,
        lastError: startResult.instance.lastError || null
      },
      reused: startResult.reused,
      gatewaySource: startResult.gatewaySource || 'self-serve'
    };
  });

  // 停止实例（结束进程树）
  /**
   * 激活已有终端窗口（不启动新进程）。
   * 终端：按会话名调 AppActivate；herdr：用 herdr 自己的 focus。
   */
  router.post('/api/codebuddy/instances/:instanceId/activate', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const launchTarget = ['herdr', 'herdr-app'].includes(instanceRecord.launchTarget)
      ? instanceRecord.launchTarget
      : 'terminal';

    if (launchTarget === 'herdr') {
      const focusResult = await focusHerdrWorkspace(instanceRecord.instanceDirectoryPath);
      context.body = {
        activated: Boolean(focusResult && focusResult.ok !== false),
        mode: 'herdr',
        sessionName: ''
      };
      return;
    }

    if (launchTarget === 'herdr-app') {
      // herdr app：切到该目录对应的 space 并置前，不重开终端
      const spaceResult = await openInHerdrApp({ targetPath: instanceRecord.instanceDirectoryPath });
      context.body = {
        activated: Boolean(spaceResult && spaceResult.selected),
        mode: 'herdr-app',
        spaceName: spaceResult ? spaceResult.spaceName : '',
        sessionName: ''
      };
      return;
    }

    // 终端窗口标题就是会话名，先查出会话名再按标题激活
    let sessionName = '';
    if (instanceRecord.activeSessionId) {
      try {
        const historyData = await getCodebuddySessionHistory(
          instanceRecord,
          instanceRecord.activeSessionId
        );
        sessionName = (historyData && historyData.sessionName) || '';
      } catch {
        sessionName = '';
      }
    }

    const activateResult = await activateCodebuddyTerminalWindow(
      buildInstanceWindowTitle(instanceRecord.taskId),
      sessionName
    );
    context.body = {
      activated: activateResult.activated,
      strategy: activateResult.strategy,
      mode: 'terminal',
      sessionName
    };
  });

  router.post('/api/codebuddy/instances/:instanceId/stop', async (context) => {
    const stoppedInstance = await stopCodebuddyInstance(context.params.instanceId);
    // 实例要停了，ACP 连接一并释放，避免残留半开连接
    await disconnectAcp(stoppedInstance);
    // 终端模式下顺手关掉窗口，避免留下「已退出进程」的黑窗；
    // herdr / herdr-app 的终端归 space 管理，这里不动（space 可能还有别的标签页）
    if (!['herdr', 'herdr-app'].includes(stoppedInstance.launchTarget)) {
      await closeCodebuddyTerminalWindow(buildInstanceWindowTitle(stoppedInstance.taskId));
    }
    context.body = {
      stopped: true,
      // true 表示只是解绑（进程是用户自己开的 TUI，未被结束）
      detachedOnly: stoppedInstance.detachedOnly === true,
      instanceId: stoppedInstance.id,
      port: stoppedInstance.port
    };
  });

  // 实例下的对话列表
  router.get('/api/codebuddy/instances/:instanceId/jobs', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const jobList = await listCodebuddyJobs(instanceRecord);
    context.body = {
      jobList: jobList.map((jobEntry) => ({
        id: jobEntry.id,
        name: jobEntry.name || '',
        state: jobEntry.state,
        status: jobEntry.status || null,
        tempo: jobEntry.tempo || null,
        detail: jobEntry.detail || '',
        cwd: jobEntry.cwd || null,
        webUrl: jobEntry.webUrl || null,
        updatedAt: jobEntry.updatedAt || null
      }))
    };
  });

  // 派发新对话：未指定 cwd 时取需求里第一个 worktree，回退第一个主仓库
  router.post('/api/codebuddy/instances/:instanceId/jobs', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const requestBody = context.request.body || {};
    const promptText = String(requestBody.prompt || '').trim();
    if (!promptText) {
      throw new ValidationError('指令不能为空');
    }

    const taskRecord = await persistenceManager.findRequirementTaskById(instanceRecord.taskId);
    const defaultJobCwd = resolveDefaultJobCwd(taskRecord);
    const jobCwd = String(requestBody.cwd || defaultJobCwd || '').trim();
    if (!jobCwd) {
      throw new ValidationError('无法确定对话工作目录：需求下没有可用的 worktree 或主仓库路径');
    }

    const dispatchedJob = await dispatchCodebuddyJob(instanceRecord, {
      prompt: promptText,
      cwd: jobCwd,
      name: String(requestBody.jobName || instanceRecord.taskName || '').trim() || undefined,
      model: requestBody.model,
      permissionMode: requestBody.permissionMode
    });
    touchInstanceActivity(instanceRecord);
    await recordInstanceJob(
      instanceRecord.id,
      dispatchedJob.id,
      dispatchedJob.name || '',
      dispatchedJob.sessionId
    );

    context.body = {
      job: {
        id: dispatchedJob.id,
        sessionId: dispatchedJob.sessionId,
        state: dispatchedJob.state,
        name: dispatchedJob.name || '',
        cwd: dispatchedJob.cwd,
        webUrl: dispatchedJob.webUrl || null
      }
    };
  });

  // 回复对话（后续指令）
  router.post('/api/codebuddy/instances/:instanceId/jobs/:jobId/reply', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const replyText = String((context.request.body || {}).text || '').trim();
    if (!replyText) {
      throw new ValidationError('指令不能为空');
    }
    const replyResult = await replyCodebuddyJob(instanceRecord, context.params.jobId, replyText);
    touchInstanceActivity(instanceRecord);
    context.body = { replyResult: replyResult || null };
  });

  // 停止当前对话
  router.post('/api/codebuddy/instances/:instanceId/jobs/:jobId/stop', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const stopResult = await stopCodebuddyJob(instanceRecord, context.params.jobId);
    context.body = { stopResult: stopResult || null };
  });

  // 历史对话快照（首次打开对话面板时回放）
  router.get('/api/codebuddy/instances/:instanceId/jobs/:jobId/transcript', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const updatesList = await getCodebuddyJobTranscript(instanceRecord, context.params.jobId);
    context.body = { updates: updatesList };
  });

  // 对话流：把实例 SSE 原样转发，只改写事件名（加 codebuddy- 前缀避免与前端其他事件冲突）
  router.get('/api/codebuddy/instances/:instanceId/jobs/:jobId/stream', async (context) => {
    const instanceRecord = await getCodebuddyInstanceById(context.params.instanceId);
    const abortController = new AbortController();

    context.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    context.status = 200;
    context.respond = false;

    const responseBody = context.res;
    let streamClosed = false;
    const closeStream = () => {
      if (streamClosed) {
        return;
      }
      streamClosed = true;
      if (!responseBody.writableEnded) {
        responseBody.end();
      }
    };

    context.req.on('close', () => {
      abortController.abort();
      closeStream();
    });

    let upstreamStreamResponse;
    try {
      upstreamStreamResponse = await openCodebuddyJobStream(
        instanceRecord,
        context.params.jobId,
        abortController.signal
      );
    } catch (streamError) {
      responseBody.write(
        `event: codebuddy-error\ndata: ${JSON.stringify({ message: streamError.message })}\n\n`
      );
      closeStream();
      return;
    }

    touchInstanceActivity(instanceRecord);
    const upstreamReader = upstreamStreamResponse.body.getReader();
    const textDecoder = new TextDecoder();
    let pendingBufferText = '';

    const heartbeatHandle = setInterval(() => {
      if (!responseBody.writableEnded) {
        responseBody.write(': heartbeat\n\n');
      }
    }, SSE_HEARTBEAT_INTERVAL_MS);

    try {
      while (true) {
        const readResult = await upstreamReader.read();
        if (readResult.done) {
          break;
        }
        pendingBufferText += textDecoder.decode(readResult.value, { stream: true });
        let frameDelimiterIndex = pendingBufferText.indexOf('\n\n');
        while (frameDelimiterIndex !== -1) {
          const frameText = pendingBufferText.slice(0, frameDelimiterIndex);
          pendingBufferText = pendingBufferText.slice(frameDelimiterIndex + 2);
          const parsedFrame = parseSseFrame(frameText);
          if (parsedFrame && !responseBody.writableEnded) {
            responseBody.write(
              `event: codebuddy-${parsedFrame.eventName}\ndata: ${parsedFrame.dataText}\n\n`
            );
          }
          frameDelimiterIndex = pendingBufferText.indexOf('\n\n');
        }
      }
    } catch {
      // 客户端断开或上游中断：静默收尾
    } finally {
      clearInterval(heartbeatHandle);
      try {
        await upstreamReader.cancel();
      } catch {
        // 已结束的连接取消失败可忽略
      }
      closeStream();
    }
  });
}

/** 需求聚合目录：工作区文件所在目录优先（聚合模式下即 <工作区目录>\<需求名>） */
function resolveRequirementDirectoryPath(taskRecord) {
  if (taskRecord && taskRecord.workspaceFilePath) {
    return path.dirname(taskRecord.workspaceFilePath);
  }
  const fallbackDirectoryName = sanitizeDirectoryName(taskRecord.requirementName || taskRecord.branchName || '');
  return path.join(persistenceManager.getWorkspaceDirectoryPath(), fallbackDirectoryName || 'codebuddy-workspace');
}

/** 目录名安全化：与工作区文件名规则保持一致 */
function sanitizeDirectoryName(nameText) {
  return String(nameText)
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 对话默认工作目录：第一个已建 worktree 的项目，回退第一个主仓库 */
function resolveDefaultJobCwd(taskRecord) {
  const projectEntryList = (taskRecord && taskRecord.projectList) || [];
  const worktreeProject = projectEntryList.find((projectEntry) => projectEntry && projectEntry.worktreePath);
  if (worktreeProject) {
    return worktreeProject.worktreePath;
  }
  const repoProject = projectEntryList.find((projectEntry) => projectEntry && projectEntry.repoPath);
  return repoProject ? repoProject.repoPath : null;
}

/** 解析单个 SSE 帧：取出事件名与 data 文本（多行 data 用换行拼接，与原协议一致） */
function parseSseFrame(frameText) {
  let eventName = 'message';
  const dataLineList = [];
  for (const lineText of frameText.split(/\r?\n/)) {
    if (lineText.startsWith('event:')) {
      eventName = lineText.slice(6).trim() || 'message';
    } else if (lineText.startsWith('data:')) {
      dataLineList.push(lineText.slice(5).trim());
    }
  }
  if (dataLineList.length === 0) {
    return null;
  }
  return { eventName, dataText: dataLineList.join('') };
}
