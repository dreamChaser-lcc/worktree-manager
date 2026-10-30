# Spec Delta

## Purpose

让用户对一个 git 仓库的多个 worktree 进行全生命周期管理：创建、查看、删除、清理，并在每一步通过前置校验与安全拦截避免误操作破坏工作成果。

## ADDED Requirements

### Requirement: 从主仓库创建 worktree

系统 SHALL 支持用户指定主仓库目录、目标路径与分支策略来创建 worktree。分支策略分为两种：签出已有分支，或基于指定起点（默认当前 HEAD，可选其他 ref）新建分支。创建前系统 SHALL 依次执行前置校验，任一不通过即拒绝创建并给出明确原因：

1. 主仓库目录必须是有效 git 仓库
2. 目标路径必须不存在（或为空目录）
3. 目标路径不得位于主仓库工作目录内部
4. 所选分支不得已被其他 worktree 签出
5. 分支名合法且不与已有分支冲突（新建分支时）

#### Scenario: 使用已有分支创建成功

- **WHEN** 用户选择主仓库与一个未被占用的已有分支，并给出有效目标路径
- **THEN** 系统在该路径创建 worktree 并签出该分支，返回创建结果

#### Scenario: 新建分支创建成功

- **WHEN** 用户选择"新建分支"，填写合法分支名与起点 ref
- **THEN** 系统基于该起点创建分支并在此 worktree 中签出

#### Scenario: 目标路径已存在且非空

- **WHEN** 用户填写的目标路径已存在且包含文件
- **THEN** 系统拒绝创建，并提示路径被占用

#### Scenario: 目标路径位于主仓库内部

- **WHEN** 用户填写的目标路径是主仓库工作目录的子路径
- **THEN** 系统拒绝创建，并说明嵌套 worktree 会污染 git 状态

#### Scenario: 主目录不是 git 仓库

- **WHEN** 用户选择的主目录没有 git 仓库
- **THEN** 系统拒绝创建，并提示该目录不是有效仓库

#### Scenario: 分支已被其他 worktree 占用

- **WHEN** 用户选择的分支已经签出在另一个 worktree 中
- **THEN** 系统拒绝创建，并指出该分支被占用的 worktree 路径

### Requirement: 列出仓库的全部 worktree

系统 SHALL 支持查询指定主仓库下的全部 worktree，每条记录至少包含：路径、分支名、HEAD 摘要、工作区是否有未提交修改（脏状态）。

#### Scenario: 查看列表

- **WHEN** 用户选择一个 git 仓库查看其 worktree 列表
- **THEN** 系统返回该仓库全部 worktree（含主 worktree）及其状态信息

#### Scenario: 仓库无任何链接 worktree

- **WHEN** 指定仓库只有主 worktree 本身
- **THEN** 系统正常返回仅含主 worktree 的列表，不报错

### Requirement: 删除 worktree 带安全拦截

系统 SHALL 支持删除指定 worktree，并在删除前执行安全检查：

- 工作区存在未提交修改时，SHALL 默认拒绝删除，仅在用户显式确认强制删除后才执行
- 分支存在未合并到默认分支的提交时，SHALL 向用户提示未合并提交数量
- 主 worktree 本身 SHALL 永远不可被删除

#### Scenario: 删除干净的 worktree

- **WHEN** 目标 worktree 无未提交修改且用户确认删除
- **THEN** 系统移除该 worktree 目录及其 git 记录

#### Scenario: 有未提交修改时默认拦截

- **WHEN** 目标 worktree 存在未提交修改且用户未显式确认强制删除
- **THEN** 系统拒绝删除并列出未提交内容摘要

#### Scenario: 强制删除需显式确认

- **WHEN** 目标 worktree 存在未提交修改且用户明确选择强制删除
- **THEN** 系统丢弃该 worktree 的本地修改并完成删除

#### Scenario: 分支有未合并提交时提示

- **WHEN** 目标 worktree 所在分支领先默认分支若干提交
- **THEN** 系统在删除前提示未合并提交数量，由用户决定是否继续

#### Scenario: 主 worktree 不可删除

- **WHEN** 用户尝试删除主仓库本身所在的 worktree
- **THEN** 系统直接拒绝，不做任何删除动作

### Requirement: 删除时可一并清理磁盘目录

删除 worktree 时系统 SHALL 默认连同磁盘目录一起清理：使用链接感知方式删除目录（目录链接仅断开链接本身，绝不深入链接目标删除内容），并通过 prune 清理 git 记录。系统 SHALL NOT 在默认路径使用 git 原生递归删除——其实测会跟随目录联接破坏共享依赖内容。用户 SHALL 可以关闭该行为，关闭后使用 git 原生删除，目录与记录按 git 原生结果处理。

#### Scenario: 默认清理目录且记录被清

- **WHEN** 用户删除一个 worktree 且未关闭"一并清理目录"
- **THEN** 磁盘目录被删除、git 记录被清理，返回删除成功

#### Scenario: 关闭一并清理时保留 git 原生行为

- **WHEN** 用户关闭"一并清理目录"
- **THEN** 系统执行 git 原生删除，目录与记录按 git 原生结果处理

#### Scenario: 链接目标内容不受影响

- **WHEN** 清理删除了含目录联接（如共享主目录依赖的 node_modules）的 worktree 目录
- **THEN** 联接指向的主仓库目录内容保持完整

### Requirement: 清理失效的 worktree 记录

系统 SHALL 支持 prune 操作，移除目标路径已不存在的失效 worktree 元数据。

#### Scenario: 清理失效记录

- **WHEN** 用户对指定仓库执行 prune，且存在目录已被手动删除的 worktree 记录
- **THEN** 系统清除这些失效记录并报告清理数量

#### Scenario: 无失效记录

- **WHEN** 用户对指定仓库执行 prune 且所有 worktree 记录均有效
- **THEN** 系统报告清理数量为 0，不产生副作用
