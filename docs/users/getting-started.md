# 安装与日常使用

## 准备与安装

需要 macOS、Node.js 24+ 和可访问的 Langfuse Project（支持 OTLP v4）。WorkBuddy 还需要 Docker Desktop；Codex 需要支持插件与 Stop hook 的 CLI，或带内置 CLI 的桌面应用。当前适配 WorkBuddy 5.5.3、Codex CLI 0.153.4。

```bash
npm install -g git+ssh://git@github.com/fine405/langfuse-helper.git
langfuse-helper
```

当前从 GitHub 分发，未发布到 npm 公共仓库；私有仓库需要访问权限与 SSH 认证。也可安装维护者提供的标准包：`npm install -g ./langfuse-helper-0.7.0.tgz`。用户无需克隆源码、构建插件或安装 SDK。

## 发现与配置

无参数命令在终端中提供 agent 和操作菜单，输入 `q` 取消；非交互环境只显示帮助。也可以直接运行：

```bash
langfuse-helper agents
langfuse-helper workbuddy configure
langfuse-helper codex configure
```

当前发现 WorkBuddy、Codex 和 Claude Code；只有已安装、有扩展且可运行的 agent 才能从菜单启动。Claude Code 暂无扩展，WorkBuddy 当前只支持桌面版采集。

配置向导依次完成：

1. 选择已有 target 共用 Project，或创建新 target。
2. 填写基础 URL 与项目 API Keys；没有项目时，可打开 Langfuse 页面按提示创建。
3. 选择 `metadata` 或 `text`，以及是否启用采集。
4. 查询实际 Project，验证成功后保存。

API Key 输入不回显。输入 Org/Project 名称不会自动创建资源，也不能改变密钥归属。推荐同实例、同 Org、不同 Project，详见[上报目标](targets.md)。

## WorkBuddy

完全退出 WorkBuddy，再运行：

```bash
langfuse-helper workbuddy start
langfuse-helper workbuddy status
```

helper 启动 Docker Collector、发送服务和 WorkBuddy。**需要采集时通过此入口打开；普通图标启动不会启用采集。** 不会强制结束正在执行的任务。

更换配置前退出 WorkBuddy；向导会停止原目标服务，旧队列留在原目录。重新 `start` 并新建任务使设置生效。Langfuse Session 使用原 WorkBuddy 任务 ID。

`langfuse-helper workbuddy stop` 停止采集与发送，保留配置和历史，不关闭应用。要恢复普通使用，完全退出后再正常打开。

## Codex

```bash
langfuse-helper codex start
langfuse-helper codex start --app
```

第一条启动 CLI，第二条打开桌面版；菜单也提供两种入口。helper 安装内置扩展并启用 hooks。

**首次安装或 hook 更新后，在新任务的 `/hooks` 中审阅并信任 Stop hook。安装不等于授权执行。** 桌面版没有审阅入口时，可用同一用户目录的 Codex CLI 完成，再新建桌面任务。见 [Codex Hooks](https://learn.chatgpt.com/docs/hooks)。

若上游 `tracing@codex-observability-plugin` 已启用，先在 Codex Plugins 中禁用它，避免两个发送器同时工作；helper 不会自动移除用户插件。

```bash
langfuse-helper codex status
langfuse-helper codex stop
```

扩展启用、hook 已信任、采集开关打开后，正常启动 Codex 也可采集。每轮结束时上报，Langfuse Session 为 `codex:<thread-id>`。`stop` 关闭后续采集，已进行中的发送可能完成，Codex 保持打开。

更换目标后新建任务；旧任务保留原目标和正文模式。首次采集从当前轮开始，不自动回灌此前所有轮次。

## 正文与配置位置

`metadata` 只上传结构、标识和用量。`text` 增加经过规则脱敏、截断的用户输入、可见回复、工具参数与结果，不主动上传系统提示或独立 reasoning 字段。规则无法识别全部业务秘密。

| 内容 | 默认位置 |
|---|---|
| targets 与 agent 绑定 | `~/.langfuse-helper/config.json` |
| 各目标的队列、账本和状态 | `~/.langfuse-helper/state/<agent>/<target-hash>/` |
| Codex 任务绑定 | `~/.langfuse-helper/bindings/codex/` |

`agents.<agent>.maxContentChars` 默认 16000。WorkBuddy 还可配置轮询、活动超时与模型价格，见[字段与费用](../architecture/data-model.md)。密钥文件仅当前用户可读写，但不是加密存储，不要分享整个目录。

自定义位置可用 `LANGFUSE_HELPER_HOME`、`WORKBUDDY_APP_PATH`、`CODEX_APP_PATH`、`LANGFUSE_HELPER_CODEX_BIN`。CLI 与 hook 必须使用同一个 helper 目录；已打开的桌面应用不会继承新终端环境，通常保持默认位置最省事。

## 更新与卸载

先停止已配置的 agent，完全退出 WorkBuddy，再更新：

```bash
langfuse-helper workbuddy stop
langfuse-helper codex stop
npm install -g git+ssh://git@github.com/fine405/langfuse-helper.git
```

只执行自己接入的 agent 命令。更新后重新 `start`；Codex 必要时重新审阅 hook，并新建任务。npm 不会自动停止后台服务。

卸载时先移除已接入的扩展，再移除 CLI：

```bash
langfuse-helper workbuddy uninstall
langfuse-helper codex uninstall
npm uninstall -g langfuse-helper
```

配置、发送账本与 Langfuse 历史保留。

[上报目标](targets.md) · [排障](troubleshooting.md) · [文档导航](../README.md)
