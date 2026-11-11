# worktree-manager 平台接口全表

Base URL：`http://127.0.0.1:5210`（本地无鉴权）
所有请求/响应均为 JSON；失败时返回 `{ message }` 与 4xx/5xx 状态码。

## 允许 agent 调用

### 需求任务

| 方法 | 路径 | 说明 | 关键参数 |
| --- | --- | --- | --- |
| `GET` | `/api/requirement-tasks` | 列表（分页 + 过滤） | `status`=`pending-test\|tested\|published\|all`、`stageTag`=`待开发\|开发中\|测试中\|unset`、`startDate`、`endDate`、`page`、`pageSize` |
| `POST` | `/api/requirement-tasks` | 创建需求任务（含建 worktree、依赖、工作区文件） | `requirementName`、`branchName`、`projectList[{repoPath, projectName?}]`、`dependencyStrategy`=`install\|share\|skip`、`generateWorkspace` |
| `PUT` | `/api/requirement-tasks/:taskId` | 编辑任务（改名、改分支、增删项目） | 同创建字段 |
| `POST` | `/api/requirement-tasks/:taskId/stage` | 设置阶段标签 | `stageTag`=`待开发\|开发中\|测试中` |
| `POST` | `/api/requirement-tasks/:taskId/publish` | 标记已发布 / 取消发布 | `published`=boolean |
| `GET` | `/api/requirement-tasks/:taskId/locate` | 分支定位：各项目 worktree 当前分支、dirty 状态 | — |
| `GET` | `/api/requirement-tasks/:taskId/dependency-check` | 依赖状态：`shared\|independent\|missing` | — |
| `POST` | `/api/requirement-tasks/:taskId/generate-workspace` | 重新生成 `.code-workspace` | — |
| `POST` | `/api/requirement-tasks/:taskId/install-independent` | 启动独立安装（后台任务） | `worktreePath`、`customScript?` |
| `POST` | `/api/requirement-tasks/:taskId/restore-shared` | 切回共享依赖（重建目录链接） | — |
| `POST` | `/api/requirement-tasks/reorder` | 拖拽排序 | `orderedTaskIdList` |

### worktree

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/worktrees` | 列出某仓库的全部 worktree（`?repoPath=`） |
| `POST` | `/api/worktrees/create` | 创建 worktree |
| `POST` | `/api/worktrees/open-editor` | 用编辑器打开目录 |
| `GET` | `/api/worktree-history` | 创建历史 |

### 分支 / 文件系统 / 任务日志

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/branches` | 分支概览（`?repoPath=`） |
| `GET` | `/api/branches/default-base` | 默认基线分支 |
| `GET` | `/api/filesystem/repository-check` | 是否 git 仓库 + 当前分支（`?path=`） |
| `GET` | `/api/filesystem/directory` | 列子目录（`?path=`） |
| `GET` | `/api/filesystem/drives` | 盘符列表 |
| `POST` | `/api/filesystem/reveal` | 资源管理器定位（`targetPath`） |
| `POST` | `/api/filesystem/open-herdr` | 在 herdr 打开/复用工作区（`targetPath`、`label`、`startServer?`） |
| `POST` | `/api/filesystem/close-herdr` | 关闭 herdr 工作区（`targetPath`、`label`） |
| `GET` | `/api/tasks` | 后台任务列表（依赖安装等） |
| `GET` | `/api/tasks/:jobId` | 单个任务状态 |
| `GET` | `/api/tasks/:jobId/logs` | 任务日志（SSE 流） |

## 禁止 agent 调用（破坏性）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `DELETE` | `/api/requirement-tasks/:taskId` | 删除需求（移除关联 worktree，分支保留） |
| `DELETE` | `/api/requirement-tasks/:taskId/permanent` | 彻底删除任务记录 |
| `POST` | `/api/requirement-tasks/:taskId/restore` | 恢复需求并重建 worktree（会建目录，慎用） |
| `DELETE` | `/api/worktrees` | 删除 worktree 目录 |
| `POST` | `/api/worktrees/prune` | 批量清理失效记录 |
| `DELETE` | `/api/worktree-history` | 清空历史 |
| `DELETE` | `/api/tasks/:jobId` | 删除任务记录与日志 |
| `PUT` | `/api/settings` | 改全局设置（数据目录、默认编辑器等） |

## 响应要点

- `GET /api/requirement-tasks`：`{ tasks: [...], total, page, pageSize }`，任务含 `id / requirementName / branchName / workspaceFilePath / projectList[{projectName, repoPath, worktreePath}] / stageTag / publishedAt / createdAt / updatedAt`
- `POST /api/requirement-tasks`：`{ task, warning? }`；`branchName` 已存在等异常可能以 `warning` 返回而不是报错
- `POST /api/filesystem/open-herdr`：`{ created, clientAction: 'launched'|'activated'|'existing', workspaceId, label, targetPath }`；服务未运行时返回 `{ needsServerStart: true }`（HTTP 200）
- `POST /api/filesystem/close-herdr`：`{ closedCount, matchedCount, label }`；未找到时 `closedCount: 0` 并带 `message`
- `GET /api/requirement-tasks/:taskId/locate`：`{ projectList: [{ worktreeList: [{ path, branch, isMain, isDirty }], gitWebUrl, locateError? }] }`
- `GET /api/requirement-tasks/:taskId/dependency-check`：`{ projectList: [{ projectName, dependencyMode, riskLevel, riskMessage }] }`
