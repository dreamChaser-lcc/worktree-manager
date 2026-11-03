# Graph Report - .  (2026-11-03)

## Corpus Check
- Corpus is ~47,098 words - fits in a single context window. You may not need a graph.

## Summary
- 462 nodes · 950 edges · 19 communities (17 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 20 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_前端 API 与界面|前端 API 与界面]]
- [[_COMMUNITY_依赖共享与策略|依赖共享与策略]]
- [[_COMMUNITY_服务端启动与配置|服务端启动与配置]]
- [[_COMMUNITY_桌面端壳与 sidecar|桌面端壳与 sidecar]]
- [[_COMMUNITY_Electron 打包配置|Electron 打包配置]]
- [[_COMMUNITY_持久化与需求概念|持久化与需求概念]]
- [[_COMMUNITY_服务端依赖栈|服务端依赖栈]]
- [[_COMMUNITY_工作区文件生成|工作区文件生成]]
- [[_COMMUNITY_Tauri 配置|Tauri 配置]]
- [[_COMMUNITY_根工程配置|根工程配置]]
- [[_COMMUNITY_前端依赖栈|前端依赖栈]]
- [[_COMMUNITY_桌面图标生成|桌面图标生成]]
- [[_COMMUNITY_编辑器启动|编辑器启动]]
- [[_COMMUNITY_开发脚本|开发脚本]]
- [[_COMMUNITY_Tauri 主进程|Tauri 主进程]]
- [[_COMMUNITY_数据导入导出|数据导入导出]]
- [[_COMMUNITY_Electron preload 桥|Electron preload 桥]]

## God Nodes (most connected - your core abstractions)
1. `executeGitCommand()` - 27 edges
2. `getJson()` - 18 edges
3. `createWorktree()` - 17 edges
4. `removeWorktree()` - 16 edges
5. `ValidationError` - 15 edges
6. `createApp()` - 14 edges
7. `postJson()` - 14 edges
8. `createFixtureRepository()` - 13 edges
9. `listWorktrees()` - 11 edges
10. `persistenceManager` - 11 edges

## Surprising Connections (you probably didn't know these)
- `桌面端（Electron / Tauri）` --implemented_by--> `{ app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain }`  [INFERRED]
  README.md → desktop-electron/main.js
- `Tauri sidecar 单文件服务` --implemented_by--> `name`  [INFERRED]
  README.md → desktop-tauri/package.json
- `需求任务聚合（多项目×分支×worktree）` --implemented_by--> `registerRequirementTaskRoutes()`  [INFERRED]
  README.md → server/src/routes/requirement-task-routes.js
- `依赖共享（junction 目录联接）` --implemented_by--> `LOCK_FILE_DETECTION_RULES`  [INFERRED]
  README.md → server/src/core/dep-linker.js
- `.code-workspace 工作区文件生成` --implemented_by--> `sanitizeWorkspaceFileName()`  [INFERRED]
  README.md → server/src/core/workspace-file-generator.js

## Import Cycles
- None detected.

## Communities (19 total, 2 thin omitted)

### Community 0 - "前端 API 与界面"
Cohesion: 0.05
Nodes (70): clearWorktreeHistory(), createRequirementTask(), createWorktree(), deleteRequest(), deleteRequirementTask(), deleteTaskRecord(), fetchBranchOverview(), fetchDefaultBaseRef() (+62 more)

### Community 1 - "依赖共享与策略"
Cohesion: 0.07
Nodes (55): git worktree 并行开发目录, applySharedDependencyLink(), detectPackageManager(), recommendDependencyStrategy(), startIndependentInstall(), checkWorktreeDependencyStatus(), diffDependencyMaps(), readPackageDependencies() (+47 more)

### Community 2 - "服务端启动与配置"
Cohesion: 0.06
Nodes (43): 依赖独立安装与恢复共享, createApp(), currentFileDir, serverConfig, AppError, compileSingleLevelWildcard(), copyIgnoredFiles(), copySingleFile() (+35 more)

### Community 3 - "桌面端壳与 sidecar"
Cohesion: 0.07
Nodes (31): 桌面端（Electron / Tauri）, Tauri sidecar 单文件服务, { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain }, createMainWindow(), createTray(), fs, net, path (+23 more)

### Community 4 - "Electron 打包配置"
Cohesion: 0.07
Nodes (28): build, appId, directories, extraResources, files, nsis, productName, win (+20 more)

### Community 5 - "持久化与需求概念"
Cohesion: 0.12
Nodes (17): NeDB 本地持久化, 依赖共享（junction 目录联接）, 发布状态与阶段标签, 需求任务聚合（多项目×分支×worktree）, 本地持久化提案, 需求任务提案, worktree 管理器提案, README 主文档 (+9 more)

### Community 6 - "服务端依赖栈"
Cohesion: 0.11
Nodes (18): dependencies, koa, koa-bodyparser, @koa/router, koa-static, @seald-io/nedb, worktree-manager, devDependencies (+10 more)

### Community 7 - "工作区文件生成"
Cohesion: 0.17
Nodes (12): .code-workspace 工作区文件生成, buildWorkspaceFileContent(), generateWorkspaceFileForTask(), isExistingDirectory(), sanitizeWorkspaceFileName(), convertRemoteUrlToWebUrl(), generateAndAttachWorkspace(), getJson() (+4 more)

### Community 8 - "Tauri 配置"
Cohesion: 0.11
Nodes (17): app, security, windows, build, frontendDist, bundle, active, externalBin (+9 more)

### Community 9 - "根工程配置"
Cohesion: 0.12
Nodes (16): description, engines, node, name, private, scripts, build:web, build:web:watch (+8 more)

### Community 10 - "前端依赖栈"
Cohesion: 0.13
Nodes (14): dependencies, react, react-dom, worktree-manager, devDependencies, vite, @vitejs/plugin-react, name (+6 more)

### Community 11 - "桌面图标生成"
Cohesion: 0.18
Nodes (11): appIconPngBuffer, assetsDirectory, buildChunk(), buildDirectory, crc32(), createRoundedSquarePng(), desktopDirectory, fs (+3 more)

### Community 12 - "编辑器启动"
Cohesion: 0.57
Nodes (5): buildEditorSpawnCommand(), locateCommandCandidates(), openDirectoryInEditor(), resolveBatchFileTarget(), resolveEditorExecutable()

### Community 13 - "开发脚本"
Cohesion: 0.40
Nodes (4): CHILD_PROCESS_LIST, childProcessList, killChildProcessTree(), shutdownAll()

### Community 14 - "Tauri 主进程"
Cohesion: 0.83
Nodes (3): find_free_port(), main(), wait_server_ready()

## Knowledge Gaps
- **122 isolated node(s):** `path`, `fs`, `net`, `serverEntryPath`, `trayIconPath` (+117 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `README 主文档` connect `持久化与需求概念` to `依赖共享与策略`, `服务端启动与配置`, `桌面端壳与 sidecar`, `工作区文件生成`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._
- **Why does `桌面端（Electron / Tauri）` connect `桌面端壳与 sidecar` to `持久化与需求概念`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Why does `worktree-manager` connect `服务端依赖栈` to `依赖共享与策略`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **What connects `path`, `fs`, `net` to the rest of the system?**
  _122 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `前端 API 与界面` be split into smaller, more focused modules?**
  _Cohesion score 0.0504950495049505 - nodes in this community are weakly interconnected._
- **Should `依赖共享与策略` be split into smaller, more focused modules?**
  _Cohesion score 0.07372346528973035 - nodes in this community are weakly interconnected._
- **Should `服务端启动与配置` be split into smaller, more focused modules?**
  _Cohesion score 0.05547785547785548 - nodes in this community are weakly interconnected._