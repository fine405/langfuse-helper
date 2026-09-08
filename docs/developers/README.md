# 开发与验证

本页面向修改插件或复现验证的开发者。安装与日常使用见[接入指南](../users/getting-started.md)，整体流程见[架构说明](../architecture/overview.md)。

## 配置、安装与打包

当前配置统一由 [settings.mjs](../../scripts/settings.mjs) 读取用户目录的 `langfuse.json`；[wizard.mjs](../../scripts/wizard.mjs) 组织交互问题，[setup.mjs](../../scripts/setup.mjs) 验证项目并提供用户操作。[install.mjs](../../scripts/install.mjs) 管理固定安装目录、命令和可双击入口。

```bash
npm run package
```

在 `dist/` 生成按版本命名的 macOS ZIP 和 SHA-256 文件。打包使用明确的文件清单，不包含凭证、正式运行数据或 Git 状态。ZIP 中保留开发文档与测试，便于学习；发布前应从解压后的目录进行安装检查。

`npm run install:local` 将当前源码安装到用户目录，会修改本人的配置、安装文件和入口。日常开发建议使用隔离的 WorkBuddy 配置文件及数据目录，避免启动开发版本处理正在使用的队列。`npm test` 中的安装与配置测试使用临时用户目录，不安装到真实用户环境。

0.5.0 不读取或迁移旧仓库 `.env`、`.local/settings.json`，不扫描和移动旧发送记录。新的安装和后续更新使用同一份用户数据，更新不重置发送账本。

## 开发环境与代码入口

需要 Node.js 24+。仓库使用 Node.js 内置模块，没有第三方 npm 依赖，无需 `npm install`。Collector 检查需要 Docker Desktop；插件引擎检查需要 macOS 上已安装的 WorkBuddy，当前适配版本为 5.5.3。

| 入口 | 职责 |
|---|---|
| [plugins/workbuddy-langfuse](../../plugins/workbuddy-langfuse) | WorkBuddy 插件声明与 Hook 事件 |
| [collector](../../collector) | 原生 OTLP 接收、过滤、持久队列和 Session 关联 |
| [scripts/setup.mjs](../../scripts/setup.mjs) | 配置向导及完整启动、停止入口 |
| [scripts/sidecar.mjs](../../scripts/sidecar.mjs) | 增量读取、任务状态与自动发送流程 |
| [scripts/enrichment.mjs](../../scripts/enrichment.mjs) | 模型、用量和可选正文的补充 |
| [scripts/langfuse.mjs](../../scripts/langfuse.mjs) | Langfuse 请求与持久发送账本 |
| [scripts/recovery.mjs](../../scripts/recovery.mjs) | 不确定发送的远端核对与恢复 |
| [test](../../test) | 单元测试、组件测试和协议样本 |

## 自动检查

在仓库根目录运行与改动范围相关的检查：

| 命令 | 验证范围 | 环境与影响 |
|---|---|---|
| `npm test` | 数据投影、关联、用量、发送账本、状态与增量服务等逻辑 | Node.js 24+；不需要真实 Langfuse 项目 |
| `npm run test:collector` | 真实 Collector 的 protobuf 链路、过滤、跨批关联、持久队列与重启 | Docker Desktop；创建并清理隔离容器与临时数据 |
| `npm run test:plugin` | 持久安装、引擎重新发现、11 个 Hook、升级/降级、空格路径及卸载 | 已安装 WorkBuddy；使用临时配置目录 |
| `npm run test:langfuse` | 真实远端字段、费用映射、响应丢失恢复和重复发送跳过 | 已配置 `.env`；向当前 Langfuse 项目写入并保留带 `synthetic` 标记的记录 |

`test:langfuse` 使用合成记录，不运行模型；插件引擎与 Collector 样本也不替代真实 WorkBuddy 桌面任务验证。完整验证应分别保留自动检查和真实任务的证据。

## 真实桌面链路验证

按[接入指南](../users/getting-started.md)启动完整接入，在 WorkBuddy 中新建无敏感内容的任务。例如，用长工具观察已完成步骤是否能在整轮结束前出现：

```text
请依次分两次调用终端：先执行 printf WB_LF_FIRST，
拿到结果后执行 sleep 30 && printf WB_LF_SECOND。
不要读取文件或访问网络，最后回复 WB_LF_DONE。
```

运行 `npm run service:status` 取得 Session ID。在第二个工具执行期间观察 Langfuse 中第一个已完成步骤；入库延迟不是固定值。任务完成并入库后运行：

```bash
npm run langfuse:verify -- <Session ID>
```

预期 `passed: true`。需要核对原生 ID、层级、时间、用量、可选正文和重复发送时，参考[完整验收记录](acceptance/acceptance-phase3-2026-09-08.md)与[交付清单](acceptance/completion-plan.md)。发送状态为 `accepted` 只代表接收确认或查询核对成功，不能替代字段验证。

## 验收与阶段历史

| 文档 | 用途 |
|---|---|
| [0.5.0 安装与配置检查](acceptance/onboarding-0.5.0.md) | 用户配置、安装包、入口与验证边界 |
| [完整交付清单](acceptance/completion-plan.md) | v0.4.0 全部交付项和证据对应关系 |
| [阶段 3 与完整验收](acceptance/acceptance-phase3-2026-09-08.md) | 自动增量上报、真实任务、故障恢复与最终边界 |
| [阶段 2B 验收](acceptance/acceptance-phase2b-2026-09-08.md) | 正文、缓存与计费数据 |
| [阶段 2A 验收](acceptance/acceptance-phase2a-2026-09-08.md) | 元数据与 Token 上报 |
| [阶段 1 修复验收](acceptance/acceptance-2026-09-08.md) | 持久插件安装与跨批 Session 关联修复 |
| [阶段 1 失败记录](acceptance/acceptance-2026-09-07.md) | 0.1.0 当时的问题与修复范围 |
| [阶段 1 操作记录](acceptance/phase-1.md) | 早期本地诊断与验收步骤 |
| [阶段 2 操作记录](acceptance/phase-2.md) | 早期手动上报与 Session 核验步骤 |
| [历史验证汇总](acceptance/verification.md) | 阶段 1 至 2A 的验证进展 |

历史记录中的端口、命令和结论只对应当时版本；当前接入方式以使用者文档为准。

[返回文档导航](../README.md)
