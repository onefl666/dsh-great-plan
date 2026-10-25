# AGENTS.md — Great Plan / 卓越计划

Operational guide for AI agents in this repo. Verify with `bash tools/gate.sh` before claiming done.
Last verified: 2026-10-25 (DSH 0.2.1-rc.3, bundled Node v24.21.0, 52/52 host tests).

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
- No new session event types and no new Agent tools: this plugin is composition only, built on existing `commands`/`sessionProjections`/`compaction`/session/model/settings services. Its two configuration fields are the plugin's own volatile Config switches backing the Settings page (see **Host Config and Settings page**).

## Project

DSH Web plugin `@local/dsh-great-plan` ("Great Plan" / "卓越计划"). It adds an **Execution options** entry to the native plan-review card, lets the user choose model + reasoning effort, and offers three ways to execute the reviewed plan:

- **Execute plan** — approve the pending review in the current session.
- **Compact and execute** — run the Host command `/great-plan-compact` over the history before the pending plan, then approve.
- **Start fresh and execute…** — stop the current turn, create a new session in the same workspace (agent preset selectable), send the approved plan as its first prompt; the old session is kept and not archived.

The native `Approve` / `Request changes` / `View full plan` controls and the plan-review lifetime stay untouched; the plugin only adds one entry to the `conversation.plan-review.actions` slot.

It also adds a **Great Plan** page (id `great-plan`) to the native Settings panel with two switches: **Inject brainstorming prompt** / **注入头脑风暴提示词** (`injectBrainstormingPrompt`) and **Inject unlimited token budget prompt** / **注入 token 预算无上限提示词** (`injectUnlimitedBudgetPrompt`), both volatile and on by default. Turning the brainstorming switch off removes the clarification/brainstorming paragraph from the plan prompt while the evidence chain and executor handoff stay. Turning the budget switch off removes the unlimited-token-budget reminder from both the plan prompt and the fresh-session execution message. The changes apply to the next prompt assembly without a Host restart.

While plan mode is active (or pending-active) the Host registers the global prompt section `great-plan:plan-evidence`. An optional unlimited-token-budget reminder comes first, then the clarification/brainstorming guidance, then the evidence and executor handoff. The guidance asks the planner to clarify material ambiguities one question at a time, summarize its recommendation, relevant tradeoffs, and assumptions, and include background, an evidence chain, and an execution handoff. It is advisory, does not expose private step-by-step reasoning, and never replaces or copies the native plan policy; see **Architecture**.

Names: package and Client module id `@local/dsh-great-plan`; profile bundle row id and Settings entry id `great-plan`; Config fields `injectBrainstormingPrompt` and `injectUnlimitedBudgetPrompt`; locale namespace `great-plan`; Host command `great-plan-compact`; display title `Great Plan` / `卓越计划`. Manifest display metadata lives in `locale/*.json`; runtime dictionaries live inline in `client.js`.

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
- **G-TEST** — `node --test test/*.test.js`; all **52** cases must pass. The offline tests never import `host/config.js` or link the real installation; the peer declarations that make the Host imports resolvable are asserted statically by `manifest.test.js`.
- The gate script uses `node` from `PATH`, else the DSH runtime node (`$DSH_HOME/dsh-runtimes/*/dependencies/node/bin/node`; on this machine `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`, v24.21.0). There is no system `node` on this host.
- Manual equivalent when `node` is on `PATH`: `node --test test/*.test.js` and `node --check ...`.
- **Linked-root resolution check** (no GUI needed, run after touching `package.json` or Host imports): create a scratch DSH home under `/tmp` whose profile links this package and declares `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and this bundle, then run the installed CLI: `DSH_HOME=/tmp/<scratch> "<app>/Contents/Resources/runtime/cli/bin/dsh" --profile <name> --dump-config-schema`. The `great-plan` row must report `status: schema` with both the `injectBrainstormingPrompt` and `injectUnlimitedBudgetPrompt` definitions (each defaulting to `true` and marked volatile), and no `Cannot find package '@deepseek-ai/schemastery'` diagnostic may appear. Stock-bundle rows of the scratch profile may still report unrelated diagnostics; the scratch profile is a fixture — never point it at the real profile or write the profile's files.

**What green does NOT prove:** live Host/Client composition; live prompt assembly (including the `great-plan:plan-evidence` section and the fresh-session budget reminder) and model compliance with the budget, brainstorming, and evidence guidance; the real slot props (`review`/`requestKey`); `ctx.modelDirectories`/`ctx.sessions`/`ctx.remote.*`/`ctx.uiWorkspace` behavior; a real compaction backend and its model request; new-session creation/opening/cancel/archive; locale switching; theme, light/dark contrast, focus, Escape, and layout; install metadata and icon rendering. Those require the manual checklist below in the running DSH Web GUI. `host/config.js` statically imports Schemastery from the DSH installation, which the offline tests cannot resolve (they must stay offline), so no Host test imports it; the peer dependency that makes that import resolvable in a running Host is covered statically by `manifest.test.js`, and the live resolution by the check above.

**Manual GUI checklist** (restart DSH for Host changes; refresh/touch `client.js` for Client changes; enter `/plan`, ask for a plan, then):

1. Review strip shows the localized **Execution options** trigger beside untouched native actions; the dialog is anchored to the trigger.
2. Model/effort rows show the current model; model groups and effort levels load; picking one applies immediately and the Composer model selector agrees. Subagent sessions disable model switching and show the notice.
3. **Execute plan** approves the review (card settles; the turn continues).
4. **Compact and execute** runs the command first, shows its success text or a fallback warning, then approves anyway; closing while busy cancels.
5. **Start fresh and execute…** shows the warning, preset, title preview, and model summary; the preset sub-page lists presets; confirm creates and opens a new session in the same workspace whose first message contains the approved plan; the old session is kept (stop is best-effort; a failure logs a console warning).
6. Locale switch zh ↔ en updates all plugin copy without reload; Plugins list title/description/icon match the manifest.
7. Light and dark themes both read correctly; only `--dsw-*` tokens style the chrome.
8. Escape and backdrop close the idle dialog; focus is trapped and restored; Tab order is sane; execute/model/effort/clear block close, while a running compaction stays cancellable by closing.
9. No console crash, no unhandled rejection.
10. A plan produced in `/plan` carries real background, an evidence chain (paths with line ranges, searches/commands and results, docs/URLs, conflict resolution), and a handoff; citations are real and unverified items are marked as assumptions.
11. A materially ambiguous request leads to one focused question at a time before the final plan; a clear request does not trigger needless questions. The final plan briefly explains key choices and tradeoffs, distinguishes assumptions from user requirements, and leaves the native review flow intact.
12. The budget, brainstorming, and evidence requirements are discoverable in plan mode: after a Host restart the section is live, and asking the planner to quote the budget, clarification, rationale, or handoff requirements shows the new guidance.
13. **Start fresh and execute…** sends the new intro as the first message: execution reuses the plan's evidence/handoff instead of repeating the investigation and verifies only what is marked unverified/assumed. When the budget switch is on, the first message carries the unlimited-budget reminder before the approved plan; when off, it does not. **Compact and execute** keeps the plan message and its handoff after compaction and never adds the budget reminder.
14. Settings lists the localized **Great Plan** page; both switches start on, follow zh ↔ en, trap focus like host rows, and read correctly in light and dark themes.
15. Turning either switch off saves without a Host restart, survives a page reload and a Settings reopen, and affects only its own guidance: brainstorming off keeps the evidence/handoff and budget paragraphs; budget off removes the reminder from the next `/plan` prompt and the fresh-session message while brainstorming/evidence stay; turning it back on restores it. A refused write keeps the previous value and shows the localized retry message.

Browser automation is not available here. If you cannot run the GUI, say exactly which checklist items remain unverified.

## Host Tests

`test/` is a deterministic, offline Node test project using the built-in runner and `node:assert/strict`; it has no dependencies and never touches DSH, the network, a model, or a DOM.

| File | Covers |
|---|---|
| `test/manifest.test.js` | Package manifest (bundle patch, Client declaration, exports, files, peer dependencies for the Host imports), locale metadata, icon, Client chunk naming, required delivery files, "no Harness Client package imports", Host entry exports. |
| `test/plan-compaction.test.js` | `selectPlanCompactionRange` (balanced-edge snap, leading system skip, pending-plan exclusion, `empty`/`no-review`) and `createCompactCommand` (success text, inactive plan, missing backend, missing pending review, busy code mapping, argument rejection). |
| `test/plan-evidence.test.js` | Budget, brainstorming, and evidence guidance content; the three-part composition and every switch combination; `readBrainstormingEnabled`/`readUnlimitedBudgetEnabled` (boolean, volatile reference, missing/throwing); the switches flipping text at read time; active/inactive plan-mode and pending gating parity; empty-text degradation (missing services/agent/state, throwing reads); section registration name/order/fallback; `apply()` wiring (command, prompt section, `settings.configure({ auto: false })`) with a fake `ctx`/`inject`. |
| `test/client-actions.test.js` | Chunk registration, `composeFreshTitle` (append/dedupe/blank/80-char budget), `buildPlanExecutionPrompt` (localized intro + optional budget reminder + `<approved-plan>` wrapper, empty rejection). |
| `test/client-wiring.test.js` | Entry loads every chunk via `require.async`, declares the required services, registers on `conversation.plan-review.actions` and (optionally) `settings.section` with the expected options, and builds the inject faces; the plan-review action still registers without `configForms`; uses a fake `ctx`. |
| `test/client-render.test.js` | `ExecutionTrigger` returns a trigger for a plan review; `ExecutionDialog` renders the root view without throwing; `GreatPlanSection` renders both accessible switches for a ready form, hides them while loading, and `readBrainstormingValue`/`readBudgetValue`/`readBudgetSwitch` treat missing values as on. |

Fakes: `globalThis.window.__ModuleLoader__`, fake React (hooks return fixed values, `useSyncExternalStore` calls `getSnapshot`, `createPortal` is identity), `document.body` stub; the Host tests use a fake `systemPrompt` registry and a fake `ctx` whose `inject` hands back fake services. **No real React render, effects, or DOM.** These are structure and pure-logic tests; a green render test is not behavior coverage.

When a chunk is added or an import edge changes, update the module registries in `client-wiring.test.js` and `client-render.test.js` (and `client-actions.test.js` if it materializes the chunk). Keep tests deterministic and cheap; don't add dependencies.

## Architecture

**Two halves, one package.** The manifest declares the package as a bundle (`dsh.bundle.patch`), a Web Client (`dsh.client`: `platform: 'web'`, `immediately: true`, `inject` ordering for conversation/user-questions/model-selection/workspace/settings/settings-general/locale), and the runtime exports (`.`, `./client`, `./locale/*.json`, `./icon`). Host: `index.js` re-exports `Config` from `host/config.js` and `apply` from `host/apply.js`; `apply(ctx, config)` registers the command inside `ctx.inject(['commands'], ...)`, the prompt section inside `ctx.inject(['systemPrompt'], ...)`, and `settings.configure({ auto: false })` inside `ctx.inject(['settings'], ...)`. Client: `client.js` registers a `window.__ModuleLoader__.load({ id, factory })` entry for the package; each `client.<name>.js` chunk registers the same id with `chunk: 'client.<name>.js'`. The entry loads chunks with `require.async('./client.<name>.js')`; chunks require siblings synchronously as `require('@local/dsh-great-plan/client.<name>.js')`. Load order in `apply` is load-bearing: `ui → settings → model → preset → actions → panel` (later chunks require `ui`/`model`/`preset` at factory time). `react`/`react-dom` come from the browser module table; never bundle or install them.

**Host prompt section `great-plan:plan-evidence`** (`host/plan-evidence.js`): `index.js` registers it inside `ctx.inject(['systemPrompt'], ...)` through `systemPrompt.section({ name, order, text })`. It sits in the global prompt layer immediately after the native `plan:policy` (order = `systemPrompt.getSectionOrder('PLAN_POLICY') + 1`, fallback 501) and before `TEAM_POLICY` (600). Text renders only while the agent's plan projection is active or pending-active, with pending winning over logged state (`pending === undefined ? active === true : pending === true`) so it appears and disappears at the same step boundary as `plan:policy`. When the budget switch is on, the section starts with the unlimited-token-budget reminder, then the brainstorming guidance; the evidence/handoff guidance always closes the section and disabled parts are omitted entirely (see `composePlanGuidance`). The guidance asks the planner to assess the request, ask one concise question per turn only for material ambiguities, then summarize relevant options, rationale, tradeoffs, and assumptions; it does not request private step-by-step reasoning and does not authorize execution outside the native plan-review flow. It also retains the existing background, evidence-chain, citation, and executor-handoff requirements. Without a `systemPrompt` service the section is simply never registered; a missing `planMode` service, agent, or projection state, or a throwing `planMode.get`, degrades to empty text. None of these paths affects prompt assembly. The plugin deliberately does not override plan-mode's `section` config — that would be upgrade-fragile — and never replaces or copies the native `plan:policy` text.

**Host Config and Settings page** (`host/config.js` + `client.settings.js`): `Config = z.object({ injectBrainstormingPrompt: z.boolean().default(true).volatile(), injectUnlimitedBudgetPrompt: z.boolean().default(true).volatile() })`, imported from `@deepseek-ai/schemastery` — declared in `peerDependencies`, so DSH's runtime resolution maps that bare import to the installation's copy (an undeclared import fails activation; see **Build & Install**). `host/config.js` is never imported by the offline tests. `apply` keeps the live config object and the section text reads `readBrainstormingEnabled(config)` and `readUnlimitedBudgetEnabled(config)` on every assembly, so a Settings write takes effect at the next prompt without restarting the Host; a plain boolean, a missing value, or an unreadable field/reference all fall back to on. `settings.configure({ auto: false }, ctx.fiber)` suppresses the schema-derived Settings page because the plugin ships its own.

The Client registers a list cell in `settings.section` (declared by `client-ui-settings-general`): `id: 'great-plan'`, `order: 25`, `label: () => t('settings.nav')`, `locale: 'great-plan'`, inject face `{ form: configForms.get('great-plan') }`. It reads/writes through `ctx.configForms` — the shared Host-settings mirror and ordered write queue — with `form.set(field, next)` returning whether the Host accepted the write for `injectBrainstormingPrompt` or `injectUnlimitedBudgetPrompt`. The capability is optional: `configForms` is not in the plugin's declared `inject` list, so a composition without the settings UI still loads the plan-review entry, and only the page is skipped. The same mirror supplies `readBudgetSwitch(configForms)` to the fresh-session execution prompt; without it that reminder defaults to on. Both switches are hand-rolled `role="switch"` buttons (host primitives are never imported), disabled while loading/busy or when the form is not writable, with loading, unavailable, read-only, and save-failure copy in both locales. The two rows share one busy/failure state, so a write in flight disables both.

**Host command `/great-plan-compact`** (`host/plan-compaction.js` + `host/plan-range.js`):
- Contract object `{ name, description, handler(invocation) }`; `invocation = { agent, rawInput, signal }`; returns `{ kind: 'success' | 'error', text }`, never throws for expected failures.
- Preconditions: no arguments; plan projection active (`sessionProjections.stateOf(session, 'plan').active === true`); a composed compaction service with `compactRegion`; a pending plan review = the last surface node is an `assistant/message` carrying a `tool-call` block.
- Range: start at the first node after leading `system/message` nodes; end at the last node before the pending plan message where `toolPairingBalancedAfter(session, seq)` holds (snap backwards); no history → `empty`, no pending review → `no-review`.
- It executes `compaction.compactRegion(start, end, agent, signal)` and reports `Compacted <n> history items (~<t> tokens).`. Stable manual-compaction codes map to user text: `busy`, `changed`, `summary`, `commit`, `persistence`, `cancelled`; unknown errors use `messageOf`.
- `@deepseek-ai/dsh-compaction` is imported lazily and declared in `peerDependencies`, so DSH's runtime resolution supplies the installation's copy. Missing package/backend degrades to a command error; the Client then warns and still approves.
- The command never answers the review, changes plan mode, or writes new session events; approval stays in the Client.

**Slot registration** (`client.js`): the plugin is a list cell in `conversation.plan-review.actions` (kind `list`, scope `session`, declared by `client-ui-user-questions`, also occupied by `client-ui-plan`):

```js
ctx.slots.inject('conversation.plan-review.actions', () => ctx.slots.register({
  name: 'conversation.plan-review.actions',
  id: 'great-plan-execute-options',
  order: -2,
  locale: 'great-plan',
  inject: (sessionId) => ({ directory, actions, presetStore, modelAvailable }),
}, panel.ExecutionTrigger));
```

Owner props: `review` = `PlanReview` (`id`, `question`, `plan`, optional `callId`, `approve`, optional `decline`, each option `{ label, description? }`) and `requestKey`. Standard slot props used: `sessionId`, `t`, `useSessionStatus`, `useSessions`, `useWorkspaces`. Injected face: `directory = ctx.modelDirectories.directoryFor(sessionId)` (shared Composer state — never own model state), `actions` (`client.actions.js`), shared `presetStore`, and `modelAvailable = ctx.sessions.subagentAddress(sessionId) === undefined`. `ctx.effect` owns the locale dictionary and the injected stylesheet; chunk factories stay side-effect free.

**Execution flows** (hard constraints):

```text
trigger (only when pendingInteraction.kind === 'plan-review')
├─ execute  pending.answer({ answers: [{ id: review.id, selected: [review.approve.label] }] })
│            + pending.dismiss() when snapshot.channel === 'rpc'
├─ compact  ctx.remote.commands.execute(sessionId, '/great-plan-compact', [], signal)
│            → approveReview regardless; on failure show warning for 800 ms, then approve
│            (closing the dialog aborts the operation and suppresses the approval)
└─ clear    ctx.sessions.create({ workspaceId | cwd, agentPreset })
             → ctx.sessions.using(newId, { source: 'greatPlan', signal }, ref =>
                 rename best-effort → ctx.remote.session.selectModel →
                 session.prompt([{ type: 'text', text: approved-plan prompt }], 'queue', signal))
             → ctx.uiWorkspace.openSession(newId) → previous.session.cancel() best-effort
             if rename/model/prompt fails after create: archiveSession(newId, { stopActivity: true })
```

- The dialog re-reads `pending` from `useSessionStatus`; if the review settled (`pending === undefined`) it shows "review gone" and does nothing.
- One operation at a time (`busy`; model/effort selection counts as busy). Close, back, and Escape are blocked during model, effort, execute, and clear operations; during compaction they stay enabled and closing aborts the wait, so the review is not approved. Every post-await state change is gated by `aliveRef`.
- Dialog view state is `root | model | effort | clear | preset`; it resets on close. `directory.load()` runs on open; `presetStore.load(true)` runs when entering the clear view.
- `reviewGone`, model/apply failures, approve failures, and fresh-session failures each surface as inline `ErrorText`; compaction failure is a non-fatal `WarningText`.
- The fresh-session prompt is the localized intro plus the approved plan; when the budget switch is on, `client.actions.js` inserts the unlimited-budget reminder before `<approved-plan>`. The Client reads the switch through `readBudgetSwitch(configForms)` at execution time and defaults to on. **Compact and execute** never inserts it.

**Client services used** (confirm against the installed package before changing): `ctx.locale.register(ns, { zh, en })` (complete dictionaries for both shipped locales); `ctx.remote.commands.execute(sessionId, name, args, signal)` → `{ ok, value?, error? }` with the command outcome at `value.result`; `ctx.remote.session.selectModel({ sessionId, provider, model, reasoningEffort? })`; `ctx.remote.agentPresets.list()` → `{ ok, value: { presets } }` (broken presets filtered; `gateway/invocation-unavailable` → "unavailable"); `ctx.sessions.create/using/binding/subagentAddress`; `session.rename/prompt/cancel`; `ctx.uiWorkspace.openSession/archiveSession`; `ctx.get('configForms')` (optional shared Host-settings mirror backing the settings page and the fresh-session budget switch).

**Styling and locale.** All chrome uses `--dsw-*` design tokens injected from `client.ui.js` (one style element tagged `data-plugin-css`, disposed by `ctx.effect`); layout and focus behavior copy the host controls. Visible copy goes through `t(...)` with identical zh/en keys. The dialog renders through `ReactDOM.createPortal(..., document.body)` with anchored positioning, focus trap, Escape handling, and focus restore.

## Module Map

| Path | Purpose |
|---|---|
| `index.js` | Host entry: re-exports `Config` and `apply`; the DSH Loader reads both exports here. |
| `host/apply.js` | `apply(ctx, config)`: registers `/great-plan-compact` with `commands`, the evidence prompt section with `systemPrompt`, and `settings.configure({ auto: false })`. |
| `host/config.js` | Schemastery `Config` with the volatile `injectBrainstormingPrompt` and `injectUnlimitedBudgetPrompt` switches (both default on). |
| `host/plan-compaction.js` | Command factory, validation, failure mapping. |
| `host/plan-range.js` | Pure plan-compaction range selection (`selectPlanCompactionRange`). |
| `host/plan-evidence.js` | Global `great-plan:plan-evidence` prompt section: order resolution, plan-active/pending gate, budget + brainstorming + evidence/handoff composition, config-driven switch reading. |
| `client.js` | Client entry: ModuleLoader factory, zh/en dictionaries, locale/style effects, preset store, budget-switch reader, slot registration, chunk load order. |
| `client.ui.js` | CSS (tokens, `.gp-*`), store helpers, icons, dialog/list/button primitives, `Dialog` (portal, anchoring, focus, Escape). |
| `client.model.js` | Model-directory state reading, labels, model/effort list views. |
| `client.preset.js` | Agent-preset store (`idle/loading/ready/unavailable/error`, inflight dedupe) and preset list view. |
| `client.actions.js` | Approve, compact, fresh-session operations; title composition; approved-plan prompt with the optional budget reminder. |
| `client.panel.js` | `ExecutionTrigger` + `ExecutionDialog` state machine, view routing, busy/abort handling. |
| `client.settings.js` | `settings.section` page body: the brainstorming and unlimited-budget switches over the shared configuration form, with loading/unavailable/read-only/error states. |
| `locale/en.json`, `locale/zh.json` | Plugin listing `meta.title`/`meta.description` only — not runtime copy. |
| `icon.svg` | Plugin icon (SVG, inside the package, < 256 KiB). |
| `cordis.patch.yml` | Host bundle patch inserting row `great-plan`. |
| `package.json` | Manifest: `exports`, `files`, `peerDependencies` (Host imports supplied by the installation), `dsh.bundle.patch`, `dsh.client`. |
| `test/*.test.js` | Node host tests (see **Host Tests**). |
| `tools/gate.sh` | Verification gate (see **Gate**). |

## Conventions (new code only; never mass-rename legacy)

- Plain modern JavaScript, 2-space indentation, semicolons, single quotes; match the surrounding file. Host files are ESM; Client chunks are ModuleLoader factories and must not use `import`/`export` — use `require`/`require.async` and package-qualified ids.
- Naming: components `PascalCase`; functions/variables `camelCase`; module constants `UPPER_SNAKE` (`NS`, `CSS`, `STYLE_ID`); CSS classes `.gp-*`; locale keys dot-namespaced (`panel.*`, `clear.*`, `preset.*`, `error.*`).
- Chunk files are flat at the package root and named `client.<name>.js` (test-enforced). New runtime files must be listed in `package.json` `files` (and `exports` for new public resources). A new chunk also needs its `require.async` load (and sibling `require` edges) in `client.js`, the fake registries in both Client tests, and the README project-structure tables.
- Every visible string goes through `t(...)`; add both `zh` and `en` keys in the same edit; keep placeholder names (`{message}`) identical. Command descriptions are not localizable (known limitation).
- Styles live in `client.ui.js` and only reference host tokens; keep `prefers-reduced-motion` and `:focus-visible` handling; don't add literal colors to chrome (artwork excepted).
- Host failure handling returns `{ kind: 'error', text }` with actionable text, maps stable error codes, and forwards `signal`; never throw for expected failures.
- Client failure handling catches at the UI boundary, shows `ErrorText`/`WarningText`, keeps the dialog usable, and logs best-effort cleanup failures as `console.warn('great-plan: ...')`.
- No new session event types and no new Agent tools. The only configuration is the plugin's own volatile Config switches for its Settings page; never edit another plugin's Config, and never write the profile yourself. Keep unload clean: effects dispose the stylesheet and dictionary, and the plugin writes nothing to the profile.
- Tests: cover every new pure function or wiring change in `test/`; no new dependencies; deterministic and offline.

## Sync Checklists

**New Client chunk** (order matters):
1. Add `client.<name>.js` at the package root with `window.__ModuleLoader__.load({ id: '@local/dsh-great-plan', chunk: 'client.<name>.js', factory })`.
2. Load it in `client.js` `apply` with `require.async('./client.<name>.js')` in dependency order; siblings require it as `require('@local/dsh-great-plan/client.<name>.js')`.
3. Update the fake module registries in `client-wiring.test.js`/`client-render.test.js` (and `client-actions.test.js` if materialized there); keep the chunk-naming manifest test green.
4. Update "Project structure" in both READMEs (`README.md`, `README.zh-CN.md` 项目结构) and the Module Map above.

**New dialog view or step**:
1. Extend the `view` union and `titles` map in `client.panel.js`; define the back target and blocked/busy behavior.
2. Reset its state on close; abort in-flight work; gate state on `aliveRef`.
3. Add zh/en keys; keep dictionary key sets identical.
4. Extend `client-render.test.js` and run the manual GUI checklist.

**New locale key**:
1. Add the same key to both dictionaries in `client.js`.
2. Format placeholders through `t(key, { ... })`; never concatenate translated fragments.
3. Only listing metadata (`meta.title`/`meta.description`) belongs in `locale/*.json`.

**New Host command** (only when `/great-plan-compact` cannot be reused):
1. Factory in `host/<name>.js`; register it from `index.js` inside `ctx.inject(['commands'], ...)` with a lowercase kebab-case name.
2. Validate `rawInput`; return `{ kind, text }`; map stable error codes; test in `test/` with fake session/projection/compaction.
3. Never answer the review or append session events; keep approval in the Client.
4. Document it in both READMEs ("Command" section) — commands are user-visible.

**Service or dependency change**:
1. Add the service to the plugin-level `inject` array in `client.js` (or `ctx.inject` in the Host). Keep optional services optional with graceful degradation.
2. Update the fake `ctx` in `client-wiring.test.js` and assert the new wiring.
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
- Client chunk file names `client.js`, `client.ui.js`, `client.settings.js`, `client.model.js`, `client.preset.js`, `client.actions.js`, `client.panel.js`. The `client.<name>.js` naming rule and load order are load-bearing. Settings slot cell `id: 'great-plan'` lives in the host-owned `settings.section` slot; Config fields `injectBrainstormingPrompt` and `injectUnlimitedBudgetPrompt` are the Settings page's storage keys.
- Slot cell `id: 'great-plan-execute-options'`, `order: -2`; slot key `conversation.plan-review.actions` is host-owned — never rename or re-declare it.
- Locale namespace `great-plan`; CSS prefix `gp-`; Host command `great-plan-compact`; `sessions.using` `source: 'greatPlan'`.
- Prompt section `great-plan:plan-evidence` (global Host prompt layer, order 501) — the neighboring native sections `plan:policy` and `TEAM_POLICY` are host-owned; never override plan-mode's `section` config and never replace or copy the native `plan:policy` text.
- zh/en dictionary text is product copy: don't "improve" strings without a request.

Known limitations (0.2.0, as shipped):

- The model list has no search; the Composer model control remains the full picker.
- Selecting a model applies immediately and is saved as the default model by existing DSH behavior.
- Compaction requires a composed backend and makes one summary model request; unavailable, empty, or failed compaction shows a warning and still approves the plan.
- New-session title prefix and old-session stop are best-effort; new-session execution is the primary result.
- `/great-plan-compact` appears in the command menu, and command descriptions cannot be localized.
- The budget, brainstorming, and evidence guidance in the plan prompt section is advisory: the model may ignore it, and the plugin does not validate plan behavior or content. Without `systemPrompt`/`planMode` services the section is silently absent (empty text), and a Host restart is required before the section is live. The Settings switches independently control the budget reminder (plan prompt and fresh-session message) and the brainstorming paragraph; the evidence/handoff paragraph always renders in plan mode. The switches need a DSH composition with `settings` + `configEditor` and the Client settings UI; without them the Host keeps both defaults (on), the Settings page is not registered, and the Client defaults the fresh-session budget reminder to on. The reminder is never added to **Compact and execute**.
- No integration tests exist for compaction, fresh-session execution, or the live UI; those rely on the manual checklist.

Debt and quirks (record, don't fix unless asked):

- Runtime dictionaries are inline in `client.js` while `locale/*.json` carries only listing metadata. The duplication is intentional (browser bundle vs Host metadata); don't merge without a design change.
- Tests use fake React and never mount components; the `ExecutionDialog` and `GreatPlanSection` render tests call the component functions directly (no hooks or effects). 52/52 is not behavioral coverage.
- Client HMR keys off the `client.js` artifact only (mtime/ctime/size); chunk-only edits can serve a stale revision. Touch `client.js` or restart before judging browser output.
- `@deepseek-ai/dsh-compaction` is imported dynamically and `@deepseek-ai/schemastery` statically in `host/config.js`; both are declared under `peerDependencies` and resolved to the DSH installation's copies by the runtime resolution (the offline tests cannot resolve them, so they never import `host/config.js`). The peer mapping is load-bearing: without it the import resolves from the workspace and plugin activation fails. A composition without compaction degrades to a command error plus fallback execution; a Host where `host/config.js` cannot resolve fails the plugin load, which is why the config import stays in its own module.
- This workspace became a git repository on 2026-10-24 (`origin` = `https://github.com/onefl666/dsh-great-plan`, branch `main`); history before that has no rollback. Don't commit or push unless asked.
- The dialog renders through a React portal to `document.body` (existing pattern). Don't hand-write DOM outside components or add a second application root.
- `0.2.0`, private local package; no lockfile and no `node_modules` in this repo.

## Maintaining This File

This file follows the repo's operational-guide contract: rules → verification → architecture → ownership map → conventions → change recipes → frozen debt. Update it in the same change whenever behavior, commands, module ownership, or frozen names move. README (`README.md` English, `README.zh-CN.md` Chinese, kept in sync) is user-facing; AGENTS.md is agent-facing; keep both true, and update the "Last verified" line when you run the gate on a new DSH/Node version.
