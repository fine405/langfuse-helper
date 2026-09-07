# 验证记录

本机环境：WorkBuddy 5.5.3、Node.js 24.20.0、Docker Desktop；Collector Contrib 固定为 0.160.0，并固定镜像 digest。

| 检查 | 结果 |
|---|---|
| Node 单元与 Hook 测试 | 6 项通过：未知/零用量、重复记录暴露、半行、内容白名单、静默失败、12 路并发 |
| Collector 配置验证 | 通过 |
| 用户启动入口与本地预览 | doctor、collector:start、demo、status 通过：1 条合成 Trace、4 个 spans、0 个重复 ID、0 个缺失 Session；真实数据尚为 0 |
| Collector 协议集成 | 通过：JSON → 标准 protobuf exporter → 正式接收管线 → 本地文件 |
| 原始 ID/父子关系/时间 | 模拟集成测试通过 |
| 用量计数 | 模拟的 4 个 spans 中只有 1 个 generation 携带用量；根、工具、model_request 不携带重复用量 |
| 内容过滤 | 测试中的正文、事件正文、span 名称正文、错误消息和资源身份未落盘 |
| WorkBuddy 内置引擎插件加载 | 通过：临时配置中发现并启用 workbuddy-langfuse@inline，manifest 有效，运行时只加载本插件的 6 个 Hook，0 个错误 |
| 重复 Hook 注册 | 已规避 5.5.3 的默认文件与显式配置重复合并；测试要求恰好 6 个 Hook，而不是 12 个 |
| 桌面端真实主任务 | 等待用户按 phase-1.md 验证；未宣称通过 |
| Langfuse 写入 | 本阶段没有该功能 |

合成测试不调用模型、不消耗 WorkBuddy 推理额度，也不访问 Langfuse。插件加载测试使用临时配置目录；不会读取用户的会话内容。

兼容性发现：5.5.3 会先把 `hooks/hooks.json` 自动填入插件信息，再将默认文件与该配置合并，导致每个 Hook 注册两次。本插件改用 manifest 显式指定的 `hooks/events.json`，避开默认文件名；真实引擎测试已确认从 12 个降为 6 个。桌面端是否按预期触发仍需验收。
