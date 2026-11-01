# Proposal

## Why

当前使用方式是「双击 start.bat → 浏览器打开 127.0.0.1:5210」，需要保留命令行窗口与浏览器标签页。桌面化后：桌面图标双击即用、托盘常驻、任务完成原生通知、可选开机自启。

拓展基础已具备：`server/src/core/` 与 HTTP 解耦、前端为纯静态产物（`web/dist`）、数据目录支持便携模式（程序目录下 `data/`）——桌面版天然适配。

## What Changes

**双版本并行，相互隔离，均不改造现有 server/ 与 web/ 源码：**

- **Electron 版（一期先行）**：主进程即 Node，内嵌现有 Koa 服务并加载 `web/dist`，零架构改造；独立目录 `desktop-electron/`
- **Tauri 版（独立并行）**：Tauri 壳 + 以 sidecar 方式运行打包为单文件可执行的 Node 服务；独立目录 `desktop-tauri/`，与 Electron 版互不冲突
- 系统能力（两版对齐）：托盘（服务状态/打开/退出）、任务完成原生通知、开机自启（默认关闭）、关闭行为可选、窗口记忆
- 端口策略：5210 被占用时自动换端口并提示
- 单实例：同一时刻仅一个应用实例（托盘激活已有实例），规避 nedb 无跨进程锁风险
- 环境前提（一期）：**要求用户已安装 Git**（README 与应用内使用教程均已注明环境要求）；便携版 Git 打包列为二期选项

### 明确搁置（后续计划）

- **克隆远程仓库 / 拉取新项目**：该能力需要 git 远程认证（应用内「登录 git」），涉及凭据管理设计，本期不做，作为桌面版后续能力另行提案

## Capabilities

### New Capabilities

- `desktop-app-electron`: Electron 桌面壳——窗口与托盘生命周期、内嵌服务承载、端口冲突处理、原生通知、开机自启、Windows 打包
- `desktop-app-tauri`: Tauri 桌面壳——sidecar 方式运行单文件 Node 服务、系统托盘、原生通知、小体积打包

### Modified Capabilities

- `worktree-console`: 设置页新增桌面相关开关（开机自启、关闭行为）；浏览器访问模式保留为并行使用方式，两者共用数据目录

## Impact

- 代码：新增 `desktop-electron/` 与 `desktop-tauri/` 两个相互隔离的壳目录；`server/` 与 `web/` 保持可独立运行（`npm start` + 浏览器访问不废除）；settings 新增桌面偏好字段
- 依赖：桌面壳框架依赖仅存在于各自壳目录，不进入 server 运行时依赖
- Tauri 版关键前提：Node 服务需编译为独立可执行文件（sidecar），选型（bun compile / Node SEA 等）在 Tauri 版设计阶段定夺；SSE 在 Tauri WebView 的兼容性需原型验证
- 风险：nedb 无跨进程锁 → 桌面端必须单实例；两版与浏览器模式并行使用时共用数据目录（便携模式），不应同时运行多个服务实例
