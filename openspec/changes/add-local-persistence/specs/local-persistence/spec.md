# Spec Delta

## Purpose

为本工具提供不依赖数据库服务、无需原生编译的本地持久化能力：记录类数据落嵌入式文档库，安装日志按任务落追加文件，存放位置可配置。

## ADDED Requirements

### Requirement: 纯 JS 嵌入式存储

持久化 SHALL 使用纯 JavaScript 嵌入式存储（@seald-io/nedb）实现，SHALL NOT 引入需要原生编译的依赖，SHALL NOT 要求启动独立数据库服务。

#### Scenario: 安装即可运行

- **WHEN** 按 README 在全新机器执行依赖安装并启动服务
- **THEN** 无任何编译步骤，服务启动后持久化功能可用

#### Scenario: 重启后记录可查

- **WHEN** 服务停止后重新启动
- **THEN** 此前写入的任务记录、创建历史、最近主仓库目录仍可查询

### Requirement: 数据目录解析与回退

数据根目录 SHALL 按以下顺序解析：配置文件记录值 → 默认值 `D:\softwares\worktree-manager` → 默认值所在盘符不可用时回退 `%USERPROFILE%\worktree-manager-data`。目录不存在时 SHALL 自动创建。

#### Scenario: 默认目录生效

- **WHEN** 未修改过配置且 D 盘存在时启动服务
- **THEN** 数据写入 `D:\softwares\worktree-manager`

#### Scenario: 盘符缺失回退

- **WHEN** 机器不存在 D 盘且未修改过配置
- **THEN** 数据写入 `%USERPROFILE%\worktree-manager-data`

### Requirement: 任务记录持久化

任务元数据（id、名称、状态、退出码、创建与结束时间）SHALL 在创建与终态变更时写入持久存储；每个任务的完整输出日志 SHALL 以追加写文件保存。服务重启后历史任务的元数据与完整日志 SHALL 均可读取；运行时回调集合等不可序列化字段 SHALL NOT 落盘。

#### Scenario: 历史任务可查

- **WHEN** 服务重启后请求历史任务列表与某任务日志
- **THEN** 返回重启前创建任务的元数据与完整输出日志

#### Scenario: 任务进行中崩溃后日志保留

- **WHEN** 任务运行期间服务进程被终止后重启
- **THEN** 该任务已产生的日志可完整读取

### Requirement: 崩溃任务状态恢复

服务启动完成存储加载后，SHALL 将持久存储中状态为 running 的任务批量更新为 interrupted，并写入终态时间。

#### Scenario: 遗留 running 标记为中断

- **WHEN** 任务运行中服务被终止，随后服务重启
- **THEN** 该任务状态显示为 interrupted 且有终态时间

### Requirement: 最近主仓库记忆

系统 SHALL 记录主仓库目录的使用（路径 + 最近使用时间），保留最近 10 条并淘汰最久未用项，同时 SHALL 可返回最后使用的主仓库路径。

#### Scenario: 记录与淘汰

- **WHEN** 先后使用 11 个不同的主仓库目录完成仓库校验
- **THEN** 记录保留最近 10 条，最早使用的一条被淘汰

### Requirement: 创建历史记录

worktree 创建流程 SHALL 在执行后写入历史记录，包含主仓库路径、分支、目标路径、依赖策略、结果（成功/失败）、警告列表与时间；失败记录 SHALL 携带失败原因。记录永久保留，SHALL 支持手动清空。

#### Scenario: 成功创建产生记录

- **WHEN** 创建 worktree 全流程成功
- **THEN** 历史中新增一条成功记录，字段完整

#### Scenario: 创建失败产生记录

- **WHEN** 创建流程在任一步骤失败
- **THEN** 历史中新增一条失败记录并携带失败原因

### Requirement: 配置文件管理

配置文件 SHALL 固定位于 `%USERPROFILE%\.worktree-manager\settings.json`，保存数据目录等配置；配置文件缺失或损坏时 SHALL 按默认规则重建且不影响已落盘数据。修改数据目录 SHALL 校验目标路径可创建、写入配置并立即生效。

#### Scenario: 修改数据目录立即生效

- **WHEN** 用户在设置页将数据目录改为有效的新路径
- **THEN** 配置被保存，后续数据写入新目录，无需重启服务
