# 配置、上报与恢复时序

## Codex：重读全文件，不等于重发全文件

```mermaid
sequenceDiagram
  participant A as Codex
  participant H as Stop hook
  participant R as Rollout 文件
  participant B as 任务绑定与轮次记录
  participant D as 发送账本
  participant L as Langfuse
  A->>H: 本轮结束，提供 transcript_path 与身份
  H->>B: 读取开关、固定目标、内容模式
  H->>R: 重读 rollout，重建轮次与调用树
  H->>B: 首次从当前轮建立采集边界
  loop 边界之后已完成的轮次
    H->>B: 该轮是否已确认完成？
    alt 已确认
      B-->>H: 跳过，不发送该轮
    else 尚未确认
      H->>H: 等待完整子任务树，映射稳定 trace/span ID
      H->>D: 查询 ID 与正文摘要，预留 sending
      D-->>H: 已接受的 observation 跳过
      H->>L: 发送剩余 observation
      alt 完整 HTTP 接收确认
        L-->>H: 成功响应
        H->>D: 标记 accepted
        H->>B: 全轮确认后标记完成
      else 响应不确定
        H->>D: 标记 uncertain，阻止自动重放
      end
    end
  end
```

这里有两个层次：轮次记录避免反复构造和上传已完成轮；账本以 `target + traceId:spanId + digest` 处理跨进程重试、部分完成与响应丢失。实际 Project 身份同时参与目录隔离与账本查询。

- 首次 Stop 默认从当前轮开始，缺少 turn ID 时从最后一个已完成轮开始，不自动补发更早历史。
- 未完成轮不发送。子任务文件缺失或子任务仍未完成时保留待处理状态，等后续 Stop，或完成后显式 `codex export <rollout-path> --send`。
- 子任务挂在父轮下，不单独由自己的 Stop 重复生成主 Trace。当前实现以父轮导出时已完整的树为快照；已确认父轮不会追补之后新产生的子任务轮次。
- HTTP 接收确认不是“页面已可见”，Langfuse 异步入库可能延迟。
- 同一 ID 内容变化会停止发送，不把它当成可以覆盖旧记录的更新。

上游固定版本的 `.langfuse` sidecar 按已完成 turn ID 跳过轮次，但在 SDK 最终网络刷新前记录，且不按目标分离。本实现不使用它。上游来源见 [UPSTREAM.md](../../plugins/codex-langfuse/UPSTREAM.md)。

## WorkBuddy：持续增量读取

```mermaid
sequenceDiagram
  participant W as WorkBuddy
  participant C as Collector 与关联器
  participant S as 发送服务
  participant T as Hook 与任务文件
  participant D as 发送账本
  participant L as Langfuse
  W->>C: 原生 OTLP 事件
  C->>C: 持久化队列，按身份关联 Session
  W->>T: Hook 事件与任务文件追加
  loop 服务读取周期
    S->>C: 读取游标之后的事件，补查待关联记录
    S->>T: 增量读取完整行，补齐模型用量与工具结果
    S->>S: 只选择身份明确且已结束的 observation
    S->>D: 按目标、原生 ID 与摘要预留
    S->>L: 发送已准备好的子步骤
    L-->>S: 完整接收确认
    S->>D: 标记 accepted，保存读取进度
  end
  W->>C: 整轮结束，原生根 observation 到达
  S->>L: 补齐根与完整调用关系
```

已完成子步骤可能先出现，整轮结束后根节点补齐。重复到达保留在诊断层，不等于重复上报。未收到的原生数据不会靠猜测重建；Collector 不可达且原生 SDK 未持久化的部分仍可能形成采集缺口。

## 两种 agent 共用的响应丢失恢复

```mermaid
sequenceDiagram
  participant S as 发送器
  participant D as 本地账本
  participant L as Langfuse
  actor U as 用户
  S->>D: sending，持久化 ID、摘要与 payload
  S->>L: 上传 observation
  L--xS: 响应丢失或超时
  S->>D: uncertain
  Note over S,D: 进程直接崩溃时保留 sending，同样阻止重放
  U->>S: recover
  S->>L: 查询 trace 下的 observation
  L-->>S: 已可见的 ID 与 deliveryDigest
  alt 恰好一条相同 ID 且摘要相同
    S->>D: accepted，无需再发送
  else 没查到
    S->>D: 保留 unconfirmed
    Note over U,L: 查询暂时为空不能证明上传失败
  else 重复 ID 或摘要不同
    S->>D: 保留冲突，等待核查
  end
```

WorkBuddy 后台服务也会执行远端核对；Codex 没有常驻恢复进程，使用 `recover` 后在下一次 Stop 或显式 export 继续。明确未建连、确定的认证拒绝可以重试；响应不确定不能仅凭超时就标记失败重发。这是保守的可靠发送策略，不是对任意故障承诺 exactly-once。

[架构](overview.md) · [使用者排障](../users/troubleshooting.md)
