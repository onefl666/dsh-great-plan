# 卓越计划（Great Plan）

[English](README.md) | **简体中文**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/onefl666/dsh-great-plan)](https://github.com/onefl666/dsh-great-plan/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/onefl666/dsh-great-plan)](https://github.com/onefl666/dsh-great-plan/issues)

一个 DSH Web 插件：在执行计划前选择模型与思考强度，并支持直接执行、压缩上下文后执行，或在新会话中清空上下文执行。

## 功能

- **执行计划**：批准计划，在当前会话中按所选模型继续执行。
- **压缩上下文并执行**：先压缩计划之前的历史，再原地批准。
- **清空上下文并执行…**：停止当前回合，在同一工作区新建会话，把计划作为首条消息执行；可选择 Agent 模式，旧会话保留。
- **证据优先的计划**：plan 模式下要求计划包含背景、证据链和交接说明（建议性约束）。

原生的 **Approve**、**Request changes**、**View full plan** 保持不变；插件只在计划审核卡上增加一个 **执行选项** 入口。

## 要求

- 带 Web 客户端的 DSH（已在 DSH 0.2.1-rc.2 验证）。
- **压缩上下文并执行** 需要 DSH 组合中有 compaction 后端；没有时会提示后仍执行计划。

## 安装

通过 `plugin_manager` 的 `install_bundle` 安装本目录，target 为包目录的绝对路径。安装后插件在 Plugins 列表中显示为 **卓越计划**。

## 使用

1. 用 `/plan` 进入 plan 模式，让 Agent 提交计划。
2. 审核卡出现后，点击 **执行选项**。
3. 可选：选择模型与思考强度。选择会立即应用到当前会话，并与 Composer 模型选择器一致。
4. 选择执行方式：
   - **执行计划**：直接批准。
   - **压缩上下文并执行**：先压缩；压缩不可用、无可压缩历史或失败时，提示后仍批准。运行中关闭浮层即取消。
   - **清空上下文并执行…**：确认说明、选择 Agent 模式后创建新会话并打开；旧会话停止但保留。

## 命令

`/great-plan-compact` 压缩待审核计划之前的历史。**压缩上下文并执行** 会自动调用它；它也会出现在命令菜单中，不接受参数。

## 已知限制

- 模型列表不提供搜索；完整选择请用 Composer 的模型控件。
- 选择模型会按 DSH 既有行为同时保存为默认模型。
- 压缩会产生一次摘要模型请求。
- 新会话标题前缀与旧会话停止均为 best-effort。
- 证据优先提示是建议性约束，插件不校验计划内容；命令描述不支持多语言。

## 开发

无构建步骤、无依赖。运行 gate（语法检查 + host 测试）；`PATH` 中没有 node 时会自动使用 DSH 自带的 Node：

```bash
bash tools/gate.sh
```

gate 通过只说明语法与 host 测试正常，不代表 GUI 行为正确。修改 Host 后需重启 DSH；修改 Client 后 touch `client.js` 并刷新页面。架构、GUI 手工清单与约定见 [AGENTS.md](AGENTS.md)。

## 项目结构

| 路径 | 作用 |
|---|---|
| `index.js`、`host/` | Host 半：`/great-plan-compact` 命令与 plan 模式提示词段 |
| `client.js`、`client.<name>.js` | Client 半：入口及 `ui`、`model`、`preset`、`actions`、`panel` chunk |
| `locale/` | Plugins 列表的标题与描述 |
| `test/`、`tools/gate.sh` | Host 测试与验证 gate |

详见 [AGENTS.md](AGENTS.md) 的 Module Map。

## 许可

[MIT](LICENSE) © 2026 onefl666。包仍为 `"private": true`，不会发布到 npm。
