# Worktree 管理器

![版本](https://img.shields.io/badge/版本-v0.2.0-0969da) ![平台](https://img.shields.io/badge/平台-Windows_10_/_11-2ea44f) ![运行时](https://img.shields.io/badge/Node.js-%E2%89%A5_18-339933)

多需求并行开发管理工具：把同一个 git 仓库按需"worktree"成多个目录同时开发，以**需求**为维度聚合分支、多项目与 worktree，解决并行开发中最头疼的三件事——**目录怎么开、依赖怎么装、需求怎么管**。

## 它解决什么问题

| 痛点 | 这里的做法 |
|---|---|
| **多任务并行开发难管理**：3 个需求同时改同一个仓库，反复 stash、切分支，或者 clone 好几份仓库 | 一键把仓库 worktree 成多个目录，每个需求一个目录、各待各的分支；秒级创建，不重复 clone；写完的代码互不干扰 |
| **依赖装不起也怕装乱**：每个新目录重新 `npm install` 要几分钟；直接共享主目录依赖又怕版本互相污染 | 三种策略按需选：junction 共享主目录（秒级、零磁盘）、独立安装（pnpm 硬链接磁盘占用近似为零，完全隔离）、不处理；自动按 lockfile 推荐，共享依赖版本漂移会标**高风险**并一键隔离 |
| **需求统计与关联靠脑补**：一个需求横跨前端后端多个仓库，改到一半忘了哪些项目关联了哪些分支和目录 | 需求任务把「需求链接 + 分支 + 多项目 + 各自 worktree」聚合成一张清单，实时展示每个项目当前分支与需求是否一致，附 git 网页链接；分支被两个需求重复占用会提示冲突 |
| **需求结束收不了尾**：目录删不干净、分支忘没忘合并不知道、过段时间想找回现场无从下手 | 一键删除自动清目录（有未提交修改会拦截并列出文件），git 分支全保留；任何时候可一键恢复原样；任务记录、创建历史、安装日志全程留痕 |

## 核心亮点

![⚡ 秒级并行目录](https://img.shields.io/badge/⚡-秒级并行开发目录-0969da?style=for-the-badge) ![📋 需求聚合](https://img.shields.io/badge/📋-需求任务聚合-2ea44f?style=for-the-badge) ![🛡 依赖守护](https://img.shields.io/badge/🛡-依赖风险守护-d93f3b?style=for-the-badge) ![♻️ 归档可恢复](https://img.shields.io/badge/♻️-归档可恢复-8250df?style=for-the-badge)

- **⚡ 秒级并行开发目录**：worktree 展开 + 依赖 junction 共享（零磁盘）或独立安装（隔离），创建后立即可开发
- **📋 需求任务聚合**：多项目 × 分支 × worktree 一站式管理，保存即生成 `.code-workspace`，一个窗口打开全部项目
- **🛡 依赖风险守护**：共享依赖自动核对版本一致性，高风险一眼可见；安装支持自定义脚本、任务互斥、日志实时可查
- **♻️ 需求完成可恢复**：归档清理磁盘，git 分支保留，恢复时按原分支重建 worktree 并自动接回共享依赖

详细使用步骤见[图文教程](docs/TUTORIAL.md)（含界面截图）与[需求任务工作流](#需求任务工作流核心功能)。

## 支持的系统

| 系统 | 支持情况 |
|---|---|
| Windows 10/11 | ✅ 完整支持（开发与测试环境；依赖共享的目录联接 junction 为 Windows 标准能力） |
| macOS / Linux | ⚠️ 未经验证：核心 git 流程理论上跨平台，但启动脚本（`start.bat`）、默认路径、局域网防火墙提示等均按 Windows 编写，共享依赖的 junction 在非 Windows 卷上行为未测试 |

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

## 需求任务工作流（核心功能）

拿到一个需求后，按以下流程使用（应用内「使用指南」弹窗有同样内容的页面版）：

1. **新建需求任务**：粘贴需求链接与标题（支持整段粘贴自动拆分）、填写开发分支、添加涉及项目（项目名自动取目录尾段）。保存后默认生成 `.code-workspace` 工作区文件：各项目已关联 worktree 的用 worktree 目录，仅关联项目（尚未建 worktree）的用主仓库目录，一个编辑器窗口打开全部项目。
2. **为项目创建 worktree**：表单内一键创建，路径自动按 `<工作区目录>\<需求名>\<项目名>` 预填（需求聚合目录模式，可在设置页关闭）；分支默认基于远程最新分支新建；五道前置校验（git 仓库 / 路径可用 / 不嵌套 / 分支未占用 / 分支名合法）。
3. **依赖处理**：按主仓库 lockfile 自动推荐策略（pnpm → 独立安装；npm/yarn → junction 共享，可手动覆盖）；worktree 建好后可随时在明细中切换——「独立安装」支持自定义安装脚本（默认为包管理器 install），同一 worktree 的安装任务互斥（重复触发会提示）；「恢复共享」一键切回 junction。
4. **依赖风险检查**：明细中实时展示每个 worktree 的依赖状态（共享主目录 / 独立安装 / 未安装 / 高风险）；共享模式下 worktree 与主仓库的 `package.json` 依赖声明不一致时标记高风险，提示执行独立安装。
5. **日常开发**：明细中查看各项目当前分支与需求分支是否一致、有无未提交修改；一键用编辑器打开 worktree / 在资源管理器定位；项目附带 git 远程地址的可点击网页链接；同一分支被多个需求重复关联时提示分支冲突。
6. **完成归档**：删除需求任务会移除全部关联 worktree 与文件目录（三道拦截：未提交修改需强制确认、未合并提交数提示、主 worktree 禁删；失败时逐项目列出未提交文件清单与处理建议），git 分支本地与远程均保留，可随时「恢复」按原路径原分支重建——主仓库已有依赖时自动重建共享链接。「彻底删除」物理移除任务记录（不可恢复，分支仍保留）。

其他能力：

| 能力 | 说明 |
|---|---|
| 创建 worktree（独立页） | 不走需求流程时使用：选主仓库 → 选/建分支 → 选目标路径 → 选依赖策略 |
| 依赖共享 | 共享主目录（junction，秒级零磁盘）/ 独立安装（走包管理器缓存，后台任务 + 实时日志）/ 不处理 |
| worktree 列表 | 路径、分支、HEAD、脏状态、主 worktree 标识 |
| 删除 | 未提交修改需强制确认（列出具体文件清单）、未合并提交数提示、主 worktree 禁删；目录被编辑器/终端占用时给出"关闭占用程序后重试"的友好提示 |
| prune | 清理目录已不存在的失效 worktree 记录 |
| 后置动作 | 复制被忽略文件（.env、.env.local、*.local 白名单，可配置）与忽略目录（.husky 整棵递归复制，目标已有内容时覆盖，保证提交钩子在 worktree 内可用）；用编辑器打开新目录 |
| 任务记录 | 依赖安装等后台任务的状态（执行中/成功/失败/已中断）、完整日志可回看；SSE 实时推送 |
| 创建历史 | worktree 创建成功/失败均留痕并记录原因 |
| 主仓库记忆 | 页面打开自动回填最后使用的主仓库，"最近主仓库"下拉一键切换（保留 10 条） |
| 设置页 | 查看/修改：数据根目录（两种位置模式 radio 切换——独立数据目录（默认 `D:\softwares\worktree-manager`，可自定义）或程序目录下 `data\`（随程序携带）；立即生效，历史数据保留原目录不迁移）、代码默认存储目录（目录选择器默认定位，默认 `D:\project`）、工作区文件目录、需求聚合目录模式开关、编辑器命令（"打开"所用，默认 `code`，可改 `cursor` 等，自动检测本机已装编辑器） |
| 持久化 | 任务记录与完整安装日志、worktree 创建历史、最近主仓库目录跨重启保留；数据用纯 JS 嵌入式库 @seald-io/nedb 存储，零原生编译 |
| 操作反馈 | 所有异步操作按钮均有 loading 转圈与禁用态，完成后自动刷新结果，无需手动刷新页面 |

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
    dependency-risk-checker  worktree 依赖状态与共享风险检查
    ignore-file-copier  忽略文件/目录白名单复制
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

## 后续规划

- **数据一键导入导出**（`openspec/changes/add-data-import-export/`）：把任务记录、创建历史、需求任务、最近主仓库打包为 `.wtm-data.json` 一键导出；导入支持合并去重（默认）与覆盖（先自动备份），用于换机迁移、备份与数据分享。
- **桌面应用端**（`openspec/changes/add-desktop-app/`）：双版本并行、相互隔离——Electron 版（一期先行，内嵌现有 Koa 服务零改造）与 Tauri 版（sidecar 运行单文件服务），托盘常驻、原生通知、开机自启、Windows 安装包；一期要求已装 Git，「克隆远程仓库」列入后续计划。提案与任务清单见 `proposal.md` / `tasks.md`；环境搭建（Rust 装到 D 盘、MSVC 限制）与卸载留档见 [docs/DESKTOP-DEV.md](docs/DESKTOP-DEV.md)。

## 常见问题

- **提示"分支已被其他 worktree 签出"**：git 限制同一分支不能同时签出在两处（可能是其他需求已占用该分支），请新建分支或选其他分支；需求明细中会有分支冲突提示。
- **提示"该 worktree 已有安装任务执行中"**：同一 worktree 的安装任务互斥，等当前任务结束（任务记录中看状态）再触发；执行中也不能恢复共享。
- **删除时提示未提交修改**：到 worktree 里提交或还原修改后重试；确认放弃修改可在删除确认框勾选"强制删除"（失败详情中会列出具体未提交文件）。
- **删除时提示目录被占用**：关闭打开了该目录的程序（VSCode、终端、资源管理器）后重试；仍失败可手动删除目录后点击 prune 清理记录。
- **共享模式运行时报依赖找不到**：主目录换了依赖版本/结构，回主目录重装即可（所有共享方同步生效）。
- **杀毒软件提示 junction**：目录联接是 Windows 标准能力（mklink /J 等价），无需管理员权限。
