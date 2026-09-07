# 正文、缓存与计费数据验收

版本 0.3.0，WorkBuddy 5.5.3，本机 Langfuse v4。新建“验收 WorkBuddy Langfuse 无敏感内容”，两轮分别执行 printf 和 sleep 3 后 printf，未读取文件或访问网络。

真实结果：2 条 Trace、14 个 observations，4 次 generation；输入合计 123522，输出 102，缓存输入 103936，实际 WorkBuddy 积分 0.56。每次模型调用的输入、输出、缓存、积分与指定任务的 JSONL 逐条对应。模型名由 fast-model 补齐为 glm-5.3-flash。工具参数、结果、用户请求与可见回答均已在 Langfuse 取回核对。重复上传新增 0 条、跳过 14 条。

输入 Token 在 Langfuse 中拆成互斥项：input 为未缓存输入，input_cached 为缓存命中；两者相加等于原生总输入。generation 只在原生 model_stream 上记一次；多个工具共享同一模型响应时不会重复累计用量或积分。

本次正文模式只采集用户请求、可见回答、工具参数和结果。模型 input 明确标注 inputScope=user-query; system-context-and-history-omitted，不冒充完整的底层模型请求。系统上下文、reasoning 和文件快照不进入补充数据库；常见凭证及用户主目录脱敏，内容超长标记截断。脱敏规则不能识别所有业务机密，metadata 仍为默认模式。

货币费用：WorkBuddy 原生返回积分，未提供每次调用的美元账单。真实记录保留 0.56 积分，美元未知；不使用未经验证的模型单价或把积分转换为美元。支持用户配置有来源的 USD 单价，并标记为估算。独立且明确标记的合成 Langfuse 集成样本已验证 40 未缓存输入、60 缓存输入、20 输出与 0.00027 USD 的配置估算一致；该价格仅用于测试。

证据在本地 .local/acceptance.phase2b-structure.json、acceptance.phase2b-source.json、acceptance.phase2b-langfuse.json（不提交 Git）。26 项自动测试通过，覆盖默认不采正文、脱敏截断、半行、重启、替换/缩短、坏行原子回滚、路径归属、多工具同响应、缓存互斥、费用来源与远端字段核对。独立 Langfuse 集成测试通过。

阶段 3 的自动上报、活动状态和恢复尚在实现，不能用这份回合结束后验收证明运行中功能。
