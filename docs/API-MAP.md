# 前后端接口映射表

前端 `web/src/api/client.js` 以字符串 URL 调用后端，静态 AST 无法建立调用关系（graphify 图谱里前后端社区之间没有边）。本文件手工维护映射，用于两端同步改动与影响面排查。

**维护约定**：新增/修改/删除接口时同步更新本表；`client.js` 行号变动不必精确同步，以函数名为准。

## 通用请求封装（web/src/api/client.js）

| 前端函数 | 说明 |
| --- | --- |
| `requestJson(method, pathWithQuery, requestBody)` | 统一 fetch 封装：非 2xx 抛出 `Error`，并携带 `status` 与 `details`（后端拦截详情） |
| `getJson` / `postJson` / `putJson` / `deleteRequest` | 对应 HTTP 方法薄封装 |

## 需求任务（server/src/routes/requirement-task-routes.js）

| 方法 | 路径 | 前端函数 |
| --- | --- | --- |
| GET | `/api/requirement-tasks?status&page&pageSize` | `fetchRequirementTaskPage` / `fetchRequirementTaskList` |
| POST | `/api/requirement-tasks` | `createRequirementTask` |
| PUT | `/api/requirement-tasks/:taskId` | `updateRequirementTask` |
| DELETE | `/api/requirement-tasks/:taskId?force` | `deleteRequirementTask` |
| POST | `/api/requirement-tasks/:taskId/restore` | `restoreRequirementTask` |
| DELETE | `/api/requirement-tasks/:taskId/permanent?force` | `permanentDeleteRequirementTask` |
| POST | `/api/requirement-tasks/:taskId/publish` | `setRequirementPublished` |
| POST | `/api/requirement-tasks/:taskId/stage` | `setRequirementStage` |
| POST | `/api/requirement-tasks/reorder` | `reorderRequirementTasks` |
| POST | `/api/requirement-tasks/:taskId/generate-workspace` | `generateRequirementWorkspace` |
| GET | `/api/requirement-tasks/:taskId/locate` | `fetchRequirementTaskLocate` |
| GET | `/api/requirement-tasks/:taskId/dependency-check` | `fetchRequirementDependencyCheck` |
| POST | `/api/requirement-tasks/:taskId/install-independent` | `startRequirementIndependentInstall` |
| POST | `/api/requirement-tasks/:taskId/restore-shared` | `restoreSharedDependencies` |

前端使用方：`RequirementTaskPanel.jsx`（列表 + 明细弹窗容器）、`RequirementTaskForm.jsx`（新建/编辑）、`CreateWorktreeForm.jsx`（`fetchRequirementTaskList` 用于挂载已有需求）。`RequirementTaskDetailDialog.jsx` 不直接 import client，全部动作由 `RequirementTaskPanel.jsx` 以 props 注入。

## worktree（server/src/routes/worktree-routes.js）

| 方法 | 路径 | 前端函数 |
| --- | --- | --- |
| GET | `/api/worktrees?repoPath` | `fetchWorktreeList` |
| POST | `/api/worktrees/create` | `createWorktree` |
| DELETE | `/api/worktrees?repoPath&targetPath&force&deleteDirectory` | `removeWorktree` |
| POST | `/api/worktrees/prune` | `pruneWorktreeRecords` |
| POST | `/api/worktrees/open-editor` | `openDirectoryInEditor` |

前端使用方：`WorktreeListPanel.jsx`（列表/删除/清理）、`CreateWorktreeForm.jsx` 与 `WorktreeQuickCreateDialog.jsx`（创建）、`RequirementTaskForm.jsx`（`fetchWorktreeList` 选 worktree）、`RequirementTaskPanel.jsx`（`openDirectoryInEditor`）。

## 分支（server/src/routes/branch-routes.js）

| 方法 | 路径 | 前端函数 |
| --- | --- | --- |
| GET | `/api/branches?repoPath` | `fetchBranchOverview` |
| GET | `/api/branches/default-base?repoPath` | `fetchDefaultBaseRef` |

前端使用方：`BranchSelector.jsx`（`fetchBranchOverview`）、`CreateWorktreeForm.jsx` 与 `WorktreeQuickCreateDialog.jsx`（`fetchDefaultBaseRef`）。

## 文件系统（server/src/routes/filesystem-routes.js）

| 方法 | 路径 | 前端函数 |
| --- | --- | --- |
| GET | `/api/filesystem/drives` | `fetchDriveList` |
| GET | `/api/filesystem/directory?path` | `fetchDirectoryListing` |
| GET | `/api/filesystem/repository-check?path` | `fetchRepositoryCheck` |
| POST | `/api/filesystem/reveal` | `revealInExplorer` |

前端使用方：`DirectoryPicker.jsx`（盘符/目录浏览）、`CreateWorktreeForm.jsx` 与 `WorktreeListPanel.jsx`（仓库校验）、`RequirementTaskPanel.jsx`（`revealInExplorer` 打开资源管理器，明细弹窗经 props 复用）。

## 后台任务（server/src/routes/task-routes.js）

| 方法 | 路径 | 前端使用方 |
| --- | --- | --- |
| GET | `/api/tasks` | `fetchTaskList`（`TaskHistoryPanel.jsx`） |
| GET | `/api/tasks/:jobId` | `fetchTaskDetail` |
| DELETE | `/api/tasks/:jobId` | `deleteTaskRecord`（`TaskHistoryPanel.jsx`） |
| GET (SSE) | `/api/tasks/:jobId/logs` | 无 client 封装：`TaskLogPanel.jsx` 直接用 `EventSource` 订阅 `history` / `append` / `end` 事件 |

## 设置与编辑器（server/src/routes/settings-routes.js）

| 方法 | 路径 | 前端函数 |
| --- | --- | --- |
| GET | `/api/settings` | `fetchSettings` |
| PUT | `/api/settings` | `updateSettings` |
| GET | `/api/editors/installed` | `fetchInstalledEditors` |

前端使用方：`SettingsPanel.jsx`（设置读写与编辑器列表）、`App.jsx`（启动时 `fetchSettings`）。

## 记录类（server/src/routes/record-routes.js）

| 方法 | 路径 | 前端函数 |
| --- | --- | --- |
| GET | `/api/recent-repos` | `fetchRecentRepositories` |
| GET | `/api/worktree-history` | `fetchWorktreeHistory` |
| DELETE | `/api/worktree-history` | `clearWorktreeHistory` |

前端使用方：`CreationHistoryPanel.jsx`（worktree 历史查询与清空）、`App.jsx`（`fetchRecentRepositories`）。

## 探活（server/src/routes/health-routes.js）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 前端无封装，供运维/桌面壳探活 |

## 变更影响面速查

| 改动位置 | 必须同步检查 |
| --- | --- |
| `server/src/routes/*.js` 路径或字段 | 本表 + `web/src/api/client.js` 对应函数 + 该函数的前端使用方 |
| `web/src/api/client.js` 函数签名 | 调用该函数的组件（用函数名在 `web/src` 内 grep） |
| 新增接口 | 先加后端路由 → 加 client 封装 → 更新本表 → 前端组件接入 |
