# 安装、配置与日常使用

## 环境准备

当前支持 macOS、WorkBuddy 5.5.3、Node.js 24+、Docker Desktop，以及可访问的 Langfuse 项目。插件不安装或修改 Langfuse 服务。其他 WorkBuddy 版本的原生事件或任务文件结构可能不同。

安装 [Node.js](https://nodejs.org/) 和 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 后，完成各自的首次启动提示。插件没有第三方 npm 依赖。

## 安装到用户目录

获取维护者提供的 `workbuddy-langfuse-0.5.0-macos.zip` 并解压，完全退出 WorkBuddy，双击 **安装.command**。安装器会把程序放到固定的用户目录，然后打开 `~/Applications/WorkBuddy Langfuse/`。安装完成后可以删除下载的 ZIP 和解压目录。

如果 macOS 阻止打开下载的脚本，请先核实安装包来源，再按系统提示在“隐私与安全性”中允许打开。安装器不自动绕过系统安全设置，不要求管理员权限。

安装包按版本分发；项目仓库保持私有时，GitHub 发布页也需要相应访问权限。可以直接使用维护者提供的安装包。

## 首次配置

双击 **配置 Langfuse.command**，按照向导操作：

1. 填写 Langfuse 基础地址，例如 `http://localhost:3000`。Cloud 用户填写项目所属区域的地址，不包含 `/api` 或项目页面路径。
2. 选择是否已有组织、项目和项目 API Keys。
3. 如果没有，组织名称默认 `Personal`，项目名称默认 `WorkBuddy`，可按回车使用默认值。向导可以打开 Langfuse 页面，提示登录、创建组织和项目，然后到项目 **Settings → API Keys** 生成密钥。
4. 填写项目 Public Key、Secret Key。密钥输入不回显；已有密钥可按回车保留。
5. 选择 `metadata` 或 `text`，以及是否启用采集。
6. 验证通过后显示实际项目并保存。WorkBuddy 已退出时，可以选择立即启动。

默认名称用于引导在 Langfuse 中创建资源；填写名称不会自动创建组织或项目。最终接入项目由密钥确定，保存的 `project_name` 和 `project_id` 来自实际查询；`organization_name` 是创建时的提示名称，不代表已经通过 API 核验了组织归属。项目 API Keys 的获取方式见 [Langfuse 官方文档](https://langfuse.com/docs/api-and-data-platform/features/public-api)。

验证失败不会覆盖原配置。已有配置仅关闭采集、且地址与密钥保持不变时，可以在 Langfuse 暂时不可达的情况下保存关闭设置，再使用停止入口停止当前进程。

## 启动与修改配置

完全退出 WorkBuddy 后，双击 **启动 WorkBuddy.command**。它会尝试打开 Docker Desktop，启动 Collector 和上报服务，再带采集环境打开 WorkBuddy。Docker 首次启动或准备时间较长时，请先完成 Docker 的提示，再重新打开启动入口。

直接点击普通 WorkBuddy 图标不会启用采集。启动入口不会强制结束正在执行的任务。

需要修改时，重新打开 **配置 Langfuse.command**。配置在服务启动时读取；更改后退出 WorkBuddy，再通过专用入口启动。正文模式按 Session 固定，更改后应新建任务，继续旧任务会保留原模式或报告冲突。

首次启用从当前事件位置开始登记任务，不自动回灌所有历史。重启后继续处理已登记任务和已持久化队列。

## 配置文件

唯一的文件配置入口是 `~/.workbuddy/langfuse.json`。不读取仓库 `.env` 或 `.local/settings.json`，不提供旧配置迁移。

```json
{
  "enabled": true,
  "base_url": "http://localhost:3000",
  "public_key": "pk-lf-替换为项目PublicKey",
  "secret_key": "sk-lf-替换为项目SecretKey",
  "organization_name": "Personal",
  "project_name": "WorkBuddy",
  "content": "metadata"
}
```

向导还会保存实际项目 ID、运行数据目录和默认运行设置。JSON 文件不加密密钥；安装器和向导使用仅当前用户可读写的文件权限。不要分享整个配置文件。

可选设置包括 `maxContentChars`（默认 16000）、`stalledAfterSeconds`（默认 60）、`pollIntervalMs`（默认 1000）和 `prices`（默认空对象）。需要调整时可编辑同一文件，保存后重新启动接入。

`metadata` 不上传对话和工具正文；`text` 包含用户问题、可见回复、工具参数与结果，先按有限规则脱敏并截断。它不是完整模型 prompt，无法保证识别所有业务秘密。

价格按实际模型名配置，仅接受 USD，需填写来源及每百万 Token 价格。以下仅展示格式，数字不能作为真实模型报价：

```json
{
  "prices": {
    "replace-with-actual-model-name": {
      "currency": "USD",
      "source": "你核实过的价格页面、合同编号与日期",
      "perMillion": {
        "input": 2,
        "input_cached": 0.5,
        "input_cache_creation": 2,
        "output": 8
      }
    }
  }
}
```

将 `prices` 合并到现有配置，保留其他字段。未配置时仍上传实际 WorkBuddy 积分；积分不直接换算成美元。

## 状态、更新和卸载

打开 **查看状态.command**，可以看到配置开关、连接地址、实际项目、服务是否运行、待发送数量、最近任务 ID 和异常。服务尚未启动时会明确显示未运行。根据任务 ID，在 Langfuse 的 Sessions 页面查看对应任务。

更新前完全退出 WorkBuddy，打开 **停止采集.command**；下载新版安装包后重新运行 **安装.command**。更新会替换程序文件，保留同一份配置和运行数据。不要删除数据目录来处理重复记录。

卸载时，完全退出 WorkBuddy，打开 **卸载插件.command**。卸载会停止采集、移除 WorkBuddy Hook 插件和本工具的启动入口，保留配置、发送账本和 Langfuse 历史。重新安装后可以继续使用保留的数据。

## 命令行使用

安装器提供 `~/.local/bin/workbuddy-langfuse`。若 `~/.local/bin` 已在 PATH 中，可以直接使用命令名；否则使用下面的完整路径。安装器不修改你的 Shell 配置。

```bash
~/.local/bin/workbuddy-langfuse configure
~/.local/bin/workbuddy-langfuse start
~/.local/bin/workbuddy-langfuse status
~/.local/bin/workbuddy-langfuse stop
```

开发者也可在源码目录运行 `npm run install:local` 安装当前代码，或运行 `npm run configure`、`npm start`。这些方式共用用户配置与运行数据，源码目录本身不再保存接入凭证或正式发送状态。

## 文件位置与高级覆盖

| 用途 | 默认位置 |
|---|---|
| 用户配置 | `~/.workbuddy/langfuse.json` |
| 安装文件 | `~/.workbuddy/langfuse-plugin/app/` |
| 启动入口 | `~/Applications/WorkBuddy Langfuse/` |
| 命令行入口 | `~/.local/bin/workbuddy-langfuse` |
| 队列、游标、发送账本和启动日志 | `~/.workbuddy/langfuse-plugin/state/` |
| Collector 元数据与 Session 关联 | 上述目录中的 `collector/` |
| Hook 通知 | `~/.workbuddy/langfuse-plugin/hooks.jsonl` |

高级命令行场景中，连接参数按“`WORKBUDDY_LANGFUSE_*` 环境变量 → 标准 `LANGFUSE_*` 环境变量 → JSON → 默认值”读取。两种密钥都必须成对设置；环境变量不会自动打开 `enabled`。安装器生成的启动命令清除连接参数的环境覆盖，始终使用用户保存的配置。

`WORKBUDDY_CONFIG_DIR` 可指定 WorkBuddy 配置目录，`WORKBUDDY_LANGFUSE_CONFIG` 可指定本插件配置文件。`WORKBUDDY_LANGFUSE_STATE_DIR` 可覆盖运行数据目录；`WORKBUDDY_LANGFUSE_DATA_DIR` 可指定 Hook 日志目录。自定义路径仅供明确需要隔离环境的场景，不能用空账本回放已发送任务。

本地默认端口为 Collector `14318`、状态服务 `14319`，可分别通过 `WB_LF_PORT`、`WB_LF_SERVICE_PORT` 调整，相关进程必须使用一致设置。

[排障手册](troubleshooting.md) · [文档导航](../README.md)
