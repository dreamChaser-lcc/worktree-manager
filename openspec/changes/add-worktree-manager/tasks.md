# Tasks

## 1. 项目脚手架

- [x] 1.1 初始化仓库结构：根 package.json（engines: node >=18）、`server/`、`web/` 两个工作区目录与基础脚本，验证 `npm install` 全部安装成功
- [x] 1.2 搭建 Koa 服务骨架：koa + @koa/router + koa-static，显式监听 `127.0.0.1:5210`，提供 `/api/health` 健康检查；验证本机 curl 返回 ok、端口仅绑定回环地址
- [x] 1.3 搭建 Vite + React 前端骨架：dev 模式代理 `/api` 到 Koa；生产构建产物由 Koa 静态托管；验证 dev 页面可访问、`npm run build` 后 5210 端口出页面
- [x] 1.4 配置 vitest 测试环境（server 侧），验证示例测试可运行

## 2. core 执行器（与 HTTP 层解耦）

- [x] 2.1 实现 `core/git-executor`：统一 `git -C <repo>` spawn 封装（超时、stderr 归一化、`--porcelain` 输出解析），单测覆盖成功/非零退出/超时三种路径
- [x] 2.2 实现 `core/validators`：git 仓库校验、目标路径可用性、嵌套仓库检查、同卷检查、分支名合法性，单测覆盖五项校验的正反用例
- [x] 2.3 实现 `core/worktree-manager`：create（已有/新建分支）、list（路径/分支/HEAD/脏状态）、remove（含 force 语义与主 worktree 拒删）、prune、分支占用检测；用临时 fixture 仓库集成测试覆盖规格中的各场景
- [x] 2.4 实现 `core/dep-linker`：lockfile 检测与策略推荐（pnpm→独立安装、npm/yarn→junction、无→不推荐）；junction 共享（node_modules 缺失拒绝、跨卷拒绝）；独立安装执行（返回子进程流）；不处理；集成测试验证链接后可读取依赖文件、主目录缺失时拒绝
- [x] 2.5 实现 `core/ignore-file-copier`：白名单复制（默认 `.env`、`.env.local`、`*.local`，白名单可配置），单测覆盖存在复制/不存在静默跳过

## 3. REST API 层（server/routes）

- [x] 3.1 目录浏览 API：列出驱动器根与子目录树，返回所选目录是否为 git 仓库；接口测试覆盖正常目录与非法路径
- [x] 3.2 分支列表 API：返回分支清单及各分支被 worktree 占用的位置标注；接口测试用 fixture 仓库验证占用标注
- [x] 3.3 创建 API：按"校验 → worktree add → 依赖处理 → 复制忽略文件 → 打开编辑器"串联 core 模块，任一步失败按 design D8 报告失败步骤与现场保留情况；接口测试在真实临时仓库走通 junction 共享全流程
- [x] 3.4 列表 / 删除 / prune API：删除支持显式 force 参数，未提交修改与未合并提交的拦截信息随 409 响应返回；接口测试覆盖干净删除、拦截、强删、prune 四类
- [x] 3.5 实现 `server/job-runner` 与 SSE 端点：内存任务表 + 增量日志推送 + 终态标记；接口测试订阅 SSE 收到增量日志与 success/failure 终态

## 4. Web 前端（React）

- [x] 4.1 目录选择器组件：目录树浏览、选择回填绝对路径、git 仓库实时校验反馈；本地走查可用
- [x] 4.2 创建表单：已有/新建分支两种模式、被占用分支标注且禁选、依赖策略区（自动推荐默认 + 三选一可覆盖）、复制忽略文件与打开编辑器勾选、共享模式约束提示文案；本地走查表单联动正确
- [x] 4.3 worktree 列表页：路径/分支/脏状态展示、删除交互（未提交修改时弹出强确认）、prune 入口与结果反馈；本地走查列表操作闭环
- [x] 4.4 任务日志面板：SSE 订阅、日志滚动追加、成功/失败终态标记；用一次真实独立安装任务走查
- [x] 4.5 前后端联调走查：在真实业务仓库完整执行"创建(junction 共享) → 列表 → 打开编辑器 → 删除"并核对每步界面反馈与实际文件系统结果一致

## 5. 交付

- [x] 5.1 提供 `start.bat` 一键启动脚本与 README（启动方式、机器依赖 Node≥18+Git、共享模式约束说明）；在干净目录按 README 步骤复现启动成功
- [x] 5.2 全量回归：`openspec validate` 通过；vitest 全量通过；手动验收清单（创建三策略 × 删除拦截 × prune）逐项过一遍

## 6. 删除时的目录清理回退（用户验收反馈）

- [x] 6.1 服务端：removeWorktree 支持 deleteDirectory 选项，git 原生删除失败（Directory not empty 等）时回退为 junction 感知的手动目录清理 + prune；测试覆盖"junction+被忽略文件触发回退、主仓库依赖内容完好、git 记录清理"
- [x] 6.2 前端：删除确认弹层增加"同时删除磁盘目录"选项（默认勾选）并透传 API；走查删除流程
- [x] 6.3 回归：vitest 全量通过、前端重建、服务重启后用户可复验

## Workflow follow-up

- 验收通过后归档本 change（`openspec archive add-worktree-manager`）。
