# 第二阶段 A 验收：元数据与 Token 通过

日期：2026-09-08，Asia/Shanghai。版本：0.2.0。WorkBuddy 5.5.3、Node 24.20.0、Collector 0.160.0、本机 Langfuse v4，目标项目 Codex Local。

桌面任务“WorkBuddy Langfuse 第二阶段用量验收”在同一 Session 内只执行 pwd、sleep 3，分别完成 WB_LF_USAGE_001、WB_LF_USAGE_002。另一次因自动输入未完整保留而取消的测试任务未参与上传或验收。

| 检查 | 结果 |
|---|---|
| 原生结构 | 2 条主 Trace、14 个 spans：4 generation、2 tool、2 agent、6 辅助 span |
| Session 与重复 | Session 缺失 0，重复 ID 0，四类核心 Hook 各 2 次 |
| 原生模式差异 | agentlens 过滤了 4 个 model_request，因而比阶段 1 少 4 个 spans；实际模型调用未减少 |
| 工具耗时 | pwd 1847.30 ms；sleep 3 4685.91 ms |
| 首次上传 | HTTP 已接收 14 条 |
| 实际入库 | v2 observations 按两条 Trace 取回恰好 14 条，Session、类型、层级、原始时间与模型别名全部一致 |
| Token | 4 次 generation 均取得实际用量，与指定测试任务 JSONL 的 4 条 message.usage 逐项一致 |
| 正文 | 远端明确读取的 input/output 字段全部为空 |
| 再次上传 | uploaded=0、skipped=14；再次查询仍为 14 条，用量不变 |

| 模型调用 | WorkBuddy 输入/输出 | Langfuse 输入/输出 |
|---|---|---|
| 第一轮工具前 | 33328 / 87 | 33328 / 87 |
| 第一轮工具后 | 33467 / 8 | 33467 / 8 |
| 第二轮工具前 | 34114 / 24 | 34114 / 24 |
| 第二轮工具后 | 34171 / 8 | 34171 / 8 |
| 合计 | 135080 / 127 | 135080 / 127 |

根节点修正：两个 interaction 都带有未导出的外层父 ID。上传时建立明确的 Trace 根，并把原父 ID 保存在 metadata.nativeParentSpanId；内部层级与原 ID/时间未变。本地诊断记录未被修改。

远端验证显式请求 basic,time,usage,model,io 字段；缺少字段不能当作“用量为 0”或“没有正文”。模型字段在公共 API 中名为 model。第一次验证因只取默认字段而报告失败；修正查询与验证器后全部通过，没有因此重复上传。

本地证据：.local/acceptance.phase2-structure.json、.local/acceptance.phase2-langfuse.json、.local/acceptance.phase2-repeat.json。均不提交 Git，不包含提示词或工具正文。自动测试共 20 项通过，包含发送后重启、项目隔离、重复执行、内容变化、超时/部分拒绝/进程崩溃登记、远端重复与用量膨胀检测。

尚未验收：正文 opt-in、工具输入输出、缓存细分、实际模型价格及费用、持续自动上报、网络不确定状态的自动恢复。因此此次交付标记为阶段 2A，不能宣称完整阶段 2 或阶段 3 已完成。
