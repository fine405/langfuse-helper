# 排障与恢复

先运行 `langfuse-helper workbuddy status`，查看连接、上报状态和异常。修改连接参数请使用 `langfuse-helper workbuddy configure`。

所有命令都可以在任意目录执行。`langfuse-helper workbuddy doctor` 检查环境，`langfuse-helper workbuddy status --json` 查看完整队列和错误，`langfuse-helper workbuddy diagnose` 查看底层到达统计。不要先删除数据库。

## 常见情况

| 现象 | 检查与处理 |
|---|---|
| 普通图标启动后没有新数据 | 退出 WorkBuddy，通过 `langfuse-helper workbuddy start` 重开。插件持久安装不等于本次进程启用了采集 |
| 只有 synthetic，没有自己的任务 | synthetic 是模拟记录。检查 Hook 新事件、新 Session 与原生 interaction；新建任务后查看对应 Session |
| service.json 不存在/连接拒绝 | 服务未运行，使用 `langfuse-helper workbuddy start` 启动完整接入；用 `langfuse-helper workbuddy serve` 前台运行上报服务以查看错误，Ctrl+C 退出 |
| WorkBuddy 未完全退出 | 从应用菜单退出；启动脚本不会强制结束现有任务 |
| 插件文件 stale | 更新命令使用内置插件 API 并核对文件；退出 WorkBuddy、运行 `langfuse-helper workbuddy stop`，用 npm 更新后重新 `start` |
| queue 暂时增加 | 可能是网络不可达或 Langfuse 拒绝。查看 faults，通过配置向导修正地址或项目密钥，然后重新启动接入 |
| waitingForNativeOrTranscript 有 ready | 可能在等最终任务记录，也可能是尚无原生任务步骤锚点的后台 Trace；队列为空且主任务 verify 通过时，辅助记录不需要强行上传 |
| pending / unassociated | 等原生 Session 锚点，或 WorkBuddy 辅助 span 没有主任务归属；不代表这些辅助记录都应上传 |
| 原生 ID 内容变化 | 编辑、重生成或价格/正文变化影响了已冻结记录，已隔离；不要删账本强行覆盖 |
| 任务路径或正文模式变化 | 当前 Session 已登记原设置。恢复设置继续，或用新任务应用新模式 |
| Token 未知或缓存校验失败 | 保留未知，不填零；核对当前 WorkBuddy/模型的数据格式是否已变化 |
| Trace 页面一直停留在早期记录 | 页面可能没有自动刷新，刷新后再核对完整树；这与 API 入库可见性分开判断 |
| Langfuse 一开始缺少父节点 | 子 span 可先到，根到整轮结束才导出；待入库后用 verify 核对完整结构 |
| 运行状态 quiet | 只是未见新活动；长工具、模型等待都可能出现，不等于错误 |

## 配置与安装问题

- 通过配置向导修改 `~/.workbuddy/langfuse.json`；修改后重新启动接入使设置生效。
- 提示 JSON 错误时，检查文件语法；错误提示不会打印密钥。
- 提示项目与账本不匹配时，原配置保持不变。请核对项目密钥，不要清空账本。
- 更新前先退出 WorkBuddy 并运行 `langfuse-helper workbuddy stop`；npm 不会自动停止运行中的服务。
- npm 提示权限不足时，使用当前用户可写的 Node.js/npm 安装位置；不要用强制覆盖来处理未知的同名命令。
- 找不到命令时，运行 `npm config get prefix`，确认该目录下的 `bin` 已加入 PATH，然后重新打开终端。运行 `command -v langfuse-helper` 确认命令位置。

## 不确定发送

```bash
langfuse-helper workbuddy recover
```

该命令只查询当前项目。结果为 accepted 时已找到恰好一条相同 ID、相同 deliveryDigest 的记录，会更新账本且不重发；unconfirmed 保留；conflict 需要人工核查重复 ID 或数据变化。

如果记录始终 unconfirmed，先核实 Langfuse 服务健康、异步处理队列已消化、查询项目和 trace ID 正确。短暂查不到不足以证明请求失败。只有你已确认未入库、愿意承担延迟入库导致重复的剩余风险时，才显式释放单条记录：

```bash
langfuse-helper workbuddy recover --retry-confirmed-absent <trace-id:span-id>
```

脚本会再次查询，且拒绝释放未满 5 分钟或有冲突的记录。释放后服务下一次发送周期重试。保留发送账本和核查记录；不要批量删库或盲目重传全部 Session。

## 手动预览和入库核对

```bash
langfuse-helper workbuddy export <session-id>
langfuse-helper workbuddy verify <session-id>
```

第一个命令只做本地预览。历史任务需要人工选定并发送时才加 `--send`；它与自动发送共用账本。自动模式只登记启用后的任务，不自动回灌全部历史。verify 查询每个 Trace 的实际 observation，核对 ID、层级、时间、用量和正文等字段。

## 本地数据损坏或目标变更

SQLite 错误、摘要冲突、Session 冲突都应保留现场。停止本地服务后备份数据，再分析错误，不要通过清空队列隐藏问题。不要把 A 项目的队列直接换密钥发送到 B 项目；为新项目配置独立的数据目录，或先完成 A 项目的恢复核对。

Collector 在原生 SDK 前不可达时，SDK 尚未持久化的记录可能丢失；后续看到缺少 observation 应报告采集缺口，不用猜测时间或正文补造。Hook 写入故障静默返回也可能导致任务未登记；处理写入问题后，新建任务检查是否恢复采集。

[返回接入指南](getting-started.md) · [文档导航](../README.md)
