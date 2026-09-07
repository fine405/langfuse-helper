# 第一阶段验收

目标：确认真实 WorkBuddy 桌面任务的原生埋点覆盖与 Hook 加载，不向 Langfuse 写数据。

最近一次[真实桌面验收](acceptance-2026-09-07.md)未通过。已确认模型、工具及两轮 Trace；插件加载与子 span Session 仍阻塞阶段 2。

先按 README 启动 Collector，通过诊断入口启动 WorkBuddy，并在同一个新任务中完成两次请求。使用无敏感信息的测试内容。

| 检查 | 通过条件 | 未通过意味着什么 |
|---|---|---|
| 环境 | doctor 的 WorkBuddy、Node、Docker 检查通过 | 修复环境后再做任务验证 |
| 接收通道 | demo 后 synthetic 出现 4 个 spans | Collector 未启动、端口不一致或转换失败 |
| 主任务覆盖 | native 中出现 interaction/agent、model_stream/generation、实际使用的 tool | 只有辅助调用不算通过，需要检查桌面 worker 是否导出 |
| Session | 两轮主任务对应同一个 Session，且这两条主 Trace 的每个子 span 都带该 Session | 存在缺失或不匹配的会话字段，下一阶段前补映射；不能先按 Session 过滤后再计算缺失数 |
| Turn | 两次用户输入对应两条主任务 Trace | 标题等辅助 Trace 可能额外出现；不能机械要求全局 traces 恰好为 2 |
| 真实时间 | 3 秒工具的 span 耗时符合实际 | 工具 span 或关联未完整采集 |
| Hook | 同一测试 Session 的 UserPromptSubmit、Stop 各 2 次；每个实际工具 call ID 恰好匹配一次 PreToolUse 与 PostToolUse | 环境未继承、插件未加载、Hook 未触发、缺少关联 ID 或重复注册 |
| 用量 | 有 usage 则记录并检查；没有则保留未知 | 第一阶段允许缺失，必须在第二阶段验证成本前解决 |
| 重复 | `duplicateIdentities=0` | 有双重导出、重试或 ID 重复；本阶段只暴露问题，不掩盖它 |

`npm run status` 是聚合统计。如果要核对具体 span，可本地打开 `.local/collector/traces.jsonl`，按 `langfuse.session.id` 和 `span.type` 找到测试主任务。字段转换保留了 traceId、spanId、parentSpanId 和原始纳秒时间。

自动执行结构验收：`npm run accept:phase1 -- <Session ID>`。先按 Session 找到 `interaction`，再按其 traceId 收集全部子 span；无关辅助 Trace 不参与主任务验收。该命令不读取 WorkBuddy transcript，也不调用模型或上传数据。命令退出码 0 表示所列结构检查通过，1 表示未通过或输入错误；还需结合桌面执行结果确认工具实际执行的内容。

验证反馈建议提供 `npm run status` 的统计结果，以及是否看到了工具 Hook。不要直接分享完整 WorkBuddy 启动日志。

故障排查顺序：

1. native 为 0：确认 WorkBuddy 完全退出后由本项目入口启动，而不是复用了旧进程。
2. synthetic 也为 0：运行 `docker compose -f collector/compose.yaml logs --tail 50` 检查接收端。
3. Hook 有、native 无：开发目录加载有效，但原生 exporter 尚未到达本机，检查主任务模式、worker 和环境继承。
4. native 有、Hook 无：检查 Node 是否可执行、插件目录加载和 Hook 支持；这两条采集路径相互独立。
5. 同时存在其他 WorkBuddy worker：先只用一个新任务验证，记录多 worker 情况，避免将辅助引擎数据当作主任务。

阶段边界：这版不是完整 Langfuse 上报器，不包含 JSONL 轨迹重建、持久发送队列、运行中卡顿判定或历史补传。阶段 1 的验证结果决定阶段 2 是否继续用原生 OTLP，或增加必要的 transcript 适配。
