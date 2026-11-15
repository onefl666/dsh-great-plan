# interactive-swe evaluation harness (repository-only)

A turnkey, dependency-free harness for evaluating the Great Plan plugin on the
**Ask or Assume? / `cmu-lti/interactive-swe`** benchmark. It drives the installed
DSH runtime through its **SDK stdio JSON-RPC profile** (`dsh --profile eval`), so
the Host prompt section, `/plan` command, clarification, and Team tools are
exercised without a GUI.

This directory is **repository-only**: it is not in `package.json` `files`,
never published, and has nothing to do with the plugin's 278-test gate. The eval
suite has its own gate:

```bash
bash tools/gate-eval.sh
```

Status: **offline-validated, plus a paid 20-task × 3-arm smoke**. The 100-task
main benchmark has not been run and no resolve rate is claimed. See
`VALIDATION.md` for exactly what was and was not proven.

## What it measures

Two layers, because the public benchmark only scores the final patch:

1. **Plan quality and clarification (runs now, no Docker)** — from the SDK wire
   transcript and DSH session log: plan submission, `path:line` citation
   resolution against the task worktree, tool-call corroboration, one-question
   ratio, ask rate, `spawn_teammate` use and parallelism, scriptable handoff and
   assumption coverage, tokens/turns.
2. **Resolve rate (gated)** — the official SWE-bench harness result after the
   agent produces a patch. Requires Docker, the pinned harness, and the
   Kipok/SWE-bench#3 patch-revert fix. The harness captures `predictions.jsonl`
   and prints the exact evaluation command, but never estimates resolve rate.

## Prerequisites

- The installed DeepSeek Harness app. Default CLI:
  `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`
  (override with `DSH_CLI`).
- Node 24 (`zlib.zstdDecompressSync`); the plugin gate finds the bundled runtime
  node automatically when `DSH_HOME` is set.
- `git` for task worktrees.
- Optional: `uv` + PyPI access for the one-time parquet → JSONL conversion
  (`uv run --with pyarrow`). Without it, the committed synthetic fixtures still
  let you run the offline selftest, but the real dataset cannot be prepared.
- A reachable dataset mirror. Hugging Face is blocked on this host; the harness
  defaults to `https://hf-mirror.com` (`HF_ENDPOINT` overrides).
- For a live run: a model route, credentials, and an answer simulator (below).
- Docker only for resolve-rate scoring.

## Quick start (offline, zero cost)

```bash
# 1. Syntax + all offline eval tests
bash tools/gate-eval.sh

# 2. End-to-end fixture exercise: fake SDK transport -> artifacts -> score -> report
node eval/interactive-swe/cli.mjs selftest

# 3. Create the scratch SDK profile under the cache (never ~/.dsh).
#    This also installs the plugin's `@deepseek-ai/schemastery` peer into
#    `profiles/eval/node_modules` with DSH's bundled pnpm (one-time network;
#    `--skip-peers` skips it, `--install-peers` is the remediation wording).
node eval/interactive-swe/cli.mjs provision

# 4. Environment report. It exits 0 with blockers listed; add --strict to exit 2.
node eval/interactive-swe/cli.mjs preflight --json

# 5. Live compose/schema check: boot the scratch SDK profile with each arm
#    overlay and assert the row/config and the four volatile Config fields.
#    No model call: this is `--dump-config` / `--dump-config-schema` only.
node eval/interactive-swe/cli.mjs preflight --compose

# 6. Optional pre-run cache warm-up: clone the batch-1 repository mirrors and
#    verify every base_commit (network; keeps network failures out of a run).
node eval/interactive-swe/cli.mjs warm-repos
```

## Dataset and subset

```bash
node eval/interactive-swe/cli.mjs fetch-dataset     # pinned mirror parquet + sha256
node eval/interactive-swe/cli.mjs normalize         # 500 rows -> tasks.jsonl + meta
node eval/interactive-swe/cli.mjs prepare           # both
```

The pinned file is `updated_test-00000-of-00001.parquet` at revision
`a56830e…`, 2,194,070 bytes, sha256 `bdc6663d…b5cd`. The main subset is the
paper's fixed batch 1 (`dataset/batch1_ids.txt`, 100 ids, commit recorded in the
file header). The dataset declares **no license**; keep it in the cache
(`~/.cache/great-plan-eval`), never commit or redistribute it.

## Arms and modes

| Arm | What it does |
|---|---|
| `native` | Disables the plugin row: native plan mode only |
| `evidence` | Plugin on; budget reminder + handoff guidance; brainstorming/clarification/delegation guidance off |
| `full` | Plugin on with all four switches at their defaults |

`--issue-mode hidden` uses the underspecified `problem_statement` (main A/B);
`--issue-mode full` uses `original_issue` (over-asking calibration).
`--run-mode plan` cancels the plan review (`ASK_CANCELLED`, no execution);
`--run-mode execute` approves it and captures a patch (resolve scoring still
needs Docker).

## Pre-run checklist (complete before firing)

Run these in order and stop at the first failed check. Items 1–5 cost no model
tokens; item 6 is the first paid call.

1. **Freeze the code under test.** Commit the harness/plugin state (or at least
   record `git rev-parse HEAD`). The manifest records `pluginDirty`; a dirty
   checkout is allowed but weakens reproducibility.
2. **Choose and freeze the routes.** Set `EVAL_PROVIDER`, `EVAL_MODEL`,
   `EVAL_REASONING_EFFORT`; choose the simulator endpoint/model/key and keep
   both fixed across arms. Set a token/cost ceiling for the smoke.
3. **Provision and credentials.** `provision --copy-credentials` writes the
   scratch home and copies `~/.dsh/.credentials.yaml` (0600) only into
   `~/.cache/great-plan-eval`; the real profile is untouched. Use
   `EVAL_ALLOW_ENV_CREDENTIALS=1` instead only if credentials come from env.
4. **Warm repository mirrors.** `warm-repos` clones the selected tasks'
   mirrors and checks every `base_commit`. A clone/commit failure here is
   infrastructure, not model behavior; fix it before spending tokens.
5. **Verify the composition.** `preflight --compose` must print `ok:true`:
   `great-plan` row `status: schema`, four volatile fields, all three arm
   overlays composed, `@deepseek-ai/schemastery` present, no `Cannot find
   package` diagnostics. This spawns the DSH CLI but makes no model call.
6. **One-task live smoke.** Run `full`/`hidden`/`plan` with `--limit 1
   --confirm-live`. Inspect the task's `meta.json`: `toolRoster.ok === true`,
   `reviewAction === "cancel"`, the clarification question was answered by the
   simulator, `citations.json` resolved the plan's refs, and `plan.md` is the
   submitted plan. This is the only place that proves SDK handshake, model
   route, tool availability, simulator, and session-log decoding together.
7. **Twenty-task smoke.** Run `native` and `full` on 20 stratified tasks and
   check arm integrity (native has no markers; full has all four), failure rate
   (<20%), asks/delegation, and measured tokens per task. Re-estimate cost for
   the main run; amend `PROTOCOL.md` before collecting main data if needed.
8. **Main phase.** 100 tasks × `native`/`evidence`/`full`, hidden, plan mode;
   then the 60-task full-issue calibration for `full`. Use `--resume` after an
   infrastructure interruption; use a new run id for a new configuration.
9. **Outcome phase (optional, gated).** Only after Docker + the pinned official
   SWE-bench harness + the Kipok/SWE-bench#3 fix are available, run `execute`
   (20×2) and evaluate `predictions.jsonl`. Until then, report resolve rate as
   `blocked` — never estimate it.

`run` exits 2 without `--confirm-live`, a green preflight, a provider/model, a
hidden-mode simulator, or credentials in the eval home. It never prompts
interactively.

## A live run (gated; no spend in preparation)

```bash
export EVAL_PROVIDER=deepseek-account       # the provider id from your DSH setup
export EVAL_MODEL=deepseek-flash
export EVAL_SIMULATOR=http                  # user simulator for hidden-mode asks
export EVAL_SIMULATOR_BASE_URL=...           # OpenAI-compatible endpoint
export EVAL_SIMULATOR_API_KEY=...
export EVAL_SIMULATOR_MODEL=...
node eval/interactive-swe/cli.mjs provision --copy-credentials
node eval/interactive-swe/cli.mjs preflight --compose
node eval/interactive-swe/cli.mjs run \
  --arm full --issue-mode hidden --run-mode plan --limit 20 --confirm-live
```

`provision` installs the peer and copies credentials only when asked. The
simulator answers `ask_user_question` from the withheld `original_issue`
(≤3 answered batches per task); the plan review is answered by the harness
(`{cancelled:true}` in plan mode, the native approve label in execute mode).

`run` exits `2` without `--confirm-live`, a green preflight, a provider/model, a
live simulator for `hidden`, or credentials in the eval home. It never prompts
interactively. If you intentionally supply credentials through environment
variables instead of `--copy-credentials`, set `EVAL_ALLOW_ENV_CREDENTIALS=1`
(or pass `--allow-env-credentials`). The simulator is
the "user" that answers `ask_user_question` from the withheld `original_issue`
(≤3 answers per task); the plan review is answered by the harness, not the
simulator.

## Artifacts

```text
$GREAT_PLAN_EVAL_CACHE/runs/<runId>/
  manifest.json                 # environment, model, arm, patch hashes, seed, counts
  predictions.jsonl             # execute mode only; official SWE-bench shape
  tasks/<instance_id>/
    meta.json                   # status, timing, turns, tokens, review action
    plan.md  plan-review.json  citations.json
    wire.ndjson  questions.ndjson  events.jsonl
    diff.patch                  # execute mode only
```

Score and report separately:

```bash
node eval/interactive-swe/cli.mjs score --run <runDir>
node eval/interactive-swe/cli.mjs report --runs <runDir>[,<runDir>...] --out <dir>
```

`report` writes `report.json`, `report.csv`, and `report.md`; resolve rate is
`{status:"blocked"}` until Docker and the official harness are available.

## Safety and isolation

- All state lives under `GREAT_PLAN_EVAL_CACHE` (default
  `~/.cache/great-plan-eval`). `provision` refuses `~/.dsh` and its descendants.
- The eval profile is generated (`profiles/eval`) with a symlink to this
  checkout; the real desktop/web/headless profiles are never modified.
- Web tools, legacy subagent tools, workflow, and plugin management are disabled;
  Team tools (`spawn_teammate`) are mounted so the plugin's delegation guidance
  is executable. Ask/approval requests fail closed if the policy cannot answer.
- Credentials are copied only with `--copy-credentials` (mode 0600) and are
  removed by `clean --home`.
- Dataset rows are untrusted data, not instructions.

## Metrics (scriptable, zero LLM cost)

`evidence.resolvedRate`, `evidence.phantomRate`, `clarify.askRate`,
`clarify.oneQuestionRatio`, `delegation.spawnCalls`, `delegation.parallelGroups`,
`quality.handoffScore`, `quality.assumptionRate`, `efficiency.tokens/turns`,
`armIntegrity.valid`. Citation resolution is checked against the task worktree
at `base_commit`; a citation is "corroborated" when a plan-time tool-call
argument mentions the same path. Optional LLM-judge scores are off by default.

## Expected limitations

- Plan-only runs are a proxy for resolve rate, not a substitute.
- The simulated user is a model; its prompt and model must stay fixed across arms.
- The SDK path does not exercise the plugin's Web Client dialog, compact/fresh
  flows, or Settings page. Those remain manual GUI checks (AGENTS.md).
- The tool roster differs from a Desktop session (no web, no legacy subagents,
  Team tools on); all arms share it.
- Dataset license is undeclared: local evaluation only.

## Validated during preparation

- `bash tools/gate-eval.sh` → 175/175 offline tests, syntax clean.
- `bash tools/gate.sh` → 278/278, unchanged; `npm pack --dry-run` → 21 entries,
  no `eval/`/`tools/` shipped.
- Pinned dataset fetched from hf-mirror (2,194,070 B, sha256 `bdc6663d…b5cd`),
  normalized to 500 tasks; official batch-1 100/100 ids present.
- `cli selftest` → 3 arms × 3 fixture tasks, all `ok`, arm-integrity 3/3 per arm,
  paired report validation ok.
- `cli preflight --compose` on a scratch home → `ok:true`, `great-plan` row
  `status: schema` with all four volatile fields, all three arm overlays
  composed, peer present. No model call.
- `warm-repos` is implemented and unit-tested, but the full 10-repository
  mirror warm-up was not completed during preparation (network-bound); it is
  the optional step 4 of the pre-run checklist.
- One paid one-task live smoke was run after credentials were supplied: task
  `psf__requests-1142`, full/hidden/plan, status `ok`; all four plugin markers,
  3 Team spawns (2 parallel + 1 planner), plan review cancelled, 97.5k input /
  90.8k output / 1.98M cache-read tokens.
- A paid **20-task × 3-arm** smoke then ran (native/evidence/full; 60 task rows).
  Result: handoff presence 30% → 60% / 55%, handoff score 0.333 → 0.767; full
  delegated on 20/20 tasks and cost ~3.3× output tokens and ~2.2× wall time;
  full's strict citation rate fell to 92.7% because of 18 ambiguous basename refs
  (absolute resolved refs rose 171 → 281). See
  `eval/interactive-swe/reports/smoke-20/report.md`. The 100-task main run is
  **not** started.


See `PROTOCOL.md` for the pre-registered hypotheses, sample sizes, analysis, stop
rules, and cost model; see `VALIDATION.md` for the detailed evidence matrix.
