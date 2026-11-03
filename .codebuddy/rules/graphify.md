# 查代码优先使用 graphify 知识图谱

本项目已通过 graphify 构建知识图谱，产物在 `graphify-out/`：

- `graph.json` — 完整图数据（462 节点 / 950 边 / 19 社区）
- `GRAPH_REPORT.md` — 人类可读指南（God Nodes 核心抽象、Community Hubs 模块导航、跨社区桥梁）
- `graph.html` — 交互式可视化

## 规则

1. **回答代码位置、架构、模块关系、影响面类问题时，先查图谱再 grep**：
   - 快速导航：先读 `graphify-out/GRAPH_REPORT.md` 的 "God Nodes" 与 "Community Hubs" 章节；
   - 精确查询：`/graphify query "问题"`、`/graphify path "A" "B"`、`/graphify explain "节点"`。
2. 图谱未覆盖的实现细节（具体代码行、最新未入图的改动）才回退到 grep / read_file。
3. 图谱是 2026-11-03 构建的快照；代码有较大改动后可执行 `graphify update .` 增量更新。

## 图谱速览（God Nodes）

`executeGitCommand()`（全系统 git 唯一入口）、`getJson()`/`postJson()`（前端 API 层）、`createWorktree()`/`removeWorktree()`（worktree 生命周期）、`persistenceManager`（NeDB 持久化）。
