# Worktree 管理器

本地 Web 工具：把同一个 git 仓库"worktree"成多个目录并行开发，新目录秒级创建、可零成本复用主目录依赖，免去重复 clone 与重复下载依赖。

## 机器依赖

- Node.js ≥ 18
- Git

## 启动

双击 `start.bat`（自动装依赖、构建前端、启动服务并打开浏览器），或手动执行：

```bash
npm run setup        # 安装 server/ 与 web/ 依赖
npm run build:web    # 构建前端产物
npm start            # 启动服务，访问 http://127.0.0.1:5210
npm run dev:server:watch  # 开发热重启：改动 server/src 下代码自动重启（Node ≥ 18.11 内置 --watch，零依赖）
npm run build:web:watch  # 前端源码改动自动重新打包 dist（打包后刷新浏览器即生效，后端无需重启）
npm run dev              # 一键开发：当前终端同时跑后端热重启 + 前端自动打包（输出带 [server]/[web] 前缀，Ctrl+C 全部退出）
```

默认仅监听 `127.0.0.1`（仅本机可访问）。`start.bat` 已默认设置 `WORKTREE_MANAGER_HOST=0.0.0.0` 允许局域网通过本机 IP 访问（如仅本机使用，注释掉 start.bat 中该行即可收回）。注意：首次被局域网访问时 Windows 防火墙可能拦截，需允许 Node.js 或放行 5210 端口（管理员执行 `netsh advfirewall firewall add rule name="Worktree Manager" dir=in action=allow protocol=TCP localport=5210`）。

## 功能

| 能力 | 说明 |
|---|---|
| 创建 worktree | 选主仓库 → 选/建分支 → 选目标路径；五道前置校验（git 仓库 / 路径可用 / 不嵌套 / 分支未占用 / 分支名合法） |
| 依赖共享 | 共享主目录（junction，秒级零磁盘）/ 独立安装（走包管理器缓存，后台任务 + 实时日志）/ 不处理 |
| 策略推荐 | 按 lockfile 自动推荐：pnpm → 独立安装；npm/yarn → junction 共享；可手动覆盖 |
| worktree 列表 | 路径、分支、HEAD、脏状态、主 worktree 标识 |
| 删除 | 三道拦截：未提交修改需强制确认、未合并提交数提示、主 worktree 禁删 |
| prune | 清理目录已不存在的失效 worktree 记录 |
| 后置动作 | 复制被忽略文件（.env、.env.local、*.local 白名单，可配置）；用编辑器打开新目录 |
| 持久化 | 任务记录与完整安装日志、worktree 创建历史（成功/失败均留痕）、最近主仓库目录（10 条）跨重启保留；数据用纯 JS 嵌入式库 @seald-io/nedb 存储，零原生编译 |
| 主仓库记忆 | 页面打开自动回填最后使用的主仓库，"最近主仓库"下拉一键切换 |
| 需求任务 | 以需求为维度聚合：需求链接、分支名称、涉及项目及各自关联的 worktree、预留备注；表单内可直接创建 worktree 或选已有；支持查看明细与一键打开 |
| 工作区文件 | 保存需求任务时可生成 `.code-workspace`（默认勾选），聚合各项目已关联 worktree，文件带需求标识注释；存放目录默认为数据目录下 `workspaces\`，设置页可改 |
| 设置页 | 查看/修改：数据根目录（立即生效，历史数据保留原目录不迁移）、代码默认存储目录（目录选择器默认定位，默认 `D:\project`）、工作区文件目录（默认数据目录下 `workspaces\`）、编辑器命令（"打开"所用，默认 `code`，可改 `cursor` 等） |

## 数据与持久化

- 数据根目录默认 `D:\softwares\worktree-manager`（D 盘不存在时自动回退到 `%USERPROFILE%\worktree-manager-data`），可在网页"设置"页修改
- 目录内容：`nedb/`（任务元数据、创建历史、最近主仓库三个库）+ `job-logs/`（每个安装任务一个 `.jsonl` 日志文件）
- 配置文件固定在 `%USERPROFILE%\.worktree-manager\settings.json`，与数据目录分离；配置缺失/损坏会按默认规则重建，不影响业务数据
- 服务重启后：历史任务与日志可回看（任务列表含"已中断"状态 = 上次运行中进程被终止）；主仓库目录自动回填
- 请勿同时启动多个服务实例（嵌入式库无跨进程锁）

## 依赖共享模式的重要约束（务必了解）

- **共享主目录（junction）**：依赖版本以主目录为准。在新 worktree 分支上升级依赖不会生效；请勿在共享模式的 worktree 里执行 `npm/pnpm/yarn install`——会写穿联接、改写主目录依赖，波及所有共享它的 worktree。
- **独立安装**：各 worktree 依赖完全隔离；pnpm 项目走全局 store 硬链接，磁盘占用近似为零。
- Windows 下目录联接要求同一磁盘卷；跨卷时请改用独立安装。

## 目录结构

```
server/                 Koa 后端（仅监听本机）
  src/core/             核心执行器（与 HTTP 解耦，可复用给未来桌面端/Agent）
    git-executor        git 命令统一执行与 porcelain 解析
    validators          前置校验（仓库/路径/卷/分支名）
    worktree-manager    worktree 创建/列表/删除/prune
    dep-linker          依赖策略：检测/推荐/junction/独立安装
    ignore-file-copier  忽略文件白名单复制
    editor-opener       编辑器打开
  src/routes/           REST API 路由
  src/jobs/             任务执行器（内存运行态 + 持久化留存 + SSE 日志流）
  src/storage/          持久化存储（@seald-io/nedb 三库 + JSONL 任务日志 + 设置文件）
web/                    React + Vite 前端
openspec/               规格与变更文档（spec-driven）
```

## 测试

```bash
npm test    # vitest：单测 + 真实临时仓库集成测试（含 API 与 SSE）
```

## 常见问题

- **提示"分支已被其他 worktree 签出"**：git 限制同一分支不能同时签出在两处，请新建分支或选其他分支。
- **共享模式运行时报依赖找不到**：主目录换了依赖版本/结构，回主目录重装即可（所有共享方同步生效）。
- **杀毒软件提示 junction**：目录联接是 Windows 标准能力（mklink /J 等价），无需管理员权限。
