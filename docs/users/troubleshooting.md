# 排障与恢复

先运行对应 agent 的 `status` 与 `doctor`。不要删除配置、账本或队列来处理重复记录。

```bash
langfuse-helper agents
langfuse-helper targets
langfuse-helper workbuddy status
langfuse-helper codex status
```

## 发现、配置与安装

| 现象 | 处理 |
|---|---|
| agent 未出现在交互菜单 | 检查 `agents` 的 detected、supported、runnable；发现未支持的 CLI 不会提供启动按钮 |
| 应用在自定义目录 | 使用 `WORKBUDDY_APP_PATH`、`CODEX_APP_PATH`；Codex 可用 `LANGFUSE_HELPER_CODEX_BIN` 指定可执行文件 |
| 没有 verified target | 先运行 `langfuse-helper <agent> configure` |
| JSON 错误 | 检查 `~/.langfuse-helper/config.json`；不要把含密钥的文件粘贴到问题报告中 |
| 密钥验证失败 | 填写项目密钥对及所属区域的基础 URL；输入 Org/Project 名称不会改变密钥归属 |
| target 已属于其他项目 | 新建 target 名称；同名目标不能换投另一 Project |
| 已有 Codex 上游 tracing 扩展 | 在 Codex Plugins 中禁用该扩展，再安装 helper 扩展，避免双重发送 |
| Codex marketplace 指向其他目录 | 先通过 `codex plugin marketplace list` 核对注册；仅移除已确认过时的那条注册后再 `codex install`。helper 不覆盖其他 marketplace |
| 找不到 langfuse-helper 命令 | 检查 `npm config get prefix` 对应的 `bin` 是否在 PATH 中，重开终端 |

## Codex 没有数据

按顺序检查：

1. `codex status` 中 enabled 是否为 true，插件是否已安装且 enabled。
2. 在新 Codex 任务的 `/hooks` 中确认 Stop hook 已审阅并信任。安装或更新不会自动代替这一步。
3. Hook 执行环境是否能找到 Node.js 24+。终端启动由 helper 补充当前 Node 的目录；已打开的桌面应用不会继承新终端环境，必要时退出后重新启动。
4. 完成一轮，再检查 `lastRun` 和 deliveries。Codex 按轮次结束上报，不显示 WorkBuddy 式的持续活动状态。
5. 更换 target 后新建任务。提示任务属于其他目标时，选回原 target 处理旧任务。
6. 子任务尚未完成或文件尚未出现时，等全部结束再通过下述 export 重试。

```bash
langfuse-helper codex export /absolute/path/to/rollout.jsonl
langfuse-helper codex export /absolute/path/to/rollout.jsonl --send
```

无 `--send` 只显示摘要，不写任务绑定或账本。首次处理从最后一个完成轮开始；已有任务使用固定采集边界。它不是导入整个历史目录的命令。开始前须启用 Codex 采集。

文件中完整行损坏会停止导出；写入中的末尾半行可以等待补齐。已确认的父轮使用当时的完整子任务树作为快照，之后新产生的子任务轮次不会追补到该父轮。

## WorkBuddy 没有数据或状态不完整

| 现象 | 处理 |
|---|---|
| 普通图标启动后没有数据 | 完全退出，通过 `langfuse-helper workbuddy start` 重开 |
| WorkBuddy 未完全退出 | 从应用菜单退出；helper 不强制结束现有任务 |
| 服务未运行或 service.json 不存在 | 运行 `start`；高级排障可用 `serve` 前台运行发送服务 |
| Docker 尚未就绪 | 完成 Docker Desktop 首次启动提示后重试 |
| 端口被占用 | 停止占用端口的原接入；不要把另一目标的服务当成当前服务 |
| queue 增加或 faults 出现 | 检查网络、Langfuse 拒绝原因及目标密钥；修改配置后重启 |
| waitingForNativeOrTranscript | 等原生 Session 锚点或完整任务记录；没有主任务归属的辅助 Trace 不会强行上传 |
| 子节点先出现，父节点稍后到达 | 完成整轮并等待 Langfuse 入库后刷新；可用 verify 核对 |
| quiet | 只表示一段时间没有新活动，不代表模型或工具已经失败 |
| 内容、Session 或摘要冲突 | 保留现场，恢复原设置或新建任务；不能清空账本强行覆盖 |

```bash
langfuse-helper workbuddy status --json
langfuse-helper workbuddy diagnose
langfuse-helper workbuddy export <session-id>
langfuse-helper workbuddy verify <session-id>
```

`status --json` 查询正在运行的服务，未运行返回非零。`diagnose` 的重复到达统计不是发送次数。`verify` 查询实际入库 observation，核对 ID、父子关系、时间、用量和正文。

## 不确定发送

两个 agent 都支持：

```bash
langfuse-helper workbuddy recover
langfuse-helper codex recover
```

命令只查询绑定项目。结果为 accepted 表示找到恰好一条相同 ID、相同 deliveryDigest 的记录，会确认账本而不重发。unconfirmed 保留；conflict 需要核查重复 ID 或摘要变化。Langfuse 异步入库，所以暂时查不到不能证明上传失败。

在确认服务健康、异步队列已消化、项目与 ID 正确后，只有用户确认记录未入库才显式释放单条记录：

```bash
langfuse-helper codex recover --retry-confirmed-absent <trace-id:span-id>
```

WorkBuddy 使用相同参数。记录必须至少 5 分钟前产生，且当前查询没有发现匹配或冲突。WorkBuddy 服务随后重试；Codex 在后续 Stop 或显式 export 时继续。不能承诺延迟入库绝不会造成重复，因此不自动批量释放。

## 旧队列、损坏与采集缺口

目标切换后旧队列仍保存在原目标目录。重新绑定原 target 后继续恢复，不将旧 payload 直接换密钥发往新项目。停止进程后再备份和分析 SQLite 错误。

WorkBuddy SDK 未送达 Collector、hook 未执行、Codex 原始 rollout 被删除等问题，都可能造成采集缺口。helper 不编造 observation 来补齐。排障报告只提供已脱敏的状态摘要和版本信息，不直接分享配置、数据库或原始会话文件。

[接入指南](getting-started.md) · [时序图](../architecture/sequences.md)
