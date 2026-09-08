# WorkBuddy Langfuse Plugin

把 WorkBuddy 桌面任务中的模型调用、工具执行和 Token 用量自动发送到你的 Langfuse 项目，在一个 Session 中查看多轮任务、调用关系和每一步的耗时。

默认只上传结构与用量，不上传对话和工具正文。需要查看正文时，可以在配置中显式开启。

## 开始使用

当前支持环境：**macOS、WorkBuddy 5.5.3、Node.js 24+、Docker Desktop、支持 OTLP v4 的 Langfuse**。仓库没有第三方 npm 依赖，无需运行 `npm install`。

准备一个可访问的 Langfuse 项目，在项目设置的 API Keys 页面生成 Public Key 和 Secret Key。可以配置自托管 Langfuse 或 Langfuse Cloud 的项目地址；本仓库不包含 Langfuse 服务的部署。

### 1. 下载并配置

```bash
git clone https://github.com/fine405/workbuddy-langfuse-plugin.git
cd workbuddy-langfuse-plugin
npm run configure
```

按提示填写 Langfuse 地址和项目密钥。密钥输入不回显，保存到本地 `.env`，不提交 Git。正文模式默认选择 `metadata`；选择 `text` 才上传经过脱敏、截断的用户问题、模型回复和工具输入输出。

### 2. 启动 WorkBuddy

完全退出 WorkBuddy，启动 Docker Desktop，然后在仓库目录运行：

```bash
npm start
```

这个入口会检查环境、安装或更新插件、启动本地服务，并带采集配置打开 WorkBuddy。以后需要采集时也通过 `npm start` 打开。**直接点击普通 WorkBuddy 图标启动，不会自动启用采集。**

### 3. 在 Langfuse 查看任务

在刚打开的 WorkBuddy 中新建任务。查看本地状态：

```bash
npm run service:status
```

在输出的 `sessions[].sessionId` 中找到任务 ID，再到 Langfuse 的 Sessions 页面打开同一 ID。已完成的步骤会陆续出现，整轮结束后会补齐调用关系；入库存在延迟，必要时刷新页面。

详细配置、更新和卸载步骤见[接入指南](docs/users/getting-started.md)。

## 可以看到什么

| 信息 | 说明 |
|---|---|
| 多轮任务与调用关系 | 同一个 WorkBuddy 任务归到一个 Session，查看模型、工具和各步骤的耗时 |
| 模型与 Token | 实际模型名，以及输入、输出和缓存用量 |
| WorkBuddy 积分 | 保留原始积分；可另行配置模型价格进行美元估算，积分不直接换算成美元 |
| 可选正文 | 开启后查看用户问题、模型回复、工具参数和结果；不包含系统提示、思考过程或完整历史上下文 |
| 本地运行状态 | 查看正在执行、等待审批、无新活动或进程退出等状态 |

正文脱敏采用有限规则，无法识别所有业务秘密；需要正文始终留在本机时，请保持默认的 `metadata` 模式。

## 日常操作

| 操作 | 命令 |
|---|---|
| 修改接入配置或正文模式 | `npm run configure` |
| 安装或更新插件并启动采集 | 退出 WorkBuddy 后 `npm start` |
| 查看运行和发送状态 | `npm run service:status` |
| 停止采集与上报，保留历史 | `npm stop` |
| 卸载插件 | 退出 WorkBuddy 后 `npm run plugin:uninstall` |

更改正文模式后，退出 WorkBuddy、重新 `npm start`，并新建任务，使设置生效。遇到连接、发送或恢复问题，请查看[排障手册](docs/users/troubleshooting.md)。

更多资料见[文档导航](docs/README.md)；想了解实现原理，可阅读[架构说明](docs/architecture/overview.md)。
