# 验证记录

本机环境：WorkBuddy 5.5.3、Node.js 24.20.0、Docker Desktop；Collector Contrib 固定为 0.160.0，并固定镜像 digest。

**当前结论：阶段 1 未通过，阶段 2 未启动。** 2026-09-07 已由 Codex 操作真实桌面端完成两轮验收，结果见 [acceptance-2026-09-07.md](acceptance-2026-09-07.md)。独立引擎加载成功不足以证明桌面 worker 加载成功。

| 检查 | 结果 |
|---|---|
| Node 单元、Hook 与验收测试 | 11 项通过；新增缺少 Session / Hook、重复、单轮、模拟数据与辅助 Trace 的验收回归检查 |
| Collector 配置验证 | 通过 |
| 用户启动入口与本地预览 | doctor、collector:start、demo、status 通过；已实际运行 workbuddy:launch 并完成两轮桌面调用 |
| Collector 协议集成 | 通过：JSON → 标准 protobuf exporter → 正式接收管线 → 本地文件 |
| 原始 ID/父子关系/时间 | 模拟集成测试通过 |
| 用量计数 | 模拟的 4 个 spans 中只有 1 个 generation 携带用量；根、工具、model_request 不携带重复用量 |
| 内容过滤 | 测试中的正文、事件正文、span 名称正文、错误消息和资源身份未落盘 |
| WorkBuddy 内置引擎插件加载 | 通过：临时配置中发现并启用 workbuddy-langfuse@inline，manifest 有效，运行时只加载本插件的 6 个 Hook，0 个错误 |
| 重复 Hook 注册 | 已规避 5.5.3 的默认文件与显式配置重复合并；测试要求恰好 6 个 Hook，而不是 12 个 |
| 桌面端真实主任务 | 收到 2 条主 Trace、18 个 spans，其中 4 个 generation、2 个 tool、2 个 agent；0 个重复 span |
| 桌面 Session 完整性 | 未通过：同一会话的 6 个子 span 缺少 Session，包括两个 tool |
| 桌面 Hook | 未通过：实际 worker 缺少 CODEBUDDY_PLUGIN_DIRS，插件列表无本插件，测试 Session 无 Hook 记录 |
| 桌面真实时间 | 通过：实际执行 sleep 3，工具 span 记录 4543.14 ms，包含运行开销 |
| 自动结构验收 | 正确返回 passed=false、退出码 1；本地明细位于 .local/acceptance.phase1.json |
| Langfuse 写入 | 本阶段没有该功能 |

合成测试不调用模型、不消耗 WorkBuddy 推理额度，也不访问 Langfuse。插件加载测试使用临时配置目录；不会读取用户的会话内容。

兼容性发现：5.5.3 会先把 `hooks/hooks.json` 自动填入插件信息，再将默认文件与该配置合并，导致每个 Hook 注册两次。本插件改用 manifest 显式指定的 `hooks/events.json`，避开默认文件名；独立引擎测试已确认从 12 个降为 6 个。桌面端受另一项插件加载问题影响，本次未触发这些 Hook。
