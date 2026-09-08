# WorkBuddy Langfuse Plugin

把 WorkBuddy 中的模型调用、工具执行和 Token 用量发送到你的 Langfuse 项目，在一个 Session 中查看多轮任务、调用关系和耗时。

默认只上传结构与用量。需要查看用户问题、模型回复和工具输入输出时，可以通过配置向导开启正文采集。

## 安装

当前支持 **macOS、WorkBuddy 5.5.3、Node.js 24+、Docker Desktop，以及支持 OTLP v4 的 Langfuse 服务**。

1. 获取维护者提供的 `workbuddy-langfuse-0.5.0-macos.zip`，解压后双击 **安装.command**。
2. 安装完成后，会打开用户“应用程序”中的 **WorkBuddy Langfuse** 文件夹。
3. 双击 **配置 Langfuse.command**，按向导完成接入。

无需克隆仓库或进入源码目录。安装器会检查 Node.js；启动入口会尝试打开 Docker Desktop。尚未安装这些依赖时，会给出安装地址和提示。本插件不部署 Langfuse 服务。

## 配置 Langfuse

向导会询问 Langfuse 地址，以及是否已有组织、项目和项目 API Keys。

- **已有项目**：填写该项目的 Public Key 和 Secret Key。
- **尚未创建**：向导会打开 Langfuse 页面，引导创建组织、项目并生成 API Keys。名称留空时使用组织 `Personal`、项目 `WorkBuddy`。
- **选择正文模式**：默认 `metadata` 只传结构与用量；`text` 另传经过有限规则脱敏、截断的正文。

向导会验证密钥，并显示实际连接的项目。配置统一保存在 `~/.workbuddy/langfuse.json`，密钥输入不回显，文件仅当前用户可读写。

## 日常使用

所有入口都位于 `~/Applications/WorkBuddy Langfuse/`：

| 入口 | 用途 |
|---|---|
| **启动 WorkBuddy.command** | 启动采集服务，并带采集配置打开 WorkBuddy |
| **配置 Langfuse.command** | 修改地址、密钥、正文模式或采集开关 |
| **查看状态.command** | 查看实际连接的项目、待发送数量、最近任务和异常 |
| **停止采集.command** | 停止采集与上报，保留配置和历史 |
| **更新插件.command** | 打开发布页获取新安装包 |
| **卸载插件.command** | 卸载插件和启动入口，保留用户配置与数据 |

**启动前请完全退出 WorkBuddy。** 日常通过上面的专用入口打开；直接点击普通 WorkBuddy 图标不会启用采集。

更改配置后，退出 WorkBuddy 并重新打开专用启动入口使设置生效；正文模式对新建任务生效。

在 WorkBuddy 新建任务后，打开“查看状态”，复制任务 ID，在 Langfuse 的 Sessions 页面查看同一 ID。已完成的步骤会陆续出现，整轮结束后会补齐调用关系；入库存在延迟，必要时刷新页面。

## 可以看到什么

| 信息 | 说明 |
|---|---|
| 多轮任务与调用关系 | 同一个任务归到一个 Session，查看模型、工具和各步骤耗时 |
| 模型与 Token | 实际模型名，以及输入、输出和缓存用量 |
| WorkBuddy 积分 | 保留原始积分；可另行配置模型价格进行美元估算 |
| 可选正文 | 用户问题、模型回复、工具参数和结果；不包含系统提示、思考过程或完整历史上下文 |
| 本地运行状态 | 正在执行、等待输入或审批、暂时没有新活动、进程退出等 |

正文脱敏无法识别所有业务秘密；需要正文始终留在本机时，请保持默认的 `metadata` 模式。

详细配置和命令行用法见[接入指南](docs/users/getting-started.md)，异常处理见[排障手册](docs/users/troubleshooting.md)。更多资料见[文档导航](docs/README.md)；实现原理可按需阅读[架构说明](docs/architecture/overview.md)。
