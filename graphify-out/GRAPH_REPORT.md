# Graph Report - worktree-manager  (2026-11-05)

## Corpus Check
- 105 files · ~48,309 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 749 nodes · 1187 edges · 61 communities (40 shown, 21 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2f0d2099`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

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
- [[_COMMUNITY_Worktree 管理器|Worktree 管理器]]
- [[_COMMUNITY_Requirement 从主仓库创建 worktree|Requirement: 从主仓库创建 worktree]]
- [[_COMMUNITY_ADDED Requirements|ADDED Requirements]]
- [[_COMMUNITY_ADDED Requirements|ADDED Requirements]]
- [[_COMMUNITY_ADDED Requirements|ADDED Requirements]]
- [[_COMMUNITY_ADDED Requirements|ADDED Requirements]]
- [[_COMMUNITY_Decisions|Decisions]]
- [[_COMMUNITY_Decisions|Decisions]]
- [[_COMMUNITY_ADDED Requirements|ADDED Requirements]]
- [[_COMMUNITY_package.json|package.json]]
- [[_COMMUNITY_Proposal|Proposal]]
- [[_COMMUNITY_Tasks|Tasks]]
- [[_COMMUNITY_Proposal|Proposal]]
- [[_COMMUNITY_Proposal|Proposal]]
- [[_COMMUNITY_Proposal|Proposal]]
- [[_COMMUNITY_Proposal|Proposal]]
- [[_COMMUNITY_Tasks|Tasks]]
- [[_COMMUNITY_Worktree 管理器桌面端（Tauri 版）|Worktree 管理器桌面端（Tauri 版）]]
- [[_COMMUNITY_Tasks|Tasks]]
- [[_COMMUNITY_Spec Delta|Spec Delta]]
- [[_COMMUNITY_Tasks|Tasks]]
- [[_COMMUNITY_Tasks|Tasks]]
- [[_COMMUNITY_查代码优先使用 graphify 知识图谱|查代码优先使用 graphify 知识图谱]]
- [[_COMMUNITY_HelpGuideDialog.jsx|HelpGuideDialog.jsx]]
- [[_COMMUNITY_依赖共享（junction 目录联接）|依赖共享（junction 目录联接）]]
- [[_COMMUNITY_桌面端（Electron  Tauri）|桌面端（Electron / Tauri）]]
- [[_COMMUNITY_依赖独立安装与恢复共享|依赖独立安装与恢复共享]]
- [[_COMMUNITY_发布状态与阶段标签|发布状态与阶段标签]]
- [[_COMMUNITY_需求任务聚合（多项目×分支×worktree）|需求任务聚合（多项目×分支×worktree）]]
- [[_COMMUNITY_Tauri sidecar 单文件服务|Tauri sidecar 单文件服务]]
- [[_COMMUNITY_.code-workspace 工作区文件生成|.code-workspace 工作区文件生成]]
- [[_COMMUNITY_git worktree 并行开发目录|git worktree 并行开发目录]]
- [[_COMMUNITY_桌面端环境搭建文档|桌面端环境搭建文档]]
- [[_COMMUNITY_桌面应用端提案|桌面应用端提案]]
- [[_COMMUNITY_数据导入导出提案|数据导入导出提案]]
- [[_COMMUNITY_本地持久化提案|本地持久化提案]]
- [[_COMMUNITY_需求任务提案|需求任务提案]]
- [[_COMMUNITY_worktree 管理器提案|worktree 管理器提案]]
- [[_COMMUNITY_README 主文档|README 主文档]]
- [[_COMMUNITY_Tauri 桌面端说明|Tauri 桌面端说明]]
- [[_COMMUNITY_图文使用教程|图文使用教程]]
- [[_COMMUNITY_HelpGuideDialog.jsx|HelpGuideDialog.jsx]]

## God Nodes (most connected - your core abstractions)
1. `executeGitCommand()` - 27 edges
2. `getJson()` - 18 edges
3. `createWorktree()` - 17 edges
4. `removeWorktree()` - 16 edges
5. `ValidationError` - 15 edges
6. `createApp()` - 14 edges
7. `postJson()` - 14 edges
8. `createFixtureRepository()` - 13 edges
9. `Worktree 管理器` - 13 edges
10. `listWorktrees()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `executeCreationFlow()` --calls--> `openDirectoryInEditor()`  [EXTRACTED]
  server/src/routes/worktree-routes.js → server/src/core/editor-opener.js
- `readProjectRemoteUrl()` --calls--> `executeGitCommand()`  [EXTRACTED]
  server/src/routes/requirement-task-routes.js → server/src/core/git-executor.js
- `copyIgnoredSafely()` --calls--> `copyIgnoredFiles()`  [EXTRACTED]
  server/src/routes/requirement-task-routes.js → server/src/core/ignore-file-copier.js
- `executeCreationFlow()` --calls--> `copyIgnoredFiles()`  [EXTRACTED]
  server/src/routes/worktree-routes.js → server/src/core/ignore-file-copier.js
- `generateAndAttachWorkspace()` --calls--> `generateWorkspaceFileForTask()`  [EXTRACTED]
  server/src/routes/requirement-task-routes.js → server/src/core/workspace-file-generator.js

## Import Cycles
- None detected.

## Communities (61 total, 21 thin omitted)

### Community 0 - "前端 API 与界面"
Cohesion: 0.05
Nodes (70): clearWorktreeHistory(), createRequirementTask(), createWorktree(), deleteRequest(), deleteRequirementTask(), deleteTaskRecord(), fetchBranchOverview(), fetchDefaultBaseRef() (+62 more)

### Community 1 - "依赖共享与策略"
Cohesion: 0.07
Nodes (55): applySharedDependencyLink(), detectPackageManager(), LOCK_FILE_DETECTION_RULES, recommendDependencyStrategy(), startIndependentInstall(), checkWorktreeDependencyStatus(), diffDependencyMaps(), readPackageDependencies() (+47 more)

### Community 2 - "服务端启动与配置"
Cohesion: 0.05
Nodes (43): createApp(), AppError, appendJobLog(), createJob(), findRunningJob(), finishJob(), getJob(), jobMap (+35 more)

### Community 3 - "桌面端壳与 sidecar"
Cohesion: 0.17
Nodes (14): { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain }, createMainWindow(), createTray(), fs, net, path, probeFreePort(), readWindowState() (+6 more)

### Community 4 - "Electron 打包配置"
Cohesion: 0.07
Nodes (28): build, appId, directories, extraResources, files, nsis, productName, win (+20 more)

### Community 6 - "服务端依赖栈"
Cohesion: 0.11
Nodes (18): dependencies, koa, koa-bodyparser, @koa/router, koa-static, @seald-io/nedb, worktree-manager, devDependencies (+10 more)

### Community 7 - "工作区文件生成"
Cohesion: 0.17
Nodes (12): buildExcludedProjectReason(), buildWorkspaceFileContent(), generateWorkspaceFileForTask(), isExistingDirectory(), sanitizeWorkspaceFileName(), convertRemoteUrlToWebUrl(), generateAndAttachWorkspace(), getJson() (+4 more)

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
Cohesion: 0.17
Nodes (14): currentFileDir, serverConfig, buildEditorSpawnCommand(), locateCommandCandidates(), openDirectoryInEditor(), resolveBatchFileTarget(), resolveEditorExecutable(), compileSingleLevelWildcard() (+6 more)

### Community 13 - "开发脚本"
Cohesion: 0.40
Nodes (4): CHILD_PROCESS_LIST, childProcessList, killChildProcessTree(), shutdownAll()

### Community 14 - "Tauri 主进程"
Cohesion: 0.83
Nodes (3): find_free_port(), main(), wait_server_ready()

### Community 19 - "Worktree 管理器"
Cohesion: 0.07
Nodes (25): MSVC C++ 生成工具（注意：只能装 C 盘，无法选路径）, Rust 安装（关键：先设环境变量再安装，才能落到 D 盘）, Tauri 项目运行与构建, 卸载方法（本次执行过，留档备查）, 结论速览, ① 任务列表, ② 新建需求任务, ③ 粘贴自动解析 (+17 more)

### Community 20 - "Requirement: 从主仓库创建 worktree"
Cohesion: 0.07
Nodes (26): ADDED Requirements, Purpose, Requirement: 从主仓库创建 worktree, Requirement: 列出仓库的全部 worktree, Requirement: 删除 worktree 带安全拦截, Requirement: 删除时可一并清理磁盘目录, Requirement: 清理失效的 worktree 记录, Scenario: 主 worktree 不可删除 (+18 more)

### Community 21 - "ADDED Requirements"
Cohesion: 0.09
Nodes (21): ADDED Requirements, Purpose, Requirement: 任务记录持久化, Requirement: 创建历史记录, Requirement: 崩溃任务状态恢复, Requirement: 数据目录解析与回退, Requirement: 最近主仓库记忆, Requirement: 纯 JS 嵌入式存储 (+13 more)

### Community 22 - "ADDED Requirements"
Cohesion: 0.10
Nodes (19): ADDED Requirements, Purpose, Requirement: 分支选择与占用标注, Requirement: 创建后可选动作, Requirement: 服务仅监听本机回环地址, Requirement: 目录浏览选择, Requirement: 长任务日志流, Scenario: 任务失败可见 (+11 more)

### Community 23 - "ADDED Requirements"
Cohesion: 0.12
Nodes (16): ADDED Requirements, Purpose, Requirement: 关联 worktree 选择与自动预选, Requirement: 创建 worktree 挂载需求任务, Requirement: 需求任务查看与打开, Requirement: 需求任务维护, Scenario: 两步确认删除, Scenario: 主仓库不匹配如实反馈 (+8 more)

### Community 24 - "ADDED Requirements"
Cohesion: 0.12
Nodes (16): ADDED Requirements, Purpose, Requirement: junction 共享主目录依赖, Requirement: 不处理依赖, Requirement: 按包管理器自动推荐依赖策略, Requirement: 独立安装依赖, Scenario: npm 项目推荐 junction 共享, Scenario: pnpm 项目推荐独立安装 (+8 more)

### Community 25 - "Decisions"
Cohesion: 0.12
Nodes (15): Context, D1. 存储引擎：@seald-io/nedb（记录）+ JSONL 文件（日志）, D2. 数据布局与默认目录, D3. 配置生效语义：立即重建存储实例，不迁移历史数据, D4. 任务持久化边界, D5. 崩溃恢复：启动扫描, D6. 最近主仓库：LRU-10 + 最后使用项, D7. 创建历史：成功失败均记 + 手动清空 (+7 more)

### Community 26 - "Decisions"
Cohesion: 0.12
Nodes (15): Context, D1. 架构：本地自起服务（方案 A），core 执行器独立成层, D2. 后端框架：Koa 2.x + @koa/router + koa-static, D3. 目录链接：优先 junction（`fs.symlink(..., 'junction')`）, D4. 依赖策略矩阵：lockfile 检测给默认，用户可覆盖, D5. 长任务：内存任务表 + SSE 日志流, D6. git 交互：child_process.spawn + porcelain 输出解析, D7. 忽略文件复制：白名单制 (+7 more)

### Community 27 - "ADDED Requirements"
Cohesion: 0.13
Nodes (14): ADDED Requirements, Purpose, Requirement: 主仓库自动回填与历史切换, Requirement: 创建历史展示与清空, Requirement: 历史任务查看, Requirement: 设置页, Scenario: 修改为不可创建的路径, Scenario: 修改成功 (+6 more)

### Community 28 - "package.json"
Cohesion: 0.15
Nodes (12): description, devDependencies, @tauri-apps/cli, name, private, scripts, build, compile:server (+4 more)

### Community 29 - "Proposal"
Cohesion: 0.22
Nodes (8): Capabilities, Impact, Modified Capabilities, New Capabilities, Proposal, What Changes, Why, 明确搁置（后续计划）

### Community 30 - "Tasks"
Cohesion: 0.22
Nodes (8): 1. 项目脚手架, 2. core 执行器（与 HTTP 层解耦）, 3. REST API 层（server/routes）, 4. Web 前端（React）, 5. 交付, 6. 删除时的目录清理回退（用户验收反馈）, Tasks, Workflow follow-up

### Community 31 - "Proposal"
Cohesion: 0.25
Nodes (7): Capabilities, Impact, Modified Capabilities, New Capabilities, Proposal, What Changes, Why

### Community 32 - "Proposal"
Cohesion: 0.25
Nodes (7): Capabilities, Impact, Modified Capabilities, New Capabilities, Proposal, What Changes, Why

### Community 33 - "Proposal"
Cohesion: 0.25
Nodes (7): Capabilities, Impact, Modified Capabilities, New Capabilities, Proposal, What Changes, Why

### Community 34 - "Proposal"
Cohesion: 0.25
Nodes (7): Capabilities, Impact, Modified Capabilities, New Capabilities, Proposal, What Changes, Why

### Community 35 - "Tasks"
Cohesion: 0.29
Nodes (6): 1. 存储层（server/src/storage）, 2. 任务持久化接入, 3. 记录接入业务, 4. Web 前端, 5. 交付, Tasks

### Community 36 - "Worktree 管理器桌面端（Tauri 版）"
Cohesion: 0.33
Nodes (5): Worktree 管理器桌面端（Tauri 版）, 已知限制（待验证项见 openspec 任务 2.2）, 构建步骤, 环境前提（构建机）, 运行时行为（与 Electron 版对齐）

### Community 37 - "Tasks"
Cohesion: 0.33
Nodes (5): 1. Electron 版（desktop-electron/，一期先行）, 2. Tauri 版（desktop-tauri/，独立并行）, 3. 后续计划（本期不做，另行提案）, 4. 验证与交付, Tasks

### Community 38 - "Spec Delta"
Cohesion: 0.33
Nodes (5): ADDED Requirements, Purpose, Requirement: 创建动作留痕, Scenario: 记录失败不阻断创建, Spec Delta

### Community 39 - "Tasks"
Cohesion: 0.40
Nodes (4): 1. 服务端, 2. Web 前端, 3. 验证与交付, Tasks

### Community 40 - "Tasks"
Cohesion: 0.40
Nodes (4): 1. 服务端, 2. Web 前端, 3. 验证与交付, Tasks

### Community 41 - "查代码优先使用 graphify 知识图谱"
Cohesion: 0.50
Nodes (3): 图谱速览（God Nodes）, 查代码优先使用 graphify 知识图谱, 规则

### Community 42 - "HelpGuideDialog.jsx"
Cohesion: 0.17
Nodes (11): worktree（server/src/routes/worktree-routes.js）, 分支（server/src/routes/branch-routes.js）, 前后端接口映射表, 变更影响面速查, 后台任务（server/src/routes/task-routes.js）, 探活（server/src/routes/health-routes.js）, 文件系统（server/src/routes/filesystem-routes.js）, 记录类（server/src/routes/record-routes.js） (+3 more)

## Knowledge Gaps
- **324 isolated node(s):** `{ app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain }`, `path`, `fs`, `net`, `serverEntryPath` (+319 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **21 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `worktree-manager` connect `服务端依赖栈` to `依赖共享与策略`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **Why does `worktree-manager` connect `前端依赖栈` to `依赖共享与策略`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `{ app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain }`, `path`, `fs` to the rest of the system?**
  _324 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `前端 API 与界面` be split into smaller, more focused modules?**
  _Cohesion score 0.050693069306930696 - nodes in this community are weakly interconnected._
- **Should `依赖共享与策略` be split into smaller, more focused modules?**
  _Cohesion score 0.07343660355708548 - nodes in this community are weakly interconnected._
- **Should `服务端启动与配置` be split into smaller, more focused modules?**
  _Cohesion score 0.054987212276214836 - nodes in this community are weakly interconnected._
- **Should `Electron 打包配置` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._