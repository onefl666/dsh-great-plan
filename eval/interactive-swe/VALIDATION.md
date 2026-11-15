# Validation record: interactive-swe harness preparation

This file records exactly what was executed during preparation, on which
machine, and what remains unverified. It is intentionally conservative: a green
offline suite proves code paths over fixtures, not a live DSH/model run.

Environment sampled at preparation time (2026-11-11, Asia/Shanghai):

| Item | Value |
|---|---|
| Repository | `/Users/flyblue/myProject/dsh-great-plan` |
| Plugin version | 0.6.0 (`package.json`) |
| Starting plugin commit | `b52c510` (working tree clean before `eval/`) |
| DSH app | `/Applications/DeepSeek Harness.app`, runtime 0.2.2-rc.1 |
| Node | v24.21.0 (bundled runtime; no system node) |
| Python | 3.14.10 system; bundled 3.12.14; `uv` 0.13.7 |
| Docker | not installed (no docker/podman/colima/OrbStack) |
| Network | HF direct blocked; `hf-mirror.com` reachable; GitHub/PyPI/npm reachable |
| Disk free | ~70 GiB |

## Executed checks

| # | Command | Result | Proves |
|---|---|---|---|
| 1 | `bash tools/gate.sh` (before and after changes) | 278/278, `gate: green` both times | The plugin gate is unaffected; `lib/`, `test/`, `package.json`, `tools/gate.sh` have no diff |
| 2 | `bash tools/gate-eval.sh` | **174/174** eval tests, syntax clean, `gate-eval: green` | Eval suite is green, offline, dependency-free |
| 3 | `cli selftest` (isolated cache) | 3 arms × 3 fixture tasks, all `ok`; validation `ok:true`; arm integrity 3/3 per arm; `toolRoster.ok` true | Fake SDK driver → artifacts → score → paired report, including per-arm marker and required-tool checks |
| 4 | `cli warm-repos` (batch 1) | **not completed in preparation** (full mirror cloning was network-bound and stopped; the partial mirror was removed). Command + unit tests exist. | Pre-run cache warm-up; run it before the paid smoke, or let the runner clone lazily |
| 5 | `fetchDataset` against hf-mirror | 2,194,070 bytes, sha256 `bdc6663d…b5cd`, revision `a56830e…` | The pinned dataset download route and hash check work on this host |
| 6 | `normalizeParquet` (uv + pyarrow) | 500 normalized tasks, 12 repos | Parquet → `tasks.jsonl` works; count/hash recorded in `tasks.meta.json` |
| 7 | batch-1 ids vs dataset | 100/100 ids present, 100 unique, deterministic subset | The committed official batch-1 list matches the fetched dataset |
| 8 | `cli preflight --compose` (scratch home) | `ok:true`; `great-plan` row `status: schema`; four fields (`injectBrainstormingPrompt`, `injectUnlimitedBudgetPrompt`, `includeOriginalUserInstructions`, `includeMinimalRuntimeContext`) default `true` and volatile; all three arm overlays compose (`native`/`evidence`/`full`); peer `@deepseek-ai/schemastery` present | The scratch SDK profile resolves the linked plugin, its peer, the Config schema, the team rows, and the arm overlays **without a model call** |
| 9 | `npm pack --dry-run --json` | 21 entries; no `eval/` or `tools/` entry | The harness stays repository-only; publish inventory unchanged |
| 10 | `cli run` one-task live smoke (`psf__requests-1142`, full/hidden/plan) | `ok`; plan review cancelled; all four full-arm markers present; 3 `spawn_teammate` calls (2 parallel explorers + 1 planner); tokens: 97,534 in / 90,825 out / 1,975,296 cache-read; 125 tool calls, 4 turns | The SDK handshake, model route (`deepseek-official/deepseek-flash`, effort `max`), Team tools, plan review, session logging, and artifacts work end to end |
| 11 | 20-task three-arm smoke (`native`/`evidence`/`full`, hidden, plan) | native 20/20 ok, evidence 20/20 ok, full 19/20 ok + 1 `plan_missing`; report in `eval/interactive-swe/reports/smoke-20/` | First quantitative comparison: handoff and delegation rise; full costs ~3× tokens and resolves fewer citation refs strictly |
| 12 | 100-task main run | **not run** | The 20-task smoke is the current evidence; the main run is the next decision |

Two live-compose defects were found and fixed during preparation, then re-verified:

1. **Peer resolution**: a manual plugin symlink alone is not enough; the linked
   plugin's `@deepseek-ai/schemastery` peer must exist under
   `profiles/eval/node_modules`. `provision` now runs
   `dsh plugin --profile eval add @deepseek-ai/schemastery@~3.18.5` per home
   (`ensurePeerDependencies`), and `preflight` probes the profile directory
   first. `@deepseek-ai/dsh-compaction` was deliberately **not** installed: the
   installed runtime rejects the published version as incompatible, and it is
   only needed by the lazy `/great-plan-compact` command, not by plan-mode
   evaluation.
2. **Schema parser**: the real `--dump-config-schema` wraps the projected Config
   in `$defs.configN.anyOf[0].properties`; the parser now resolves `configRef`
   through a JSON Pointer and flattens the branches.

Both fixes have offline regression tests (profile/preflight suites are 54
tests). The runner also checks the first `request/header` tool roster
(`ask_user_question`, `exit_plan_mode`, `spawn_teammate`) and marks a task
`protocol_error` when one is missing; dry-run fixtures cover both outcomes.

### Live one-task smoke (after the user supplied an API key)

Run: `full` / `hidden` / `plan`, task `psf__requests-1142`, scratch home, no
Docker. Result: `ok`.

- The real `request/header` shape is `data.header.tools` (32 tools). The initial
  runner looked only at `data.tools`, so the captured smoke's
  `meta.toolRoster.checked` is `false`; the parser now handles the real shape and
  the same event yields all three required tools with `missing: []`. The next
  run records `toolRoster.ok:true`.
- Initial citation snapshot: 10/24 refs resolved, 14 "phantom" — all 14 were
  basename-only refs after a full-path first mention (`models.py:388` after
  `requests/models.py:388`). The resolver now accepts a basename only when
  exactly one file in the worktree matches; multiple matches are `ambiguous`.
  Re-scoring the same smoke artifacts with the fixed resolver gives **24/24
  resolved (14 via unique basename, 0 ambiguous)** and density 2.06 per 1k plan
  chars.
- The plan review is recorded in `questions.ndjson`; it must not count as a
  clarification. Clarification stats now exclude plan-review rows; this task has
  `askCalls: 0`, `taskWithAsk: false`.
- The model asked no clarification question in this task, so the live simulator
  was not exercised end to end; a direct simulator call to
  `https://api.deepseek.com/chat/completions` with `deepseek-v4-pro` returned a
  valid selected answer and token usage.
- Token prices are not hard-coded; the measured usage above is the input for a
  budget decision. A 20-task smoke multiplies it roughly linearly (cache hits
  may reduce input cost).

### 20-task three-arm smoke (paid, hidden, plan mode)

Same 20 stratified batch-1 tasks, `seed 42`, 4 concurrent workers. Report:
`eval/interactive-swe/reports/smoke-20/report.md` (JSON/CSV alongside).

| Metric | native | evidence | full |
|---|---|---|---|
| Tasks ok / total | 20/20 | 20/20 | 19/20 (+1 plan_missing) |
| Plan submitted | 20/20 | 20/20 | 19/20 |
| Mean plan chars | 9,896 | 11,943 | 12,036 |
| Citation refs / resolved / ambiguous / phantom | 171 / 171 / 0 / 0 | 240 / 236 / 3 / 1 | 303 / 281 / 18 / 3 |
| Strict citation resolution rate | 100% | 98.3% | 92.7% |
| Handoff present / score | 30% / 0.333 | 60% / 0.767 | 55% / 0.767 |
| Tasks with spawn / spawn calls | 3 / 9 | 3 / 6 | 20 / 70 |
| Ask calls / ask rate | 0 / 0% | 1 / 5% | 0 / 0% |
| Input tokens | 1,090,730 | 1,040,311 | 2,925,568 |
| Output tokens | 1,099,669 | 1,115,541 | 3,601,990 |
| Cache-read tokens | 48,373,760 | 46,074,752 | 112,316,672 |
| Turns mean / tool calls mean | 1.45 / 80.1 | 1.3 / 72.8 | 4.5 / 209.2 |
| Minutes per task | 6.0 | 5.5 | 13.0 |

Manipulation check: marker integrity was 20/20 in every arm (native none;
evidence budget+handoff; full all four), so the arms differ by prompt section as
intended.

Observed effects (n=20, underpowered):
- Handoff presence +30pp for evidence (McNemar p=0.109) and +25pp for full
  (p=0.125); handoff score 0.333 → 0.767 in both treatment arms.
- Full delegated on 20/20 tasks (3.5 spawns/task) versus 3/20 in native and
  evidence; this is the brainstorming guidance, not the handoff guidance.
- Citation **volume** rose (8.6 → 12 → 15.2 refs/task) and absolute resolved refs
  rose (171 → 236 → 281), but the strict rate fell because full produced 18
  ambiguous basename refs (plus 3 phantom, 1 out-of-bounds). Ambiguous refs are
  conservatively unresolved; a context-aware resolver could raise full's rate,
  so 92.7% is a lower bound.
- Full cost ~3.3× output tokens and ~2.2× wall time versus native. Evidence was
  roughly cost-neutral.
- Clarification was rare in all arms (0–1 asks in 20 hidden tasks); this smoke
  does not demonstrate clarification calibration.
- The single full failure (`pydata__xarray-3993`) ended after 4 turns / 147 tool
  calls / 13.5 min with no plan review; it is a model-output failure, retained in
  the report and excluded from plan-quality denominators.

Paired bootstrap (10,000 resamples, seed 12345) on the same 20 tasks:

| Metric | evidence vs native | full vs native |
|---|---|---|
| Plan chars | +2,047 [123, 3,800] | +2,140 [179, 4,002] |
| Citation refs/task | +3.45 [−3.70, +10.15] | +6.60 [+0.50, +12.15] |
| Strict citation resolution rate | −0.9pp [−2.5, 0] | −7.1pp [−14.2, −1.9] |
| Handoff score | +0.433 [+0.183, +0.667] | +0.433 [+0.233, +0.617] |
| Spawn calls/task | −0.15 [−0.80, +0.45] | +3.05 [+2.50, +3.50] |
| Output tokens/task | +794 [−33,477, +27,243] | +125,116 [+93,668, +156,314] |
| Wall time/task | −30s [−176s, +87s] | +420s [+276s, +576s] |

Handoff presence by McNemar: evidence +30pp, b=8/c=2, p=0.109; full +25pp,
b=6/c=1, p=0.125. With n=20 these binary shifts are directional, not
statistically significant; the continuous handoff score CIs exclude zero.

## Evidence matrix

| Claim | Status | Evidence / caveat |
|---|---|---|
| The eval tree is repository-only and not packaged | **Verified** | `eval/` is outside `package.json` `files`; `npm pack` entryCount 21 with no eval/tools entry; integrity tests ignore unpacked trees (`test/integrity.test.js:141-172,250-266`) |
| The plugin gate is unaffected | **Verified** | `tools/gate.sh` 278/278 before and after; `git diff -- lib test package.json tools/gate.sh` empty |
| Session logs can be decoded frame-by-frame | **Verified** | Split on `28 B5 2F FD`, per-frame `zlib.zstdDecompressSync`; corrupted trailing frames degrade to warnings |
| Dataset access works on this host | **Verified** | Mirror URL + pinned sha256 + 500 normalized rows |
| Official batch-1 100 ids are usable | **Verified** | 100/100 present; ids committed with provenance commit `ee8603e8…` |
| The scratch SDK profile composes the plugin and arms | **Verified without model** | `--dump-config-schema` row `status: schema` + four volatile fields; `--dump-config` passes for all three arms; peer present |
| The plugin's Host prompt section renders under `/plan` | **Verified in one live smoke** | All four full-arm markers appeared in the live `system/message`; native/evidence marker absence is covered by offline arm-integrity tests and the 20-task smoke |
| Team tools (`spawn_teammate`) are available | **Verified live** | The smoke made 3 `spawn_teammate` calls (2 parallel explorers + 1 planner); `request/header` lists 32 tools including the three required ones |
| SDK answers plan reviews and clarification questions | **Source/docs verified, not live** | `parseHostAnswer` requires every id exactly once; `{cancelled:true}` → ASK_CANCELLED (`dsh-sdk-jsonrpc-server/lib/index.js:207-227`) |
| Fixture end-to-end path works | **Verified** | `cli selftest`: 3 arms, artifacts, citations, clarify/delegation/quality, report, arm integrity |
| Plan-only metrics are a proxy for resolve rate | **By design** | No Docker, no official SWE-bench harness execution; `report.resolveRate` is `gated`/`blocked`, never fabricated |
| Dataset license | **Not declared** | HF card has no license and no LICENSE file; local cache only, never commit/redistribute |
| Web UI execution dialog/compact/fresh/Settings flows | **Not covered** | SDK path exercises the Host half only; manual GUI checklist in `AGENTS.md` remains the authority |

## Known limitations carried into the harness

- The simulated user is a model call at live time; its prompt/model must stay
  fixed across arms, and its quality affects the hidden arm.
- The eval profile's tool roster differs from a Desktop session (web tools,
  legacy subagents, workflow, and plugin management are disabled; Team tools are
  on). All arms share it, but results are not directly comparable to the paper's
  OpenHands setup.
- Plan-only runs cannot execute the repository's tests; plans are grounded in
  file inspection, not test outcomes.
- Model sampling is not controllable through this harness; pairing and recorded
  model/effort are the mitigation.
- A live run requires explicit credentials and a simulator; preparation makes
  none of those calls.
- Worktrees are retained by default so citations can be re-resolved after a run;
  `runTask({ removeWorktree: true })` opts into cleanup.

## How to reproduce the executed checks

```bash
bash tools/gate.sh
bash tools/gate-eval.sh
node eval/interactive-swe/cli.mjs provision
node eval/interactive-swe/cli.mjs preflight --compose
node eval/interactive-swe/cli.mjs selftest
node eval/interactive-swe/cli.mjs fetch-dataset
node eval/interactive-swe/cli.mjs normalize
~/.dsh-tools/bin/npm pack --dry-run --json
```
