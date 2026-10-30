# Design

## Context

全新项目，当前工作区为空目录，无历史包袱。需求动机见 proposal.md。已确认的约束：

- 方案 A：本地自起服务，后端 Node.js，机器仅需 Node ≥ 18 与 Git
- 前端 React，后端 Koa
- Windows 优先，后续可能扩展到 macOS/Linux
- 包管理器混合使用（npm / yarn / pnpm 都有），策略由用户在界面确认
- 第一期即要求全生命周期（创建 + 列表 + 删除拦截 + prune + 复制 .env + 打开编辑器）

## Goals / Non-Goals

**Goals:**

- core 执行器与 HTTP 层彻底解耦，为将来 Electron 桌面端 / 中心平台 Agent 演进留出复用路径
- 创建一条 worktree 的常规路径（含 junction 共享）控制在秒级完成
- 所有 git 与文件系统操作可预期：前置校验先行，失败给出可读原因，绝不半途留下脏状态

**Non-Goals:**

- 不做中心化平台、多机器管理与认证体系（方案 B 的范畴）
- 不做依赖版本漂移的自动同步（共享 node_modules 的版本以主目录为准，靠界面提示约束用户行为）
- 不支持 monorepo workspace 内部子包级别的依赖共享（第一期只处理仓库根 node_modules）
- 不做 git 仓库的克隆/拉取等仓库管理功能

## Decisions

### D1. 架构：本地自起服务（方案 A），core 执行器独立成层

```
web/ (React + Vite)  ──HTTP/SSE──▶  server/ (Koa: routes + job-runner)
                                        │ 调用
                                        ▼
                                   core/ (纯逻辑执行器，不依赖 HTTP)
                                     worktree-manager / dep-linker /
                                     ignore-file-copier / validators
```

理由：本工具全部价值发生在开发者本机文件系统，中心化平台 80% 复杂度（认证、通信、保活）不贡献核心价值。core 与传输层解耦后，Electron 主进程或未来 Agent 可直接复用 core。
备选：中心平台 + 本地 Agent（方案 B）——被否，见 Non-Goals；纯 CLI——被否，用户明确要 Web 界面。

### D2. 后端框架：Koa 2.x + @koa/router + koa-static

理由：本工具后端是"执行命令 → 读结果"的异步链，Koa 原生 async/await 洋葱模型最干净；核心只做 HTTP，体量极简；SSE 直接 `ctx.body = stream` 即可。Express 生态优势（海量中间件）在本场景用不上，Fastify 的性能优势对单机单用户无意义。

### D3. 目录链接：优先 junction（`fs.symlink(..., 'junction')`）

Windows 上 symlink 需要管理员或开发者模式，junction 不需要且 Node 原生支持。类 Unix 平台预留 symlink 实现，按 `process.platform` 分发（第一期只实现 Windows 分支，接口先留好）。
备选：统一 symlink——被否，Windows 权限门槛；仅支持 pnpm——被否，用户混合使用包管理器。

### D4. 依赖策略矩阵：lockfile 检测给默认，用户可覆盖

| lockfile | 默认推荐 | 理由 |
|---|---|---|
| pnpm-lock.yaml | 独立安装（pnpm store 硬链接） | 近似零额外磁盘且各 worktree 隔离，无共享污染 |
| package-lock.json / yarn.lock | junction 共享主目录 | 0 磁盘秒级，是 npm/yarn 生态下唯一省盘法 |
| 无 lockfile | 无默认，提示手选 | 主目录可能没装过依赖，链接无意义 |

共享模式的固有约束（分支间依赖版本以主目录为准、不要在 worktree 里执行 install）通过界面提示文案告知，不做运行时强拦截。

### D5. 长任务：内存任务表 + SSE 日志流

独立安装是唯一的分钟级操作。任务执行器（server/job-runner）维护内存任务 Map（任务 id → 状态/日志缓冲），SSE 端点按 id 推送增量输出。无持久化需求——服务重启后任务记录即失效，安装本身可重跑。
备选：WebSocket——被否，单向日志推送 SSE 足够且实现更简单；落盘日志文件——被否，第一期无此诉求。

### D6. git 交互：child_process.spawn + porcelain 输出解析

所有 git 调用统一走 `git -C <repo> ...`，解析 `--porcelain`（`worktree list --porcelain`、`status --porcelain`、`branch --format`）等机器可读输出，不解析人类可读格式。分支占用检测基于 `worktree list --porcelain` 的 branch 字段比对。

### D7. 忽略文件复制：白名单制

默认白名单 `.env`、`.env.local`、`*.local`，允许用户在配置中增删。不自动搬运所有 gitignore 文件——构建产物等忽略文件既大又无用，白名单把风险面收住。

### D8. 创建流程的失败原子性

创建顺序固定为：校验 → `git worktree add` → 依赖处理 → 后置动作。git worktree add 是原子边界：它失败则直接返回错误，不产生任何后续动作；它成功后依赖/后置动作失败不回滚 worktree（保留现场），仅向用户报告哪一步失败及补救方式。避免实现复杂的事务回滚。

## Risks / Trade-offs

- [git 原生 worktree remove 在 Windows 上会跟随 junction 删除目标内容（实测 2.46），破坏共享主目录依赖；碰到被占用文件时报 Directory not empty 且目录残留] → 删除默认不走 git 递归删除：先 junction 感知删除目录（只断链不删目标），再 prune 清记录；仅当用户显式关闭"一并清理目录"时才使用 git 原生行为
- [共享 node_modules 被分支间依赖版本差异污染] → 创建成功页与依赖区固定展示约束说明；列表页提供"去主目录安装"引导
- [用户在 worktree 里误执行 install 写穿 junction 改了主目录] → 文档与界面提示；长期可探测 lockfile 变更时告警（暂不实现）
- [pnpm 项目根 node_modules 内部含大量链接，junction 整体共享后解析路径变化] → pnpm 项目默认走独立安装策略（D4），从推荐层面规避
- [目标盘与主仓库不同卷时 junction 无效] → 创建前校验同卷（已入 dependency-sharing 规格）
- [工具具备本机任意路径读写能力] → 服务仅监听 127.0.0.1；所有路径参数做存在性与合法性校验；不做 open redirect 类代理
- [Node 将模块解析到真实路径，个别依赖 `__dirname` 行为异常] → 已知取舍，共享模式提示文案中说明；出现问题的项目可改用独立安装

## Migration Plan

全新项目，无迁移。交付形态：仓库根 `node server.js` 启动（或提供 `start.bat`），浏览器打开 `http://localhost:5210`。回滚 = 停止进程，工具对被管理仓库只留下标准 worktree 结构，可用原生 git 命令接管。

## Open Questions

无 —— 技术栈、架构方案、依赖策略均已在前置探讨中拍板。
