# Tasks

> 桌面端任务清单：Electron 版一期先行（零架构改造），Tauri 版独立并行；两组互不依赖，均不改动现有 server/ 与 web/ 源码。

## 1. Electron 版（desktop-electron/，一期先行）

- [x] 1.1 壳工程初始化：主进程 + 预加载脚本 + electron-builder 打包配置；依赖仅存在于本目录
- [x] 1.2 启动流程：主进程内嵌启动现有 Koa 服务（复用 server 入口）→ 轮询 /api/health 就绪 → 加载 web/dist
- [x] 1.3 端口策略：5210 被占用时自动换端口并在界面提示实际端口
- [x] 1.4 单实例锁：重复启动时激活已有实例窗口
- [x] 1.5 系统托盘：图标 + 菜单（打开主界面 / 退出），服务状态标识
- [x] 1.6 原生通知：依赖安装任务完成/失败时系统通知，点击聚焦应用窗口（跳转指定页签留二期）
- [x] 1.7 关闭行为：最小化到托盘 / 直接退出（托盘菜单可切；设置页持久化留二期）；退出随主进程结束内嵌服务
- [x] 1.8 开机自启（托盘菜单开关，OS 持久化；设置页开关留二期）与窗口记忆（尺寸/位置/最大化）
- [x] 1.9 数据目录：默认使用「程序目录下 data」便携模式（WORKTREE_MANAGER_APP_DATA 注入，config.js 最小兼容点），与浏览器方式共用
- [x] 1.10 打包分发：electron-builder NSIS 安装包（extraResources 携带 server 与 web-dist；图标由 scripts/generate-desktop-icons.js 生成）
- [ ] 1.11 打包产物冒烟：免安装版（win-unpacked）已验证通过；NSIS 安装包的安装/卸载流程待验证

## 2. Tauri 版（desktop-tauri/，独立并行）

- [x] 2.1 设计决策（已定）：Node 服务单文件可执行采用 **bun build --compile**（原生支持 ESM + 顶层 await，单文件产出，Koa/nedb 为纯 JS 兼容风险低）；Node SEA 不支持顶层 await（server.js 使用中）故排除，pkg 已停止维护
- [ ] 2.2 原型验证：sidecar 进程托管 server 可执行文件；SSE 在 Tauri WebView 的兼容性；nedb 在壳内数据目录读写正常
- [ ] 2.2 原型验证：sidecar 进程托管 server 可执行文件；SSE 在 Tauri WebView 的兼容性；nedb 在壳内数据目录读写正常
- [ ] 2.3 壳工程初始化：Tauri 项目（Rust 侧窗口/托盘/通知），与 Electron 版目录隔离
- [ ] 2.4 sidecar 集成：启动/停止服务进程、健康检查等待、端口策略与单实例锁
- [ ] 2.5 系统能力对齐 Electron 版：托盘、原生通知、开机自启、关闭行为、窗口记忆
- [ ] 2.6 打包分发：Tauri bundle 产出 Windows 安装包（含 sidecar 可执行文件），体积对比报告
- [ ] 2.7 冒烟验证同 1.11

## 3. 后续计划（本期不做，另行提案）

- [ ] 3.1 克隆远程仓库 / 拉取新项目：需要应用内 git 远程认证设计（凭据存储、token 管理），依赖此能力前先完成安全设计
- [ ] 3.2 便携版 Git 打包（安装包自带 Git，消除用户安装 Git 的前提），评估体积与许可
- [ ] 3.3 自动更新方案（两版各自评估）

## 4. 验证与交付

- [ ] 4.1 `npm test` 全量通过（server 侧行为不变）；前端 build 通过；lint 无错误
- [ ] 4.2 README 更新：桌面端下载与使用说明、环境前提（Git 需自装）；「支持的系统」同步
- [ ] 4.3 应用内「使用指南」补充桌面端差异（托盘、通知、自启动、环境前提）
