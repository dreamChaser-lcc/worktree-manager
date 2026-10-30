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
```

服务仅监听 `127.0.0.1`，局域网内其他机器不可访问。

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
  src/jobs/             内存任务表 + SSE 日志流
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
