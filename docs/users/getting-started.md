# 安装、配置与日常使用

## 环境准备

当前支持 macOS、WorkBuddy 5.5.3、Node.js 24+、Docker Desktop，以及可访问的 Langfuse 项目。插件不安装或修改 Langfuse 服务。其他 WorkBuddy 版本的原生事件或任务文件结构可能不同。

安装 [Node.js](https://nodejs.org/) 和 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 后，完成各自的首次启动提示。插件没有第三方 npm 依赖。

## 安装 CLI

通过 npm 全局安装，无需克隆或保留源码目录：

```bash
npm install -g git+ssh://git@github.com/fine405/workbuddy-langfuse-plugin.git
langfuse-helper --version
langfuse-helper --help
```

包名和命令名均为 `langfuse-helper`，操作按 agent 分组，例如 `langfuse-helper workbuddy start`。目前仅支持 WorkBuddy；Codex 等其他 agent 尚未实现。仓库尚未发布到 npm 公共仓库；GitHub 安装需要仓库访问权限和 SSH 认证。安装只放置 CLI 文件，不会自动启动应用、创建 Langfuse 资源或修改用户配置。

如果维护者提供了标准 npm 包，可以直接安装，不用解压：

```bash
npm install -g ./langfuse-helper-0.6.0.tgz
```

程序及命令链接由 npm 管理，配置和发送记录位于用户目录。全局安装提供稳定路径，适合 Hook 插件和后台服务持续引用。这里采用 npm 支持的 [Git URL 和本地包安装方式](https://docs.npmjs.com/cli/v11/commands/npm-install/)。

## 首次配置

运行 `langfuse-helper workbuddy configure`，按照英文向导操作：

1. 填写 Langfuse 基础地址，例如 `http://localhost:3000`。Cloud 用户填写项目所属区域的地址，不包含 `/api` 或项目页面路径。
2. 选择是否已有组织、项目和项目 API Keys。
3. 如果没有，组织名称默认 `Personal`，项目名称默认 `WorkBuddy`，可按回车使用默认值。向导可以打开 Langfuse 页面，提示登录、创建组织和项目，然后到项目 **Settings → API Keys** 生成密钥。
4. 填写项目 Public Key、Secret Key。密钥输入不回显；已有密钥可按回车保留。
5. 选择 `metadata` 或 `text`，以及是否启用采集。
6. 验证通过后显示实际项目并保存。WorkBuddy 已退出时，可以选择立即启动。

默认名称用于引导在 Langfuse 中创建资源；填写名称不会自动创建组织或项目。最终接入项目由密钥确定，保存的 `project_name` 和 `project_id` 来自实际查询；`organization_name` 是创建时的提示名称，不代表已经通过 API 核验了组织归属。项目 API Keys 的获取方式见 [Langfuse 官方文档](https://langfuse.com/docs/api-and-data-platform/features/public-api)。

验证失败不会覆盖原配置。已有配置仅关闭采集、且地址与密钥保持不变时，可以在 Langfuse 暂时不可达的情况下保存关闭设置，再运行 `langfuse-helper workbuddy stop` 停止当前进程。

## 启动与修改配置

完全退出 WorkBuddy 后，运行 `langfuse-helper workbuddy start`。它会尝试打开 Docker Desktop，启动 Collector 和上报服务，再带采集环境打开 WorkBuddy。Docker 首次启动或准备时间较长时，请先完成 Docker 的提示，再运行 `langfuse-helper workbuddy start`。

直接点击普通 WorkBuddy 图标不会启用采集。启动入口不会强制结束正在执行的任务。

需要修改时，运行 `langfuse-helper workbuddy configure`。配置在服务启动时读取；更改后退出 WorkBuddy，再运行 `langfuse-helper workbuddy start`。正文模式按 Session 固定，更改后应新建任务，继续旧任务会保留原模式或报告冲突。

首次启用从当前事件位置开始登记任务，不自动回灌所有历史。重启后继续处理已登记任务和已持久化队列。

## 配置文件

文件配置统一保存在 `~/.workbuddy/langfuse.json`，由配置向导读写。

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

向导还会保存实际项目 ID、运行数据目录和默认运行设置。JSON 文件不加密密钥；向导使用仅当前用户可读写的文件权限。不要分享整个配置文件。

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

`langfuse-helper workbuddy status` 显示配置开关、连接地址、实际项目、队列、最近任务和异常；`langfuse-helper workbuddy status --json` 查询运行服务的完整 JSON 状态。后者在服务未运行时返回非零退出码。

更新前完全退出 WorkBuddy，停止采集，再用 npm 安装新版：

```bash
langfuse-helper workbuddy stop
npm install -g git+ssh://git@github.com/fine405/workbuddy-langfuse-plugin.git
langfuse-helper --version
langfuse-helper workbuddy start
```

通过本地 `.tgz` 安装时，将更新命令换成 `npm install -g ./langfuse-helper-<version>.tgz`。不要在上报服务或 WorkBuddy 运行期间替换程序文件；npm 本身不会检查它们的运行状态。更新保留原配置和数据目录，不要删除账本来处理重复记录。

卸载前完全退出 WorkBuddy，再依次执行：

```bash
langfuse-helper workbuddy uninstall
npm uninstall -g langfuse-helper
```

第一步停止采集并移除 WorkBuddy Hook 插件，第二步由 npm 删除 CLI。配置、队列、发送账本和 Langfuse 历史保留，重新安装后可继续使用。

## 从源码运行与打包

开发时在源码目录使用 `node bin/langfuse-helper.mjs workbuddy <command>`，例如 `node bin/langfuse-helper.mjs workbuddy --help`。配置和正式发送状态不保存在源码目录。

维护者运行 `npm run package`，在 `dist/` 生成标准 `.tgz` 包和 SHA-256 文件。安装包通过 npm 的文件清单仅包含运行代码、插件、Collector 配置和文档，不包含用户配置、运行数据库或测试目录。

## 文件位置与高级覆盖

| 用途 | 默认位置 |
|---|---|
| 用户配置 | `~/.workbuddy/langfuse.json` |
| 安装文件 | npm 全局目录中的 `langfuse-helper`；用 `npm root -g` 查看 |
| 命令行入口 | npm 全局前缀的 `bin/langfuse-helper`；用 `command -v langfuse-helper` 查看 |
| 队列、游标、发送账本和启动日志 | `~/.workbuddy/langfuse-plugin/state/` |
| Collector 元数据与 Session 关联 | 上述目录中的 `collector/` |
| Hook 通知 | `~/.workbuddy/langfuse-plugin/hooks.jsonl` |

高级命令行场景中，连接参数按“`WORKBUDDY_LANGFUSE_*` 环境变量 → 标准 `LANGFUSE_*` 环境变量 → JSON → 默认值”读取。两种密钥都必须成对设置；环境变量不会自动打开 `enabled`。CLI 遵循当前终端的环境变量，配置向导会提示已有覆盖；不再需要的覆盖变量应先清除。

`WORKBUDDY_CONFIG_DIR` 可指定 WorkBuddy 配置目录，`WORKBUDDY_LANGFUSE_CONFIG` 可指定本插件配置文件。`WORKBUDDY_LANGFUSE_STATE_DIR` 可覆盖运行数据目录；`WORKBUDDY_LANGFUSE_DATA_DIR` 可指定 Hook 日志目录。自定义路径仅供明确需要隔离环境的场景，不能用空账本回放已发送任务。

本地默认端口为 Collector `14318`、状态服务 `14319`，可分别通过 `WB_LF_PORT`、`WB_LF_SERVICE_PORT` 调整，相关进程必须使用一致设置。

[排障手册](troubleshooting.md) · [文档导航](../README.md)
