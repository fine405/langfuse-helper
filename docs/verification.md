> 历史阶段记录。当前完整接入请使用 [接入指南](getting-started.md)；后续功能与最终结果见 [完整验收](acceptance-phase3-2026-09-08.md)。

# 验证记录

环境：WorkBuddy 5.5.3、Node.js 24.20.0、Docker Desktop。Collector Contrib 0.160.0 与 Node 24.20.0 Alpine 镜像均固定 digest。

**阶段 1 修复后通过（2026-09-08）**。两轮真实桌面任务的详细证据见 [acceptance-2026-09-08.md](acceptance-2026-09-08.md)；原失败记录保留在 [acceptance-2026-09-07.md](acceptance-2026-09-07.md)。

| 检查 | 结果 |
|---|---|
| Node 测试 | 16 项通过：诊断统计、验收判定、Hook opt-in、跨会话交错/跨批/重启关联、冲突撤回、重复可见、非法批次原子回滚 |
| Collector 协议集成 | 通过：JSON → 标准 protobuf exporter → 正式 Collector 转换 → OTLP JSON → SQLite 关联器 |
| 原始 ID/父子关系/时间 | 集成检查全部保留 |
| 子 span Session | 原始工具缺少 Session；SQLite 中通过同一 traceId 补齐并标记 origin=trace-id |
| 用量过滤 | 模拟链路只有 model_stream/generation 保留用量，根、工具、model_request 不重复计数 |
| 内容过滤 | 正文、事件正文、span 名称正文、错误消息和资源身份未进入文件或数据库 |
| 持久插件安装 | 临时配置中安装、引擎重启后不带开发目录变量仍启用、恰好 6 个 Hook、卸载通过 |
| 用户实际配置 | 安装到 WorkBuddy 用户配置后，真实桌面 worker 已触发本插件 Hook |
| 真实两轮桌面任务 | 2 条主 Trace、18 个 spans、0 个 Session 缺失、0 个重复 |
| 四类核心 Hook | UserPromptSubmit / PreToolUse / PostToolUse / Stop 各 2 次，工具 call ID 精确对应 |
| 真实耗时 | sleep 3 工具记录 4586.95 ms，包含执行开销 |
| 自动结构验收 | passed=true，退出码 0；本地记录 .local/acceptance.phase1-fixed.json |
| Langfuse 写入 | 阶段 1 没有该功能；真实 usage 未取得，保持未知 |

合成与独立引擎测试不调用模型、不消耗推理额度、不访问 Langfuse。真实桌面验收使用两条无敏感信息的测试请求。

5.5.3 兼容性：位置参数形式的插件 CLI 命令存在参数错位，安装脚本使用临时认证引擎的插件 API；桌面 worker 不保留 CODEBUDDY_PLUGIN_DIRS，因此必须持久注册。默认 hooks/hooks.json 与 manifest 配置可能被合并两次，本插件显式指定 hooks/events.json，并要求重启后的运行时恰好注册 6 个 Hook。

## 第二阶段 A（0.2.0）

追加的真实写入验收见 [阶段 2A 记录](acceptance-phase2a-2026-09-08.md)。总计 20 项自动测试通过；14 条远端 observation 的层级、时间、Session 与 Token 全部匹配，重复上传新增 0 条。正文选择、缓存与费用仍待阶段 2B。
