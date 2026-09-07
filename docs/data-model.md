# 字段、费用与正文边界

## 正式追踪

`interaction / subagent → AGENT`、`model_stream → GENERATION`、`tool/mcp_call → TOOL`，其他已知步骤为 SPAN。`model_request` 不重复生成 generation。正式记录保留原生 trace/span ID、父 ID 和起止时间；同一 WorkBuddy 任务的多轮 Trace 用 `langfuse.session.id` 归到同一个 Session。

生成记录通过 Session、trace ID、message ID 与任务文件对应；工具通过 Session、trace ID、call ID 对应。仅凭时间接近或工具名相同不会合并记录。并发 Session 和子代理的原生追踪也遵循这些身份；若原生事件缺少关联信息，服务等待补齐而不猜测归属。

## Token 和积分

WorkBuddy 5.5.3 的本次实测响应中，规范化 `input_tokens` 包含缓存命中。通过 `rawUsage.prompt_tokens` 核对后，映射为互斥用量：

```text
Langfuse input                = 原输入 - cacheRead - cacheWrite
Langfuse input_cached         = cacheRead
Langfuse input_cache_creation = cacheWrite
Langfuse output               = 原 output
```

因此“总输入”应把三类 input 相加，不要再把缓存叠加到原输入上。原生与任务文件的输入/输出不一致、缓存超过总输入、无法证实缓存约定时会暂停该记录，避免悄悄夸大用量。零表示真实零，缺失表示未知。

实际模型来自 `providerData.model`；`requestModel` 保留如 fast-model 的请求别名。一次模型响应中的多个 function_call 可共享 message ID，所以用量与积分只挂在一条 generation 上，各工具不复制这些数字。

`metadata.workbuddyCredits` 来自原始 `rawUsage.credit`，单位是 WorkBuddy 积分。没有依据把它直接换成美元。Langfuse 页面也可能把未配置价格的汇总显示为 `$0.00`，不能据此认定实际免费；在 generation 的 metadata 中查看 workbuddyCredits 与 costBasis。可选 USD 配置会设置 `cost_details`、`costBasis=configured-usd-estimate` 与 `priceSource`，仍是估算，不是 WorkBuddy 发票或实际结算金额。

## 正文

默认 `metadata` 不上传 input/output 正文。`text` 是按 Session 固定的显式选择：

| 对象 | input | output |
|---|---|---|
| generation | 最新用户 query | 本次模型的可见文本或工具调用列表 |
| tool | 本次调用参数 | 该 call ID 的工具结果文本 |
| 根/普通步骤 | 不补正文 | 不补正文 |

模型的 input **不是完整模型请求**：排除 system、系统提醒、reasoning、历史消息和隐藏上下文，标记 `inputScope=user-query; system-context-and-history-omitted`。图片、文件快照等也不作为正文导出。

在写入本插件的任务缓存前，去掉常见 secret/password/API key/authorization 字段、常见密钥文本、私钥块、思考标签和个人 home 路径。超出配置字符数的值截断并标记 `inputTruncated/outputTruncated`；处理过敏感匹配时标记 Redacted。

这是有限规则脱敏，无法识别所有业务秘密、个人信息或自定义凭证格式。需要这些内容始终不离开本机时，请保持 `metadata`。WorkBuddy 自己维护的原始任务文件不由本插件清洗；分享排障材料时不要直接分享该文件、`.env` 或整个 `.local`。

## 本地活动状态

| 状态 | 可用证据 |
|---|---|
| running | UserPromptSubmit，或工具结束后继续处理 |
| tool | PreToolUse 后尚未收到对应结束事件 |
| waiting | PermissionRequest、permission_prompt 通知，或交互式提问工具 |
| ending | Stop 到达，尚未核对原生根结果 |
| completed / failed / cancelled | 原生 interaction 结果；取消也参考明确的 aborted 标记 |
| ended | SessionEnd，表示会话生命周期结束，保留已有结果证据 |
| process-exited | 活跃任务登记的 worker PID 不存在或启动身份不再匹配 |
| quiet=true | 活跃状态超过阈值没有新事件，审批等待除外 |

`quiet` 只表示一段时间没有可见新活动，不能断言模型卡死；`process-exited` 也不假装知道最终业务结果。工具失败不等于整轮失败，Agent 可能恢复继续。状态显示在本地，Langfuse 继续以真实原生 observation 为准。
