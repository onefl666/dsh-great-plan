# Great Plan

**English** | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/onefl666/dsh-great-plan)](https://github.com/onefl666/dsh-great-plan/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/onefl666/dsh-great-plan)](https://github.com/onefl666/dsh-great-plan/issues)

A DSH Web plugin: choose the model and reasoning effort, then execute a reviewed plan in place, after compaction, or in a fresh session.

## Features

- **Execute plan** — approve the plan and continue in the current session with the selected model.
- **Compact and execute** — compact the history before the plan, then approve it in place.
- **Start fresh and execute…** — stop the current turn and run the plan as the first message of a new session in the same workspace, with a selectable agent preset. The old session is kept.
- **Brainstorming-guided plans** — ask one short question at a time only when ambiguity could change the approach; once clear, summarize key rationale, tradeoffs, and assumptions (advisory only). Turn this off on the plugin's Settings page; the evidence and handoff guidance stays.
- **Unlimited-token-budget plans** — in plan mode and fresh-session execution, remind the model that its token budget is unlimited and not to cut investigation, tool calls, or necessary questions to save tokens (advisory only). Turn this off on the plugin's Settings page.
- **Great Plan settings page** — a page in the native Settings panel with the switches **Inject brainstorming prompt** and **Inject unlimited token budget prompt** (both on by default), applied to the next plan without restarting DSH.
- **Evidence-first plans** — in plan mode, the planner is asked to include background, an evidence chain, and a handoff for the executor (advisory only).

The native **Approve**, **Request changes**, and **View full plan** controls are unchanged; the plugin only adds one **Execution options** entry to the plan-review card.

## Requirements

- DSH with the Web client (verified on DSH 0.2.1-rc.2).
- **Compact and execute** needs a compaction backend in the DSH composition. Without one, it shows a warning and executes the plan anyway.

## Installation

Install this directory with `plugin_manager` `install_bundle`, using the absolute package directory as the target. The plugin then appears in the Plugins list as **Great Plan**.

## Usage

1. Enter plan mode with `/plan` and ask the agent for a plan.
2. When the review card appears, click **Execution options**.
3. Optionally pick a model and reasoning effort. The change applies to the session immediately and matches the Composer model selector.
4. Pick an execution method:
   - **Execute plan** — approves the plan.
   - **Compact and execute** — compacts first; if compaction is unavailable, empty, or fails, it warns and still approves. Closing the dialog while it runs cancels.
   - **Start fresh and execute…** — review the warning, choose an agent preset, then confirm. The new session opens; the old one stops and is kept.

## Settings

Open **Settings** from the sidebar and choose **Great Plan**. **Inject brainstorming prompt** controls whether the plan-mode prompt asks for clarification and brainstorming; turning it off keeps the evidence-chain and executor-handoff requirements. **Inject unlimited token budget prompt** controls the unlimited-budget reminder in the plan prompt and in the **Start fresh and execute…** first message; turning it off removes only that reminder. Both are on by default, stored by the Host, and survive reloads.

## Command

`/great-plan-compact` compacts the history before the pending plan. **Compact and execute** calls it for you; it also appears in the command menu and takes no arguments.

## Known limitations

- The model list has no search; use the Composer model control for the full picker.
- Selecting a model is also saved as the default model (existing DSH behavior).
- Compaction makes one summary model request.
- The new-session title prefix and stopping the old session are best-effort.
- The budget, brainstorming, and evidence guidance is advisory; the plugin does not validate model compliance. Command descriptions are not localized. The Settings switches need the DSH settings services; without them the page is not registered and both reminders stay on.
- The unlimited-budget reminder is added only to the plan-mode prompt and the **Start fresh and execute…** first message; **Compact and execute** does not add it. The Client reads the fresh-session switch from the configuration mirror and defaults to on when the settings UI is unavailable.

## Development

There is no build step or installed dependency. The Host half imports a few DSH packages (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-compaction`) that the running installation supplies, declared as peer dependencies. Run the gate (syntax check + host tests); it finds DSH's bundled Node when none is on `PATH`:

```bash
bash tools/gate.sh
```

A green gate proves parsing and host tests only, not GUI behavior. Restart DSH after Host changes; touch `client.js` and reload the page after Client changes. Architecture, the manual GUI checklist, and conventions are in [AGENTS.md](AGENTS.md).

## Project structure

| Path | Role |
|---|---|
| `index.js`, `host/` | Host half: the `/great-plan-compact` command and the plan-mode prompt section |
| `client.js`, `client.<name>.js` | Client half: entry plus `ui`, `settings`, `model`, `preset`, `actions`, `panel` chunks |
| `locale/` | Plugins-list title and description |
| `test/`, `tools/gate.sh` | Host tests and the verification gate |

See the Module Map in [AGENTS.md](AGENTS.md) for details.

## License

[MIT](LICENSE) © 2026 onefl666. The package stays `"private": true` and is not published to npm.
