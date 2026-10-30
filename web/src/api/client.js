/** REST API 封装：统一错误抛出（error.details 携带拦截详情） */
async function requestJson(method, pathWithQuery, requestBody) {
  const requestOptions = { method, headers: { 'Content-Type': 'application/json' } };
  if (requestBody !== undefined) {
    requestOptions.body = JSON.stringify(requestBody);
  }
  const response = await fetch(pathWithQuery, requestOptions);
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestError = new Error(responseBody.error || `请求失败(${response.status})`);
    requestError.status = response.status;
    requestError.details = responseBody.details || null;
    throw requestError;
  }
  return responseBody;
}

export function getJson(pathWithQuery) {
  return requestJson('GET', pathWithQuery);
}

export function postJson(pathWithQuery, requestBody) {
  return requestJson('POST', pathWithQuery, requestBody);
}

export function putJson(pathWithQuery, requestBody) {
  return requestJson('PUT', pathWithQuery, requestBody);
}

export function deleteRequest(pathWithQuery) {
  return requestJson('DELETE', pathWithQuery);
}

export function fetchDriveList() {
  return getJson('/api/filesystem/drives');
}

export function fetchDirectoryListing(directoryPath) {
  return getJson(`/api/filesystem/directory?path=${encodeURIComponent(directoryPath)}`);
}

export function fetchRepositoryCheck(directoryPath) {
  return getJson(`/api/filesystem/repository-check?path=${encodeURIComponent(directoryPath)}`);
}

export function fetchBranchOverview(repoPath) {
  return getJson(`/api/branches?repoPath=${encodeURIComponent(repoPath)}`);
}

export function fetchDefaultBaseRef(repoPath) {
  return getJson(`/api/branches/default-base?repoPath=${encodeURIComponent(repoPath)}`);
}

export function createWorktree(createPayload) {
  return postJson('/api/worktrees/create', createPayload);
}

export function fetchWorktreeList(repoPath) {
  return getJson(`/api/worktrees?repoPath=${encodeURIComponent(repoPath)}`);
}

export function removeWorktree(repoPath, targetPath, force, deleteDirectory) {
  return deleteRequest(
    `/api/worktrees?repoPath=${encodeURIComponent(repoPath)}&targetPath=${encodeURIComponent(targetPath)}&force=${force ? 'true' : 'false'}&deleteDirectory=${deleteDirectory === false ? 'false' : 'true'}`
  );
}

export function pruneWorktreeRecords(repoPath) {
  return postJson('/api/worktrees/prune', { repoPath });
}

export function openDirectoryInEditor(targetPath) {
  return postJson('/api/worktrees/open-editor', { targetPath });
}

export function fetchRecentRepositories() {
  return getJson('/api/recent-repos');
}

export function fetchTaskList() {
  return getJson('/api/tasks');
}

export function fetchTaskDetail(jobId) {
  return getJson(`/api/tasks/${encodeURIComponent(jobId)}`);
}

export function fetchWorktreeHistory() {
  return getJson('/api/worktree-history');
}

export function clearWorktreeHistory() {
  return deleteRequest('/api/worktree-history');
}

export function fetchSettings() {
  return getJson('/api/settings');
}

export function fetchInstalledEditors() {
  return getJson('/api/editors/installed');
}

export function updateSettings(settingsPayload) {
  return putJson('/api/settings', settingsPayload);
}

export function fetchRequirementTaskList() {
  return getJson('/api/requirement-tasks');
}

export function createRequirementTask(taskPayload) {
  return postJson('/api/requirement-tasks', taskPayload);
}

export function updateRequirementTask(taskId, taskPayload) {
  return putJson(`/api/requirement-tasks/${encodeURIComponent(taskId)}`, taskPayload);
}

export function deleteRequirementTask(taskId, force) {
  const forceQuery = force ? '?force=true' : '';
  return requestJson('DELETE', `/api/requirement-tasks/${encodeURIComponent(taskId)}${forceQuery}`);
}

export function restoreRequirementTask(taskId) {
  return postJson(`/api/requirement-tasks/${encodeURIComponent(taskId)}/restore`, {});
}

export function permanentDeleteRequirementTask(taskId, force) {
  const forceQuery = force ? '?force=true' : '';
  return requestJson('DELETE', `/api/requirement-tasks/${encodeURIComponent(taskId)}/permanent${forceQuery}`);
}

export function deleteTaskRecord(jobId) {
  return requestJson('DELETE', `/api/tasks/${encodeURIComponent(jobId)}`);
}

export function generateRequirementWorkspace(taskId) {
  return postJson(`/api/requirement-tasks/${encodeURIComponent(taskId)}/generate-workspace`, {});
}

export function fetchRequirementTaskLocate(taskId) {
  return getJson(`/api/requirement-tasks/${encodeURIComponent(taskId)}/locate`);
}

export function revealInExplorer(targetPath) {
  return postJson('/api/filesystem/reveal', { targetPath });
}

export function fetchRequirementDependencyCheck(taskId) {
  return getJson(`/api/requirement-tasks/${encodeURIComponent(taskId)}/dependency-check`);
}

export function startRequirementIndependentInstall(taskId, worktreePath, customScript) {
  return postJson(`/api/requirement-tasks/${encodeURIComponent(taskId)}/install-independent`, {
    worktreePath,
    customScript: typeof customScript === 'string' && customScript.trim() !== '' ? customScript.trim() : undefined
  });
}

export function restoreSharedDependencies(taskId, worktreePath) {
  return postJson(`/api/requirement-tasks/${encodeURIComponent(taskId)}/restore-shared`, { worktreePath });
}
