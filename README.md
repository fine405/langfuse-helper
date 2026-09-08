# Langfuse Helper

把 WorkBuddy 中的模型调用、工具执行和 Token 用量发送到你的 Langfuse 项目，在一个 Session 中查看多轮任务、调用关系和耗时。

面向 AI agent 的 Langfuse 接入 CLI，当前支持 WorkBuddy。通过 `langfuse-helper workbuddy` 完成配置、启动和管理。默认只上传结构与用量，需要查看对话与工具正文时再显式开启。

## 安装

需要 **macOS、WorkBuddy 5.5.3、Node.js 24+、Docker Desktop，以及支持 OTLP v4 的 Langfuse 服务**。

```bash
npm install -g git+ssh://git@github.com/fine405/workbuddy-langfuse-plugin.git
langfuse-helper --version
```

安装后可以在任意目录使用命令，无需保留源码目录。当前从 GitHub 分发，尚未发布到 npm 公共仓库；私有仓库需要访问权限和 GitHub SSH 认证。也支持安装维护者提供的标准 `.tgz` 包，详见[接入指南](docs/users/getting-started.md)。

## 配置 Langfuse

```bash
langfuse-helper workbuddy configure
```

向导、命令帮助和终端提示均为英文：

- **已有项目**：填写 Langfuse 地址和项目 Public Key、Secret Key。
- **尚未创建**：向导可以打开 Langfuse 页面，引导创建组织、项目和 API Keys。默认组织名为 `Personal`，项目名为 `WorkBuddy`。
- **正文模式**：`metadata` 只传结构与用量；`text` 另传经过有限规则脱敏、截断的正文。

向导验证密钥后显示实际项目。配置保存在 `~/.workbuddy/langfuse.json`，密钥输入不回显，文件仅当前用户可读写。本插件不部署 Langfuse 服务。

## 启动与查看任务

完全退出 WorkBuddy，然后运行：

```bash
langfuse-helper workbuddy start
langfuse-helper workbuddy status
```

`start` 会尝试启动 Docker Desktop、安装或更新 Hook 插件、启动采集服务，再打开 WorkBuddy。**日常需要采集时，通过此命令打开；直接点击普通 WorkBuddy 图标不会启用采集。**

在 WorkBuddy 新建任务后，用 `status` 查看任务 ID，再到 Langfuse 的 Sessions 页面查看同一 ID。已完成的步骤会陆续出现，整轮结束后补齐调用关系；入库存在延迟，必要时刷新页面。

## 日常命令

| 命令 | 用途 |
|---|---|
| `langfuse-helper workbuddy configure` | 修改地址、密钥、正文模式或采集开关 |
| `langfuse-helper workbuddy start` | 启动采集并打开 WorkBuddy |
| `langfuse-helper workbuddy status` | 查看连接、待发送数量、最近任务和异常 |
| `langfuse-helper workbuddy stop` | 停止采集与上报，保留配置和历史 |
| `langfuse-helper workbuddy doctor` | 检查运行环境 |
| `langfuse-helper workbuddy --help` | 查看 WorkBuddy 完整命令说明 |

更改配置后，退出 WorkBuddy 并重新 `start`；正文模式对新建任务生效。更新与卸载由 npm 管理，具体步骤见[接入指南](docs/users/getting-started.md)。

## 可以看到什么

| 信息 | 说明 |
|---|---|
| 多轮任务与调用关系 | 同一个任务归到一个 Session，查看模型、工具和各步骤耗时 |
| 模型与 Token | 实际模型名，以及输入、输出和缓存用量 |
| WorkBuddy 积分 | 保留原始积分；可另行配置模型价格进行美元估算 |
| 可选正文 | 用户问题、模型回复、工具参数和结果；不包含系统提示、思考过程或完整历史上下文 |
| 本地运行状态 | 正在执行、等待输入或审批、暂时没有新活动、进程退出等 |

正文脱敏无法识别所有业务秘密；需要正文始终留在本机时，请保持默认的 `metadata` 模式。

异常处理见[排障手册](docs/users/troubleshooting.md)。更多资料见[文档导航](docs/README.md)；实现原理可按需阅读[架构说明](docs/architecture/overview.md)。
