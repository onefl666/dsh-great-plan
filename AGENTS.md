# AGENTS.md — Great Plan / 卓越计划

Operational guide for AI agents in this repo. Verify with `bash tools/gate.sh` before claiming done.
Last verified: 2026-10-30 (DSH 0.2.1-rc.5, bundled Node v24.21.0, 190/190 offline tests).

## Agent Rules

- Don't assume. Unclear → ask. Multiple interpretations → present them, don't pick silently. Simpler approach exists → say so.
- Surgical changes: every changed line traces to the request. No drive-by refactors, reformatting, or dependency additions; match the file's existing style.
- Remove only orphans YOUR change created. Pre-existing dead code → mention it, don't delete.
- Behavior change → failing host test first (in `test/`), then implement until green. Behavior-preserving refactor → gate + existing tests.
- Report outcomes honestly: paste failing gate/test output; never gloss over. A green gate proves parsing and host tests only — it does not prove the plugin works in the GUI.
- Client changes are "done" only after the live manual checklist in **Gate** (or an explicit statement of which items you could not run). Never claim visual or behavioral success from tests, syntax checks, or installation alone.
- Never write the profile's `package.json` or `cordis.patch.yml`, and don't run pnpm inside `$DSH_PROFILE_DIR`. Install/update through `plugin_manager` (`install_bundle`, target = this package directory).
- Restore user state after manual testing: close sessions you opened, revert temporary model/preset changes, don't leave renamed, archived, or extra sessions behind.
- When a DSH Service method, Event, slot prop, or theme token is uncertain, inspect it (`cordis_inspect_query` `Service`/`Event`/`Slots`/`Theme`, or the owning package README) instead of guessing. The installed Harness is the authority.
- No new session event types and no new Agent tools: this plugin is composition only, built on existing `commands`/`sessionProjections`/`compaction`/session/model/settings services. Its four configuration fields are the plugin's own volatile Config switches backing the Settings page (see **Host Config and Settings page**).

## Project

DSH Web plugin `@local/dsh-great-plan` ("Great Plan" / "卓越计划"). It adds an **Execution options** entry to the native plan-review card, lets the user choose model + reasoning effort, and offers three ways to execute the reviewed plan:

- **Execute plan** — approve the pending review in the current session.
- **Compact and execute** — run the Host command `/great-plan-compact` over the history before the pending plan, then approve. If compaction cannot run (no backend, empty history, failed request, cancellation) the plan is **not** approved automatically: the dialog keeps the failure visible and offers **Retry compaction / Execute anyway / Cancel**.
- **Start fresh and execute…** — stop the current turn, create a new session in the same workspace (agent preset selectable), and send the approved plan as its first prompt together with the user instructions sent during the current plan-mode episode. When the selected preset is `minimal`, the first prompt also carries a compact fresh-session runtime context (workspace directory, browser platform, current time/zone, cleared-context note). Before confirming, the dialog previews the exact first message (blocks, instruction count/size, total characters, approximate tokens, oversized hint) and exposes three **this-run** switches (budget reminder, original instructions, Minimal runtime context) that never write Settings. Instructions are never truncated. The old session is stopped after the new message is sent but is kept and not archived.

The dialog also shows the reviewed plan itself (question + `planPreviewText` summary + an expandable full-plan `<pre>`), offers **Back to editing** (calls the same `pending.dismiss()` as the native Discuss action; the hidden review stays pending and reopenable), and dims the page behind it. Model selection gained a search filter and a provider-default reasoning-effort row; the Settings page gained per-row reset-to-default.

The native `Approve` / `Request changes` / `View full plan` controls and the plan-review lifetime stay untouched; the plugin only adds one entry to the `conversation.plan-review.actions` slot.

It also adds a **Great Plan** page (id `great-plan`) to the native Settings panel with four switches: **Inject brainstorming prompt** / **注入头脑风暴提示词** (`injectBrainstormingPrompt`), **Inject unlimited token budget prompt** / **注入 token 预算无上限提示词** (`injectUnlimitedBudgetPrompt`), **Include original user instructions** / **携带原始用户指令** (`includeOriginalUserInstructions`), and **Include runtime context in Minimal mode** / **极简模式下附带运行环境** (`includeMinimalRuntimeContext`). All four are volatile and on by default. The first two control the plan prompt and the budget reminder; the last two control the fresh-session first message. Plan-prompt changes apply to the next prompt assembly; the fresh-session switches are read at execution time. The new Host fields only reach the Settings form after a Host restart.

While plan mode is active (or pending-active) the Host registers the global prompt section `great-plan:plan-evidence`. An optional unlimited-token-budget reminder comes first, then the clarification/brainstorming guidance, then the evidence and executor handoff. The guidance asks the planner to clarify material ambiguities one question at a time, summarize its recommendation, relevant tradeoffs, and assumptions, and include background, an evidence chain, and an execution handoff. It is advisory, does not expose private step-by-step reasoning, and never replaces or copies the native plan policy; see **Architecture**.

Names: package and Client module id `@local/dsh-great-plan`; profile bundle row id and Settings entry id `great-plan`; Config fields `injectBrainstormingPrompt`, `injectUnlimitedBudgetPrompt`, `includeOriginalUserInstructions`, and `includeMinimalRuntimeContext`; locale namespace `great-plan`; Host command `great-plan-compact`; display title `Great Plan` / `卓越计划`. Manifest display metadata lives in `locale/*.json`; runtime dictionaries live inline in `client.js`.

## Build & Install

There is no build step, bundler, or installed dependency: Host files are plain ESM Node modules; Client files are plain browser-module factories served as-is (see `dsh-client-modules`). Editing the workspace edits the installed plugin because the active profile links this directory:

```text
$DSH_PROFILE_DIR/node_modules/@local/dsh-great-plan -> /Users/flyblue/myProject/dsh-great-plan
```

Bare `@deepseek-ai/*` imports in the Host half resolve to the running installation **only** because `package.json` lists them in `peerDependencies` (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-compaction`). DSH's runtime resolution routes a bare import from a linked root to the installation's copy only for peer-declared names; a linked package's `dependencies` are not installed, so an undeclared import resolves from the workspace and activation fails with `failed to import: … ERR_MODULE_NOT_FOUND`. `@deepseek-ai/dsh-*` peer ranges must also satisfy the running runtime version, or DSH's admission preflight disables the plugin; keep them as broad as the code allows.

Reinstall (`plugin_manager` `install_bundle`, absolute package directory as target) only after changing package identity or the manifest; ordinary file edits need no reinstall.

- **Host half** (`index.js`, `host/*.js`) is loaded by the DSH Host process as a Node module. Node caches modules, so **restart DSH** to load Host changes.
- **Client half** (`client.js` + `client.*.js` chunks) is served on demand by `dsh-client-modules` and registered through `window.__ModuleLoader__`. The HMR transport polls the entry artifact (`client.js`) by mtime/ctime/size and reloads the plugin in open pages (default 500 ms). Editing only a chunk does **not** change the entry revision, so chunk-only edits can keep the old revision: touch `client.js` (bumps the revision), then reload the page; restart DSH if in doubt. A reload loses plugin React state; do not promise live reload without seeing it.
- Check the browser console after each manual run: a crashing slot entry logs `slot entry crashed in '<slot>'`.
- Authoritative DSH docs: the bundled `cordis-plugin-development` skill under the running installation (`.../dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`; in Desktop it lives inside `app.asar`, so read it with the file-read tool, not shell), plus each package's `README.md` at its resolved `packageDir`.

## Gate (verification)

```bash
bash tools/gate.sh   # exit 0 = green
```

- **G-SYNTAX** — `node --check` on `index.js`, every `host/*.js`, and every `client*.js` (entry + chunks).
- **G-TEST** — `node --test test/*.test.js`; all **190** cases must pass (9 files). The offline tests never import `host/config.js` or link the real installation; the peer declarations that make the Host imports resolvable are asserted statically by `manifest.test.js`.
- The gate script uses `node` from `PATH`, else the DSH runtime node (`$DSH_HOME/dsh-runtimes/*/dependencies/node/bin/node`; on this machine `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`, v24.21.0). There is no system `node` on this host.
- Manual equivalent when `node` is on `PATH`: `node --test test/*.test.js` and `node --check ...`.
- **Linked-root resolution check** (no GUI needed, run after touching `package.json` or Host imports): create a scratch DSH home under `/tmp` whose profile links this package and declares `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and this bundle, then run the installed CLI: `DSH_HOME=/tmp/<scratch> "<app>/Contents/Resources/runtime/cli/bin/dsh" --profile <name> --dump-config-schema`. The `great-plan` row must report `status: schema` with all four Config definitions (`injectBrainstormingPrompt`, `injectUnlimitedBudgetPrompt`, `includeOriginalUserInstructions`, `includeMinimalRuntimeContext`, each defaulting to `true` and marked volatile), and no `Cannot find package '@deepseek-ai/schemastery'` diagnostic may appear. Stock-bundle rows of the scratch profile may still report unrelated diagnostics; the scratch profile is a fixture — never point it at the real profile or write the profile's files.

**What green does NOT prove:** live Host/Client composition; live prompt assembly (including the `great-plan:plan-evidence` section and the fresh-session budget reminder) and model compliance with the budget, brainstorming, and evidence guidance; the real slot props (`review`/`requestKey`, the live `PendingQuestion` behind `answer`/`dismiss`/`snapshot`); `ctx.modelDirectories`/`ctx.sessions`/`ctx.remote.*`/`ctx.uiWorkspace` behavior; the real three-wave chunk loading over the network; a real compaction backend and its model request; the compact-failure retry/proceed/cancel flow against a real Host reply; new-session creation/opening/cancel/archive and its RPC ordering; `ctx.inject(['configForms'])` late arrival in a real composition; locale switching; theme, light/dark contrast, focus, Escape, radiogroup/checkbox announcements, and layout; install metadata and icon rendering. Those require the manual checklist below in the running DSH Web GUI. `host/config.js` statically imports Schemastery from the DSH installation, which the offline tests cannot resolve (they must stay offline), so no Host test imports it; the peer dependency that makes that import resolvable in a running Host is covered statically by `manifest.test.js`, and the live resolution by the check above.

**Manual GUI checklist** (restart DSH for Host changes; refresh/touch `client.js` for Client changes; enter `/plan`, ask for a plan, then):

1. Review strip shows the localized **Execution options** trigger beside untouched native actions; the dialog is anchored to the trigger, and no dialog tree exists in the DOM while it is closed.
2. Root dialog: the plan section shows the review question and the plain-text first-heading/paragraph summary; **View full plan** expands the complete plan (labelled region, scrolls, `pre-wrap`) and **Hide full plan** collapses it; the backdrop visibly dims the page; Escape and backdrop close while idle.
3. **Back to editing** equals the native Discuss action: the review card hides, the review stays pending and reopenable from the tool-call row, and no execution happens; the button is absent when the pending review cannot be dismissed.
4. Model/effort rows show the current model. The model list search filters by provider id/display name and model id/name case-insensitively; clearing restores the full list; an empty result shows **No matching models**. The effort list always offers **Provider default** and selecting it clears an explicit reasoning override; the Composer model selector agrees. Subagent sessions disable model switching and show the notice.
5. **Execute plan** approves the review (card settles; the turn continues).
6. **Compact and execute** success path: a transient localized "compaction complete" status, then approval; the conversation's command card still shows the Host's English result text.
7. **Compact and execute** failure path (use a deployment without a compaction backend, or a session with no compactable history): the dialog stays open with a localized failure block and **Retry compaction / Execute anyway / Cancel**; **Execute anyway** approves; **Cancel** closes without approving; closing/Escape/backdrop while the command is still running cancels the wait and never approves.
8. **Start fresh and execute…** shows the warning, plan section, preset, title preview, model summary, the preview block list (included/excluded plus per-block characters), instruction count/size, total characters, approximate tokens, and the runtime hint when Minimal context is on.
9. This-run switches: toggling budget/instructions/runtime changes the preview, and confirming produces a first message with exactly the enabled blocks; the toggles never write Settings (reopen Settings: values unchanged); the Minimal switch is disabled outside the Minimal preset and shows the hint.
10. Instruction reading: entering the clear view shows a loading state, then the instruction count; a session without plan-mode instructions shows the unavailable note with a plan-only preview; closing the dialog while reading aborts the read without console errors.
11. Fresh confirm gating: while the model catalog is loading/idle the confirm button is disabled with the loading note; on a catalog error confirm stays enabled with the default-model note.
12. The preset sub-page lists presets and labels `minimal` as **极简模式 / Minimal mode**; entering the clear view does not force-refresh a ready preset list (only its retry button forces a reload).
13. Fresh first message content: execution reuses the plan's evidence/handoff instead of repeating the investigation and verifies only what is marked unverified/assumed. The message carries every real user text sent during the current plan-mode episode, in order, excluding runtime-context / AGENTS / time-context / skill-catalog injections, never truncated. The budget reminder follows the this-run switch; `<fresh-session-context>` appears only for the Minimal preset with that switch on. **Compact and execute** keeps the plan message and never adds the budget reminder, the instructions block, or the Minimal context.
14. Fresh execution ordering: the old session is stopped only after the new session's prompt was sent, the new session opens, and the old session stays listed; a failure after creation archives the new session and reports a localized error (check the session list for no orphan).
15. Settings: the localized **Great Plan** page shows four switches on by default, follows zh ↔ en, and reads correctly in light and dark themes; turning one off saves without a Host restart and reveals the localized **Reset to default** control; reset writes the default back; a refused write keeps the previous value and shows the localized retry message.
16. Settings resilience: a composition without the settings capability still loads the plan-review entry (the page is skipped); loading/unavailable/unknown states render the localized note instead of crashing.
17. Locale switch zh ↔ en updates every new string (preview labels, compact failure/buttons, error copy, settings reset) without a reload; Plugins list title/description/icon match the manifest.
18. A11y: changing views moves focus to the dialog title; a blocked Escape (execute/model/effort/clear) closes nothing and does not leak to the host (the native card stays); model/effort/preset lists announce as radiogroups; switches are described by their descriptions; checkboxes have labels; touch targets are ≥24px; `aria-busy` is set during operations; focus is trapped and restored on close.
19. Performance/network: the first plugin load fetches chunks in three waves (ui+actions → settings/model/preset → panel) in the network panel; a closed dialog is not mounted; repeated open/close adds no duplicate stylesheet or dictionary; no console crash or unhandled rejection.
20. Plan-prompt quality (existing coverage): a plan produced in `/plan` carries real background, an evidence chain (paths with line ranges, searches/commands and results, docs/URLs, conflict resolution), and a handoff; citations are real and unverified items are marked as assumptions. A materially ambiguous request leads to one focused question at a time before the final plan; a clear request does not trigger needless questions. After a Host restart, asking the planner to quote the budget, clarification, rationale, or handoff requirements shows the new guidance.

Browser automation is not available here. If you cannot run the GUI, say exactly which checklist items remain unverified.

## Host Tests

`test/` is a deterministic, offline Node test project using the built-in runner and `node:assert/strict`; it has no dependencies and never touches DSH, the network, a model, or a DOM.

| File | Covers |
|---|---|
| `test/manifest.test.js` | Package manifest (bundle patch, Client declaration, exports, files, peer dependencies for the Host imports), locale metadata, icon, Client chunk naming, required delivery files, "no Harness Client package imports", Host entry exports. |
| `test/plan-compaction.test.js` | `selectPlanCompactionRange` (balanced-edge snap, leading system skip, pending-plan exclusion, `exit_plan_mode` tool-call precondition including other tool calls and missing names, overridable tool name, `empty`/`no-review`) and `createCompactCommand` (defensive non-string `rawInput`, success text, inactive plan, missing backend, missing pending review, exported static message table, `busy`/`changed`/`summary`/`commit`/`persistence`/`cancelled` code mapping, aborted signal, argument rejection). |
| `test/plan-evidence.test.js` | Guidance content; the three-part composition and every switch combination; the all-on constant fast path identity (`===`); `readBrainstormingEnabled`/`readUnlimitedBudgetEnabled` (boolean, volatile reference, missing/throwing); switches flipping text at read time; active/inactive plan-mode and pending gating parity; empty-text degradation (missing services/agent/state, throwing reads); section registration name/order/fallback; `apply()` wiring (command, prompt section, `settings.configure({ auto: false })`) with a fake `ctx`/`inject`. |
| `test/client-actions.test.js` | Chunk registration; `composeFreshTitle`; `buildPlanExecutionPrompt` (byte-identical to the shared assembler); `describeFreshPrompt` matrix (five ordered blocks, chars sum to total, included flags, oversized boundary at 32000/32001, 50k non-truncation, text identity with `composeFreshPrompt`); `planPreviewText`; `ActionError`/`describeActionError`; plan-mode user-text collection; `readPlanModeInstructions` metadata/abort/page-cap/degradation; runtime facts/Intl cache; Minimal context; `composeFreshPrompt` switch/preset matrix; the 13-entry `COMPACT_MESSAGE_KEYS` cross-side mapping imported from `host/plan-compaction.js`; `runCompactCommand` result shapes/raw text; `dismissReview`; `createFreshExecution` ordering, parallel create/instructions start, rename tolerance, stillPending/reviewGone, archive-on-failure, `.cleanupError`, instruction reuse, `cancelError`. |
| `test/client-wiring.test.js` | Entry registers; three-wave `require.async` grouping (6 loads, in-wave concurrency ≤ 3, sequential waves); required services; slot options and full inject faces including `readPromptSwitches`; `settings.section` only with `configForms`; late `ctx.inject(['configForms'])` arrival (already-built face reads the new values); `testSurface.loadChunks`/`dictionaries`; plan-review registration without `configForms`. |
| `test/client-render.test.js` | Trigger (closed renders no dialog); root plan expand/collapse; **Back to editing** success/failure/absence; compact failure three buttons + retry loading + proceed/cancel + success status + `aria-busy`; clear preview blocks/checkboxes/loading/oversized/minimal gating/confirm gating/confirm arguments/`stillPending`/`.cleanupError`; back navigation; primitives (`Checkbox`, radio `ListRow`, title attributes, `Dialog` `aria-busy`, `WarningBox`, blocked-Escape handler contract). |
| `test/client-locale.test.js` | `testSurface.dictionaries` export; zh/en key-set equality; non-empty values; placeholder parity; the 0.3.0 key inventory; chunk-wave declaration; every `COMPACT_MESSAGE_KEYS` value is a `compact.error.*` key present in both dictionaries (exactly 13). |
| `test/client-model.test.js` | `filterModelGroups` matrix (blank/whitespace same reference, non-string, provider id/display-name and model id/name matching, provider match keeps all models, no reorder/mutation, empty groups dropped); `ModelListView` search/filter/no-matches/loading/empty/error/retry/disabled; `EffortListView` provider-default presence/selection, explicit effort, `noEffort`; radiogroup props; preserved helpers; preset-list radiogroup/state coverage. |
| `test/client-settings.test.js` | Hook-free `GreatPlanSection` for missing/invalid form vs delegation; ready rows/h2/`aria-describedby`/descriptions; per-row reset only when off and `form.set(field, true)`; toggle writes; refused/throwing writes; busy; loading/idle/unavailable/error/unknown; read-only; read-helper defaults. |

Fakes: `globalThis.window.__ModuleLoader__`, fake React (`useSyncExternalStore` calls `getSnapshot`, `createPortal` is identity; `client-render.test.js` adds a small hook-mount harness for manual re-renders but still runs no real React render, effects, or DOM), `document.body` stub; the Host tests use a fake `systemPrompt` registry and a fake `ctx` whose `inject` hands back fake services. These are structure and pure-logic tests; a green render test is not behavior coverage.

When a chunk is added or an import edge changes, update the module registries in `client-wiring.test.js` and `client-render.test.js` (and `client-actions.test.js` if it materializes the chunk) and add the chunk to `CHUNK_WAVES` in `client.js`. Keep tests deterministic and cheap; don't add dependencies.

## Architecture

**Two halves, one package.** The manifest declares the package as a bundle (`dsh.bundle.patch`), a Web Client (`dsh.client`: `platform: 'web'`, `immediately: true`, `inject` ordering for conversation/user-questions/model-selection/workspace/settings/settings-general/locale), and the runtime exports (`.`, `./client`, `./locale/*.json`, `./icon`). Host: `index.js` re-exports `Config` from `host/config.js` and `apply` from `host/apply.js`; `apply(ctx, config)` registers the command inside `ctx.inject(['commands'], ...)`, the prompt section inside `ctx.inject(['systemPrompt'], ...)`, and `settings.configure({ auto: false })` inside `ctx.inject(['settings'], ...)`. Client: `client.js` registers a `window.__ModuleLoader__.load({ id, factory })` entry for the package; each `client.<name>.js` chunk registers the same id with `chunk: 'client.<name>.js'`. The entry loads chunks in three waves through the `CHUNK_WAVES`/`loadChunks(require.async)` helper: `Promise.all([ui, actions])` → `Promise.all([settings, model, preset])` → `panel` (parallel inside one wave, sequential across waves). `ui` and `actions` are independent; later chunks require `ui`/`model`/`preset` at factory time and `panel` also requires `actions` synchronously, so the grouping is load-bearing: a chunk that requires a sibling materialized in a later wave would crash the slot entry. The entry factory also returns a **test-only** `testSurface` (`dictionaries`, `loadChunks`) next to `inject`/`apply`; the DSH Loader consumes only the latter two (verified against `dsh-client-modules`: registration validates only `id`/`chunk`/`factory`). `react`/`react-dom` come from the browser module table; never bundle or install them.

**Host prompt section `great-plan:plan-evidence`** (`host/plan-evidence.js`): `index.js` registers it inside `ctx.inject(['systemPrompt'], ...)` through `systemPrompt.section({ name, order, text })`. It sits in the global prompt layer immediately after the native `plan:policy` (order = `systemPrompt.getSectionOrder('PLAN_POLICY') + 1`, fallback 501) and before `TEAM_POLICY` (600). Text renders only while the agent's plan projection is active or pending-active, with pending winning over logged state (`pending === undefined ? active === true : pending === true`) so it appears and disappears at the same step boundary as `plan:policy`. When the budget switch is on, the section starts with the unlimited-token-budget reminder, then the brainstorming guidance; the evidence/handoff guidance always closes the section and disabled parts are omitted entirely (see `composePlanGuidance`). The guidance asks the planner to assess the request, ask one concise question per turn only for material ambiguities, then summarize relevant options, rationale, tradeoffs, and assumptions; it does not request private step-by-step reasoning and does not authorize execution outside the native plan-review flow. It also retains the existing background, evidence-chain, citation, and executor-handoff requirements. Without a `systemPrompt` service the section is simply never registered; a missing `planMode` service, agent, or projection state, or a throwing `planMode.get`, degrades to empty text. None of these paths affects prompt assembly. The plugin deliberately does not override plan-mode's `section` config — that would be upgrade-fragile — and never replaces or copies the native `plan:policy` text.

**Host Config and Settings page** (`host/config.js` + `client.settings.js`): `Config = z.object({ injectBrainstormingPrompt: z.boolean().default(true).volatile(), injectUnlimitedBudgetPrompt: z.boolean().default(true).volatile(), includeOriginalUserInstructions: z.boolean().default(true).volatile(), includeMinimalRuntimeContext: z.boolean().default(true).volatile() })`, imported from `@deepseek-ai/schemastery` — declared in `peerDependencies`, so DSH's runtime resolution maps that bare import to the installation's copy (an undeclared import fails activation; see **Build & Install**). `host/config.js` is never imported by the offline tests. `apply` keeps the live config object and the section text reads `readBrainstormingEnabled(config)` and `readUnlimitedBudgetEnabled(config)` on every assembly, so a Settings write takes effect at the next prompt without restarting the Host; a plain boolean, a missing value, or an unreadable field/reference all fall back to on. `settings.configure({ auto: false }, ctx.fiber)` suppresses the schema-derived Settings page because the plugin ships its own.

The Client registers a list cell in `settings.section` (declared by `client-ui-settings-general`): `id: 'great-plan'`, `order: 25`, `label: () => t('settings.nav')`, `locale: 'great-plan'`, inject face `{ form: configForms.get('great-plan') }`. It reads/writes through `ctx.configForms` — the shared Host-settings mirror and ordered write queue — with `form.set(field, next)` returning whether the Host accepted the write for one of the four Config fields. The capability is optional: `configForms` is not in the plugin's declared `inject` list, so a composition without the settings UI still loads the plan-review entry, and only the page is skipped. The Client binds it with `ctx.inject(['configForms'], (scope) => {...})` (late arrival supported): inside that callback it stores the latest `configForms` for `readFreshPromptSwitches(configForms)` and registers the settings cell; the plan-review cell registers outside the callback and never depends on it. The same mirror supplies `readFreshPromptSwitches(configForms)` (budget + original instructions + Minimal context) to the fresh-session execution prompt and the clear-view preview switches; without it every switch defaults to on. The page component is split into a hook-free `GreatPlanSection` (missing/unreadable form → heading + unavailable note) and `GreatPlanForm` (hooks, status handling, four rows); each row whose switch is off also renders a ghost **Reset to default** control that calls `form.set(field, true)`. All four switches are hand-rolled `role="switch"` buttons (host primitives are never imported), described by their description element via `aria-describedby`, disabled while loading/busy or when the form is not writable, with loading, unavailable, read-only, and save-failure copy in both locales. The four rows share one busy/failure state, so a write in flight disables all four.

**Host command `/great-plan-compact`** (`host/plan-compaction.js` + `host/plan-range.js`):
- Contract object `{ name, description, handler(invocation) }`; `invocation = { agent, rawInput, signal }`; returns `{ kind: 'success' | 'error', text }`, never throws for expected failures.
- Preconditions: no arguments (`rawInput` is defensive: a non-string value is treated as no arguments); plan projection active (`sessionProjections.stateOf(session, 'plan').active === true`); a composed compaction service with `compactRegion`; a pending plan review = the last surface node is an `assistant/message` whose content carries a `tool-call` block named `EXIT_PLAN_MODE_TOOL` (`exit_plan_mode`). Another tool call, or a tool-call block without a name, is not a plan review.
- Range: start at the first node after leading `system/message` nodes; end at the last node before the pending plan message where `toolPairingBalancedAfter(session, seq)` holds (snap backwards); no history → `empty`, no pending review → `no-review`.
- It executes `compaction.compactRegion(start, end, agent, signal)` and reports `Compacted <n> history items (~<t> tokens).`. Stable manual-compaction codes map to user text: `busy`, `changed`, `summary`, `commit`, `persistence`, `cancelled`; unknown errors use `messageOf`.
- `USAGE`, `FAILURES`, and `MESSAGES` export every static user-visible message; the Client mirrors each exact string in `COMPACT_MESSAGE_KEYS` (13 entries) so the dialog can localize failures, and the cross-side test in `client-actions.test.js` fails if a host message loses its mapping. Dynamic messages (`...: <detail>`) stay English by design and are documented limitations.
- `@deepseek-ai/dsh-compaction` is imported lazily and declared in `peerDependencies`, so DSH's runtime resolution supplies the installation's copy. Missing package/backend degrades to a command error; the dialog localizes it and offers **Retry compaction / Execute anyway / Cancel** instead of approving.
- The command never answers the review, changes plan mode, or writes new session events; approval stays in the Client.

**Slot registration** (`client.js`): the plugin is a list cell in `conversation.plan-review.actions` (kind `list`, scope `session`, declared by `client-ui-user-questions`, also occupied by `client-ui-plan`):

```js
ctx.slots.inject('conversation.plan-review.actions', () => ctx.slots.register({
  name: 'conversation.plan-review.actions',
  id: 'great-plan-execute-options',
  order: -2,
  locale: 'great-plan',
  inject: (sessionId) => ({ directory, actions, presetStore, modelAvailable, readPromptSwitches }),
}, panel.ExecutionTrigger));
```

Owner props: `review` = `PlanReview` (`id`, `question`, `plan`, optional `callId`, `approve`, optional `decline`, each option `{ label, description? }`) and `requestKey`. Standard slot props used: `sessionId`, `t`, `useSessionStatus`, `useSessions`, `useWorkspaces`. Injected face: `directory = ctx.modelDirectories.directoryFor(sessionId)` (shared Composer state — never own model state), `actions` (`client.actions.js` bound to the session: approve/compact/fresh-session operations plus `readPlanModeInstructions` and `dismissReview`), shared `presetStore`, `modelAvailable = ctx.sessions.subagentAddress(sessionId) === undefined`, and `readPromptSwitches()` (the settings-mirror snapshot for the clear-view preview, defaults on). The panel chunk also requires `client.actions.js` synchronously for the pure helpers (`describeFreshPrompt`, `planPreviewText`, `describeActionError`, `describeCompactFailure`, `readRuntimeFacts`, `normalizePromptSwitches`), so `actions` must load before `panel` in the chunk waves. `ctx.effect` owns the locale dictionary and the injected stylesheet; chunk factories stay side-effect free.

**Execution flows** (hard constraints):

```text
trigger (only when pendingInteraction.kind === 'plan-review'; the dialog is mounted only while open)
├─ execute  pending.answer({ answers: [{ id: review.id, selected: [review.approve.label] }] })
│            + pending.dismiss() when snapshot.channel === 'rpc'
├─ compact  ctx.remote.commands.execute(sessionId, '/great-plan-compact', [], signal)
│            success → transient localized status → approveReview
│            failure → dialog stays open with Retry compaction / Execute anyway / Cancel
│            (closing the dialog while the command runs aborts the wait and never approves)
├─ revise   pending.dismiss()            // same as native Discuss; review stays pending
└─ clear    instructions read (preview result reused when present) ∥ ctx.sessions.create({ workspaceId | cwd, agentPreset })
             → ctx.sessions.using(newId, { source: 'greatPlan', signal }, ref =>
                 Promise.all([rename best-effort, ctx.remote.session.selectModel]) →
                 stillPending re-check before prompting (else reviewGone) →
                 session.prompt([{ type: 'text', text: composed fresh prompt }], 'queue', signal))
             → previous.session.cancel() best-effort → ctx.uiWorkspace.openSession(newId) (SYNCHRONOUS)
             every failure after create (including openSession) archives newId with
             archiveSession(newId, { stopActivity: true }); an archive failure is logged and
             attached as .cleanupError → localized warning
```

- The dialog re-reads `pending` from `useSessionStatus`; if the review settled (`pending === undefined`) it shows "review gone" and does nothing. Trigger and dialog unmount when the review settles, so late failures after the old session was stopped are console-only.
- One operation at a time (`busy`; model/effort selection counts as busy). Close, back, Escape, and backdrop are blocked during model, effort, execute, clear, and revise operations; during compaction they stay enabled and closing aborts the wait, so the review is not approved. A blocked Escape is consumed (`preventDefault` + `stopPropagation`) so it cannot leak to the host. Every post-await state change is gated by `aliveRef`.
- Dialog view state is `root | model | effort | clear | preset`; it resets on unmount. A compaction failure is a root-view state (`compactFailure`), not a view. `directory.load()` runs on open; entering the clear view starts the abortable instruction read and loads presets without forcing (`presetStore.load()`); the retry button forces (`load(true)`). Changing views focuses the dialog title (the h2 has `tabIndex={-1}`); the dialog sets `aria-busy` while busy.
- The root and clear views share the plan section (question + `planPreviewText` summary + expandable full-plan `<pre>`; h3, labelled region when expanded). The clear view renders the preview block list from `describeFreshPrompt` (included/excluded + per-block chars, instruction count/chars, total chars, approximate tokens, oversized warning, runtime hint) and the three this-run switches; the fresh confirm is disabled while instructions load or while the model catalog is `loading`/`idle`, and a catalog `error` still allows confirm with the default-model note.
- Errors: coded `ActionError`s localize through `describeActionError` (`error.<code>`); unexpected action failures fall back to the contextual `error.*` keys. Compaction failures localize through `describeCompactFailure` (exact host-message mapping) with raw English fallback. Approve/model/select/fresh failures surface as inline `ErrorText`; the compaction failure block is a persistent `WarningBox` (role=status) and never auto-approves.
- The fresh-session prompt is composed in `client.actions.js` through one shared assembler: localized intro → optional budget reminder → optional Minimal `<fresh-session-context>` → optional `<plan-mode-user-instructions>` → `<approved-plan>`. `composeFreshPrompt`, `describeFreshPrompt`, and `buildPlanExecutionPrompt` all funnel through it, so the preview `text` is byte-identical to the sent message. Plan-mode user texts are read from the old session's loaded event window (`ctx.sessions.binding(sessionId).eventSource`, up to eight older pages); injected contexts are excluded. The preview reuses that read at execution (no second window scan). The Minimal context exists only for `presetId === 'minimal'` and carries the workspace directory (`useWorkspaces.path`, falling back to the session `cwd`), browser platform, current time/zone, and a cleared-context note; execution re-reads the time, so the previewed time can differ. Every switch defaults to on when the settings mirror is unavailable; a missing binding/window/user text degrades to an omitted block. Instructions and plans are never truncated (only the oversized hint reports size). **Compact and execute** never inserts any of these blocks.

**Client services used** (confirm against the installed package before changing): `ctx.locale.register(ns, { zh, en })` (complete dictionaries for both shipped locales); `ctx.remote.commands.execute(sessionId, name, args, signal)` → `{ ok, value?, error? }` with the command outcome at `value.result`; `ctx.remote.session.selectModel({ sessionId, provider, model, reasoningEffort? })`; `ctx.remote.agentPresets.list()` → `{ ok, value: { presets } }` (broken presets filtered; `gateway/invocation-unavailable` → "unavailable"); `ctx.sessions.create/using/binding/subagentAddress` plus `binding.eventSource` and `session.loadOlder()` for the plan-mode user texts; `session.rename/prompt/cancel`; `ctx.uiWorkspace.openSession` (synchronous)/`archiveSession`; `ctx.inject(['configForms'], scope => ...)` for the optional shared Host-settings mirror (late arrival; backs the four Settings switches, the per-row reset, and the fresh-prompt/preview switches) — never put `configForms` in the plugin-level `inject` array, because the plan-review entry must load without the settings UI; the `useWorkspaces` standard prop supplies the workspace `path` for the Minimal context. Action helpers exported by `client.actions.js` for the panel: `describeFreshPrompt`, `planPreviewText`, `describeActionError`, `describeCompactFailure`, `readRuntimeFacts`, `normalizePromptSwitches`, `ActionError`, `COMPACT_MESSAGE_KEYS`, `FRESH_PROMPT_WARN_CHARS`; the `createActions` face adds `readPlanModeInstructions(options)` and `dismissReview({ pending })`.

**Styling and locale.** All chrome uses `--dsw-*` design tokens injected from `client.ui.js` (one style element tagged `data-plugin-css`, disposed by `ctx.effect`); layout and focus behavior copy the host controls. Visible copy goes through `t(...)` with identical zh/en keys; `test/client-locale.test.js` enforces key parity, placeholder parity, a release key inventory, and the compact-message mapping. The dialog renders through `ReactDOM.createPortal(..., document.body)` with anchored positioning, focus trap, Escape handling, and focus restore. The backdrop is a dimmed `color-mix(...)` layer; lists with a single selection use `role="radiogroup"` + radio rows; clear-view toggles use native labelled checkboxes; switches show a ≥24px hit target and `aria-describedby`; truncated values carry `title`; a busy dialog reports `aria-busy`.

## Module Map

| Path | Purpose |
|---|---|
| `index.js` | Host entry: re-exports `Config` and `apply`; the DSH Loader reads both exports here. |
| `host/apply.js` | `apply(ctx, config)`: registers `/great-plan-compact` with `commands`, the evidence prompt section with `systemPrompt`, and `settings.configure({ auto: false })`. |
| `host/config.js` | Schemastery `Config` with four volatile switches: `injectBrainstormingPrompt`, `injectUnlimitedBudgetPrompt`, `includeOriginalUserInstructions`, `includeMinimalRuntimeContext` (all default on); the first two feed the Host section, the last two the Client fresh prompt. |
| `host/plan-compaction.js` | Command factory, validation, failure mapping, exported static user-visible message constants (`USAGE`/`FAILURES`/`MESSAGES`), `EXIT_PLAN_MODE_TOOL`. |
| `host/plan-range.js` | Pure plan-compaction range selection (`selectPlanCompactionRange`, `exit_plan_mode` precondition). |
| `host/plan-evidence.js` | Global `great-plan:plan-evidence` prompt section: order resolution, plan-active/pending gate, budget + brainstorming + evidence/handoff composition (all-on constant fast path), config-driven switch reading. |
| `client.js` | Client entry: ModuleLoader factory, zh/en dictionaries, locale/style effects, preset store, fresh-prompt/preview switch reader, slot registration, three-wave chunk loader, test-only `testSurface`. |
| `client.ui.js` | CSS (tokens, `.gp-*`, dimmed backdrop), store helpers, icons, primitives (`Button`, `SelectRow`, `StaticRow`, `Checkbox`, radio-aware `ListRow`), `Dialog` (portal, anchoring, focus trap, blocked-Escape consumption, `busy`/`aria-busy`). |
| `client.model.js` | Model-directory state reading, labels, model search (`filterModelGroups`), model/effort list views with always-present provider-default effort and radiogroup semantics. |
| `client.preset.js` | Agent-preset store (`idle/loading/ready/unavailable/error`, inflight dedupe) and preset list view (radiogroup). |
| `client.actions.js` | Shared fresh-prompt assembler (`composeFreshPrompt`/`describeFreshPrompt`/`buildPlanExecutionPrompt`), plan preview, instruction reader (metadata + abort), approve/compact/dismiss/fresh-session operations, `ActionError` + error codes, compact failure mapping/`COMPACT_MESSAGE_KEYS`, runtime facts + cached `Intl` formatters, hardened fresh-session ordering/cleanup. |
| `client.panel.js` | `ExecutionTrigger` + `ExecutionDialog` state machine, view routing, plan section + Back to editing, compact-failure retry/proceed/cancel, clear-view preview + this-run switches + abortable instruction read, focus-on-view-change, busy/abort handling. |
| `client.settings.js` | `settings.section` page body: hook-free wrapper + `GreatPlanForm`, four switches plus per-row reset-to-default over the shared configuration form, with loading/unavailable/read-only/error states and `aria-describedby`. |
| `locale/en.json`, `locale/zh.json` | Plugin listing `meta.title`/`meta.description` only — not runtime copy. |
| `icon.svg` | Plugin icon (SVG, inside the package, < 256 KiB). |
| `cordis.patch.yml` | Host bundle patch inserting row `great-plan`. |
| `package.json` | Manifest: `exports`, `files`, `peerDependencies` (Host imports supplied by the installation), `dsh.bundle.patch`, `dsh.client`; version `0.3.0`. |
| `test/*.test.js` | Offline Node tests (see **Host Tests**). |
| `tools/gate.sh` | Verification gate (see **Gate**). |
| `.github/workflows/gate.yml` | CI: runs the gate on push and pull requests with Node 24. |

## Conventions (new code only; never mass-rename legacy)

- Plain modern JavaScript, 2-space indentation, semicolons, single quotes; match the surrounding file. Host files are ESM; Client chunks are ModuleLoader factories and must not use `import`/`export` — use `require`/`require.async` and package-qualified ids.
- Naming: components `PascalCase`; functions/variables `camelCase`; module constants `UPPER_SNAKE` (`NS`, `CSS`, `STYLE_ID`); CSS classes `.gp-*`; locale keys dot-namespaced (`panel.*`, `clear.*`, `preset.*`, `error.*`).
- Chunk files are flat at the package root and named `client.<name>.js` (test-enforced). New runtime files must be listed in `package.json` `files` (and `exports` for new public resources). A new chunk also needs its `require.async` load (and sibling `require` edges) in `client.js`, the fake registries in both Client tests, and the README project-structure tables.
- Every visible string goes through `t(...)`; add both `zh` and `en` keys in the same edit; keep placeholder names (`{message}`) identical. Command descriptions are not localizable (known limitation).
- Host user-visible failures that the Client surfaces: export each static message constant from its Host module, mirror the exact string in `COMPACT_MESSAGE_KEYS` with a `compact.error.*` key in both dictionaries, and keep the cross-side test green; dynamic messages fall back to English by design.
- Command failures that keep the dialog open are UI state (e.g. `compactFailure`) rendered as a persistent `WarningBox` with explicit user choices — never auto-approve after a failure or swallow the reason.
- `client.js` returns a test-only `testSurface` next to `inject`/`apply`; the Loader ignores unknown factory-return keys, so keep it test-only (never read it from `apply` or a chunk).
- New views/states must move focus to the dialog title, keep radiogroup/checkbox/switch semantics and `aria-busy`, keep ≥24px touch targets, and abort their in-flight work on close.
- Styles live in `client.ui.js` and only reference host tokens; keep `prefers-reduced-motion` and `:focus-visible` handling; don't add literal colors to chrome (artwork excepted). A dimmed layer must use `color-mix` over host tokens, not a literal color.
- Host failure handling returns `{ kind: 'error', text }` with actionable text, maps stable error codes, and forwards `signal`; never throw for expected failures.
- Client failure handling catches at the UI boundary, shows `ErrorText`/`WarningText`, keeps the dialog usable, and logs best-effort cleanup failures as `console.warn('great-plan: ...')`.
- No new session event types and no new Agent tools. The only configuration is the plugin's own volatile Config switches for its Settings page; never edit another plugin's Config, and never write the profile yourself. Keep unload clean: effects dispose the stylesheet and dictionary, and the plugin writes nothing to the profile.
- Tests: cover every new pure function or wiring change in `test/`; no new dependencies; deterministic and offline.

## Sync Checklists

**New Client chunk** (order matters):
1. Add `client.<name>.js` at the package root with `window.__ModuleLoader__.load({ id: '@local/dsh-great-plan', chunk: 'client.<name>.js', factory })`.
2. Add it to `CHUNK_WAVES` in `client.js` (a wave may hold it only if everything it requires synchronously materializes in an earlier wave or the same wave); siblings require it as `require('@local/dsh-great-plan/client.<name>.js')`.
3. Update the fake module registries in `client-wiring.test.js`/`client-render.test.js` (and `client-actions.test.js` if materialized there); keep the chunk-naming manifest test and the three-wave wiring assertions green.
4. Update "Project structure" in both READMEs (`README.md`, `README.zh-CN.md` 项目结构) and the Module Map above.

**New dialog view or step**:
1. Extend the `view` union and `titles` map in `client.panel.js`; define the back target and blocked/busy behavior; a failure that keeps the dialog open is a state with a persistent `WarningBox` and explicit buttons, not a toast or an auto-continue.
2. Reset its state on unmount; abort in-flight work (its own AbortController); gate state on `aliveRef`; move focus to the dialog title on entry.
3. Add zh/en keys; keep dictionary key sets identical.
4. Extend `client-render.test.js` and run the manual GUI checklist.

**New locale key**:
1. Add the same key to both dictionaries in `client.js`.
2. Format placeholders through `t(key, { ... })`; never concatenate translated fragments.
3. Only listing metadata (`meta.title`/`meta.description`) belongs in `locale/*.json`.
4. Add the key to `RELEASE_KEYS` in `client-locale.test.js` when it is part of a release's inventory.

**New Host command** (only when `/great-plan-compact` cannot be reused):
1. Factory in `host/<name>.js`; register it from `index.js` inside `ctx.inject(['commands'], ...)` with a lowercase kebab-case name.
2. Validate `rawInput` (treat a non-string as no arguments); return `{ kind, text }`; map stable error codes; test in `test/` with fake session/projection/compaction.
3. Export every static user-visible message as a constant; if the Client surfaces it in a dialog, add the exact-string → locale-key mapping (see `COMPACT_MESSAGE_KEYS`) and a cross-side test.
4. Never answer the review or append session events; keep approval in the Client.
5. Document it in both READMEs ("Command" section) — commands are user-visible.

**Service or dependency change**:
1. Add the service to the plugin-level `inject` array in `client.js` (or `ctx.inject` in the Host). Keep optional services optional with graceful degradation — a UI-only capability that the plan-review entry must not depend on belongs in `ctx.inject(['<service>'], scope => ...)`, never the plugin-level array.
2. Update the fake `ctx` in `client-wiring.test.js` and assert the new wiring, including late arrival for optional services.
3. Read the owning package README / inspect the Service and Event definitions before relying on a method; never add `@deepseek-ai/*` to `dependencies` — declare every bare Host import in `peerDependencies` so DSH's runtime resolution supplies the installation copy (see **Build & Install**), and keep `@deepseek-ai/dsh-*` ranges compatible with the running runtime.
4. For a new Host package import, import lazily, catch failure, and surface actionable text (see the compaction precedent), and add the package to `peerDependencies` plus the `manifest.test.js` assertion.

**Manifest or display metadata change**:
1. Update `package.json` `exports`/`files`/`dsh.*` and keep `manifest.test.js` green.
2. Update `locale/{en,zh}.json` meta and `icon.svg` (SVG/PNG/JPEG/WebP, inside the package, ≤ 256 KiB).
3. Reinstall only if package identity or manifest changed; restart DSH to observe Host/package changes; verify the Plugins list title, description, and icon in zh and en.
4. Update install/usage in both READMEs if user-facing behavior changed.

**Structure change** (new module/directory or renamed file): "Project structure" in both READMEs + Module Map above + `package.json` `files` + affected tests; if a frozen name would change, read **Frozen Names & Known Debt** first.

## Frozen Names & Known Debt (record, don't fix)

Frozen identifiers:

- `@local/dsh-great-plan` — ModuleLoader id, Client chunk require prefix, profile link, and bundle row name. Renaming breaks the installed plugin and every browser module resolution.
- Client chunk file names `client.js`, `client.ui.js`, `client.settings.js`, `client.model.js`, `client.preset.js`, `client.actions.js`, `client.panel.js`. The `client.<name>.js` naming rule and load order are load-bearing. Settings slot cell `id: 'great-plan'` lives in the host-owned `settings.section` slot; Config fields `injectBrainstormingPrompt`, `injectUnlimitedBudgetPrompt`, `includeOriginalUserInstructions`, and `includeMinimalRuntimeContext` are the Settings page's storage keys.
- Slot cell `id: 'great-plan-execute-options'`, `order: -2`; slot key `conversation.plan-review.actions` is host-owned — never rename or re-declare it.
- Locale namespace `great-plan`; CSS prefix `gp-`; Host command `great-plan-compact`; `sessions.using` `source: 'greatPlan'`.
- Prompt section `great-plan:plan-evidence` (global Host prompt layer, order 501) — the neighboring native sections `plan:policy` and `TEAM_POLICY` are host-owned; never override plan-mode's `section` config and never replace or copy the native `plan:policy` text.
- zh/en dictionary text is product copy: don't "improve" strings without a request.
- `client.js` `CHUNK_WAVES` grouping (ui+actions → settings/model/preset → panel) and the test-only `testSurface` returned beside `inject`/`apply`. The grouping must respect synchronous sibling requires; `testSurface` must stay test-only (the Loader ignores it, but `apply` and chunks must not read it).

Known limitations (0.3.0, as shipped):

- The model list has a simple case-insensitive substring search; the Composer model control remains the full picker and the two never share state. Selecting a model applies immediately and is saved as the default model by existing DSH behavior.
- Compaction requires a composed backend and makes one summary model request. When it cannot run (unavailable backend, empty history, failed request, cancellation) the plan is **not** approved: the dialog keeps a persistent failure block with **Retry compaction / Execute anyway / Cancel**. The conversation's command result card stays English even in a Chinese UI (the Host command contract has no locale); the dialog copy is localized for the static host messages and falls back to English for dynamic `...: <detail>` failures.
- The native **Approve** / **Request changes** buttons sit behind the dialog while it is open. Close the dialog (or use **Back to editing**, which equals Request changes) to use them; **Execute plan** is the in-dialog Approve.
- New-session title prefix and old-session stop are best-effort; opening the new session is the primary result. A failure after creation archives the new session (with `stopActivity`) and reports a localized error; when the dialog was already unmounted by a settled review, the failure is logged to the console only. **Start fresh and execute…** re-checks the pending review right before prompting and stops the old session after the message is sent, but another client can still approve that review in the brief window before the stop — the residual multi-client race is not eliminated.
- A fresh session starts with the deployment's default permissions and sandbox context; the old session's permission or sandbox state is not inherited.
- `/great-plan-compact` appears in the command menu, and command descriptions cannot be localized.
- The budget, brainstorming, and evidence guidance in the plan prompt section is advisory: the model may ignore it, and the plugin does not validate plan behavior or content. Without `systemPrompt`/`planMode` services the section is silently absent (empty text), and a Host restart is required before the section is live. The four Settings switches independently control the budget reminder (plan prompt and fresh-session message), the brainstorming paragraph, the fresh-session plan-mode user instructions, and the Minimal runtime context; the evidence/handoff paragraph always renders in plan mode. The switches need a DSH composition with `settings` + `configEditor` and the Client settings UI; without them the Host keeps all four defaults (on), the Settings page is not registered, and the Client defaults all fresh-session switches to on. The new Host fields need a Host restart before the Settings form can write them. The budget reminder and the new prompt blocks are never added to **Compact and execute**.
- Plan-mode user instructions are read from the old session's loaded event window. The plugin looks back up to eight pages for the `plan/mode` start, then falls back to the `/plan` command or current turn; if no marker is loaded it uses the latest real user text. The preview reuses that read for execution. Instructions and plans are never truncated: the preview shows the total size, an approximate token count, and an oversized hint above ~32,000 characters, but a very long conversation still produces a large first message.
- The preview's Minimal runtime context is built when the clear view opens; execution re-reads the time, so the previewed time can differ. Its system/time values come from the browser (`navigator` platform and `Intl` time zone). In a remote Web deployment they describe the browser, not necessarily the Host; the workspace directory is still Host-side.
- No integration tests exist for compaction, fresh-session execution, the three-wave network load, or the live UI; those rely on the manual checklist.

Debt and quirks (record, don't fix unless asked):

- Runtime dictionaries are inline in `client.js` while `locale/*.json` carries only listing metadata. The duplication is intentional (browser bundle vs Host metadata); don't merge without a design change.
- Tests use fake React and never mount real React; `client-render.test.js` has a tiny hook-mount harness for interaction flows but still runs no real effects, portal, or DOM. 190/190 is not behavioral coverage; the manual checklist remains the only GUI proof.
- Client HMR keys off the `client.js` artifact only (mtime/ctime/size); chunk-only edits can serve a stale revision. Touch `client.js` or restart before judging browser output.
- The Client returns a test-only `testSurface` from the entry factory. The DSH Loader ignores unknown factory-return keys (verified in `dsh-client-modules`: `register()` validates only `id`/`chunk`/`factory`), so this is safe, but keep it test-only; removing it means updating `client-locale`/`client-wiring` tests.
- `@deepseek-ai/dsh-compaction` is imported dynamically and `@deepseek-ai/schemastery` statically in `host/config.js`; both are declared under `peerDependencies` and resolved to the DSH installation's copies by the runtime resolution (the offline tests cannot resolve them, so they never import `host/config.js`). The peer mapping is load-bearing: without it the import resolves from the workspace and plugin activation fails. A composition without compaction degrades to a command error plus the retry/proceed/cancel dialog; a Host where `host/config.js` cannot resolve fails the plugin load, which is why the config import stays in its own module.
- This workspace became a git repository on 2026-10-24 (`origin` = `https://github.com/onefl666/dsh-great-plan`, branch `main`); history before that has no rollback. Don't commit or push unless asked.
- The dialog renders through a React portal to `document.body` (existing pattern). Don't hand-write DOM outside components or add a second application root.
- `0.3.0`, private local package; no lockfile and no `node_modules` in this repo.

## Maintaining This File

This file follows the repo's operational-guide contract: rules → verification → architecture → ownership map → conventions → change recipes → frozen debt. Update it in the same change whenever behavior, commands, module ownership, or frozen names move. README (`README.md` English, `README.zh-CN.md` Chinese, kept in sync) is user-facing; AGENTS.md is agent-facing; keep both true, and update the "Last verified" line when you run the gate on a new DSH/Node version.
