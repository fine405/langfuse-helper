# 第一阶段真实桌面验收：未通过

这是 0.1.0 的历史失败记录；修复后的通过结果见 [2026-09-08 验收](acceptance-2026-09-08.md)。

日期：2026-09-07，Asia/Shanghai。环境：本机 WorkBuddy 5.5.3；本地阶段 1 Collector。未启用 Langfuse exporter，未修改 WorkBuddy settings.json。

先确认引擎没有运行中的会话，再退出旧 WorkBuddy、使用项目诊断入口启动。在桌面端新建“WorkBuddy Langfuse 插件无敏感验收测试”，同一任务依次请求执行 `pwd`、`sleep 3`，分别收到 `WB_LF_PHASE1_001`、`WB_LF_PHASE1_002`。该测试任务的 JSONL 确认确实执行了两次 Bash 调用及其返回。

| 项目 | 真实结果 | 结论 |
|---|---|---|
| 两轮请求 | 2 条主 Trace，锚点均属于同一 Session | 通过 |
| 模型与工具覆盖 | 18 个 spans：2 个 agent、4 个 generation、2 个 tool、10 个辅助 span | 通过 |
| 重复采集 | 两条主 Trace 内重复 traceId/spanId 组合为 0 | 通过 |
| 工具耗时 | pwd 为 1922.31 ms；sleep 3 为 4543.14 ms，包含启动/执行开销 | 通过 |
| Session 完整性 | 每轮的 parse、execute、tool 均缺少 Session，共 6 个；step/interaction/model 已带 Session | 未通过 |
| Hook 加载与触发 | 桌面 worker 的 CODEBUDDY_PLUGIN_DIRS 缺失，实际插件列表无本插件，测试 Session 的 Hook 记录为 0 | 未通过 |
| 模型用量 | 转换后的 4 个 generation 均未取到 usage | 阶段 1 允许未知；阶段 2 计费前必须核验采集路径 |

本次只按测试 Session 的 interaction 选择主 Trace，再检查其所有子 span。启动过程、标题等辅助 Trace 不参与上述计数；也没有通过先剔除无 Session 的子 span 来降低缺失数量。

## 阻塞项与修复范围

1. **桌面插件加载路径需要调整。** 父进程设置开发目录不等于桌面 worker 实际保留。独立引擎的 `test:plugin` 只能证明插件格式和加载器兼容。后续应采用桌面支持的持久插件注册方式，并验证真实任务中的四类核心 Hook；不通过复制一个手工 Hook 事件文件来代替实际触发。
2. **子 span 需要按 traceId 补充 Session 关联。** 当前无状态字段重命名无法从完全不带 Session 的 tool/parse/execute 中恢复它。需从同一 Trace 的已知 Session 建立关联，并处理先后到达；不能假设一个接收批次只属于一个 Session，也不能直接借用最近一个会话。修复后复测并发会话，防止串线。

阶段 2 暂未开始，Langfuse 服务及项目数据未变更。接下来应先修复这两项，再运行同一组两轮桌面验收；通过后才增加正式上报。

## 可重复验证

新增 `npm run accept:phase1 -- <Session ID>`，任一检查失败返回非零退出码。本次结果为 `passed=false`；两个失败项是 `sessionOnEverySpan` 与 `hooksForBothTurns`。完整的本地结构结果保存在 `.local/acceptance.phase1.json`，不提交 Git。

`npm test` 的 11 项测试全部通过，其中回归用例确保缺少子 span Session 和 Hook 时仍判失败，并拒绝以模拟数据、单轮请求、重复 span 或某一次工具的重复 Hook 代替完整验收。工具 Hook 按 call ID 与原生 span 对照。自动测试通过与产品验收未通过是不同结论。
