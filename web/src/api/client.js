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
