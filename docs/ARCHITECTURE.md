# 架构与技术栈

本文说明项目的整体架构、技术选型、运行时依赖，以及哪些是**必须的**、哪些只是**增强功能**。
安装步骤见 [README](../README.md)，接口清单见 [API-MAP](./API-MAP.md)，桌面端见 [DESKTOP-DEV](./DESKTOP-DEV.md)。

## 目录

- [一、一句话定位](#一句话定位)
- [二、总体架构](#总体架构)
- [三、技术栈](#技术栈)
- [四、目录结构与模块职责](#目录结构与模块职责)
- [五、运行时依赖分级](#运行时依赖分级)
- [六、数据与文件布局](#数据与文件布局)
- [七、端口与环境变量](#端口与环境变量)
- [八、扩展点](#扩展点)
- [九、已知限制](#已知限制)

---

## 一句话定位

一个**纯本地、零后端服务**的 Git worktree 管理工具：一个 Koa 进程同时提供 REST 接口和前端静态页面，数据落在本地 nedb 文件里，所有操作最终都落到 `git` 和本机文件系统上。

没有数据库服务、没有容器、没有云端账号，解压即用。

---

## 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  表现层                                                       │
│  浏览器访问 / Electron 窗口 / Tauri 窗口                       │
│  React 18 + Vite 5 构建产物（web/dist，由 Koa 静态托管）       │
└──────────────────────────┬───────────────────────────────────┘
                           │  HTTP JSON + SSE（/api/*）
┌──────────────────────────▼───────────────────────────────────┐
│  服务层：Koa 2（Node ≥ 18，默认 127.0.0.1:5210）              │
│                                                              │
│  routes/    9 个路由模块：health / filesystem / branch /      │
│             worktree / task / record / settings /            │
│             requirement-task / codebuddy                     │
│                                                              │
│  core/      业务能力：git worktree、依赖链接、工作区文件、      │
│             herdr、CodeBuddy 实例、编辑器启动                  │
│                                                              │
│  storage/   nedb（嵌入式文档库，JSONL 落盘）                   │
│  jobs/      后台任务执行器 + 日志流（SSE 订阅）                │
└──────┬───────────────┬───────────────────┬───────────────────┘
       │               │                   │
   git 命令         文件系统            外部进程（可选）
   worktree 操作    worktree / nedb      herdr / codebuddy / 编辑器
```

**关键特征**

| 特征 | 说明 |
| --- | --- |
| 单进程 | 一个 Node 进程同时承担 API、静态文件、后台任务 |
| 无外部服务 | 不需要 MySQL / Redis / Docker，数据在 `data/nedb/` 的 JSONL 里 |
| 前后端同源 | 前端构建进 `web/dist`，由 Koa 直接托管，无跨域、无独立网关 |
| 外部能力靠进程 | git、包管理器、herdr、CodeBuddy 都是 spawn 出来的子进程 |
| 桌面端是壳 | Electron / Tauri 只负责窗口、托盘、开机自启，业务代码零改动 |

---

## 技术栈

### 服务端

| 项 | 选型 | 版本 | 用途 |
| --- | --- | --- | --- |
| 运行时 | Node.js | ≥ 18（ESM） | 全量使用 `node:` 前缀内置模块 |
| Web 框架 | Koa | ^2.15.3 | 中间件模型，错误统一捕获 |
| 路由 | @koa/router | ^12.0.1 | 9 个模块化路由 |
| 请求体解析 | koa-bodyparser | ^4.4.1 | JSON 请求 |
| 静态托管 | koa-static | ^5.0.0 | 托管 `web/dist` |
| 存储 | @seald-io/nedb | ^4.1.2 | 嵌入式文档库，无需独立数据库 |
| 测试 | vitest | ^2.1.9 | 服务端集成测试 |

### 前端

| 项 | 选型 | 版本 |
| --- | --- | --- |
| 框架 | React | ^18.3.1 |
| 构建 | Vite | ^5.4.11 |
| React 插件 | @vitejs/plugin-react | ^4.3.4 |
| UI 组件库 | **无**（手写 CSS，约 1400 行 `styles.css`） | — |
| 状态管理 | **无**（`useState` + props 传递） | — |

前端刻意不引组件库与状态管理：页面规模有限（21 个组件），全部由 `App.jsx` 用 `useState` 管理，避免额外抽象层。

### 桌面端（二选一，都不影响主流程）

| 方案 | 选型 | 说明 |
| --- | --- | --- |
| Electron | electron ^33 + electron-builder ^25 | 主进程即 Node，`dynamic import` 现有 Koa 服务；额外提供托盘、原生通知、开机自启、单实例锁、窗口记忆 |
| Tauri | @tauri-apps/cli ^2.1 | 用 **Bun** 把后端编译成单文件 sidecar，体积远小于 Electron；需要 Rust 工具链 |

### AI 工具（`ai-tools/`，可选）

| 项 | 选型 | 说明 |
| --- | --- | --- |
| MCP server | @modelcontextprotocol/sdk ^1.20 + zod ^3.23 | stdio 传输，6 个工具 |
| Skill | 纯 markdown + 零依赖 `.mjs` 脚本 | 通过 HTTP 调平台接口 |

### 存储

| 项 | 说明 |
| --- | --- |
| 记录 | nedb，存储为 JSONL 文本，可直接读 |
| 任务日志 | `data/job-logs/` 下的 JSONL 文件，按任务追加 |
| 配置 | `data/nedb/settings.db`（可切换数据目录模式） |

---

## 目录结构与模块职责

```
worktree-manager/
├── server/                  Koa 服务端（ESM）
│   └── src/
│       ├── server.js        启动入口：读配置、监听端口
│       ├── app.js           组装 Koa：9 个路由 + 错误处理 + 静态托管
│       ├── config.js        集中配置（环境变量 + 默认值）
│       ├── routes/          HTTP 层，只做参数校验与调用编排
│       ├── core/            业务能力（无 HTTP 依赖，可单测）
│       ├── storage/         nedb 持久化封装
│       └── jobs/            后台任务执行器（spawn + 日志流）
├── web/                     React + Vite 前端
│   └── src/
│       ├── App.jsx          页签切换与全局状态
│       ├── api/client.js    全部接口封装（39 个函数）
│       ├── components/      21 个组件
│       └── styles.css       全站样式（手写，无 UI 库）
├── ai-tools/                AI 接入（MCP + Skill）
├── desktop-electron/        Electron 壳（main.js 内嵌 Koa 服务）
├── desktop-tauri/           Tauri 壳（Bun 编译 sidecar）
├── scripts/                 dev.js（并行起服务）、图标生成
├── docs/                    本文档、API-MAP、TUTORIAL、DESKTOP-DEV
└── data/                    运行时数据（nedb + job-logs，可通过配置改位置）
```

### `server/src/core/` 模块职责

| 模块 | 职责 |
| --- | --- |
| `git-executor.js` | 统一执行 git 命令，带超时（默认 60s） |
| `worktree-manager.js` | worktree 创建 / 删除 / 清理 / 列表 |
| `dep-linker.js` | 依赖链接：目录符号链接优先、junction 兜底；包管理器检测 |
| `dependency-risk-checker.js` | 共享依赖的版本一致性检查（shared / independent / missing） |
| `workspace-file-generator.js` | 生成 `.code-workspace`（worktree 优先，回退主仓库） |
| `ignore-file-copier.js` | 复制被 gitignore 的 `.env` 与 `.husky` 到新 worktree |
| `editor-opener.js` | 解析并启动编辑器（处理 `.cmd` 包装器与含特殊字符的路径） |
| `explorer-revealer.js` | 资源管理器定位文件/目录 |
| `herdr-opener.js` | herdr 工作区创建 / 聚焦 / 关闭，含终端窗口唤起 |
| `codebuddy-cli-resolver.js` | 定位 CodeBuddy 可执行文件 + 读取本机网关密码 |
| `codebuddy-instance-manager.js` | CodeBuddy 常驻实例（一个实例 = 一个 `--serve` 进程 = 一个固定端口，挂在 taskId 上） |
| `codebuddy-gateway-client.js` | 实例 HTTP API 客户端（`/api/v1/*`，需 `X-CodeBuddy-Request: 1` + Bearer 认证） |
| `codebuddy-terminal-opener.js` | 新终端窗口启动 CodeBuddy TUI（`--resume` 续接对话 / 全新会话） |
| `validators.js` / `errors.js` | 参数校验（含同卷校验）、统一错误类型 |

### `server/src/routes/` 路由模块

| 模块 | 承担的接口域 |
| --- | --- |
| `health-routes.js` | 探活 |
| `filesystem-routes.js` | 盘符/目录浏览、仓库校验、资源管理器定位、herdr 打开/关闭 |
| `branch-routes.js` | 分支概览、默认基线 |
| `worktree-routes.js` | worktree 创建/列表/删除/清理、编辑器打开 |
| `task-routes.js` | 后台任务查询、日志 SSE |
| `record-routes.js` | 创建历史、最近仓库 |
| `settings-routes.js` | 设置读写、编辑器列表 |
| `requirement-task-routes.js` | 需求任务的增删改查、定位、依赖、发布、恢复、工作区生成 |
| `codebuddy-routes.js` | CodeBuddy 实例启停、对话派发、会话续接 |

---

## 运行时依赖分级

> 「本机验证版本」为 2026-11-12 在 **Windows 11 专业版 10.0.26200** 上的实测结果，标注为「已跑通」的组合即该项目当前的实际验证状态。

### 必须（缺了完全跑不起来）

| 依赖 | 用途 | 缺失后果 | 本机验证版本 |
| --- | --- | --- | --- |
| **Node.js ≥ 18** | 服务端与前端构建的运行时 | 无法启动；ESM 与 `fetch` 都依赖 18+ | **v20.19.0** ✅ |
| **Git** | 全部 worktree 操作 | 核心功能不可用（创建/删除/分支全部失效） | **2.46.0.windows.1** ✅ |
| **npm** | 安装 `server/` 与 `web/` 依赖 | 无法初始化项目 | **10.8.2** ✅ |

### 功能依赖（缺了只是对应功能不可用）

| 依赖 | 影响的功能 | 缺失时的表现 | 本机验证版本 |
| --- | --- | --- | --- |
| **包管理器**（npm / pnpm / yarn） | worktree 内独立安装依赖 | 该 worktree 无法自动安装，只能手动装 | npm 10.8.2 / pnpm 10.28.1 / yarn 1.22.22 ✅ |
| **已安装依赖的主仓库** | 共享主目录依赖 | 建链前会校验并报错「主仓库尚未安装依赖」 | 已跑通（pnpm 结构与 npm 结构仓库均验证） |
| **编辑器命令**（默认 `code`） | 「打开工作区 / 打开目录」按钮 | 按钮报错，但仍可用资源管理器手动打开 | VS Code **1.133.0** ✅ |
| **herdr** | herdr 终端工作区（打开/关闭/新建） | 该功能报「未找到 herdr 可执行文件」 | **0.9.5** ✅（非 PATH 安装，靠 `~/.herdr/packages/standalone/releases/` 探测） |
| **CodeBuddy CLI** | CodeBuddy 实例、对话派发、会话续接 | 相关页签不可用 | **2.183.0** ✅（`codebuddy` 走 pnpm 全局，另有 `buddycn` 包装脚本） |
| **Windows Terminal**（`wt.exe`） | 更完整的终端体验 | 会回退到 `cmd` 窗口，功能一致 | **1.24.12741.0** ✅ |

> herdr 与 CodeBuddy 都采用**运行时探测**（配置项 → PATH → 自管安装目录），没装不会影响启动，只在该功能被触发时报错。

### 仅打包 / 开发时需要

| 依赖 | 用途 | 本机验证版本 |
| --- | --- | --- |
| **Vite 5** | 前端构建（`npm run build:web`）；运行期不需要 | 5.4.x（随 `web/package.json` 安装）✅ |
| **Electron 33 + electron-builder 25** | 打 Electron 桌面版 | 随 `desktop-electron/package.json` 安装，构建已验证 |
| **Rust 工具链 + @tauri-apps/cli 2** | 打 Tauri 桌面版 | **本机未安装 Rust（cargo 不在 PATH）**，仅完成过 Bun 侧 sidecar 编译 |
| **Bun** | Tauri 方案用它把后端编译成单文件 sidecar | **1.4.4** ✅ |
| **vitest 2** | 跑服务端测试 | 2.1.9 ✅ |

### 操作系统

| 平台 | 支持程度 | 本机状态 |
| --- | --- | --- |
| **Windows 10 / 11** | 目标平台，完整支持：`start.bat`、盘符枚举、目录链接、路径转义均已按 Windows 处理 | **Windows 11 专业版 10.0.26200** ✅ 全流程验证 |
| macOS / Linux | 核心 git 流程理论上可跑，但启动脚本、默认路径、目录链接行为均未验证，不作为支持目标 | 未验证 |

---

## 数据与文件布局

### 程序内部

```
worktree-manager/
├── data/                    默认数据目录（可由设置改为自定义路径）
│   ├── nedb/                *.db —— JSONL 文本，可直接打开查看
│   └── job-logs/            <jobId>.jsonl —— 后台任务日志
├── web/dist/                前端构建产物（Koa 静态托管，缺失时页面打不开）
└── server/node_modules/     服务端依赖
```

### 外部产物（工具操作的对象）

```
<主仓库>                      git 仓库，如 D:\project\userlive
└── .git/

<工作区根目录>               设置项，默认 D:\project\wroktree-manager\workspaces
└── <需求名称>/
    ├── <项目A>/              git worktree（独立分支）
    ├── <项目B>/
    └── <分支名>.code-workspace   工作区文件，folders 指向上面各目录
```

**依赖链接**：共享策略下，`<项目>/node_modules` 是指向主仓库 `node_modules` 的目录链接（符号链接优先，junction 兜底）；独立安装则是真实目录。

---

## 端口与环境变量

### 端口

| 端口 | 用途 | 可改 |
| --- | --- | --- |
| 5210 | Koa 服务（API + 前端） | `WORKTREE_MANAGER_PORT` |
| 动态端口 | CodeBuddy 实例（每个实例一个固定端口） | 由实例管理器分配 |

### 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `WORKTREE_MANAGER_HOST` | `127.0.0.1` | 监听地址；`start.bat` 设为 `0.0.0.0` 以允许局域网访问 |
| `WORKTREE_MANAGER_PORT` | `5210` | 服务端口 |
| `WORKTREE_MANAGER_WEB_DIST` | `<根>/web/dist` | 前端产物目录（桌面壳打包后路径会变） |
| `WORKTREE_MANAGER_APP_DATA` | `<根>/data` | 数据目录（桌面壳注入可写位置） |
| `WORKTREE_MANAGER_API` | `http://127.0.0.1:5210` | **仅 ai-tools 使用**，MCP server 找平台的地址 |

> 桌面壳（Electron/Tauri）会注入 `WEB_DIST` 与 `APP_DATA`，因为打包后 `import.meta.url` 相对推算会失效。

---

## 扩展点

| 想加的东西 | 改动位置 |
| --- | --- |
| 新接口 | `server/src/routes/` 加模块 → `app.js` 注册 → `web/src/api/client.js` 加封装 → 同步 `docs/API-MAP.md` |
| 新业务能力 | `server/src/core/` 加模块（保持无 HTTP 依赖，便于单测） |
| 新页面/页签 | `web/src/App.jsx` 的 `APP_TAB_LIST` + 对应 Panel 组件 |
| 新 AI 工具 | `ai-tools/mcp-server/index.js` 加 `mcpServer.tool(...)`；同步 `ai-tools/skill/worktree-manager/references/api-endpoints.md` |
| 新桌面端能力 | `desktop-electron/main.js`（托盘/通知/开机自启等） |

---

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 目录链接依赖系统权限 | 部分 Windows 版本/安全更新后，普通权限进程无法遍历目录链接（`ERROR_UNTRUSTED_MOUNT_POINT`），此时共享依赖不可用，需改用独立安装 |
| 共享依赖版本受主仓库控制 | 在共享模式的 worktree 里执行 install 会写穿链接、改写主仓库依赖 |
| 单进程无鉴权 | 默认只监听回环；改成 `0.0.0.0` 后目录浏览与命令执行能力对内网暴露，需自行评估 |
| 前端无组件库 | 样式全部手写，新增复杂交互需自己实现；好处是无额外依赖、体积小 |
| macOS / Linux 未验证 | 启动脚本与路径处理按 Windows 编写 |
