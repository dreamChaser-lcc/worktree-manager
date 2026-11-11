# ai-tools

把 worktree-manager 平台的能力暴露给 AI agent 的两套实现。两者打同一批接口，装哪个都能用，也可以都装（MCP 优先，不可用时走 skill）。

```
ai-tools/
├── install.mjs                     一键部署脚本
├── mcp-server/                     MCP server（stdio）
│   ├── package.json
│   └── index.js                    6 个工具
└── skill/
    └── worktree-manager/           CodeBuddy skill 源文件
        ├── SKILL.md
        ├── references/api-endpoints.md
        ├── schemas/create-requirement.schema.json
        └── scripts/create-requirement.mjs
```

## 目录

- [一、MCP 方案（推荐）](#一mcp-方案推荐)
  - [安装](#安装)
  - [注册](#注册)
  - [验证](#验证)
- [二、Skill 方案](#二skill-方案)
- [三、安装到全局（所有项目可用）](#三安装到全局所有项目可用)
  - [两种方案的"全局"分别指什么](#两种方案的全局分别指什么)
  - [目录对照](#目录对照)
  - [手动安装（不跑脚本）](#手动安装不跑脚本)
  - [手动安装（纯图形界面操作）](#手动安装纯图形界面操作)
  - [全局安装后注意](#全局安装后注意)
  - [升级](#升级)
  - [卸载](#卸载)
- [四、换电脑怎么用](#四换电脑怎么用)
- [五、安全边界](#五安全边界)
- [六、排错](#六排错)
- [七、附录：路径里的 %USERPROFILE% 是什么](#七附录路径里的-userprofile-是什么)

---

## 一、MCP 方案（推荐）

**能力**：agent 直接调用结构化工具，参数有 schema 校验。

| 工具 | 作用 |
| --- | --- |
| `create_requirement_task` | 建需求任务 + worktree + 依赖 + 工作区文件 |
| `list_requirement_tasks` | 按状态 / 阶段标签 / 时间查列表 |
| `get_requirement_status` | 单任务的分支定位 + 依赖状态 |
| `open_in_herdr` | 在 herdr 打开该需求的工作区 |
| `close_herdr_workspace` | 关闭 herdr 工作区（破坏性，需显式要求） |
| `check_git_repository` | 校验目录是否 git 仓库 |

### 安装

```powershell
# 在仓库根目录执行
node ai-tools/install.mjs --install-deps
```

脚本会：
1. 把 skill 复制到 `.codebuddy/skills/worktree-manager/`；
2. 打印可直接粘贴的 `mcp.json` 配置片段；
3. 在 `mcp-server/` 下执行 `npm install`。

不想自动装依赖就去掉 `--install-deps`，手动执行：

```powershell
cd ai-tools\mcp-server
npm install
```

### 注册

编辑 `%USERPROFILE%\.codebuddy\mcp.json`（即 `C:\Users\Administrator\.codebuddy\mcp.json`，这个变量是什么见[附录](#七附录路径里的-userprofile-是什么)），在 `mcpServers` 中添加（路径以脚本输出为准）：

```json
"worktree-manager": {
  "command": "node",
  "args": ["D:\\project\\lcc-github\\worktree-manager\\ai-tools\\mcp-server\\index.js"],
  "env": { "WORKTREE_MANAGER_API": "http://127.0.0.1:5210" },
  "type": "stdio",
  "timeout": 60000,
  "disabled": false
}
```

**重启 CodeBuddy** 才会加载。

### 验证

```powershell
# 平台要先跑起来
curl http://127.0.0.1:5210/api/health

# 单独验 MCP server 能否启动（会挂在等待输入，Ctrl+C 退出）
node ai-tools\mcp-server\index.js
```

看到 `[worktree-manager-mcp] 已启动，平台地址：http://127.0.0.1:5210` 即正常。

---

## 二、Skill 方案

**能力**：不改代码，靠 `SKILL.md` 告诉 agent 有哪些接口、参数怎么填，用脚本或 curl 直接调 HTTP。

```powershell
node ai-tools/install.mjs --print-only   # 只看会部署到哪，不动磁盘
node ai-tools/install.mjs                # 部署 skill
```

部署后 `.codebuddy/skills/worktree-manager/` 生效，重启 CodeBuddy 或重开项目即可。

触发方式：直接说「帮我建个需求任务，分支 xxx，项目 D:\project\yyy」，或手动 `/worktree-manager`。

**和 MCP 的区别**：skill 不提供工具，agent 读文档后自己拼请求；复杂嵌套参数（`projectList`）依赖随包脚本 `scripts/create-requirement.mjs` 兜底。

---

## 三、安装到全局（所有项目可用）

前面的安装都是**项目级**：skill 只在当前仓库生效，MCP 的 `args` 指向仓库里的路径。想让 CodeBuddy 在任何项目里都能用这两套能力，加 `--global`。

```powershell
node ai-tools/install.mjs --global --install-deps
```

### 两种方案的"全局"分别指什么

**MCP**：`mcp.json` 本身就是全局文件（`%USERPROFILE%\.codebuddy\mcp.json`），注册一次所有项目可见。差别只在 `args` 指向哪：

| 安装方式 | `args` 指向 | 仓库移动/删除后 |
| --- | --- | --- |
| 项目级 | `D:\...\worktree-manager\ai-tools\mcp-server\index.js` | 失效，需改配置 |
| 全局 | `%USERPROFILE%\.codebuddy\mcp-servers\worktree-manager\index.js` | 不受影响 |

`--global` 会把 `index.js` + `package.json` 复制到用户目录，并在那里独立 `npm install`，与仓库解耦。

**Skill**：CodeBuddy 同时读两个位置——

| 级别 | 路径 | 生效范围 |
| --- | --- | --- |
| 项目级 | `<仓库>\.codebuddy\skills\<name>\` | 仅该仓库 |
| 用户级 | `%USERPROFILE%\.codebuddy\skills\<name>\` | 所有项目 |

`--global` 部署到用户级，任何项目打开都能命中。

### 目录对照

| 内容 | 项目级（默认） | 全局（`--global`） |
| --- | --- | --- |
| skill | `.codebuddy\skills\worktree-manager\` | `%USERPROFILE%\.codebuddy\skills\worktree-manager\` |
| MCP server | 用仓库里的 `ai-tools\mcp-server\` | 复制到 `%USERPROFILE%\.codebuddy\mcp-servers\worktree-manager\` |
| MCP 依赖 | `ai-tools\mcp-server\node_modules\` | 用户目录副本下的 `node_modules\` |

### 手动安装（不跑脚本）

不想用 `install.mjs` 时，按下面两步手动复制即可。**两种方案彼此独立，可以只装其中一个。**

#### A. 手动装 MCP 到全局

**① 建目录并复制源码**（在仓库根目录执行）

```powershell
New-Item -ItemType Directory -Path "$env:USERPROFILE\.codebuddy\mcp-servers\worktree-manager" -Force | Out-Null
Copy-Item "ai-tools\mcp-server\index.js"     "$env:USERPROFILE\.codebuddy\mcp-servers\worktree-manager\" -Force
Copy-Item "ai-tools\mcp-server\package.json" "$env:USERPROFILE\.codebuddy\mcp-servers\worktree-manager\" -Force
```

cmd 版：

```cmd
mkdir "%USERPROFILE%\.codebuddy\mcp-servers\worktree-manager"
copy "ai-tools\mcp-server\index.js" "%USERPROFILE%\.codebuddy\mcp-servers\worktree-manager\"
copy "ai-tools\mcp-server\package.json" "%USERPROFILE%\.codebuddy\mcp-servers\worktree-manager\"
```

**② 在副本目录装依赖**（必须在副本目录装，不是仓库目录）

```powershell
cd "$env:USERPROFILE\.codebuddy\mcp-servers\worktree-manager"
npm install
```

装完检查这两个目录存在：`node_modules\@modelcontextprotocol`、`node_modules\zod`。

**③ 验证能启动**

```powershell
node "$env:USERPROFILE\.codebuddy\mcp-servers\worktree-manager\index.js"
```

看到 `[worktree-manager-mcp] 已启动，平台地址：http://127.0.0.1:5210` 即正常，`Ctrl+C` 退出。

**④ 手动编辑 mcp.json**

用记事本或编辑器打开 `%USERPROFILE%\.codebuddy\mcp.json`，在 `mcpServers` 对象里加一项（注意与前后项的逗号）：

```json
"worktree-manager": {
  "command": "node",
  "args": ["C:\\Users\\Administrator\\.codebuddy\\mcp-servers\\worktree-manager\\index.js"],
  "env": { "WORKTREE_MANAGER_API": "http://127.0.0.1:5210" },
  "type": "stdio",
  "timeout": 60000,
  "disabled": false
}
```

> `args` 里的用户名要换成你自己的（`%USERPROFILE%` 在 JSON 里不会展开，必须写死绝对路径）。
> 拿不准就执行 `echo $env:USERPROFILE` 看一眼。

**⑤ 重启 CodeBuddy** → MCP 面板确认 `worktree-manager` 已连接。

#### B. 手动装 Skill 到全局

整个目录复制过去即可，没有依赖、不用编译。**如果之前装过，先删旧目录**，否则 `Copy-Item -Force` 是合并不是覆盖，可能残留已废弃的文件：

```powershell
New-Item -ItemType Directory -Path "$env:USERPROFILE\.codebuddy\skills" -Force | Out-Null
Remove-Item "$env:USERPROFILE\.codebuddy\skills\worktree-manager" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "ai-tools\skill\worktree-manager" "$env:USERPROFILE\.codebuddy\skills\" -Recurse -Force
```

cmd 版：

```cmd
xcopy "ai-tools\skill\worktree-manager" "%USERPROFILE%\.codebuddy\skills\worktree-manager\" /E /I /Y
```

复制后确认这三个文件都在：

```
%USERPROFILE%\.codebuddy\skills\worktree-manager\SKILL.md
%USERPROFILE%\.codebuddy\skills\worktree-manager\references\api-endpoints.md
%USERPROFILE%\.codebuddy\skills\worktree-manager\scripts\create-requirement.mjs
```

然后**重启 CodeBuddy**。任意项目里说「帮我建个需求任务…」或 `/worktree-manager` 即可触发。

#### C. 只装一个

| 想要的效果 | 只需做 |
| --- | --- |
| agent 能直接调结构化工具 | A（MCP） |
| 轻量、可读文档、随时改 | B（Skill） |
| 两者都有，MCP 优先 | A + B |

两者互不依赖，`mcp.json` 里没有对应项不影响 skill，反过来也一样。

### 手动安装（纯图形界面操作）

不想敲命令的话，除了 **`npm install` 这一步必须在终端里执行**，其余全在资源管理器里点鼠标完成。

> 小技巧：资源管理器的**地址栏可以直接输入路径**，粘贴后按回车就会跳过去；输入 `powershell` 按回车，会在**当前目录**直接打开 PowerShell 窗口，不用再 `cd`。

#### A. 图形界面装 MCP 到全局

**① 建目标目录**

1. `Win + E` 打开文件资源管理器；
2. 在地址栏输入 `%USERPROFILE%\.codebuddy`，回车；
3. 如果没有 `mcp-servers` 文件夹：在空白处**右键 → 新建 → 文件夹**，命名为 `mcp-servers`；
4. 双击进入 `mcp-servers`，同样新建文件夹 `worktree-manager`。

最终路径应为：`C:\Users\<你的用户名>\.codebuddy\mcp-servers\worktree-manager`

**② 复制两个文件过去**

1. 再开一个资源管理器窗口，地址栏输入 `D:\project\lcc-github\worktree-manager\ai-tools\mcp-server`，回车；
2. 选中 `index.js` 和 `package.json`（按住 `Ctrl` 依次点选）；
3. `Ctrl + C`；
4. 切回第 ① 步的 `worktree-manager` 窗口，`Ctrl + V`。

确认这两个文件直接躺在 `worktree-manager` 里（不是多套了一层目录）。

**③ 装依赖（唯一需要终端的一步）**

1. 保持在 `worktree-manager` 窗口；
2. 点一下**地址栏**（或按 `Alt + D`），输入 `powershell`，回车；
3. 在弹出的窗口里输入 `npm install`，回车；
4. 看到 `added N packages` 或 `up to date` 即完成。

装完后窗口里会多出 `node_modules` 文件夹和 `package-lock.json`，说明成功。

（替代做法：在文件夹空白处 `Shift + 右键` → **在此处打开 PowerShell 窗口**，效果一样。Win11 要先点「显示更多选项」。）

**④ 编辑 mcp.json**

1. 地址栏输入 `%USERPROFILE%\.codebuddy`，回车；
2. 找到 `mcp.json`，**右键 → 打开方式 → 记事本**；
3. 找到 `"mcpServers": {` 这一行，在它下面插入下面这段（`args` 里的用户名换成你自己的）：

```json
"worktree-manager": {
  "command": "node",
  "args": ["C:\\Users\\Administrator\\.codebuddy\\mcp-servers\\worktree-manager\\index.js"],
  "env": { "WORKTREE_MANAGER_API": "http://127.0.0.1:5210" },
  "type": "stdio",
  "timeout": 60000,
  "disabled": false
},
```

4. `Ctrl + S` 保存。

> 插入位置注意：它要和已有的项**同级**，并且这段以 `},` 结尾、上一项也要以 `,` 结尾。改完不确定语法对不对，可以把内容粘到 [jsonlint.com](https://jsonlint.com) 校验一下。

**⑤ 重启 CodeBuddy**，MCP 面板里应出现 `worktree-manager`。

#### B. 图形界面装 Skill 到全局

**① 打开 skills 目录**

1. 地址栏输入 `%USERPROFILE%\.codebuddy`，回车；
2. 没有 `skills` 文件夹就**右键 → 新建 → 文件夹**，命名 `skills`；
3. 双击进入 `skills`。

**② 复制整个 skill 文件夹**

1. 另一个窗口地址栏输入 `D:\project\lcc-github\worktree-manager\ai-tools\skill`，回车；
2. 选中 `worktree-manager` **整个文件夹**（不是进去选文件），`Ctrl + C`；
3. 切回 `skills` 窗口，`Ctrl + V`。

> 如果之前装过，先把旧的 `worktree-manager` 文件夹删掉再粘，避免新旧文件混在一起。

**③ 检查文件是否齐全**

双击进入 `%USERPROFILE%\.codebuddy\skills\worktree-manager`，应能看到：

```
SKILL.md
references\api-endpoints.md
schemas\create-requirement.schema.json
scripts\create-requirement.mjs
```

**④ 重启 CodeBuddy**，任意项目里说「帮我建个需求任务…」即可触发。

#### C. 图形界面卸载

1. 地址栏 `%USERPROFILE%\.codebuddy\skills`，删掉 `worktree-manager` 文件夹；
2. 地址栏 `%USERPROFILE%\.codebuddy\mcp-servers`，删掉 `worktree-manager` 文件夹；
3. 用记事本打开 `%USERPROFILE%\.codebuddy\mcp.json`，删掉 `"worktree-manager": { ... }` 整段（注意别留下孤立的逗号）；
4. 重启 CodeBuddy。

### 全局安装后注意

SKILL.md 里的示例命令用的是项目级路径，全局安装后换成用户级：

```powershell
node "$env:USERPROFILE\.codebuddy\skills\worktree-manager\scripts\create-requirement.mjs" --check ...
```

### 升级

仓库更新后重跑即可覆盖 skill 与 MCP 源码（**保留** `node_modules`，不必重装依赖）：

```powershell
node ai-tools/install.mjs --global
```

### 卸载

```powershell
Remove-Item "$env:USERPROFILE\.codebuddy\skills\worktree-manager" -Recurse -Force
Remove-Item "$env:USERPROFILE\.codebuddy\mcp-servers\worktree-manager" -Recurse -Force
# 再从 %USERPROFILE%\.codebuddy\mcp.json 里删掉 "worktree-manager" 那一项
```

---

## 四、换电脑怎么用

```powershell
git clone <repo>
cd worktree-manager
node ai-tools/install.mjs --install-deps
```

然后：
1. 把脚本输出的那段 JSON 加进 `%USERPROFILE%\.codebuddy\mcp.json`；
2. 重启 CodeBuddy；
3. 启动平台（`start.bat`）；
4. 问一句「列出最近的需求任务」验证。

`ai-tools/` 全部随仓库走，`.codebuddy/skills/worktree-manager/` 是安装产物，已加入 `.gitignore`，不需要提交。

---

## 五、安全边界

写进 skill 与工具描述里的硬约束：

- **不提供删除类能力**：删需求、删 worktree、清历史都不在工具里，skill 也明确禁止调用；
- **`branchName` 必须由用户提供**，agent 不得编造；
- **`create_requirement_task` 默认查重**（需求名 + 分支名），避免重复建 worktree；
- **`open_in_herdr` 不自动起服务**：herdr 没跑时返回 `needsServerStart`，须用户确认后传 `startServer=true`；
- **依赖策略默认 `install`**：共享目录链接在部分 Windows 环境不可用，不作为默认。

---

## 六、排错

| 现象 | 处理 |
| --- | --- |
| 工具调用报「无法连接平台」 | 平台没起，运行根目录 `start.bat` |
| MCP 面板里没有 worktree-manager | 路径写错，或没重启 IDE；检查 `mcp.json` JSON 语法 |
| `npm install` 报依赖冲突 | 检查 `mcp-server/package.json` 里的 SDK / zod 版本 |
| 工具返回 404 | 平台版本过旧，缺少 `open-herdr` 等端点，重启平台 |
| skill 没被触发 | 确认 `.codebuddy/skills/worktree-manager/SKILL.md` 存在，重开项目 |

---

## 七、附录：路径里的 `%USERPROFILE%` 是什么

`%USERPROFILE%` 是 Windows 内置环境变量，指向**当前登录用户的主目录**。本机实际值是：

```
%USERPROFILE%  =  C:\Users\Administrator
```

所以文档里写的 `%USERPROFILE%\.codebuddy\mcp-servers\worktree-manager`，展开后就是：

```
C:\Users\Administrator\.codebuddy\mcp-servers\worktree-manager
```

### 怎么查看自己的值

| 环境 | 操作 |
| --- | --- |
| 文件资源管理器 | 地址栏输入 `%USERPROFILE%` 回车，直接跳过去 |
| cmd | `echo %USERPROFILE%` |
| PowerShell | `echo $env:USERPROFILE` |
| 任意文件夹 | 地址栏输入 `%USERPROFILE%\.codebuddy` 回车，直达配置目录 |

### 跨平台对照

| 平台 | 用户主目录写法 |
| --- | --- |
| Windows | `%USERPROFILE%`（即 `C:\Users\<用户名>`） |
| PowerShell | `$env:USERPROFILE` 或 `~` |
| macOS / Linux | `~` 或 `$HOME` |

文档里用变量写法而不是写死 `C:\Users\Administrator`，是为了换电脑、换账号时能直接复制粘贴。

### 关键坑：不是所有地方都会展开

| 位置 | 会展开吗 |
| --- | --- |
| 资源管理器地址栏 | ✅ 会 |
| cmd 命令 | ✅ 会 |
| PowerShell 的 `$env:USERPROFILE` | ✅ 会（但写 `%USERPROFILE%` 不认） |
| **`mcp.json` 里的 JSON** | ❌ **不会** |
| Node.js 代码里的字符串 | ❌ 不会 |

所以 `mcp.json` 的 `args` 必须写死绝对路径：

```json
"args": ["C:\\Users\\Administrator\\.codebuddy\\mcp-servers\\worktree-manager\\index.js"]
```

写成 `%USERPROFILE%\\.codebuddy\\...` 的话，Node 会去找一个名字就叫 `%USERPROFILE%` 的文件夹，然后报「找不到模块」。

### `.codebuddy` 目录结构

```
C:\Users\Administrator\.codebuddy\
├── mcp.json          ← MCP 服务器注册表（全局，CodeBuddy 读取）
├── skills\           ← 用户级 skill（所有项目可用，CodeBuddy 读取）
└── mcp-servers\      ← 放全局 MCP 副本的位置（本项目的约定，CodeBuddy 不关心）
```

前两个是 CodeBuddy 认的固定位置；`mcp-servers\` 只是用来放代码，实际路径是在 `mcp.json` 的 `args` 里指定的，叫什么名字都行。
