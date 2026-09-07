# 第一阶段修复验收：通过

日期：2026-09-08（Asia/Shanghai）。版本：0.1.1。环境：WorkBuddy 5.5.3、Node 24.20.0、本地 Collector 与 SQLite Session 关联器。本次没有向 Langfuse 写入。

先通过 WorkBuddy 内置引擎的插件 API 安装并验证启用，再通过项目诊断入口打开桌面端。新建“WorkBuddy Langfuse 插件修复版验收测试”，同一任务中分别请求仅执行 pwd、sleep 3，不读文件、不访问网络；桌面端实际完成两次工具调用并回复 WB_LF_FIXED_001、WB_LF_FIXED_002。

| 项目 | 结果 |
|---|---|
| 两轮请求 | 同一 Session，2 条主 Trace |
| 模型与工具覆盖 | 18 个 spans：agent 2、generation 4、tool 2、其他 span 10 |
| Session 完整性 | 两条主 Trace 的全部 18 个 spans 均属于正确 Session，缺失 0 |
| 重复采集 | traceId/spanId 重复组合 0；统计未剔除重复记录 |
| Hook | UserPromptSubmit、PreToolUse、PostToolUse、Stop 各 2 次；SessionStart 1 次 |
| 工具关联 | 两个实际 call ID 各匹配一次 PreToolUse 和 PostToolUse |
| 真实时间 | pwd 1603.48 ms；sleep 3 4586.95 ms |
| 自动验收 | 所有结构检查 true，passed=true，退出码 0 |
| 模型用量 | 4 个 generation 未取得 usage；表示未知，不表示 0 Token 或 0 成本 |

结果存储为 correlated-sqlite，完整本地统计在 .local/acceptance.phase1-fixed.json（不提交 Git）。验收先定位 Session 的 interaction，再检查两条 Trace 内全部子 span；不通过丢掉无 Session 的子 span 来制造通过结果。

修复一：持久插件注册替代桌面 worker 无法继承的开发目录。普通启动时 Hook 默认不记录，诊断入口显式启用。独立测试确认配置持久化、重启仍加载且只注册 6 个 Hook。

修复二：关联器在已过滤的元数据上按 traceId 补 Session。SQLite 持久保存映射、待关联与冲突记录，HTTP 在提交后才确认；Collector 到关联器的持久队列用于本地重试。原始元数据 JSONL 保留缺失，补齐结果标记来源。测试覆盖先后顺序、交错会话、重启、冲突撤回和重复可见。

自动检查：npm test 的 16 项测试、npm run test:collector、npm run test:plugin 全部通过。第一阶段已满足进入第二阶段的条件；Langfuse 上传、实际 Token 与内容选择将在第二阶段单独验证。
