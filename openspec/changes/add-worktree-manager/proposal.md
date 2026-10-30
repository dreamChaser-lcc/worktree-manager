# Proposal

## Why

同一 git 项目需要并行开发多个需求时，目前只能整仓 clone 多份：磁盘占用翻倍、依赖重复下载耗时。直接手敲 `git worktree` 虽然能共享 `.git` 对象库，但命令记忆成本高、坑多（分支被占用、`.env` 等忽略文件不跟随、新目录要重新装依赖）。需要把 worktree 的创建与全生命周期管理做成一个本地可视化工具，并解决依赖共享问题，让"多目录并行开发"做到秒级创建、零依赖下载。

## What Changes

- 全新搭建一个本地 Web 工具（方案 A：Node + Koa 自起服务托管 React 前端，仅监听 127.0.0.1，机器只需装 Node ≥ 18 与 Git）
- worktree 全生命周期管理：创建（五道前置校验）、列表（路径/分支/脏状态）、删除（三道安全拦截）、prune 清理
- 依赖共享能力：三种策略（junction 共享主目录 node_modules / 独立安装走各自缓存 / 不处理），按 lockfile 自动检测推荐默认项，用户可手动覆盖
- 创建后可选动作：复制被忽略文件（.env 等）、打开编辑器
- 长任务（独立安装依赖）采用异步任务 + SSE 日志流展示进度
- Windows 优先：目录链接使用 `fs.symlink(..., 'junction')` 原生实现，无需管理员权限

## Capabilities

### New Capabilities

- `worktree-lifecycle`: git worktree 的创建、列表、删除、prune 全生命周期管理，包含前置校验与安全拦截规则
- `dependency-sharing`: worktree 依赖共享策略（junction 共享 / 独立安装 / 不处理）的检测、推荐与执行
- `worktree-console`: 本地 Web 控制台，提供目录浏览选择、分支选择、依赖策略配置、任务日志流等交互能力

### Modified Capabilities

（无 —— 全新项目，尚无既有规格）

## Impact

- 代码：全新代码库（当前工作区为空目录），新增 `server/`（Koa 后端 + core 执行器模块）与 `web/`（React + Vite 前端）
- 系统依赖：Node.js ≥ 18、Git；无数据库、无外部服务
- 运行影响：仅操作本机文件系统与本地 git 仓库，服务只监听 localhost，无网络部署诉求
- 对被管理的业务仓库零侵入：只使用 `git worktree` 标准命令与文件系统操作，不修改仓库本身的结构与配置
