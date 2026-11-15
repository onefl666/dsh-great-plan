# Evaluation protocol: interactive-swe

Status: **prepared, not executed**. Preparation makes no model/API calls. This
protocol is pre-registered so a later live run cannot silently change its
hypotheses, arms, or metrics after looking at results.

## 1. Question

Does the Great Plan plugin improve the plan a coding agent produces for an
underspecified real issue, without increasing clarification on a fully specified
issue? A secondary, gated question asks whether it changes execution outcomes.

The benchmark is the "Ask or Assume?" underspecified variant of SWE-bench
Verified: `cmu-lti/interactive-swe`, 500 rows, one `test` split. Each row carries
both `problem_statement` (underspecified) and `original_issue` (fully
specified). The paper's fixed batch 1 (100 ids) is the main subset; see
`dataset/batch1_ids.txt`.

## 2. Design

| Dimension | Values |
|---|---|
| Arms | `native` (plugin row disabled), `evidence` (handoff + budget guidance, brainstorming off), `full` (all four switches on) |
| Issue modes | `hidden` = `problem_statement` (main); `full` = `original_issue` (calibration) |
| Run modes | `plan` (cancel the plan review, no execution; default); `execute` (approve, capture patch; resolve rate gated) |
| Pairing | Same instance, model, reasoning effort, tool roster, DSH version, plugin commit |
| Order | Seeded shuffle (`--seed 42`), recorded in the manifest |
| Trials | 1 per task in the main run; repeats are a separate run id |
| Reviews | `plan` mode answers `{cancelled:true}` (ASK_CANCELLED); `execute` mode answers the native approve label |

Arm rationale: the plugin's handoff guidance cannot be switched off through its
four settings fields (it is always rendered in plan mode), so the only way to
measure "no plugin prompt section" is to disable the `great-plan` row. The
`evidence` arm keeps the budget reminder and handoff text but turns off
`injectBrainstormingPrompt`, isolating the clarification/delegation/alternatives
guidance. `full` uses the defaults.

## 3. Hypotheses

- **H1 (primary)**: on `hidden`, `full` has a higher path-citation resolution
  rate and a higher scriptable handoff score than `native`.
- **H2**: on `hidden`, `full` improves over `evidence` on clarification
  calibration and delegation, showing the brainstorming guidance matters beyond
  the handoff text.
- **H3 (calibration)**: `full` asks fewer questions per task on `full` issues
  than on `hidden` issues (paired by instance); an agent that asks as much on
  fully specified issues is over-asking.
- **H4 (gated)**: on `execute`, `full` has a higher official resolve rate than
  `native` on `hidden`. This is **not** evaluated without Docker plus the pinned
  SWE-bench harness and Kipok/SWE-bench#3.

## 4. Samples

| Phase | Design | Runs | Purpose |
|---|---|---|---|
| Smoke | 20 tasks, `native`+`full` × `hidden`, plus `full` × `full` | 60 | Validate plumbing, arm integrity, tool roster, cost per run |
| Main | 100 tasks × 3 arms × `hidden` × `plan` | 300 | H1/H2 and descriptive metrics |
| Calibration | 60 tasks × `full` × `full` × `plan` | 60 | H3, paired with the main `full`/`hidden` runs |
| Execute (gated) | 20 tasks × 2 arms × `execute` | 40 + official harness | H4; requires Docker and the evaluation harness |

Smoke tasks are a deterministic stratified sample of batch 1; the main run uses
all 100 batch-1 ids. Calibration uses the first 60 ids of the main run by sorted
instance id, so pairs are unambiguous. Smoke runs are never reused in the main
run. `--limit`/`--offset`/`--ids-file` make staging explicit; every manifest
records the actual task file hash.

Before main, re-estimate variance and cost from smoke. Sample sizes are defaults,
not a promise: if smoke shows very low variance or very high cost, the run stops
and this protocol is amended before main data is collected.

## 5. Metrics

### Primary (scriptable, zero model cost)

- `evidence.resolvedRate`: cited `path:line` refs whose file exists at
  `base_commit` and whose line is in bounds, divided by total refs. A ref with
  no path separator resolves through a basename only when exactly one file in
  the worktree matches; multiple matches are reported as `ambiguous` and count
  as unresolved, never as phantom. This amendment was made after the one-task
  smoke and before main data, because the smoke showed 14/24 refs were
  basename-only follow-ups.
- `quality.handoffScore`: fraction of required handoff headings/sections present
  (background, evidence, handoff/next steps, tests/acceptance, assumptions/risks).
- `armIntegrity`: the expected plugin prompt markers must be present/absent per
  arm; a mismatch invalidates that task's plan-quality metrics.

### Secondary

- `clarify`: ask calls, questions per call, one-question ratio, tasks with ≥1
  ask, answers, cap hits. The plan-review row in `questions.ndjson` is excluded
  from every clarification metric; it is the approval exchange, not a question.
- `delegation`: `spawn_teammate` calls, unique names/scopes, parallel groups
  (same `turn`/`step`), planning-teammate heuristic.
- `efficiency`: input/output/cache tokens, turns, tool calls, wall time.
- `plan`: submitted, characters, section coverage.
- `optionalJudge`: 0–2 evidence support, assumption quality, handoff
  executability, clarification relevance. Off by default; a judge model is a
  separate choice and never replaces scriptable metrics.
- `resolveRate` (gated): official SWE-bench harness outcome. Reported as
  `blocked` until Docker and the pinned harness exist.

No single composite score is the primary claim; report components.

## 6. Analysis

- Pair by `instance_id`; only tasks with both arms complete contribute to a
  paired comparison. Report complete-case and per-arm failure rates.
- Binary metrics: McNemar exact two-sided test on discordant pairs (b, c).
- Continuous metrics: paired mean difference with seeded percentile bootstrap CI
  (10,000 resamples; recorded seed) and a two-sided sign test for robustness.
- Exclude infrastructure failures (`init_error`, `spawn_error`, `provider_error`,
  `protocol_error`, `timeout`) from quality denominators, but report them.
  `plan_missing` is a model outcome, not infrastructure; report it separately and
  exclude it from citation/handoff denominators.
- Report per-arm, per-issue-mode tables; missing arms/tasks are explicit, not
  zero-filled.
- Multiple metrics are exploratory except H1's two primary metrics and H3's ask
  rate; label them accordingly.

## 7. Stop rules

Stop the run (do not publish partial treatment effects) when any holds:

- arm-integrity failure rate > 0 in any arm (the arm patch did not apply);
- required tool roster (`ask_user_question`, `exit_plan_mode`, `spawn_teammate`)
  is missing from the first request header;
- infrastructure failure rate > 20% in any arm;
- dataset hash or batch-id set differs from the pinned values;
- a task would exceed the operator's cost cap (checked between tasks);
- the SDK protocol/version differs from the recorded environment.

## 8. Cost model

Cost is measured, not guessed: every assistant message's usage is summed per
task; simulator and judge usage is tracked separately. Optional price environment
variables turn tokens into an estimate; without them only tokens are reported.
The smoke phase exists to calibrate cost per task before the main run. Plan-only
runs have no SWE-bench container cost; execute runs additionally need one Docker
evaluation per prediction and are out of scope for preparation.

## 9. Threats to validity

- **Plan-only proxy**: plan quality is not the same as resolve rate (see the
  planning-as-routing literature). H4 is the only outcome check and is gated.
- **Simulated user**: the hidden arm depends on a model persona constrained to
  the withheld `original_issue`. Its quality/leakage affects results; record the
  simulator model and prompt version and keep it fixed across arms.
- **Tool roster differs from Desktop**: the eval profile disables web tools,
  legacy subagent tools, workflow, and plugin management, and mounts Team tools.
  All arms share the roster, but results are not directly comparable to a Desktop
  session with the full roster.
- **No Web UI actions**: the SDK path exercises the Host prompt section and
  command, not the plugin's execution dialog, compact/fresh flows, or Settings
  page. Those remain manual GUI checks.
- **Model nondeterminism**: provider sampling cannot be fixed through this
  protocol; pairing and recorded model/effort mitigate, repeats quantify.
- **Dataset construction**: the underspecified issues are GPT-4o summaries; some
  may be over- or under-specified. The full-issue calibration arm is the control.
- **No declared dataset license**: local cache only; do not redistribute.
- **Single machine**: app version, Node, and DSH commit are recorded per run.

## 10. Reproducibility

Each run manifest records: plugin git head and dirty flag, package version, DSH
CLI path and app version, Node version, model provider/model/effort, arm patch
hashes, task file hash and ids, seed, policy, simulator configuration, and
timestamps. Re-running a run id is not allowed; use a new id. The eval profile
lives under `~/.cache/great-plan-eval` and never touches the real DSH profile.

## 11. Safety and data

- The agent runs with `workspace-write` sandbox rooted at the task worktree; web
  tools are disabled; approvals are not forwarded and fail closed.
- Untrusted issue text is data, not instructions to the harness.
- The dataset (parquet, `tasks.jsonl`, issue text) stays in the cache and is
  never committed or redistributed.
- A scratch DSH home is generated per worker; credentials are copied only on an
  explicit `provision --copy-credentials` (0600) and are removable with
  `clean --home`.

## 12. Non-claims

Preparation does not claim: the plugin works in a live DSH session (first live
handshake/smoke still required), resolve rate is known (Docker absent), the
paper's numbers are reproduced, or the Web UI flows work. See `VALIDATION.md`
for the evidence matrix.
