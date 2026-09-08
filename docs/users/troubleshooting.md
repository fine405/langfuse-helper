# 排障与恢复

先运行 `npm run doctor`、`npm run service:status` 和 `npm run status`。前者检查环境，第二个看自动队列与具体错误，第三个保留底层到达统计。不要先删除数据库。

## 常见情况

| 现象 | 检查与处理 |
|---|---|
| 普通图标启动后没有新数据 | 退出 WorkBuddy，通过仓库中的 `npm start` 重开。插件持久安装不等于本次进程启用了采集 |
| 只有 synthetic，没有自己的任务 | synthetic 是通道测试。检查 Hook 新事件、新 Session 与原生 interaction；用新任务验收 |
| service.json 不存在/连接拒绝 | 服务未运行，Docker 与 Collector 就绪后执行 `npm run service:start`；详细启动错误用 `npm run service:foreground` |
| WorkBuddy 未完全退出 | 从应用菜单退出；启动脚本不会强制结束现有任务 |
| 插件文件 stale | 更新命令使用内置插件 API 并核对文件；确认仓库、marketplace 和安装版本对应，退出应用后重跑安装 |
| queue 暂时增加 | 可能是网络不可达或 Langfuse 拒绝。查看 faults，修正地址或项目密钥后等待重试 |
| waitingForNativeOrTranscript 有 ready | 可能在等最终任务记录，也可能是尚无原生任务步骤锚点的后台 Trace；队列为空且主任务 verify 通过时，辅助记录不需要强行上传 |
| pending / unassociated | 等原生 Session 锚点，或 WorkBuddy 辅助 span 没有主任务归属；不代表这些辅助记录都应上传 |
| 原生 ID 内容变化 | 编辑、重生成或价格/正文变化影响了已冻结记录，已隔离；不要删账本强行覆盖 |
| 任务路径或正文模式变化 | 当前 Session 已登记原设置。恢复设置继续，或用新任务应用新模式 |
| Token 未知或缓存校验失败 | 保留未知，不填零；核对当前 WorkBuddy/模型的数据格式是否已变化 |
| Trace 页面一直停留在早期记录 | 页面可能没有自动刷新，刷新后再核对完整树；这与 API 入库可见性分开判断 |
| Langfuse 一开始缺少父节点 | 子 span 可先到，根到整轮结束才导出；待入库后用 verify 核对完整结构 |
| 运行状态 quiet | 只是未见新活动；长工具、模型等待都可能出现，不等于错误 |

## 不确定发送

```bash
npm run recover
```

该命令只查询当前项目。结果为 accepted 时已找到恰好一条相同 ID、相同 deliveryDigest 的记录，会更新账本且不重发；unconfirmed 保留；conflict 需要人工核查重复 ID 或数据变化。

如果记录始终 unconfirmed，先核实 Langfuse 服务健康、异步处理队列已消化、查询项目和 trace ID 正确。短暂查不到不足以证明请求失败。只有你已确认未入库、愿意承担延迟入库导致重复的剩余风险时，才显式释放单条记录：

```bash
npm run recover -- --retry-confirmed-absent <traceId:spanId>
```

脚本会再次查询，且拒绝释放未满 5 分钟或有冲突的记录。释放后服务下一次发送周期重试。保留发送账本和核查记录；不要批量删库或盲目重传全部 Session。早期版本没有保存 payload/deliveryDigest 的不确定记录无法按新摘要自动确认，应保留并人工核查，不能直接当成成功。

## 手动预览和验证

```bash
npm run langfuse:upload -- <Session ID>
npm run langfuse:verify -- <Session ID>
```

第一个命令只做本地预览。历史任务需要人工选定并发送时才加 `--send`；它与自动发送共用账本。自动模式只登记启用后的任务，不自动回灌全部历史。verify 查询每个 Trace 的实际 observation，不会把 Session 字段缺失的错误记录从样本中排除。

测试与真实接入分开：`npm run test:langfuse` 会留下明确标记 synthetic 的真实入库测试记录；它不会消耗模型积分。WorkBuddy 桌面验收会正常调用你选定的模型并消耗相应积分。

## 本地数据损坏或目标变更

SQLite 错误、摘要冲突、Session 冲突都应保留现场。停止本地服务后备份数据，再分析错误，不能以清空队列作为“验收通过”。不要把 A 项目的旧队列直接换密钥发送到 B 项目；使用单独目录，或先完成 A 项目的恢复核对。

Collector 在原生 SDK 前不可达时，SDK 尚未持久化的记录可能丢失；后续看到缺少 observation 应报告采集缺口，不用猜测时间或正文补造。Hook 写入故障静默返回也可能导致未登记任务，需要新的正常 Hook 或新的验收任务。

[返回接入指南](getting-started.md) · [文档导航](../README.md)
