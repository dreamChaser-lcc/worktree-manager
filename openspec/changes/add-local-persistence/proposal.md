# Proposal

## Why

应用当前唯一的运行状态是内存任务表（`server/src/jobs/job-runner.js` 的 jobMap），服务重启后任务记录全部丢失；主仓库目录由前端组件 useState 持有，页面刷新/应用重启后归零，必须从盘符逐级重新选择才能看到 worktree 列表；worktree 创建行为不留任何历史痕迹。用户要求本工具"记得"历史：重启后可回看任务记录与完整安装日志、一键回到上次的主仓库目录、追溯创建过哪些 worktree。同时数据存放目录需可配置（默认 `D:\softwares\worktree-manager`），且持久化方案不得引入需要 C++ 编译的原生依赖，保持"装上就能跑"。

## What Changes

- 新增纯 JS 嵌入式存储层：@seald-io/nedb 管理记录类数据，安装日志按任务落 JSONL 追加文件；零原生编译、无独立数据库服务
- 持久化三类数据：任务元数据与完整日志、worktree 创建历史（成功与失败均记录）、最近主仓库目录（最近 10 条 + 最后使用项）
- 服务启动时执行崩溃恢复：持久存储中遗留的 running 任务标记为 interrupted
- 新增设置能力：配置文件固定位于用户目录 `%USERPROFILE%\.worktree-manager\settings.json`；数据根目录默认 `D:\softwares\worktree-manager`（D 盘缺失自动回退 `%USERPROFILE%\worktree-manager-data`）；Web 设置页可查看与修改，修改立即生效，不自动迁移历史数据
- Web 前端：主仓库目录自动回填与历史快速切换（现阶段不引入 localStorage，以服务端记录为单一数据源，后续可按需补充）、历史任务列表与日志回看、创建历史展示与手动清空
- 废止 add-worktree-manager/design.md D5"无持久化需求"的结论，由本变更 design 承接

## Capabilities

### New Capabilities

- `local-persistence`: 纯 JS 嵌入式持久化存储——存储引擎约束、数据目录解析与回退、任务记录与日志持久化、崩溃恢复、最近主仓库记忆、配置文件管理

### Modified Capabilities

- `worktree-console`: 新增设置页（数据目录查看/修改）、主仓库自动回填与历史切换、历史任务查看、创建历史展示与清空
- `worktree-lifecycle`: worktree 创建成功/失败后写入持久化创建历史记录

## Impact

- 代码：server 新增 storage 模块（settings / stores / job-log-files），job-runner、worktree-routes、task-routes 接入持久化；web 新增设置页与历史区块，App/WorktreeListPanel/CreateWorktreeForm 接入主仓库回显
- 依赖：server 新增 @seald-io/nedb（纯 JS，无编译步骤）
- 数据：本机新增数据目录（默认 `D:\softwares\worktree-manager`）；被管理仓库零侵入原则不变
- 兼容：升级后首次启动自动初始化空存储，无需数据迁移（原内存数据本就随重启丢失）
