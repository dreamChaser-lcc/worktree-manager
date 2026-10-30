# Spec Delta

## Purpose

让新创建的 worktree 不必重新下载依赖即可运行：通过自动检测项目的包管理器给出共享策略推荐，支持 junction 共享主目录依赖、利用包管理器缓存独立安装、以及不处理三种方式，由用户在界面上确认或覆盖。

## ADDED Requirements

### Requirement: 按包管理器自动推荐依赖策略

系统 SHALL 在创建 worktree 时读取主仓库根目录的 lockfile 判定包管理器类型，并据此给出默认推荐策略：

- 检测到 `pnpm-lock.yaml` → 推荐"独立安装"（利用 pnpm 全局 store 硬链接，近似零额外磁盘且各 worktree 依赖隔离）
- 检测到 `package-lock.json` 或 `yarn.lock` → 推荐"junction 共享主目录"
- 未检测到任何 lockfile → 不给出默认策略，提示用户手选，并说明主目录需先完成一次依赖安装

用户 SHALL 始终可以手动覆盖推荐策略。

#### Scenario: pnpm 项目推荐独立安装

- **WHEN** 主仓库根目录存在 pnpm-lock.yaml
- **THEN** 依赖策略区默认选中"独立安装"

#### Scenario: npm 项目推荐 junction 共享

- **WHEN** 主仓库根目录存在 package-lock.json
- **THEN** 依赖策略区默认选中"共享主目录"

#### Scenario: 无 lockfile 时提示手选

- **WHEN** 主仓库根目录不存在任何已知 lockfile
- **THEN** 依赖策略区无默认选中项，并展示需要用户选择的提示

### Requirement: junction 共享主目录依赖

用户选择"共享主目录"时，系统 SHALL 在新 worktree 目录创建指向主仓库 node_modules 的目录联接（Windows 使用 junction）。执行前系统 SHALL 校验主仓库 node_modules 存在，不存在则拒绝并提示先在主目录安装依赖。

#### Scenario: 共享链接创建成功

- **WHEN** 用户选择共享主目录且主仓库 node_modules 存在
- **THEN** worktree 目录内出现指向主仓库 node_modules 的链接，且在链接内可读取到依赖文件

#### Scenario: 主目录缺少 node_modules

- **WHEN** 用户选择共享主目录但主仓库尚未安装依赖
- **THEN** 系统拒绝执行链接并提示先在主目录完成安装，worktree 本身的创建不受影响

#### Scenario: 主目录与目标路径不在同一磁盘卷

- **WHEN** 主仓库与目标路径位于不同磁盘卷
- **THEN** 系统拒绝共享策略并说明跨卷无法建立有效联接，建议改用独立安装

### Requirement: 独立安装依赖

用户选择"独立安装"时，系统 SHALL 在 worktree 创建完成后，使用该包管理器的缓存/store 在 worktree 内执行依赖安装，且安装过程 SHALL 以异步任务方式执行，进度日志可实时查看。

#### Scenario: 独立安装成功

- **WHEN** 用户选择独立安装且安装命令执行成功
- **THEN** worktree 内生成独立的 node_modules，主仓库依赖不受影响

#### Scenario: 安装过程实时可见

- **WHEN** 独立安装任务执行中
- **THEN** 界面实时展示安装命令的输出日志，结束后呈现成功或失败结果

### Requirement: 不处理依赖

用户选择"不处理"时，系统 SHALL 跳过所有依赖相关操作，仅完成 worktree 创建。

#### Scenario: 跳过依赖处理

- **WHEN** 用户选择"不处理"
- **THEN** 创建流程不含任何依赖操作，界面提示该 worktree 需自行安装依赖
