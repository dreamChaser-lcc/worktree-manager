import { ValidationError } from './errors.js';
import { buildGatewayHeaders } from './codebuddy-gateway-client.js';

/**
 * CodeBuddy ACP 客户端（Agent Client Protocol over HTTP/SSE）。
 *
 * 与 REST 的区别（实测 2026-11-12，2.183.0）：
 * - REST 的 /sessions/{id}/reply 只接受 { text }，且「不占用 ACP writer」→ 只能旁路投递纯文本
 * - ACP 的 session/prompt 支持 text / image(base64) / resource 三种内容块，
 *   还能 session/cancel（停止）、session/set_model、session/set_mode
 * - session/load 的 result 里直接带 models / modes / configOptions，正是输入框下拉框的数据源
 *
 * 连接生命周期（每个实例一条连接，按 instanceId 缓存）：
 *   POST /acp/connect            → { connectionId, sessionToken }
 *   POST /acp  initialize        → 交换协议版本与能力
 *   POST /acp  session/load      → { models, modes, configOptions } + 回放历史
 *   POST /acp  session/prompt    → SSE 流（sessionUpdate 通知 + 最后一条 result）
 *   POST /acp  session/cancel    → 停止当前生成
 *   DELETE /acp                  → 释放连接
 *
 * 请求头硬性要求：X-CodeBuddy-Request + Authorization + Accept(两种都要) + acp-connection-id
 */

const ACP_REQUEST_TIMEOUT_MS = 60_000;
const ACP_INITIALIZE_REQUEST_ID = 1;

/** instanceId → { connectionId, sessionToken } */
const acpConnectionMap = new Map();
/** instanceId → 单调递增的 requestId（JSON-RPC 要求同连接内唯一） */
const acpRequestIdMap = new Map();
/**
 * instanceId → 串行队列尾部。
 * ACP 的 session/load 会回放整段历史（90KB+，实测 3~11 秒），并发打同一个实例会把它压垮
 * （连带 REST 的 /sessions/:id/history 也开始 400），所以这里强制串行。
 */
const acpSerialQueueMap = new Map();

function enqueueAcpTask(instanceId, taskFunction) {
  const previousTail = acpSerialQueueMap.get(instanceId) || Promise.resolve();
  const nextTail = previousTail.then(taskFunction, taskFunction);
  // 队列本身不能因为某次失败而中断
  acpSerialQueueMap.set(
    instanceId,
    nextTail.then(
      () => undefined,
      () => undefined
    )
  );
  return nextTail;
}

function buildAcpBaseUrl(instanceRecord) {
  if (!instanceRecord || !instanceRecord.port) {
    throw new ValidationError('实例缺少端口，无法建立 ACP 连接');
  }
  return `http://127.0.0.1:${instanceRecord.port}`;
}

function nextAcpRequestId(instanceId) {
  const nextId = (acpRequestIdMap.get(instanceId) || ACP_INITIALIZE_REQUEST_ID) + 1;
  acpRequestIdMap.set(instanceId, nextId);
  return nextId;
}

/** ACP 请求头：Accept 必须同时包含 JSON 与 SSE，否则服务端直接 406 */
function buildAcpHeaders(instanceRecord, connectionId) {
  const headerMap = {
    ...buildGatewayHeaders(instanceRecord),
    Accept: 'application/json, text/event-stream'
  };
  if (connectionId) {
    headerMap['acp-connection-id'] = connectionId;
  }
  return headerMap;
}

/**
 * 把 SSE 响应体拆成一条条 data JSON。
 * ACP 用 `event: message\ndata: {...}\n\n`，也可能是 `:ok` 心跳注释行。
 */
async function* iterateAcpSseData(responseBody) {
  const streamReader = responseBody.getReader();
  const textDecoder = new TextDecoder();
  let pendingBuffer = '';
  while (true) {
    const { done, value } = await streamReader.read();
    if (done) {
      break;
    }
    pendingBuffer += textDecoder.decode(value, { stream: true });
    let boundaryIndex = pendingBuffer.indexOf('\n\n');
    while (boundaryIndex >= 0) {
      const rawChunk = pendingBuffer.slice(0, boundaryIndex);
      pendingBuffer = pendingBuffer.slice(boundaryIndex + 2);
      const dataLine = rawChunk.split('\n').find((lineText) => lineText.startsWith('data: '));
      if (dataLine) {
        yield dataLine.slice(6);
      }
      boundaryIndex = pendingBuffer.indexOf('\n\n');
    }
  }
}

/** 建连 + initialize（结果按实例缓存，实例重启后端口变了要重新连） */
async function ensureAcpConnection(instanceRecord) {
  const cachedConnection = acpConnectionMap.get(instanceRecord.id);
  if (cachedConnection && cachedConnection.port === instanceRecord.port) {
    return cachedConnection;
  }

  const connectResponse = await fetch(`${buildAcpBaseUrl(instanceRecord)}/api/v1/acp/connect`, {
    method: 'POST',
    headers: buildGatewayHeaders(instanceRecord),
    body: '{}'
  });
  const connectBody = await connectResponse.json().catch(() => null);
  if (!connectResponse.ok || !connectBody || !connectBody.connectionId) {
    throw new ValidationError(
      `ACP 建连失败（HTTP ${connectResponse.status}）：${
        (connectBody && connectBody.error && connectBody.error.message) || '未知原因'
      }`
    );
  }

  const connectionRecord = {
    connectionId: connectBody.connectionId,
    sessionToken: connectBody.sessionToken || null,
    port: instanceRecord.port
  };
  acpConnectionMap.set(instanceRecord.id, connectionRecord);
  acpRequestIdMap.set(instanceRecord.id, ACP_INITIALIZE_REQUEST_ID);

  // initialize 是后续所有方法的前置条件，不做会得到 "Server not initialized"
  await sendAcpRequest(instanceRecord, connectionRecord.connectionId, {
    jsonrpc: '2.0',
    id: ACP_INITIALIZE_REQUEST_ID,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientInfo: { name: 'worktree-manager', version: '1.0.0' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      }
    }
  });

  return connectionRecord;
}

/**
 * 发一个 ACP 请求并等它的 result（吃掉中间的所有 sessionUpdate 通知）。
 * 适用于 initialize / session/load / set_model / set_mode / cancel。
 */
function sendAcpRequest(instanceRecord, connectionId, payload, options = {}) {
  return enqueueAcpTask(instanceRecord.id, () =>
    sendAcpRequestInner(instanceRecord, connectionId, payload, options)
  );
}

/** 旁路队列的发送（用于权限确认这类必须插队的请求） */
function sendAcpRequestDirect(instanceRecord, connectionId, payload, options = {}) {
  return sendAcpRequestInner(instanceRecord, connectionId, payload, options);
}

async function sendAcpRequestInner(instanceRecord, connectionId, payload, options = {}) {
  const abortController = new AbortController();
  const abortTimer = setTimeout(
    () => abortController.abort(),
    options.timeoutMilliseconds || ACP_REQUEST_TIMEOUT_MS
  );
  try {
    const acpResponse = await fetch(`${buildAcpBaseUrl(instanceRecord)}/api/v1/acp`, {
      method: 'POST',
      headers: buildAcpHeaders(instanceRecord, connectionId),
      body: JSON.stringify(payload),
      signal: abortController.signal
    });
    if (!acpResponse.ok || !acpResponse.body) {
      throw new ValidationError(`ACP 请求失败（HTTP ${acpResponse.status}）`);
    }

    let resultPayload = null;
    let errorPayload = null;
    for await (const dataText of iterateAcpSseData(acpResponse.body)) {
      let parsedMessage = null;
      try {
        parsedMessage = JSON.parse(dataText);
      } catch {
        continue;
      }
      if (parsedMessage.error && (parsedMessage.id === payload.id || parsedMessage.id === null)) {
        errorPayload = parsedMessage.error;
      }
      if (parsedMessage.result !== undefined && parsedMessage.id === payload.id) {
        resultPayload = parsedMessage.result;
      }
    }

    if (errorPayload) {
      throw new ValidationError(`ACP 调用失败：${errorPayload.message || '未知错误'}`);
    }
    return resultPayload;
  } catch (requestError) {
    if (requestError instanceof ValidationError) {
      throw requestError;
    }
    if (requestError.name === 'AbortError') {
      throw new ValidationError('ACP 请求超时，实例可能无响应');
    }
    throw new ValidationError(`ACP 请求异常：${requestError.message}`);
  } finally {
    clearTimeout(abortTimer);
  }
}

/** session/load 结果缓存：它会回放整段历史（90KB+，实测 7~11 秒），必须复用 */
const acpSessionLoadMap = new Map();
const ACP_SESSION_CACHE_TTL_MS = 30_000;

/**
 * 加载会话：拿 models / modes / configOptions（顺带回放历史事件，这里丢弃）。
 * 同一实例+会话在 TTL 内命中缓存；并发调用复用同一个进行中的 Promise，
 * 否则每次打开面板都会触发一次完整回放，把实例堵住（连带 REST 的 history 也变慢）。
 */
export async function loadAcpSession(instanceRecord, sessionId, cwd) {
  const cacheKey = `${instanceRecord.id}:${sessionId}`;
  const cachedEntry = acpSessionLoadMap.get(cacheKey);
  if (cachedEntry) {
    if (cachedEntry.promise) {
      return cachedEntry.promise;
    }
    if (cachedEntry.loadedAt && Date.now() - cachedEntry.loadedAt < ACP_SESSION_CACHE_TTL_MS) {
      return cachedEntry.result;
    }
  }

  const loadPromise = (async () => {
    const connectionRecord = await ensureAcpConnection(instanceRecord);
    const loadResult = await sendAcpRequest(instanceRecord, connectionRecord.connectionId, {
      jsonrpc: '2.0',
      id: nextAcpRequestId(instanceRecord.id),
      method: 'session/load',
      params: { sessionId, cwd, mcpServers: [] }
    });
    return {
      connectionId: connectionRecord.connectionId,
      sessionId,
      models: (loadResult && loadResult.models) || null,
      modes: (loadResult && loadResult.modes) || null,
      configOptions: (loadResult && loadResult.configOptions) || []
    };
  })();

  acpSessionLoadMap.set(cacheKey, { promise: loadPromise });
  try {
    const loadResult = await loadPromise;
    acpSessionLoadMap.set(cacheKey, { result: loadResult, loadedAt: Date.now() });
    return loadResult;
  } catch (loadError) {
    acpSessionLoadMap.delete(cacheKey);
    throw loadError;
  }
}

/**
 * 发消息：返回原始 SSE Response，由路由层透传给前端。
 * payload 里的 prompt 是内容块数组：[{type:'text',text}, {type:'image',data,mimeType}]
 */
export async function openAcpPromptStream(instanceRecord, sessionId, promptPartList) {
  const connectionRecord = await ensureAcpConnection(instanceRecord);
  const promptRequestId = nextAcpRequestId(instanceRecord.id);
  const acpResponse = await fetch(`${buildAcpBaseUrl(instanceRecord)}/api/v1/acp`, {
    method: 'POST',
    headers: buildAcpHeaders(instanceRecord, connectionRecord.connectionId),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: promptRequestId,
      method: 'session/prompt',
      params: { sessionId, prompt: promptPartList }
    })
  });
  if (!acpResponse.ok || !acpResponse.body) {
    throw new ValidationError(`ACP 发送消息失败（HTTP ${acpResponse.status}）`);
  }
  return acpResponse;
}

/**
 * 响应工具权限请求（interruption_request）。
 *
 * 注意：**不能走串行队列**。权限确认发生在 session/prompt 的流期间，
 * 如果排在同一条队列里会死锁（prompt 等确认，确认等 prompt 让出队列）。
 */
export async function resolveAcpInterruption(
  instanceRecord,
  sessionId,
  toolCallId,
  decision,
  feedback
) {
  const connectionRecord = await ensureAcpConnection(instanceRecord);
  const params = { sessionId, toolCallId, decision };
  if (feedback) {
    params.answers = { feedback };
  }
  return sendAcpRequestDirect(instanceRecord, connectionRecord.connectionId, {
    jsonrpc: '2.0',
    id: nextAcpRequestId(instanceRecord.id),
    method: '_codebuddy.ai/resolveInterruption',
    params
  });
}

/** 停止当前生成 */
export async function cancelAcpSession(instanceRecord, sessionId) {
  const connectionRecord = await ensureAcpConnection(instanceRecord);
  return sendAcpRequest(instanceRecord, connectionRecord.connectionId, {
    jsonrpc: '2.0',
    id: nextAcpRequestId(instanceRecord.id),
    method: 'session/cancel',
    params: { sessionId }
  });
}

/** 切换模型 */
export async function setAcpModel(instanceRecord, sessionId, modelId) {
  const connectionRecord = await ensureAcpConnection(instanceRecord);
  return sendAcpRequest(instanceRecord, connectionRecord.connectionId, {
    jsonrpc: '2.0',
    id: nextAcpRequestId(instanceRecord.id),
    method: 'session/set_model',
    params: { sessionId, modelId }
  });
}

/** 切换权限模式 */
export async function setAcpMode(instanceRecord, sessionId, modeId) {
  const connectionRecord = await ensureAcpConnection(instanceRecord);
  return sendAcpRequest(instanceRecord, connectionRecord.connectionId, {
    jsonrpc: '2.0',
    id: nextAcpRequestId(instanceRecord.id),
    method: 'session/set_mode',
    params: { sessionId, modeId }
  });
}

/** 断开并清理（实例停止/端口变化时调用） */
export async function disconnectAcp(instanceRecord) {
  const connectionRecord = acpConnectionMap.get(instanceRecord.id);
  if (!connectionRecord) {
    return;
  }
  acpConnectionMap.delete(instanceRecord.id);
  acpRequestIdMap.delete(instanceRecord.id);
  // 一并清掉该实例的会话加载缓存，避免换实例后读到旧配置
  for (const cacheKey of Array.from(acpSessionLoadMap.keys())) {
    if (cacheKey.startsWith(`${instanceRecord.id}:`)) {
      acpSessionLoadMap.delete(cacheKey);
    }
  }
  try {
    await fetch(`${buildAcpBaseUrl(instanceRecord)}/api/v1/acp`, {
      method: 'DELETE',
      headers: buildAcpHeaders(instanceRecord, connectionRecord.connectionId)
    });
  } catch {
    // 实例已经没了，忽略
  }
}

/** 实例模式下是否已建立 ACP 连接 */
export function isAcpConnected(instanceId) {
  return acpConnectionMap.has(instanceId);
}
