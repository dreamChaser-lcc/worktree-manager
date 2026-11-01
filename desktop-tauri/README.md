# Worktree 管理器桌面端（Tauri 版）

与 `desktop-electron/` 相互隔离：Tauri 壳 + **sidecar 运行单文件 Node 服务**（bun 编译产物），目标是更小的安装包。现有 `server/` 与 `web/` 零改造。

## 环境前提（构建机）

- Node.js ≥ 18 与 pnpm/npm（现有工程）
- **Bun**（编译 server 单文件）：`powershell -c "irm bun.sh/install.ps1 | iex"`
- **Rust 工具链**：rustup + MSVC Build Tools（`winget install Rustlang.Rustup` 后按提示装 VS Build Tools）
- WebView2 Runtime（Win10/11 一般自带）
- 运行目标机：仍需已安装 Git（与 Electron 版一致）

## 构建步骤

```bash
cd desktop-tauri
npm install                 # 安装 @tauri-apps/cli
npm run icon                # （重新）生成 src-tauri/icons/icon.ico
npm run compile:server      # bun 编译 server → src-tauri/binaries/server-x86_64-pc-windows-msvc.exe
npm run dev                 # 开发模式（编译 cargo + 启动 sidecar + 打开窗口）
npm run build               # 产出 NSIS 安装包（src-tauri/target/release/bundle/nsis/）
```

## 运行时行为（与 Electron 版对齐）

- sidecar 启动现有 Koa 服务：端口 5210 被占用自动换随机端口；健康等待后窗口加载页面
- 便携数据目录：资源目录下 `data/`（`WORKTREE_MANAGER_APP_DATA` 注入）
- 单实例：tauri-plugin-single-instance，重复启动聚焦已有窗口
- 注意：两个桌面版或桌面版 + 浏览器服务**不要同时运行**（nedb 无跨进程锁）

## 已知限制（待验证项见 openspec 任务 2.2）

- SSE 日志流在 Tauri WebView（WebView2）的兼容性需冒烟确认
- sidecar exe 由 bun 编译，`@seald-io/nedb` 在 bun 运行时的行为需验证
- 托盘、通知、开机自启为二期补齐（当前版本仅窗口 + sidecar）
