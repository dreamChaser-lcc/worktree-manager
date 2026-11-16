/** CodeBuddy 工作台 API 封装：错误统一抛出，details 携带服务端补充信息 */
async function requestCodebuddyApi(requestMethod, requestPath, requestBody) {
  const requestOptions = { method: requestMethod, headers: { 'Content-Type': 'application/json' } };
  if (requestBody !== undefined) {
    requestOptions.body = JSON.stringify(requestBody);
  }
  const response = await fetch(requestPath, requestOptions);
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestError = new Error(responseBody.error || `请求失败(${response.status})`);
    requestError.status = response.status;
    requestError.details = responseBody.details || null;
    throw requestError;
  }
  return responseBody;
}

/** 总览：环境 + 实例 + 需求任务 */
export function fetchCodebuddyOverview() {
  return requestCodebuddyApi('GET', '/api/codebuddy/overview');
}

/** 启动某需求的实例（端口留空则由服务端自动分配） */
export function startCodebuddyInstance(startPayload) {
  return requestCodebuddyApi('POST', '/api/codebuddy/instances', startPayload);
}

/**
 * 在需求工作目录打开终端并启动交互式 TUI。
 * sessionId：指定要续接的历史会话；都不传则由服务端取当前对话，取不到就起新会话。
 */
export function openCodebuddyTerminal(taskId, terminalOptions = {}) {
  return requestCodebuddyApi('POST', '/api/codebuddy/open-terminal', {
    taskId,
    sessionId: terminalOptions.sessionId || undefined,
    jobId: terminalOptions.jobId || undefined
  });
}

/**
 * 在 herdr 打开该需求的工作区；传 sessionId 时在工作区面板里直接续接那段对话。
 * startServer=false 且 herdr 服务未运行时返回 { needsServerStart: true }，确认后再传 true 重试。
 */
export function openCodebuddyInHerdr(taskId, sessionId, startServer = false) {
  return requestCodebuddyApi('POST', '/api/codebuddy/open-herdr', {
    taskId,
    sessionId: sessionId || undefined,
    startServer
  });
}

/** 该需求 worktree 目录下的历史会话列表（供选择续接哪一个） */
export function fetchCodebuddySessionList(taskId) {
  return requestCodebuddyApi('GET', `/api/codebuddy/tasks/${encodeURIComponent(taskId)}/sessions`);
}

/** 激活已打开的终端窗口（不会启动新进程） */
export function activateCodebuddyInstance(instanceId) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/activate`
  );
}

/** 停止实例 */
export function stopCodebuddyInstance(instanceId) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/stop`,
    {}
  );
}

/** 派发新对话 */
export function dispatchCodebuddyJob(instanceId, dispatchPayload) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/jobs`,
    dispatchPayload
  );
}

/** 回复当前对话 */
export function replyCodebuddyJob(instanceId, jobId, replyText) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/jobs/${encodeURIComponent(jobId)}/reply`,
    { text: replyText }
  );
}

/** 停止当前对话 */
export function stopCodebuddyJob(instanceId, jobId) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/jobs/${encodeURIComponent(jobId)}/stop`,
    {}
  );
}

/**
 * 会话对话历史（session 机制）：平台与 TUI 用同一段对话，
 * 返回的 requestList 是问答对数组，并带 occupiedByTerminal 标记。
 */
export function fetchCodebuddySessionHistory(instanceId, sessionId) {
  return requestCodebuddyApi(
    'GET',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/sessions/${encodeURIComponent(sessionId)}/history`
  );
}

/** 向指定会话发消息（终端占用时后端会拒绝） */
export function replyCodebuddySession(instanceId, sessionId, replyText) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/sessions/${encodeURIComponent(sessionId)}/reply`,
    { text: replyText }
  );
}

// ===== ACP 通道（完整输入框） =====

/** 建立 ACP 连接并加载会话：返回 models / modes / configOptions */
export function connectCodebuddyAcp(instanceId, sessionId) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/acp/connect`,
    { sessionId }
  );
}

/** 停止当前生成 */
export function cancelCodebuddyAcp(instanceId, sessionId) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/acp/cancel`,
    { sessionId }
  );
}

/** 响应工具权限请求（interruption_request）：allow / allowAll / deny */
export function resolveCodebuddyAcpInterruption(instanceId, payload) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/acp/interruption`,
    payload
  );
}

/** 切换模型 */
export function setCodebuddyAcpModel(instanceId, sessionId, modelId) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/acp/model`,
    { sessionId, modelId }
  );
}

/** 切换权限模式 */
export function setCodebuddyAcpMode(instanceId, sessionId, modeId) {
  return requestCodebuddyApi(
    'POST',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/acp/mode`,
    { sessionId, modeId }
  );
}

/** 发消息的 SSE 地址（用原生 fetch 读流，不走 requestCodebuddyApi） */
export function buildCodebuddyAcpPromptUrl(instanceId) {
  return `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/acp/prompt`;
}

/** 历史对话快照 */
export function fetchCodebuddyTranscript(instanceId, jobId) {
  return requestCodebuddyApi(
    'GET',
    `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/jobs/${encodeURIComponent(jobId)}/transcript`
  );
}

/** 对话流地址（EventSource 用） */
export function buildCodebuddyStreamUrl(instanceId, jobId) {
  return `/api/codebuddy/instances/${encodeURIComponent(instanceId)}/jobs/${encodeURIComponent(jobId)}/stream`;
}
