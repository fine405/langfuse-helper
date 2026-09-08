# Langfuse Helper

发现本机 AI agent，把任务中的模型调用、工具执行、Token 用量和耗时发送到 Langfuse。一个 CLI 管理 **WorkBuddy 和 Codex**，每个 agent 可以选择自己的上报目标。

默认只上传结构与用量；需要用户问题、可见回复和工具正文时，再主动开启 `text` 模式。

## 安装与开始使用

需要 **macOS、Node.js 24+、可访问的 Langfuse 项目**。WorkBuddy 还需要 Docker Desktop；Codex 不需要 Docker。

```bash
npm install -g git+ssh://git@github.com/fine405/workbuddy-langfuse-plugin.git
langfuse-helper
```

在终端中选择检测到的 agent，再选择 `configure` 或 `start`。所有命令和交互提示均为英文。当前通过 GitHub 分发，未发布到 npm 公共仓库；访问私有仓库需要 GitHub 权限与 SSH 认证。

也可以直接使用命令：

```bash
langfuse-helper agents
langfuse-helper workbuddy configure
langfuse-helper codex configure
```

配置向导会引导选择上报目标、填写项目 API Keys，并连接 Langfuse 确认实际 Project。推荐在同一个 Langfuse 实例、同一个组织中，为 WorkBuddy 和 Codex 分别创建 Project；也可以明确选择共用 Project，或连接不同实例。[了解目标配置](docs/users/targets.md)。

## 启动 agent

| Agent | 启动 | 使用说明 |
|---|---|---|
| WorkBuddy | `langfuse-helper workbuddy start` | 先完全退出 WorkBuddy；helper 启动 Collector 和发送服务，再打开应用 |
| Codex CLI | `langfuse-helper codex start` | 安装内置扩展并打开 CLI；在新任务中通过 `/hooks` 审阅并信任 Stop hook |
| Codex 桌面版 | `langfuse-helper codex start --app` | 打开桌面应用；同样需要审阅 hook，并新建任务 |

WorkBuddy 需要通过 helper 启动才能采集。Codex 在扩展启用、hook 已信任且 helper 采集开关打开后，正常启动也可以采集；每轮结束时上报已完成的调用。

## 日常使用

```bash
langfuse-helper targets
langfuse-helper workbuddy status
langfuse-helper codex status
langfuse-helper workbuddy stop
langfuse-helper codex stop
```

停止采集会保留配置和发送历史。配置保存在 `~/.langfuse-helper/config.json`；API Key 输入不回显，文件仅当前用户可读写。

在 Langfuse 的 Sessions 中查看任务。WorkBuddy 使用原任务 ID；Codex 使用 `codex:<thread-id>`。可查看调用关系、耗时、模型和 Token；WorkBuddy 还保留原始积分。未知用量不会被填成零。

`text` 会按有限规则脱敏并截断正文，不上传系统提示和独立的思考字段；脱敏不能识别所有业务秘密。

[完整接入指南](docs/users/getting-started.md) · [排障](docs/users/troubleshooting.md) · [文档导航](docs/README.md)

实现原理与图解见 [架构说明](docs/architecture/overview.md)。
