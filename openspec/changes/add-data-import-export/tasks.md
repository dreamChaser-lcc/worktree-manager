# Tasks

> 后续任务清单：数据一键导入导出。归档格式与导入策略见 proposal.md；实现前先定稿 `.wtm-data.json` 的 `formatVersion: 1` 结构。

## 1. 服务端

- [ ] 1.1 归档结构定义：`{ formatVersion, exportedAt, counts, tables: { jobRecords, creationHistory, requirementTasks, recentRepos }, jobLogs? }`；版本常量与类型校验收敛到单一模块
- [ ] 1.2 导出接口 `GET /api/data/export?includeLogs=false`：聚合四类业务数据（可选含任务日志）→ 返回文件下载（Content-Disposition: worktree-manager-data-<日期>.wtm-data.json）
- [ ] 1.3 归档校验：JSON 可解析、formatVersion 存在且 ≤ 当前支持版本、必需表字段齐全；不通过返回 400 并说明具体问题
- [ ] 1.4 导入接口 `POST /api/data/import`：body 携带归档内容与策略（merge / overwrite）
  - [ ] 1.4.1 merge（默认）：按记录 id 去重，同 id 冲突保留本地较新（updatedAt / finishedAt 比较）；返回各表导入/跳过条数
  - [ ] 1.4.2 overwrite：先将当前四类数据与 job-logs 备份到数据目录 `backup/<时间戳>/`，再清空写入；备份失败则中止导入
- [ ] 1.5 导入一致性：服务运行中导入不触碰内存运行态（运行中任务不受影响）；持久层写入走既有 persistenceManager，导入后无需重启
- [ ] 1.6 API 测试：导出结构完整性、merge 去重与冲突保留、overwrite 备份生成与数据替换、损坏/高版本归档 400、空归档导入幂等

## 2. Web 前端

- [ ] 2.1 设置页新增「数据管理」区块：导出（含"包含任务日志"勾选，默认不含）→ 浏览器下载；loading 沿用 usePendingActions
- [ ] 2.2 导入流程：文件选择 → 前端解析概览（格式版本、导出时间、各表条数）→ 策略选择（合并去重默认 / 覆盖需二次勾选确认）→ 确认弹窗执行
- [ ] 2.3 导入结果反馈：各表导入/跳过条数；overwrite 模式展示备份目录路径；提示"记录中的绝对路径跨机器可能失效，请核对需求任务与最近主仓库"
- [ ] 2.4 设置页文案说明 backup 目录用途，避免用户误认为垃圾文件

## 3. 验证与交付

- [ ] 3.1 `npm test` 全量通过；前端 build 通过；lint 无错误
- [ ] 3.2 真实数据走查：导出 → 清空环境 → 导入（merge 与 overwrite 各一次）→ 需求任务列表/任务记录/创建历史/最近主仓库完整还原
- [ ] 3.3 README（数据与持久化、后续规划）与应用内「使用指南」补充导入导出说明
