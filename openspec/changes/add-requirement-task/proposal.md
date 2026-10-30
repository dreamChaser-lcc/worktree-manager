# Proposal

## Why

worktree 工具解决的是"单个 worktree 怎么建、怎么管"，但用户的真实工作单位是"需求"：一个需求通常横跨多个项目仓库，各建一个同主题分支的 worktree 并行开发。目前需求与 worktree 的对应关系只存在于用户脑子里，换台电脑或隔几天就断了线索。需要以需求为维度维护一张任务列表（需求链接、分支名称、涉及项目及各自关联的 worktree、预留备注），支持查看与打开，让 worktree 能力真正服务于日常需求开发。

## What Changes

- 新增"需求任务"能力：以需求为单位 CRUD——需求链接、分支名称、涉及项目列表（项目名称 + 主仓库路径 + 关联 worktree）、预留备注字段
- 涉及项目的 worktree 下拉来自该仓库真实 worktree 列表；与需求分支同名的 worktree 自动预选
- 创建 worktree 表单新增可选"关联需求任务"：创建成功后自动把新 worktree 挂载到需求中主仓库匹配的项目条目（路径归一化匹配），挂载结果随响应返回
- 前端新增"需求任务"页签：列表（链接可点击、项目数、更新时间）+ 查看（展开项目/worktree 明细）+ 编辑/删除（两步确认）+ 打开（复用编辑器打开能力）
- 持久化：新增第 4 个 nedb 库 requirement-tasks.db，随数据根目录存储，纳入既有设置页目录切换能力

## Capabilities

### New Capabilities

- requirement-task: 需求任务的维护与查看——需求维度聚合分支与多项目 worktree，支持编辑校验、自动挂载与打开

### Modified Capabilities

- worktree-console: 创建表单新增可选关联需求任务下拉；新增"需求任务"页签入口

## Impact

- 代码：server 持久化管理器新增需求任务库与存取方法、新增 requirement-task-routes；worktree-routes 创建流程追加挂载步骤；web 新增 RequirementTaskForm / RequirementTaskPanel，CreateWorktreeForm 增加关联下拉
- 数据：数据目录下新增 requirement-tasks.db；对既有任务/历史/最近主仓库数据零影响
- 兼容：不传 requirementTaskId 时创建流程行为与之前完全一致
