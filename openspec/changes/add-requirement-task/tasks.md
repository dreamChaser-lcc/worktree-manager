# Tasks

## 1. 服务端

- [x] 1.1 持久化管理器新增 requirement-tasks.db 与存取方法（insert/update/find/list/delete），随数据目录切换重建
- [x] 1.2 需求任务 CRUD 路由与输入校验（需求链接/分支名称/项目名称/主仓库路径非空，项目至少一个，预留字段可选）
- [x] 1.3 创建 worktree 支持可选 requirementTaskId：成功后按归一化主仓库路径挂载到匹配项目条目，结果随响应返回；未传时行为不变
- [x] 1.4 API 测试：CRUD 全链路、三类校验 400、更新/删除 404、自动挂载成功、关联不存在任务时如实反馈（5 用例）

## 2. Web 前端

- [x] 2.1 RequirementTaskForm：需求链接/分支名称/动态项目块（项目名 + DirectoryPicker 主仓库 + worktree 下拉）/预留备注；worktree 下拉来自真实列表，同名分支自动预选，已删除关联标注
- [x] 2.2 RequirementTaskPanel：列表（链接可点击/项目数/更新时间）+ 查看展开明细 + 编辑 + 两步确认删除 + worktree 打开（复用编辑器打开）
- [x] 2.3 CreateWorktreeForm：可选"关联需求任务"下拉，创建结果展示挂载反馈
- [x] 2.4 App 新增"需求任务"页签；样式补充（无行内样式、不使用 gap）

## 3. 验证与交付

- [x] 3.1 vitest 全量通过（97/97）、前端 build 通过、lint 无错误
- [ ] 3.2 `openspec validate` 待装有 CLI 的环境补验
