# Spec Delta

## Purpose

以需求为维度聚合分支与多项目 worktree：维护需求任务列表（需求链接、分支名称、涉及项目、预留备注），并打通 worktree 创建到需求挂载的闭环，支持查看与打开。

## ADDED Requirements

### Requirement: 需求任务维护

系统 SHALL 提供需求任务的创建、编辑、删除能力，记录字段包含需求链接、分支名称、涉及项目列表（项目名称、主仓库路径、关联 worktree 路径）与预留备注字段。需求链接、分支名称与每个项目的名称/主仓库路径 SHALL 非空，涉及项目至少一个；删除 SHALL 经用户确认。

#### Scenario: 创建需求任务

- **WHEN** 用户填写需求链接、分支名称与至少一个涉及项目后保存
- **THEN** 列表出现该记录，字段与填写内容一致

#### Scenario: 校验失败不落库

- **WHEN** 用户未填写分支名称或项目缺少主仓库路径时保存
- **THEN** 界面提示具体缺失字段，记录不被保存

#### Scenario: 两步确认删除

- **WHEN** 用户点击删除并确认
- **THEN** 记录从列表移除且持久层同步删除

### Requirement: 关联 worktree 选择与自动预选

涉及项目的关联 worktree SHALL 从该主仓库的真实 worktree 列表中下拉选择；当需求分支名称与某 worktree 的分支一致且尚未关联时，SHALL 自动预选该 worktree（排除主仓库自身）。已关联但已不在列表中的 worktree SHALL 标注"可能已删除"。

#### Scenario: 同名分支自动预选

- **WHEN** 用户为项目选择主仓库且该仓库存在与需求分支同名的 worktree
- **THEN** 关联 worktree 下拉自动选中该 worktree

#### Scenario: 手动调整关联

- **WHEN** 用户在下拉中手动选择其他 worktree 或"未关联"
- **THEN** 保存后记录更新为用户选择的值

### Requirement: 创建 worktree 挂载需求任务

创建 worktree 时 SHALL 可选关联一个需求任务；创建成功后系统 SHALL 把新 worktree 挂载到该需求中主仓库匹配（路径归一化后相等）的项目条目，挂载结果 SHALL 随创建响应返回；主仓库不匹配或任务不存在时 SHALL 如实反馈且不影响创建结果。

#### Scenario: 自动挂载成功

- **WHEN** 用户创建 worktree 时选择了关联需求任务，且该需求存在主仓库匹配的项目条目
- **THEN** 创建成功后该项目条目的关联 worktree 更新为新 worktree 路径，界面提示挂载成功

#### Scenario: 主仓库不匹配如实反馈

- **WHEN** 关联的需求任务中不存在主仓库匹配的项目条目
- **THEN** 创建本身成功，响应与界面提示挂载未完成的原因

### Requirement: 需求任务查看与打开

界面 SHALL 支持展开查看需求任务明细（各项目的主仓库与关联 worktree），SHALL 支持点击需求链接跳转、对已关联 worktree 一键用编辑器打开；未关联的项目 SHALL 标注"未关联"。

#### Scenario: 展开查看明细

- **WHEN** 用户点击列表行的"查看"
- **THEN** 展开该需求的项目明细（项目名/主仓库/worktree 路径）与预留备注

#### Scenario: 打开关联 worktree

- **WHEN** 用户点击某项目行的"打开"
- **THEN** 系统请求编辑器打开该 worktree 目录并反馈结果
