# Spec Delta

## Purpose

在既有生命周期能力上补充创建历史留痕（持久化底座由本变更新增的 local-persistence 能力承载）。

## ADDED Requirements

### Requirement: 创建动作留痕

worktree 创建 SHALL 产生持久化历史记录（成功与失败均记录），字段含主仓库路径、分支、目标路径、依赖策略、结果、警告列表、时间与失败原因（如有）；记录写入失败 SHALL NOT 影响创建流程本身，以警告形式反馈。

#### Scenario: 记录失败不阻断创建

- **WHEN** 创建成功但历史记录写入失败（磁盘异常等）
- **THEN** 创建结果正常返回，响应中包含记录写入失败的警告
