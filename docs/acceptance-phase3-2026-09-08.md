# 阶段 3 与完整交付验收

版本：0.4.0。日期：2026-09-08（Asia/Shanghai）。环境：macOS、WorkBuddy 5.5.3、Node.js 24.20.0、Langfuse 4.30.0 OSS。复用本机 Codex Local 项目，未新建或删除用户项目。

## 结论

阶段 1、2A、2B、3 的交付已覆盖：原生模型/工具/步骤采集、Session 关联、正文开关与脱敏、缓存和积分、自动增量发送、运行状态、持久队列和不确定结果恢复。以下区分真实桌面验收、真实服务集成、兼容样本与单元检查，不把样本测试当作真实模型运行。

## 真实 WorkBuddy → Langfuse

| 最终验收 Session | 场景 | 入库 observations | generation | 总输入 / 输出 / 缓存输入 | 积分 |
|---|---|---:|---:|---|---:|
| `7dd6036b-5997-4c7b-8e2c-684e8c9794c9` | text；一次响应两个工具、等待回答、后续取消 | 103 | 4 | 126377 / 217 / 64512 | 0.93 |
| `6ce3d83c-961a-4138-9877-d1777ae7b331` | metadata；分别含 30 秒和 60 秒工具的两轮任务 | 24 | 6 | 203288 / 204 / 140288 | 1.18 |

两组 `langfuse:verify` 的 11 项检查全部通过：ID 数量、Session、父子关系、类型、时间、用量可用性、模型、Token、正文、积分，以及有显式配置时的费用。text 场景中大量普通 span 属于原生等待/内部步骤；它们不额外携带一份模型用量。

分别重复执行手动上传入口，得到 **uploaded=0 / skipped=103** 与 **uploaded=0 / skipped=24**，没有新的发送请求。发送账本在自动服务重启后仍有效。

直接对照原始任务记录，确认一次响应中的两条 function_call 共用 message ID，**只有最后一条附 usage**。Langfuse generation 的输出仍包含两个完整 call ID；Token 和积分只计一次。此检查独立于导出结果的自比较。

取消场景在 WorkBuddy 显示“用户已取消”，本地状态为 `cancelled`。Langfuse 根 metadata 为 `workbuddyOutcome=cancelled`；原生工具虽已结束，但任务文件没有最终工具结果，记录标为 `outputUnavailable=cancelled-before-transcript-result`，output 留空，不编造结果。

## 运行中可见性

以下时间均为 UTC；日期都是 2026-09-07。

| 观测 | 30 秒工具场景 | 60 秒工具的 UI 复核场景 |
|---|---|---|
| 第一工具原生结束 | 18:02:54.484 | 18:05:27.098 |
| Langfuse API 首次查到第一工具 | 18:02:58.343 | 18:05:43.242 |
| 当时状态 | 第二工具运行中，根未入库 | 第二工具运行中，根未入库 |
| Trace UI 首次人工读取确认 | 单独在后续场景复核 | 18:06:12.897，页面显示第一工具 1.67s，根尚未显示；随后本地状态仍为 tool |

API 的样本延迟分别约 3.9 秒和 16.1 秒。UI 的 45.8 秒是本次人工读取的确认上界，包含操作间隔，**不是页面最低加载耗时或固定延迟承诺**。此前 text 模式的 30 秒工具场景也确认第一工具结束约 10.4 秒后入库，第二工具仍在运行。

Trace 页面保持打开时可能停留在早期快照，需要刷新才能看到后续根记录和完整树。Session 页面正文、两个工具输出、等待回答结果也已在浏览器中核对。metadata 场景没有对话 input/output，页面显示无正文符合开关约定。

等待回答通过真实 AskUserQuestion 与 permission_prompt 通知确认，状态为 waiting；选择 A 后正常完成。仅在 Bash 上设置 dangerouslyDisableSandbox 的早期尝试未触发审批，没有把该尝试算成通过证据。

## 故障、兼容与安装检查

- `npm test`：36 项通过。覆盖半行、截断/替换、重启、内容投影、缓存约定、并发 Session、重复 Hook、状态变化、PID 复用、发送歧义与摘要冲突。包含真实独立服务进程：模拟服务接收 HTTP 正文后断开响应，强制退出本插件服务，重启后按远端 ID/摘要确认，POST 仍只有一次；超过 1000 条不确定记录也不阻塞另一个 Session；未经令牌认证的状态与停止请求被拒绝。
- `npm run test:collector`：真实 protobuf → Collector → JSON → SQLite 链路通过。停掉隔离测试关联器后发送，再重启 Collector 和关联器；持久队列恢复全部 6 条记录。包含 subagent 与嵌套模型的兼容样本，AGENT 类型、Session 与原生父子 ID 均保留。没有为此运行真实子代理模型任务。
- `npm run test:plugin`：真实 WorkBuddy 引擎在临时配置目录中安装、重新启动发现、恰好 11 个 Hook、升级、降级回滚、含空格路径、卸载通过。降级时内置 update 可能保留较新版本，安装器会仅重装本插件，并核对实际文件。
- `npm run test:langfuse`：真实 Langfuse 写入和查询通过。3 条明确标为 synthetic 的记录核对 Token、正文、积分与 USD 测试估算；主动丢弃接收响应后重启账本，按真实查询确认三条已入库，未重发。测试金额 0.00027 USD 只是有显式来源标签的合成价格，不是 WorkBuddy 实际价格。
- 配置向导在交互终端验证项目认证与密钥不回显，保留既有凭证并恢复 metadata 默认模式。随后完整执行 `npm start`，安装、Collector、服务和桌面启动成功，最终 metadata 任务经该入口产生。
- 文档的本地链接、引用的 npm scripts、Git diff 空白检查通过。没有 npm 依赖安装步骤，也没有提交 `.env`、原始任务文件或本地数据库。

工具失败和整轮失败的区别、无新活动、worker 退出/启动身份变化由确定性测试覆盖；真实进程故障使用的是本插件自己的隔离服务。没有为测试去强制结束用户的桌面 worker。

## 验收中修复的问题

1. 同一版本安装缓存与降级行为：显式更新本地 marketplace/插件，必要时仅重装本插件，最后比较文件。
2. 取消时 Stop 先于 PostToolUse：晚到的工具通知不再把终止状态改回 running；识别 WorkBuddy 的明确用户中断标记。
3. 后台辅助 Trace 和无类型内部子 span：只有包含原生任务步骤的 Trace 进入自动选择范围，同时保留这些 Trace 中的无类型内部节点。
4. 多工具响应只有最后一条带 usage：正文列表与 usage 的匹配分开，两个工具不丢失，账单不重复。
5. macOS 临时目录或符号链接路径：入口判断使用真实路径，避免服务静默退出。
6. 增量读取避免每轮刷新所有历史 pending：只刷新有新到达的 Trace，并按 Session 索引读取待处理项；迁移在事务中完成。

早期开发测试的 Session 保留作为排错历史，其中包含曾经捕获的辅助记录或旧版输出。它们不是本表最终验收样本，不通过删除账本或覆盖不可变 observation 来掩盖开发过程。

## 交付范围与边界

保留原生 ID/时间，不重建猜测的模型轨迹。已经进入磁盘队列或 SQLite 的数据可恢复；WorkBuddy 原生 SDK 尚未送到 Collector 的内存数据仍可能丢失。未知 usage/货币价格不伪装为零。正文只做有限规则脱敏，不宣称覆盖所有业务秘密。详见 [architecture.md](architecture.md)、[data-model.md](data-model.md) 和 [troubleshooting.md](troubleshooting.md)。
