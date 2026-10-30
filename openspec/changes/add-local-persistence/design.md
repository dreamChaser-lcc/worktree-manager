# Design

## Context

add-worktree-manager 已交付完整生命周期管理，但运行状态全在内存：job-runner 的 jobMap 是唯一状态落点（重启即失），主仓库目录由前端组件 useState 持有（刷新即失），创建动作不留痕。本变更在此基础上补齐持久化，不改既有生命周期语义。

已确认约束：

- 纯 JS、装上就能跑：不得引入原生编译依赖（用户明确否决 C++ 方案）
- 不使用 localStorage：前端回显以服务端记录为单一数据源（用户决策）
- 数据目录可配置，默认 `D:\softwares\worktree-manager`
- Windows 优先；单实例单用户（现状即 start.bat 单进程）

## Goals / Non-Goals

**Goals:**

- 重启后：任务记录与完整日志可回看、主仓库目录自动回填/一键切换、创建历史可追溯
- 存储位置可配置且对用户透明（设置页可见可改）
- 持久化故障不放大：落盘失败不影响任务与 git 主流程，以警告形式暴露

**Non-Goals:**

- 不做多进程并发写支持（nedb 无跨进程锁，保持单实例约定）
- 不做数据自动迁移/同步（修改数据目录仅切换指向，历史数据留在原目录）
- 不做自动清理策略（历史永久保留 + 手动清空）
- 不做远程/多机数据共享

## Decisions

### D1. 存储引擎：@seald-io/nedb（记录）+ JSONL 文件（日志）

记录类数据（任务元数据、创建历史、最近主仓库）用 @seald-io/nedb——纯 JS 零编译、MongoDB 风格 API、append 持久化 + 自动压缩、启动自动加载。安装日志是高频追加的纯文本流，按任务落 `<jobId>.jsonl`，`fs.appendFile` 追加写，不进文档库。

备选：better-sqlite3——被否，原生编译在 Windows 存在工具链/ABI 风险；node:sqlite——被否，需 Node ≥ 22.5 与 engines `>=18` 冲突；sql.js——被否，手动全量导出的持久化模型；LokiJS/PouchDB——被否，停更/过重；手写 JSON——次选，原子写与压缩需自理，引入库可白得这些能力。

接口隔离：业务层只依赖 storage 模块导出的存取接口，未来更换引擎（如记录量涨到数万条换 SQLite 系）不动业务代码。

### D2. 数据布局与默认目录

```
%USERPROFILE%\.worktree-manager\settings.json      固定配置文件
<数据根目录>\nedb\jobs.db / worktree-history.db / recent-repos.db
<数据根目录>\job-logs\<jobId>.jsonl
```

数据根目录解析顺序：settings.json 记录值 → 默认 `D:\softwares\worktree-manager` → D 盘不存在时回退 `%USERPROFILE%\worktree-manager-data`。目录不存在时启动自动创建。

### D3. 配置生效语义：立即重建存储实例，不迁移历史数据

设置页修改数据目录后，服务端校验目标目录可创建 → 写 settings.json → 关闭并按新目录重建 nedb 实例，立即生效。历史数据保留在原目录，设置页文案明示"仅切换存储位置，不搬运历史数据"。配置文件自身固定于用户目录，因此切换数据目录不影响配置。

### D4. 任务持久化边界

createJob 时元数据入库、finishJob 时更新终态；appendJobLog 同步追加 jsonl。logListeners（SSE 回调集合）为运行时句柄，不落盘，与现有 serializeJob 字段口径一致。历史任务日志走 jsonl 按需读取；SSE 端点对历史任务先一次性推送全量再保持打开（兼容现有前端订阅逻辑）。

### D5. 崩溃恢复：启动扫描

服务启动、存储加载完成后，将 status=running 的任务批量更新为 interrupted，finishedAt 取扫描时刻（interrupted 亦属终态，字段口径不变）。本条同时废止 add-worktree-manager/design.md D5 的"无持久化需求"结论。

### D6. 最近主仓库：LRU-10 + 最后使用项

仓库校验成功时 upsert（path + lastUsedAt），超出 10 条淘汰最久未用；接口返回列表 + lastUsedPath。前端页面加载即取、自动回填，历史下拉一键切换；现阶段不引入 localStorage，以服务端记录为单一数据源（用户决策：后续仍可按需引入浏览器缓存加速回显）。

### D7. 创建历史：成功失败均记 + 手动清空

worktree create 执行后写入一条记录：repoPath、branchName、targetPath、dependencyStrategy、结果（成功/失败）、警告列表、时间，失败记录携带失败原因。失败记录帮助排查"哪次创建卡在哪一步"。永久保留，管理页提供清空按钮（需确认）。

### D8. 前端组织：repoPath 状态提升

创建页与管理页各自持有 repoPath 的现状改为提升至 App 层（或共享 hook），保证"切换主仓库"对两个页签同时生效，回填逻辑只写一处。

## Risks / Trade-offs

- [@seald-io/nedb 为社区维护分支（原版 NeDB 已停更）] → 存储接口已隔离（D1），必要时可替换引擎；依赖锁定已知可用版本
- [落盘失败（磁盘满/权限）] → 记录写入失败降级为响应 warning 与服务端日志，任务与 git 操作照常完成；用户可从 warning 察觉
- [NeDB 无跨进程锁] → 保持单实例使用约定（现状即单进程）；README 说明勿双开
- [用户目录 settings.json 被删] → 启动按默认链重建，数据本体在数据目录不受影响
- [历史日志文件累积增长] → 单任务日志为安装输出量级（MB 级），可接受；后续需要时再加按大小/时间清理

## Migration Plan

无数据迁移：原状态本就不跨重启。升级后首次启动自动建目录、初始化空库。回滚 = 还原代码 + 删除数据目录（或仅卸载依赖），被管理仓库零侵入不受影响。

## Open Questions

无 —— 引擎、布局、配置语义、恢复语义均已在探讨中拍板。
