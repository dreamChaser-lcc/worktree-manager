import { ValidationError } from './errors.js';

/**
 * CodeBuddy 实例的 HTTP API 客户端（/api/v1/*，Beta）。
 * 实测要点（2026-11-12 验证）：
 * - 所有 /api/v1/* 都必须带 `X-CodeBuddy-Request: 1`，health 也不例外（文档标注豁免但实测非豁免）
 * - 认证走 `Authorization: Bearer <gateway.password>`，与浏览器 Cookie 互不影响
 * - REST 适合"派发 + 查询 + 回复"，流式输出走 /jobs/:id/stream（SSE）
 */

const GATEWAY_REQUEST_TIMEOUT_MS = 20_000;
const JOBS_CACHE_TTL_MS = 1200;

/** 拼装实例 baseUrl（实例只绑本机回环） */
function buildInstanceBaseUrl(instanceRecord) {
  if (!instanceRecord || !instanceRecord.port) {
    throw new ValidationError('实例缺少端口，无法访问 CodeBuddy API');
  }
  return `http://127.0.0.1:${instanceRecord.port}`;
}

/** 组装通用请求头：请求标记 + Bearer 凭据 */
export function buildGatewayHeaders(instanceRecord) {
  return {
    'X-CodeBuddy-Request': '1',
    Authorization: `Bearer ${instanceRecord.authToken}`,
    'Content-Type': 'application/json'
  };
}

/** 调实例 REST API 并解析统一信封 { data } / { error } */
export async function callCodebuddyGateway(instanceRecord, requestPath, requestOptions = {}) {
  const abortController = new AbortController();
  const abortTimer = setTimeout(
    () => abortController.abort(),
    requestOptions.timeoutMilliseconds || GATEWAY_REQUEST_TIMEOUT_MS
  );
  try {
    const gatewayResponse = await fetch(`${buildInstanceBaseUrl(instanceRecord)}${requestPath}`, {
      method: requestOptions.method || 'GET',
      headers: buildGatewayHeaders(instanceRecord),
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
      signal: abortController.signal
    });
    const responseText = await gatewayResponse.text();
    let responseBody = null;
    try {
      responseBody = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseBody = { rawText: responseText };
    }
    if (!gatewayResponse.ok) {
      const errorMessage =
        (responseBody && responseBody.error && (responseBody.error.message || responseBody.error.code)) ||
        `HTTP ${gatewayResponse.status}`;
      throw new ValidationError(`CodeBuddy API 调用失败：${errorMessage}`);
    }
    return responseBody && responseBody.data !== undefined ? responseBody.data : responseBody;
  } catch (requestError) {
    if (requestError instanceof ValidationError) {
      throw requestError;
    }
    if (requestError.name === 'AbortError') {
      throw new ValidationError('CodeBuddy API 调用超时，实例可能无响应');
    }
    throw new ValidationError(`无法访问 CodeBuddy 实例（端口 ${instanceRecord.port}）：${requestError.message}`);
  } finally {
    clearTimeout(abortTimer);
  }
}

/**
 * job 列表：GET /api/v1/jobs?all=1
 * 实测：不带 all=1 只返回「当前工作空间」且往往是空数组；cwd=* 无效，必须用 all=1 才能拿到全部对话。
 */
export async function listCodebuddyJobs(instanceRecord) {
  const jobsData = await callCodebuddyGateway(instanceRecord, '/api/v1/jobs?all=1');
  return (jobsData && jobsData.jobs) || [];
}

/** job 详情：GET /api/v1/jobs/:id */
export async function getCodebuddyJobDetail(instanceRecord, jobId) {
  const jobData = await callCodebuddyGateway(instanceRecord, `/api/v1/jobs/${encodeURIComponent(jobId)}`);
  return (jobData && jobData.job) || jobData;
}

/** 派发新 job：POST /api/v1/jobs（cwd 决定这条对话绑定哪个 worktree） */
export async function dispatchCodebuddyJob(instanceRecord, dispatchInput) {
  const dispatchBody = {
    prompt: dispatchInput.prompt,
    cwd: dispatchInput.cwd,
    name: dispatchInput.name,
    // 远程/API 派发无法交互式批准权限，统一走完全放行（settings 里可再加 deny 规则收紧）
    permissionMode: dispatchInput.permissionMode || 'bypassPermissions'
  };
  if (dispatchInput.model) {
    dispatchBody.model = dispatchInput.model;
  }
  const jobData = await callCodebuddyGateway(instanceRecord, '/api/v1/jobs', {
    method: 'POST',
    body: dispatchBody
  });
  return jobData;
}

/** 回复等待输入的 job：POST /api/v1/jobs/:id/reply */
export async function replyCodebuddyJob(instanceRecord, jobId, replyText) {
  return callCodebuddyGateway(instanceRecord, `/api/v1/jobs/${encodeURIComponent(jobId)}/reply`, {
    method: 'POST',
    body: { text: replyText }
  });
}

/** 停止 job：POST /api/v1/jobs/:id/stop */
export async function stopCodebuddyJob(instanceRecord, jobId) {
  return callCodebuddyGateway(instanceRecord, `/api/v1/jobs/${encodeURIComponent(jobId)}/stop`, {
    method: 'POST',
    body: {}
  });
}

/**
 * 按目录列出历史会话：GET /api/v1/sessions?cwd=<目录>
 * 实测：传具体目录可拿到该项目的会话（含首条消息摘要、消息数、最近活跃时间），
 * 但 cwd=* 无效，所以必须传真实工作目录。
 */
export async function listCodebuddySessions(instanceRecord, workingDirectoryPath) {
  const queryText = workingDirectoryPath ? `?cwd=${encodeURIComponent(workingDirectoryPath)}` : '';
  const sessionsData = await callCodebuddyGateway(instanceRecord, `/api/v1/sessions${queryText}`);
  return (sessionsData && sessionsData.sessions) || [];
}

/**
 * 会话对话历史：GET /api/v1/sessions/:id/history
 * 返回的是问答对（userInput / finalReply），比 ACP 事件流更适合直接渲染，
 * 而且不依赖 jobId —— 平台与 TUI 只要用同一个 sessionId 就能看到同一段对话。
 */
export async function getCodebuddySessionHistory(instanceRecord, sessionId) {
  const historyData = await callCodebuddyGateway(
    instanceRecord,
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/history`
  );
  return {
    sessionName: (historyData && historyData.name) || '',
    requestList: (historyData && historyData.requests) || []
  };
}

/** 向指定会话发消息：POST /api/v1/sessions/:id/reply（不需要 job，直接续在这段会话上） */
export async function replyCodebuddySession(instanceRecord, sessionId, replyText) {
  return callCodebuddyGateway(instanceRecord, `/api/v1/sessions/${encodeURIComponent(sessionId)}/reply`, {
    method: 'POST',
    body: { text: replyText }
  });
}

/** 历史对话快照：GET /api/v1/jobs/:id/transcript（最多最近 1000 行 ACP 事件） */
export async function getCodebuddyJobTranscript(instanceRecord, jobId) {
  const transcriptData = await callCodebuddyGateway(
    instanceRecord,
    `/api/v1/jobs/${encodeURIComponent(jobId)}/transcript`
  );
  return (transcriptData && transcriptData.updates) || [];
}

/**
 * 打开 job 的 SSE 流（返回原始 Response，由路由层转发给浏览器）。
 * 上游事件：event: message / event: keepalive；message 的 data 是完整消息对象。
 */
export async function openCodebuddyJobStream(instanceRecord, jobId, abortSignal) {
  const streamResponse = await fetch(
    `${buildInstanceBaseUrl(instanceRecord)}/api/v1/jobs/${encodeURIComponent(jobId)}/stream`,
    {
      headers: buildGatewayHeaders(instanceRecord),
      signal: abortSignal
    }
  );
  if (!streamResponse.ok || !streamResponse.body) {
    throw new ValidationError(`打开对话流失败（HTTP ${streamResponse.status}）`);
  }
  return streamResponse;
}

/** 简易缓存：避免前端轮询 overview 时对实例形成压力 */
const jobsSnapshotCache = new Map();

export async function listCodebuddyJobsCached(instanceRecord) {
  const cacheKey = `${instanceRecord.id}`;
  const cachedEntry = jobsSnapshotCache.get(cacheKey);
  if (cachedEntry && Date.now() - cachedEntry.cachedAt < JOBS_CACHE_TTL_MS) {
    return cachedEntry.jobs;
  }
  const jobsList = await listCodebuddyJobs(instanceRecord);
  jobsSnapshotCache.set(cacheKey, { jobs: jobsList, cachedAt: Date.now() });
  return jobsList;
}
