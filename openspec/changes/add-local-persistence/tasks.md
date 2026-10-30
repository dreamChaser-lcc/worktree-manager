# Tasks

## 1. 存储层（server/src/storage）

- [x] 1.1 引入 @seald-io/nedb 依赖，验证纯 ESM 导入、实例化与落盘可用（锁定 ^4.1.2，纯 JS 零编译）
- [x] 1.2 实现 settings 读写：用户目录 settings.json（原子写），数据目录解析链（配置值 → `D:\softwares\worktree-manager` → 用户目录回退）与目录自动创建；损坏/缺失时按默认重建；单测覆盖默认/回退/自定义/损坏重建
- [x] 1.3 实现三个 nedb 库初始化（jobs / worktree-history / recent-repos）与必要索引；测试覆盖"写入 → 进程内重开 → 记录恢复"
- [x] 1.4 实现 job-logs JSONL 追加写与按需全量读取；测试覆盖追加、跨实例读取
- [x] 1.5 实现启动崩溃扫描：running → interrupted（finishedAt=扫描时刻）；测试覆盖

## 2. 任务持久化接入

- [x] 2.1 job-runner：createJob 入库、finishJob 更新终态、appendJobLog 追加 jsonl；logListeners 不落盘；落盘失败降级为 warning 不阻断任务
- [x] 2.2 task-routes：任务详情/日志查询兼容历史任务（内存 miss 时查库/读文件）；新增任务列表接口；SSE 对历史任务先推全量（事件格式与运行任务一致）
- [x] 2.3 接口测试："创建任务 → 完成 → 查列表/详情/日志"全链路 + 存储层"跨实例（模拟重启）恢复"测试，含 running 中断恢复

## 3. 记录接入业务

- [x] 3.1 worktree-routes：创建成功/失败写 worktree-history（失败含原因），写失败降级 warning；接口测试覆盖成功/失败路径
- [x] 3.2 recent-repos：仓库校验成功时 upsert（LRU-10 淘汰）；GET /api/recent-repos 返回列表与 lastUsedPath；接口测试覆盖记录、淘汰、返回
- [x] 3.3 settings API：GET / PUT（目标路径可创建校验、保存配置、重建存储实例立即生效、不迁移历史数据）；接口测试覆盖校验失败与修改成功

## 4. Web 前端

- [x] 4.1 repoPath 状态提升至 App 层，两页签同步；页面加载时 GET 最近仓库自动回填，历史下拉一键切换（RecentRepoBar 组件）
- [x] 4.2 设置页（新页签 SettingsPanel）：展示/修改数据目录、校验反馈、生效提示与"不迁移历史数据"文案
- [x] 4.3 任务历史面板（新页签 TaskHistoryPanel）：任务列表（名称/状态/时间）+ 选中查看完整日志（历史任务走全量接口）
- [x] 4.4 创建历史区块（管理页 CreationHistoryPanel）：列表展示（时间/主仓库/分支/目标路径/结果）+ 两步确认清空
- [x] 4.5 走查：真实启动服务冒烟——数据目录自动落 `D:\softwares\worktree-manager`、新接口返回正常、前端 build 通过

## 5. 交付

- [x] 5.1 README 增补：数据与持久化章节（数据目录、配置文件位置、勿双开单实例提示）
- [ ] 5.2 回归：vitest 全量通过（92/92）、前端 build 通过；`openspec validate` 待装有 CLI 的环境补验
