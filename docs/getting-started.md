# 接入、更新和卸载

## 环境与准备

适配目标是 macOS 上的 WorkBuddy 5.5.3。需要 Node.js 24+、能正常启动的 Docker Desktop，以及可访问的 Langfuse 项目。其他 WorkBuddy 版本应先运行插件测试和无敏感任务，原生事件或任务文件结构改变时可能暂停补充数据。

仓库没有第三方 npm 依赖，不需要 `npm install`。首次启动 Docker 会下载固定版本的 OpenTelemetry Collector 与 Node 镜像。仓库若保持私有，学习或安装的同事需要 GitHub 仓库访问权限。

```bash
git clone https://github.com/fine405/workbuddy-langfuse-plugin.git
cd workbuddy-langfuse-plugin
npm run doctor
npm run configure
```

配置向导先验证 Langfuse 项目认证，再保存到 `.env`，文件权限为仅当前用户读写。请使用项目密钥，不是登录密码。Public Key、Secret Key 不传给 WorkBuddy，只由本地上报进程使用。

没有交互终端时，可在仓库根目录手工创建 `.env`：

```dotenv
LANGFUSE_BASE_URL=http://localhost:3000
LANGFUSE_PUBLIC_KEY=pk-lf-替换为项目PublicKey
LANGFUSE_SECRET_KEY=sk-lf-替换为项目SecretKey
```

将文件权限设为仅自己可读写：`chmod 600 .env`。Cloud 用户填写自己项目所属区域的 Langfuse 基础地址，不追加 `/api` 或项目页面路径。

## 第一次启动

1. 完全退出 WorkBuddy。关闭窗口可能仍有后台进程，请使用应用菜单的退出。
2. 启动 Docker Desktop。
3. 在仓库目录运行 `npm start`。
4. 在自动打开的 WorkBuddy 中新建无敏感测试任务。
5. 运行 `npm run service:status`，确认 `faults` 为空、队列逐渐清空，记下 Session ID。Langfuse Session 页面默认可能只显示模型/工具；点击其中的 Trace 链接查看完整树和等待步骤。
6. 等任务完成、Langfuse 入库后，运行 `npm run langfuse:verify -- <Session ID>`。预期 `passed: true`。

`npm start` 会重新校验并更新实际安装文件。WorkBuddy 运行时命令会提示退出，不会强制关闭正在执行的任务。第一次启用自动服务从当前事件位置开始，不扫描或回灌此前所有任务；重启后则继续处理已登记任务和停机期间的新到达数据。

每天需要采集时，通过仓库中的 `npm start` 启动 WorkBuddy。不要移动或删除仓库后继续使用旧安装；本地 marketplace 和服务数据都与该目录关联。路径含空格受支持，终端进入该路径时请加引号。

## 正文与价格设置

运行 `npm run configure` 可以切换 `metadata` 或 `text`。默认 `metadata` 不上传对话与工具正文。`text` 包含用户问题、模型可见回复、工具参数和结果，会先脱敏并截断；它不代表模型看到的完整 prompt。

可编辑 `.local/settings.json`：

```json
{
  "content": "metadata",
  "maxContentChars": 16000,
  "stalledAfterSeconds": 60,
  "pollIntervalMs": 1000,
  "prices": {}
}
```

正文模式按 Session 固定。更改后退出 WorkBuddy，重新 `npm start`，并**新建任务**；继续旧 Session 改变正文模式会被隔离。服务配置在启动时读取，`npm start` 会重启上报服务使设置生效。

价格按实际模型名配置，货币只接受 USD，必须填写来源和所有非零用量类型的每百万 Token 价格。下面只是配置格式，数字是演示值，不能作为真实模型报价：

```json
{
  "prices": {
    "replace-with-actual-model-name": {
      "currency": "USD",
      "source": "填写你核实过的价格页面、合同编号与日期",
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

未配置时仍上传 WorkBuddy 实际积分，不自创美元价格。Langfuse 自己的模型目录可能另行计算成本；核对本插件提供的金额时，以 `costBasis=configured-usd-estimate` 与 `priceSource` 为准。

## 更新与回滚

先退出 WorkBuddy，停止服务，再更新代码：

```bash
npm stop
git pull --ff-only
npm test
npm start
```

不要删除 `.local` 来“修复重复数据”，发送账本就在其中。升级时应备份 `.env`、整个 `.local` 和 Hook 数据目录；SQLite 在线备份请使用 SQLite backup API，普通文件复制应在服务和 Collector 停止后进行，并保留伴随文件。

需要回滚时，停止服务，检出已验证的版本，再执行该版本安装命令。恢复与该版本匹配的备份前，必须核查升级期间是否已有新记录上传；回滚旧账本会遗忘这些发送，导致重复。已有 Langfuse 历史不会随代码回滚而删除。

## 停止与卸载

```bash
npm stop
```

停止本地接收与发送，保留队列和历史。当前 WorkBuddy 进程的环境不会被外部命令撤回；完全退出后，从普通应用入口重新打开，Hook 默认不再记录。

完全退出 WorkBuddy 后卸载：

```bash
npm run plugin:uninstall
```

这只移除本插件，不改动其他插件、任务、Langfuse 项目或凭证。确认无需恢复后再自行归档本地数据；保留发送账本有助于今后避免重复。

## 地址和数据位置

| 项目 | 默认位置 |
|---|---|
| Collector 接收 | `127.0.0.1:14318/v1/traces` |
| 本地状态/停止接口 | `127.0.0.1:14319`，随机令牌认证 |
| 项目凭证 | 仓库 `.env` |
| 配置 | `.local/settings.json` |
| 原生元数据与关联结果 | `.local/collector/` |
| 增量游标、任务状态、待发送 payload | `.local/sidecar.sqlite` |
| 投影后的任务记录 | `.local/transcripts.sqlite` |
| 发送账本 | `.local/langfuse-deliveries.sqlite` |
| Hook 通知 | `~/.workbuddy/langfuse-plugin/hooks.jsonl` |
| WorkBuddy 原始任务文件 | `~/.workbuddy/projects/`，由 WorkBuddy 自己管理 |

端口可通过 `WB_LF_PORT` 和 `WB_LF_SERVICE_PORT` 调整；Collector、服务与 WorkBuddy 启动必须使用同一终端环境。`WORKBUDDY_APP_PATH` 指定应用路径；`WORKBUDDY_CONFIG_DIR` 指定 WorkBuddy 配置根目录；`WORKBUDDY_LANGFUSE_DATA_DIR` 指定 Hook 目录。更换 Langfuse 项目请使用单独安装目录，服务会阻止旧队列被自动送到不同项目。
