# 字段、费用与正文边界

## 调用树与身份

| 项目 | WorkBuddy | Codex |
|---|---|---|
| Session | 原生任务 ID | `codex:<thread-id>` |
| Trace / observation ID | 保留原生 trace/span ID | 根据 thread、turn、模型步骤和工具调用身份派生 |
| 根与子任务 | interaction / subagent → AGENT | 每个完成轮为 AGENT，子任务挂在父轮下 |
| 模型 | model_stream → GENERATION；model_request 不重复生成 | 每次模型步骤 → GENERATION |
| 工具 | tool / mcp_call → TOOL | 每次工具调用 → TOOL |
| 时间 | 原生事件时间 | rollout 事件时间 |

身份不明确、父子关系冲突或数据未完成时等待或报错，不凭时间接近猜测关联。Codex 没有 turn ID 时，以该轮起始时间作为回退身份。

## Token 与费用

Token 只挂在模型调用上，不复制给每个工具。零表示真实零，缺失表示未知；总数或缓存关系不合理时，不猜测修正。

**WorkBuddy** 的输入包含缓存，需要拆成互斥项：

```text
input                = 原输入 - cacheRead - cacheWrite
input_cached         = cacheRead
input_cache_creation = cacheWrite
output               = 原输出
```

**Codex** 同样拆分缓存与推理输出：

```text
input            = input_tokens - cached_input_tokens
input_cached     = cached_input_tokens
output           = output_tokens - reasoning_output_tokens
output_reasoning = reasoning_output_tokens
```

因此总输入要把各类 input 相加，总输出要把各类 output 相加；不要把缓存再次叠加到原总输入上。

WorkBuddy 的 `workbuddyCredits` 是原始积分，不直接换算成美元。可在 `agents.workbuddy.prices` 配置 USD 每百万 Token 单价与来源，用于估算。下面数字仅展示格式：

```json
{
  "replace-with-actual-model-name": {
    "currency": "USD",
    "source": "replace-with-verified-price-source-and-date",
    "perMillion": { "input": 2, "input_cached": 0.5, "input_cache_creation": 2, "output": 8 }
  }
}
```

Codex 费用由 Langfuse 对应模型定价计算，helper 不读取 Codex 订阅账单。页面显示 `$0.00` 也可能只是缺少价格，不能据此认定实际免费。

## 正文

默认 `metadata` 没有 input/output。`text` 按任务固定，提供以下内容：

| 对象 | WorkBuddy | Codex |
|---|---|---|
| 根 | 不补正文 | 本轮用户输入与最终可见回复 |
| 模型 | 最新用户问题、可见回复或工具调用列表 | 首个模型步骤的用户输入、各步骤可见输出 |
| 工具 | 本次参数与对应结果 | 本次参数与对应结果 |

这些字段不是完整模型 prompt，不主动上传系统指令、独立 reasoning、隐藏上下文或完整历史。内容按规则过滤常见密钥、私钥、思考标签和个人 home 路径，并截断长文本；不能保证识别全部业务秘密。

正文模式对新任务生效，旧任务保持首次采集设置。相同 observation ID 的内容改变会停止发送，不覆盖已确认记录。原始 agent 会话文件不由 helper 清洗，不应直接用于分享排障。

## 本地状态

WorkBuddy 可显示 running、tool、waiting、ending、completed/failed/cancelled、process-exited。`quiet` 只代表一段时间没有新活动，不等于失败；工具失败也不等于整轮失败。默认活动阈值 `stalledAfterSeconds=60`，轮询 `pollIntervalMs=1000`。

Codex 显示开关、插件、目标、最近 hook 结果与发送账本，不提供轮次执行中的实时活动状态。

[整体架构](overview.md) · [上报时序](sequences.md)
