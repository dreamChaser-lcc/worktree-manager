---
name: worktree-manager
description: |
  操作本地 worktree-manager 平台（http://127.0.0.1:5210）：创建需求任务、建 git worktree、查任务与依赖状态、在 herdr 终端里打开工作区。
  Use this skill when the user asks to:
  - 新建需求任务 / 建个需求 / 帮我建需求任务 / 创建需求任务
  - 拉个 worktree / 开一个开发目录 / 给这个需求建 worktree
  - 打开 herdr 终端 / 在 herdr 里打开 / 关掉 herdr 终端
  - 看看这个需求的状态 / 有哪些需求任务 / 依赖装好了没
  - create requirement task / open in herdr / worktree status

  若已安装同名 MCP（worktree-manager），优先用 MCP 工具；MCP 不可用时按本 skill 用脚本或 curl 直接调 HTTP 接口。
---

# worktree-manager 平台操作

本地平台默认跑在 `http://127.0.0.1:5210`，无鉴权。所有操作都是普通 JSON HTTP 接口。

> **路径说明**：下文示例用项目级路径 `.codebuddy/skills/worktree-manager/scripts/...`。
> 如果本 skill 是通过全局安装到用户目录的，把前缀换成 `%USERPROFILE%\.codebuddy\skills\worktree-manager\scripts\...`（bash / macOS 则是 `~/.codebuddy/skills/worktree-manager/scripts/...`）。

## 一、开始前必做

```bash
curl -s http://127.0.0.1:5210/api/health
```

连不通就停下来，告诉用户「平台未启动，请双击项目根目录的 start.bat」，不要继续尝试其它接口。

## 二、参数规则（最容易出错的地方）

| 参数 | 规则 |
| --- | --- |
| `branchName` | **必须由用户明确提供**。用户没给就直接问，禁止自行编造、猜测或从需求标题推断 |
| `repoPath` | 主仓库的**绝对路径**。不确定是否有效时先跑「仓库校验」 |
| `requirementName` | 需求标题，通常来自 TAPD/需求文档，保持原样（含【】等符号） |
| `dependencyStrategy` | 默认 `install`（独立安装，几分钟但隔离最稳）；用户明确要省时间/磁盘才用 `share` |
| `projectList` | 至少 1 个；`projectName` 可不填，平台会取目录名 |

**查重**：创建前先按「需求名 + 分支名」查重，已存在就复用，不要重复创建（脚本默认已做）。

**校验**：创建脚本内置参数校验（必填、枚举、git 分支命名规则、路径存在性、是否 git 仓库）。
参数不确定时**先跑 `--check` 预检**，通过再创建。完整约束见 `schemas/create-requirement.schema.json`。

## 三、核心操作

### 1. 创建需求任务（推荐用脚本）

**第一步：预检参数（强烈建议）**

```bash
node .codebuddy/skills/worktree-manager/scripts/create-requirement.mjs \
  --name "【微赞+星享】【惠康】客服支持语音转文字" \
  --branch "lifachao/1103_add_feature" \
  --repo "D:\project\userlive" \
  --repo "D:\project\CustomerServiceSystem" \
  --strategy install --stage 开发中 \
  --check
```

预检通过才输出「参数校验通过」并列回显参数；不通过会逐条列出问题（字段 + 原因）并以非 0 退出。加 `--json` 可拿到 `{ valid, errors: [{ field, message }] }`。

校验覆盖：
- 必填项：`--name`、`--branch`、至少一个 `--repo`
- 分支命名：不含空格与 `~ ^ : ? * [ \`，不含 `..`/`//`，不以 `/` 或 `.` 开头结尾，不以 `.lock` 结尾
- 路径：必须是绝对路径（盘符或 UNC）且目录存在
- 枚举：`--strategy` 只能 `install|share|skip`，`--stage` 只能 `待开发|开发中|测试中`
- 平台侧：`/api/health` 可达 + 每个 repo 确实是 git 仓库

**第二步：确认无误后去掉 `--check` 执行创建**

```bash
node .codebuddy/skills/worktree-manager/scripts/create-requirement.mjs \
  --name "..." --branch "..." --repo "D:\project\userlive" --strategy install
```

脚本干了这些事：本地校验 → 查重 → 调 `POST /api/requirement-tasks` → 每个项目建 worktree → 按策略处理依赖 → 生成 `.code-workspace` → 可选设置阶段标签 → 打印 taskId 与路径。

**为什么要用脚本**：`projectList` 是嵌套数组，Windows 路径在 curl/PowerShell 里容易转义出错；脚本还附带上面那套 schema 级校验，参数错了本地就拦住，不必等接口报 400。

### 2. 查询任务列表

```bash
curl -s "http://127.0.0.1:5210/api/requirement-tasks?status=all&page=1&pageSize=20"
```

`status` 取值：`pending-test`（待提测，默认口径）/ `tested`（已提测）/ `published`（已发布）/ `all`。
可叠加 `stageTag=待开发|开发中|测试中|unset`、`startDate=YYYY-MM-DD`、`endDate=YYYY-MM-DD`。

### 3. 查单个任务的状态

```bash
# 分支定位：各项目 worktree 当前在哪个分支、是否有未提交修改
curl -s "http://127.0.0.1:5210/api/requirement-tasks/<taskId>/locate"

# 依赖状态：shared / independent / missing
curl -s "http://127.0.0.1:5210/api/requirement-tasks/<taskId>/dependency-check"
```

### 4. 在 herdr 终端打开该需求

```bash
curl -s -X POST http://127.0.0.1:5210/api/filesystem/open-herdr \
  -H "Content-Type: application/json" \
  -d "{\"targetPath\":\"<工作区文件 .code-workspace 的绝对路径>\",\"label\":\"<需求名>\"}"
```

- `targetPath` 传 `.code-workspace` 文件时，后端自动取其所在目录作为工作目录；
- 工作区按 `label` 幂等：已存在则只切焦点，不重复创建；
- 返回 `{"needsServerStart":true}` 表示 herdr 服务没跑，**必须先问用户**，同意后再带 `"startServer":true` 重试。

### 5. 关闭 herdr 工作区（破坏性）

```bash
curl -s -X POST http://127.0.0.1:5210/api/filesystem/close-herdr \
  -H "Content-Type: application/json" \
  -d "{\"targetPath\":\"<工作区文件路径>\",\"label\":\"<需求名>\"}"
```

会结束该工作区内正在运行的进程。**只在用户明确要求「关闭/删掉终端」时调用**。

### 6. 校验仓库

```bash
curl -s "http://127.0.0.1:5210/api/filesystem/repository-check?path=D:\project\userlive"
```

返回 `{ isGitRepository, currentBranch }`。创建任务前不确定路径是否有效时先跑这个。

## 四、错误对照

| 现象 | 原因 / 处理 |
| --- | --- |
| 连接被拒（ECONNREFUSED） | 平台没启动 → 提示用户开 start.bat |
| 400 | 参数问题，读返回的 `message` 修正后重试；常见是不存在的 repoPath、空 branchName |
| 404 | 任务 id 不存在 |
| `needsServerStart: true` | herdr 服务没跑，先征得用户同意 |
| 依赖是 `shared` 但用户报「依赖读不到」 | 目录链接在当前系统不可用，建议改用 `install` 策略 |

## 五、禁止事项

- **不要调用任何删除类接口**（删除需求、彻底删除、删除 worktree、清空历史）；
- **不要**在用户没给 `branchName` 时自己编一个；
- **不要**在用户没同意时传 `startServer: true` 拉起 herdr；
- **不要**批量创建多个需求任务，除非用户逐个明确要求。

## 六、更多

接口全表（含 worktree、分支、任务日志等未在此列出的端点）见 `references/api-endpoints.md`。
