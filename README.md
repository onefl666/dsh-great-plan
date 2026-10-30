# Great Plan

**English** | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/onefl666/dsh-great-plan)](https://github.com/onefl666/dsh-great-plan/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/onefl666/dsh-great-plan)](https://github.com/onefl666/dsh-great-plan/issues)

A DSH Web plugin: choose the model and reasoning effort, then execute a reviewed plan in place, after compaction, or in a fresh session.

## Features

- **Execute plan** — approve the plan and continue in the current session with the selected model.
- **Compact and execute** — compact the history before the plan, then approve it in place.
- **Start fresh and execute…** — stop the current turn and run the plan as the first message of a new session in the same workspace, with a selectable agent preset. The message also carries the instructions the user sent during the current plan-mode session, in chronological order. The old session is kept.
- **Fresh-session context in Minimal mode** — when the new session uses the built-in **Minimal mode** preset, the first message also carries the workspace directory, system platform, current time/time zone, and a note that the previous context was cleared. This compensates for the Minimal preset's suppressed runtime context. Turn this off on the plugin's Settings page.
- **Brainstorming-guided plans** — ask one short question at a time only when ambiguity could change the approach; once clear, summarize key rationale, tradeoffs, and assumptions (advisory only). Turn this off on the plugin's Settings page; the evidence and handoff guidance stays.
- **Unlimited-token-budget plans** — in plan mode and fresh-session execution, remind the model that its token budget is unlimited and not to cut investigation, tool calls, or necessary questions to save tokens (advisory only). Turn this off on the plugin's Settings page.
- **Great Plan settings page** — a page in the native Settings panel with four switches: **Inject brainstorming prompt**, **Inject unlimited token budget prompt**, **Include original user instructions**, and **Include runtime context in Minimal mode** (all on by default). The plan-prompt switches apply to the next plan without restarting DSH; the fresh-session switches apply to the next execution.
- **Evidence-first plans** — in plan mode, the planner is asked to include background, an evidence chain, and a handoff for the executor (advisory only).
- **First-message preview and this-run switches** — before **Start fresh and execute…** confirms, the dialog previews exactly what the new session's first message will contain: the execution intro, the optional budget reminder, the optional Minimal runtime context, the original user instructions (with count and size), and the approved plan, plus total size and an approximate token count. Budget, instructions, and runtime context can be toggled for this run only; global Settings stay unchanged. An oversized hint appears above ~32,000 characters, and instructions are never truncated.
- **Recoverable compaction failure** — if compaction cannot run (unavailable backend, no compactable history, a failed request, or cancellation), the plan is no longer approved automatically: the dialog explains the cause and offers **Retry compaction**, **Execute anyway**, or **Cancel**. Failure copy is localized in the dialog.
- **Plan inside the dialog and Back to editing** — expand the complete reviewed plan without closing the dialog, and use **Back to editing** (the native Discuss behavior: the card is hidden and the review stays pending) to return to the composer. The backdrop now dims the page behind the dialog.
- **Model search and provider-default effort** — filter the model list by provider or model name, and clear an explicit reasoning-effort override back to the provider default in the effort list.
- **Reset to default** — every Settings row whose switch is off offers a reset control that restores its default (on).

The native **Approve**, **Request changes**, and **View full plan** controls are unchanged; the plugin only adds one **Execution options** entry to the plan-review card.

## Requirements

- DSH with the Web client, version 0.2.1-rc.3 or newer (verified on 0.2.1-rc.5).
- **Compact and execute** needs a compaction backend in the DSH composition. Without one, the dialog shows the failure and lets you retry, execute the plan anyway, or cancel.

## Installation

Install this directory with `plugin_manager` `install_bundle`, using the absolute package directory as the target. The plugin then appears in the Plugins list as **Great Plan**.

## Usage

1. Enter plan mode with `/plan` and ask the agent for a plan.
2. When the review card appears, click **Execution options**.
3. Optionally pick a model and reasoning effort. The change applies to the session immediately and matches the Composer model selector.
4. Pick an execution method:
   - **Execute plan** — approves the plan.
   - **Compact and execute** — compacts first. If compaction is unavailable, empty, fails, or is cancelled, the plan is not approved: choose **Retry compaction**, **Execute anyway**, or **Cancel**. Closing the dialog while it runs cancels the wait.
   - **Start fresh and execute…** — review the first-message preview and this-run switches, choose an agent preset, then confirm. The new session opens with the approved plan (plus the instructions and, for Minimal mode, the runtime context you kept enabled); the old session is stopped after the new message is sent and is kept.
5. **Back to editing** hides the review card and returns to the composer for change requests, exactly like the native Discuss action; **Execute plan** is the native Approve.

## Settings

Open **Settings** from the sidebar and choose **Great Plan**. **Inject brainstorming prompt** controls whether the plan-mode prompt asks for clarification and brainstorming; turning it off keeps the evidence-chain and executor-handoff requirements. **Inject unlimited token budget prompt** controls the unlimited-budget reminder in the plan prompt and in the **Start fresh and execute…** first message; turning it off removes only that reminder. **Include original user instructions** controls whether the plan-mode user texts are carried into the fresh session. **Include runtime context in Minimal mode** controls whether the workspace directory, system platform, time, and cleared-context note are added for the Minimal preset. All four are on by default, stored by the Host, and survive reloads. A row whose switch is off also offers **Reset to default**, which writes the default (on) value back through the same configuration form.

## Command

`/great-plan-compact` compacts the history before the pending plan. **Compact and execute** calls it for you; it also appears in the command menu and takes no arguments.

## Known limitations

- The model list now has a simple substring search; the Composer model control remains the full picker, and the two never share state.
- Selecting a model is also saved as the default model (existing DSH behavior).
- Compaction makes one summary model request.
- The new-session title prefix and stopping the old session are best-effort.
- The native **Approve** / **Request changes** buttons sit behind the dialog while it is open. Close the dialog (or use **Back to editing**, which equals Request changes) before using them; **Execute plan** is the in-dialog Approve.
- The conversation's command result cards stay English even in a Chinese UI (the Host command contract has no locale); the dialog's compaction failure text is localized.
- The budget, brainstorming, and evidence guidance is advisory; the plugin does not validate model compliance. Command descriptions are not localized. The Settings switches need the DSH settings services; without them the page is not registered and all four switches default to on.
- The unlimited-budget reminder is added only to the plan-mode prompt and the **Start fresh and execute…** first message; **Compact and execute** does not add it. The Client reads the fresh-session switches from the configuration mirror and defaults to on when the settings UI is unavailable.
- Plan-mode instructions are read from the old session's loaded event window; the plugin looks back up to eight history pages for the current plan-mode start, then falls back to the current turn or the latest user text. The preview reuses that read for execution. Instructions are never truncated: the preview shows the total size, an approximate token count, and an oversized hint above ~32,000 characters, but a very long conversation still produces a large first message.
- The preview's Minimal runtime context is read when the clear view opens; execution reads the time again, so the previewed time can differ.
- The Minimal-mode runtime context is read from the browser (platform, local time, and IANA zone). In a remote Web deployment it describes the browser, not necessarily the Host; the workspace directory still comes from the Host-side workspace.
- A fresh session starts with the deployment's default permissions and sandbox context; the old session's permission or sandbox state is not inherited.
- **Start fresh and execute…** re-checks the pending review right before prompting and stops the old session after the message is sent. Another client can still approve that same review in the brief window before the stop, so the residual multi-client race is not eliminated. If the dialog was already closed by the settled review, a later failure is logged to the browser console only.

## Development

There is no build step or installed dependency. The Host half imports a few DSH packages (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-compaction`) that the running installation supplies, declared as peer dependencies. Run the gate (syntax check + host tests); it finds DSH's bundled Node when none is on `PATH`:

```bash
bash tools/gate.sh
```

A green gate proves parsing and the offline tests only, not GUI behavior. The same gate runs in CI (`.github/workflows/gate.yml`, Node 24) on push and pull requests. Restart DSH after Host changes; touch `client.js` and reload the page after Client changes. Architecture, the manual GUI checklist, and conventions are in [AGENTS.md](AGENTS.md).

## Project structure

| Path | Role |
|---|---|
| `index.js`, `host/` | Host half: the `/great-plan-compact` command and the plan-mode prompt section |
| `client.js`, `client.<name>.js` | Client half: entry plus `ui`, `settings`, `model`, `preset`, `actions`, `panel` chunks |
| `locale/` | Plugins-list title and description |
| `test/`, `tools/gate.sh` | Offline tests and the verification gate |
| `.github/workflows/gate.yml` | CI: runs the gate on push and pull requests |

See the Module Map in [AGENTS.md](AGENTS.md) for details.

## License

[MIT](LICENSE) © 2026 onefl666. The package stays `"private": true` and is not published to npm.
