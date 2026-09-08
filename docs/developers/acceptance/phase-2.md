> 历史阶段记录。当前完整接入请使用 [接入指南](../../users/getting-started.md)；后续功能与最终结果见 [完整验收](acceptance-phase3-2026-09-08.md)。

# 第二阶段 A：元数据与 Token 上报

目标：只上传一个明确选中的测试 Session；Langfuse 中的模型/工具层级、时间、输入输出 Token 与本地数据逐项一致，重复执行不增加计数。当前仍关闭正文，缓存细分与费用尚未验收，完整第二阶段留待 2B。

## 启动和配置

需要第一阶段已安装的插件与本地 Collector。完全退出 WorkBuddy 后运行：

```bash
npm run collector:start
npm run workbuddy:launch:phase2
```

第二阶段入口仅将原生语义改为 agentlens，四个正文开关仍为 0。agentlens 内部也会产生模型正文，本项目接收端继续使用严格元数据白名单；不保存或向 Langfuse 传送正文。不把此处描述扩展为 WorkBuddy 其他自带遥测渠道的承诺。

在项目 `.env` 中配置目标 Langfuse 项目（该文件已被 Git 忽略，建议文件权限 0600）：

```dotenv
LANGFUSE_BASE_URL=http://localhost:3000
LANGFUSE_PUBLIC_KEY=pk-lf-your-project-key
LANGFUSE_SECRET_KEY=sk-lf-your-project-secret
```

仅上传和验证命令读取此文件。启动 WorkBuddy 不读取它。上传器先查询 API 密钥所属项目，再将项目身份用于发送账本。本机本次验收复用了现有 Codex Local 项目，用 WorkBuddy Trace 名、workbuddy 标签和 observation metadata.source 区分来源。

## 按一个 Session 验收

在同一个新测试任务中分别请求执行 pwd、sleep 3，完成后取得 Session ID：

```bash
npm run accept:phase1 -- <Session ID>
npm run langfuse:upload -- <Session ID>
npm run langfuse:upload -- <Session ID> --send
npm run langfuse:verify -- <Session ID>
```

第二条命令只预览，不连接 Langfuse。第三条发送一次，HTTP 接收确认不等于已可查询；第四条按每条 Trace 查询 v2 observations，再核对全部子记录，任何不符均返回非零退出码。若异步入库尚未完成，稍后只重跑 verify。

重复第三条时，已确认的记录输出 uploaded=0、skipped 为已发送数量；再跑 verify 确认远端记录与 Token 未增长。只选有已结束 interaction 的原生主 Trace；模拟数据和标题等辅助 Trace 不参与。缺少内部父 span、Session 冲突或同 ID 内容变化会阻止上传。当前单次最多 1000 个 spans、4 MiB，超限不发送。

WorkBuddy interaction 可能带着未导出的外层父 ID。上传器仅在同一 Trace 找不到该父节点时，将 interaction 设为 Trace 根，同时把原父 ID 保留为 metadata.nativeParentSpanId；所有内部父子关系、Trace/span ID 与原始时间保留。本地诊断原数据不变。

## 发送账本与边界

`.local/langfuse-deliveries.sqlite` 的记录按目标项目和 traceId/spanId 保存，发送前先持久登记 sending，接收成功再改 accepted。再次运行跳过 accepted；明确拒绝的 400/401/403/404/413/415 可在修复原因后再次运行。网络超时、进程在发送中退出、服务端错误或部分拒绝属于结果不确定，停止自动重传。当前没有自动解除不确定状态的命令，须先人工核查远端；阶段 3 再完善恢复流程。

不要删除发送账本或在未核查远端时改变目标地址来重传。稳定 ID 本身不能让 Langfuse v4 达成 exactly-once。这里验证的是账本完好的正常重复执行不新增，尚未解决所有跨系统故障窗口。

当前输入/输出 Token 已对照通过。fast-model 是 WorkBuddy 路由别名；原生 span 没有缓存命中细分，任务 JSONL 中的 cache_read_input_tokens 也没有被读取上传。Langfuse 不匹配价格时成本为空，不能当作免费。没有根据桌面的积分数字猜测美元费用。

退出 WorkBuddy 后从日常入口重新打开，恢复普通环境。`npm run collector:stop` 停止本项目接收端且保留所有本地数据。
