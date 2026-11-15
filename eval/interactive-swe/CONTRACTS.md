# Evaluation harness contracts (internal, v1)

This file is the coordination contract for the interactive-swe harness. It is
repository-only and not part of the published package. Read it before touching
any file under `eval/interactive-swe/`.

## Ground rules

- Plain modern ESM JavaScript (`node:` imports only). No new npm dependencies.
- Files are `.mjs`; tests are `eval/test/*.test.mjs` and run with the built-in
  `node:test` runner. Tests are offline: temp dirs, fake transports, fake fetch.
- Never write `~/.dsh` or `~/.dsh/profiles/*`. All runtime state lives under
  `GREAT_PLAN_EVAL_CACHE` (default `~/.cache/great-plan-eval`).
- No model calls and no network in tests. The live run is gated by
  `--confirm-live` in `cli.mjs`.
- Style: 2-space indent, semicolons, single quotes, JSDoc on exported helpers,
  small pure functions where possible.
- Node binary for checks/tests on this host:
  `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`.
- Run `node --check <file>` and `node --test eval/test/<your>.test.mjs` before
  reporting done.

## Write scopes

- Lead: `session/`, `tasks/`, `dataset/`, `util/`, `cli.mjs`, docs, `tools/gate-eval.sh`.
- Profile owner: `profile/`, `eval/test/profile.test.mjs`, `eval/test/preflight.test.mjs`.
- Runner owner: `simulator/`, `runner/`, `eval/test/simulator.test.mjs`,
  `eval/test/driver.test.mjs`, `eval/test/runner.test.mjs`.
- Score owner: `score/`, `judge/`, `eval/test/scoring.test.mjs`,
  `eval/test/report.test.mjs`, `eval/test/judge.test.mjs`.

Do not edit files outside your scope; report a blocking contract mismatch to
the Lead instead of changing a shared module.

## Shared utilities (`util/`)

- `jsonl.mjs`: `readJsonl(file)` (sync, returns array), `writeJsonl(file, rows)`,
  `appendJsonl(file, row)`.
- `hash.mjs`: `sha256Hex(data)` (string|Buffer), `hashJson(value)` (stable
  key-sorted JSON sha256).
- `fsutil.mjs`: `ensureDir(dir)`, `atomicWriteFile(file, content)` (tmp+rename),
  `readJsonIfExists(file)`, `listDir(dir)`.
- `proc.mjs`: `runCommand({ command, args, cwd, env, timeoutMs, input })`
  resolves `{ code, signal, stdout, stderr, durationMs }`; never throws for a
  non-zero exit, throws only when the process cannot start.
- `time.mjs`: `nowIso()`, `sleep(ms)`.
- `ids.mjs`: `newSessionId()`, `assertSafeId(value)`.

## Data contracts

### `tasks/schema.mjs`

```
REQUIRED_TASK_FIELDS = [
  'instance_id','repo','base_commit','version','environment_setup_commit',
  'problem_statement','original_issue','patch','test_patch',
  'FAIL_TO_PASS','PASS_TO_PASS','files','difficulty','hints_text','created_at',
]
normalizeTaskRow(row) -> task
  task = {
    instance_id, repo, base_commit, version, environment_setup_commit,
    problem_statement, original_issue, patch, test_patch,
    failToPass, passToPass, failToPassRaw, passToPassRaw,
    files, difficulty, hintsText, createdAt,
  }
normalizeTasks(rows) -> { tasks, errors }
selectIssue(task, issueMode) -> string   // 'hidden' | 'full'
selectTasks(tasks, options) -> task[]    // { ids, limit, offset, idsFile, seed, sample }
parseIdList(text) -> string[]            // ignores blank lines and # comments
hashTasks(tasks) -> string               // hashJson of normalized rows
validateTaskSet(tasks) -> { ok, errors }
```

`failToPass`/`passToPass` are arrays when the raw string parses as JSON,
otherwise `[]`; the raw string is always preserved. `selectTasks` must be
deterministic: when `seed` is present, shuffle in a documented stable way; when
`sample` is a positive number, take a deterministic stratified sample by
`repo` then `difficulty` order.

### Run directory (`runDir`)

```
runDir/
  manifest.json
  predictions.jsonl        # execute mode only, one line per completed task
  tasks/<instance_id>/
    meta.json
    plan.md
    plan-review.json
    citations.json
    wire.ndjson
    questions.ndjson
    events.jsonl
    diff.patch             # execute mode only
```

`manifest.json`:

```
{
  schemaVersion: 1,
  runId, arm, issueMode, runMode,
  model: { provider, model, reasoningEffort|null, maxTokens|null },
  workspace: { root, pluginHead, pluginDirty },
  env: { node, dshCli, dshHome, appVersion, platform, cpus },
  patches: [{ path, sha256 }],
  sample: { tasksFile, sha256, ids: string[], count },
  policy: { review: 'cancel'|'approve', answersCap, taskTimeoutMs, idleSettleMs, approvals },
  simulator: { kind: 'fixture'|'http'|'none', model: string|null },
  seed, startedAt, finishedAt|null,
  counts: { total, ok, failed, byStatus: Record<string, number> },
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
  stopReason: string|null,
}
```

`meta.json` per task:

```
{
  schemaVersion: 1, instanceId, arm, issueMode, runMode,
  status: 'ok'|'timeout'|'plan_missing'|'simulator_error'|'init_error'
        |'provider_error'|'protocol_error'|'spawn_error'|'internal',
  failureKind: string|null,
  sessionId, baseCommit, worktree: string|null,
  startedAt, finishedAt, durationMs,
  turns, toolCalls,
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
  reviewAction: 'cancel'|'approve'|'none',
  askCount, capHits,
  simulator: { kind, usage? },
  gitDiffSha256: string|null,
}
```

`wire.ndjson` rows: `{ ts, dir: 'in'|'out', kind: 'request'|'response'|'notification', id?, method?, payload }`.
`questions.ndjson` rows: `{ ts, requestId, questions, decision, answers, capHit, error? }` where
`decision` is `'cancel'|'answer'|'approve'|'reject'`.
`events.jsonl`: decoded durable session events, one per line.
`plan-review.json`: `{ requestId, question, options, detail, action, answeredAt }`.
`citations.json`: `{ refs: [...], stats: {...} }`.
`predictions.jsonl` row: `{ instance_id, model_name_or_path, model_patch }`.

## Session modules (`session/`)

- `zstd-log.mjs`:
  - `ZSTD_MAGIC` (Buffer `28 B5 2F FD`).
  - `splitZstdFrames(buffer) -> Buffer[]`
  - `decodeSessionLog(buffer) -> { header, events, frameCount, warnings }`
  - `readSessionLog(file) -> same`
  - `SessionLogError` with `code` (`'no-frames'|'bad-header'|'bad-frame'`).
- `events.mjs`:
  - `PLAN_MODE_TOOL='exit_plan_mode'`, `ASK_TOOL='ask_user_question'`, `SPAWN_TOOL='spawn_teammate'`.
  - `parseToolArguments(call) -> object|null` (arguments is a JSON string).
  - `extractSession(events) -> sessionFacts` (see shape below).
  - `usageTotals(sessionFacts) -> usage`.
  - `systemPromptText(sessionFacts) -> string` (join all `system/message` text).
- `locate.mjs`:
  - `findSessionLog(dshHome, sessionId) -> string|null` (bounded recursive scan,
    never throws on a missing home).
  - `sessionLogRelativePath(cwd, sessionId) -> string` (deterministic fallback).

`sessionFacts`:

```
{
  events, eventCount,
  planModes: [{ seq, active }],
  toolCalls: [{ seq, turn, step, callId, name, args, argsRaw }],
  toolResults: [{ seq, turn, step, callId, name, isError, errorCode, text }],
  assistantMessages: [{ seq, turn, step, text, usage }],
  systemMessages: [{ seq, turn, step, text }],
  userMessages: [{ seq, turn, step, sourceKind, text }],
  teamTasks: [...], teamMembers: [...],
  commands: [{ seq, kind, name, text, commandId }],
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
  planModeActive: boolean,
}
```

## Profile modules (`profile/`)

- `provision.mjs`:
  - `CACHE_ENV='GREAT_PLAN_EVAL_CACHE'`, `defaultCacheRoot(env)`,
    `assertSafeHome(home)` (rejects `$HOME/.dsh` and paths inside it).
  - `provision({ workspace, cacheRoot, workers = 1, copyCredentials = false, force = false })`
    -> `{ cacheRoot, workspace, homes: [{ name, home, profileDir }], pluginLink, copiedCredentials: boolean }`
    (sync or async; document which).
  - `profileFileContents({ workspace })` -> `{ 'package.json': string, 'cordis.yml': string,
    'cordis.patch.yml': string, 'pnpm-workspace.yaml': string }` for tests.
  - `BASE_PATCH_TEXT`, `armPatchText(arm)`.
  - Provision writes, per worker home: `profiles/eval/` with the four files above,
    `node_modules/@onefl666/dsh-great-plan` -> `workspace` symlink, and optionally
    `.credentials.yaml` (mode 0o600) copied from `~/.dsh/.credentials.yaml`.
- `preflight.mjs`:
  - `EXPECTED_CONFIG_FIELDS = ['injectBrainstormingPrompt','injectUnlimitedBudgetPrompt',
    'includeOriginalUserInstructions','includeMinimalRuntimeContext']`.
  - `parseSchemaRows(stdout) -> rows[]` (tolerant recursive walk).
  - `schemaFindings(stdout) -> { row, fields, diagnostics }`.
  - `parseDumpText(text, id) -> { found, disabled, config }` (line-based, tolerant).
  - `preflight({ workspace, cacheRoot, env, exec, compose = false, checkProfile = false })`
    -> `{ ok, blockers: string[], warnings: string[], facts: object }`.
    `exec` is injected `runCommand`-compatible for tests; default `runCommand`.
  - `handshake` is NOT implemented here; `cli.mjs` may call the driver later.

Arm names: `native`, `evidence`, `full`. `native` disables row `great-plan`;
`evidence` restates all four fields with `injectBrainstormingPrompt: false`,
`injectUnlimitedBudgetPrompt: true`, others true; `full` restates all four true.
`config` is replaced wholesale by Cordis patches, so all four fields must always
be present in `evidence`/`full`.

## Simulator (`simulator/`)

- `prompt.mjs`: `SIMULATOR_SYSTEM_PROMPT`, `buildSimulatorMessages(input)`,
  `parseSimulatorAnswer(text, questionIds) -> answers[]` (throws on malformed).
- `user-sim.mjs`: `createSimulator({ kind, model, fetchImpl, fixture, cap = 3 })`
  -> `{ kind, cap, answer({ task, questions, history }), reset() }`.
  `answer` resolves `{ answers, usage, capHit }`; every question id exactly once;
  `kind:'none'` resolves `{ cancelled: true }`; `kind:'fixture'` reads
  `fixture[instance_id]` (array of answers or map by question text).
- `http-sim.mjs`: `callOpenAiCompatible({ baseUrl, apiKey, model, messages, fetchImpl })`
  -> `{ text, usage }` using global `fetch` by default.

## Runner (`runner/`)

- `sdk-driver.mjs`:
  - `runSdkSession({ command, args, cwd, env, model, sessionId, inputText,
    questionPolicy, timeoutMs, idleSettleMs, spawnImpl, onFrame })`
    -> `{ frames, questions, response, completion, exitCode, stderrTail,
         startedAt, endedAt, timedOut, errors }`.
  - `questionPolicy(request) -> Promise<wireAnswer>`; wireAnswer is
    `{ answers:[{id, selected, custom?}] }` or `{ cancelled:true }`.
  - Handles `approval/request` by replying `{ outcome: 'rejected' }`.
  - No model/network; spawn only. Tests inject a fake child (`spawnImpl`) with
    `stdin`, `stdout`, `stderr`, `on`, `kill`, `pid`.
- `prompts.mjs`: `buildPlanInput(issueText)` -> `/plan <trimmed issue>`;
  `assertSingleTextBlock(text)`.
- `worktree.mjs`: `ensureMirror({ repo, cacheRoot, exec })`,
  `addWorktree({ repo, cacheRoot, baseCommit, dir, exec })`,
  `copyExport({ repo, cacheRoot, baseCommit, dir, exec })` (fallback when
  worktree is unavailable), `captureDiff({ dir, exec })`,
  `removeWorktree({ repo, cacheRoot, dir, exec })`.
- `transcript.mjs`: `createRecorder(taskDir)` with `wire(kind, frame)`,
  `question(row)`, `event(event)`, `flush()`; writes JSONL files.
- `runner.mjs`: `runTask(options)` and `runBatch(options)`.
  - `runTask` receives `{ task, arm, issueMode, runMode, runDir, home, patches,
    model, simulator, driver, worktree, policy, dryRun }` and writes the task
    artifacts. `driver`/`worktree` are injectable for tests; default real ones.
  - `runBatch({ tasks, runId, runDir, arm, issueMode, runMode, homes, patches,
    model, simulator, policy, seed, limit, offset, concurrency, resume, deps })`
    writes `manifest.json`, iterates deterministically, and returns the manifest.
  - `dryRun` uses a fake driver from `fixtures/fake-driver.mjs` (owned by the
    runner owner) so `cli selftest` can exercise the full path offline.
- `fixtures/fake-driver.mjs`: `createFakeDriver({ tasks, answers })` returning a
  driver-compatible function that emits synthetic wire frames/events: a few
  `read`/`grep` tool calls, one `spawn_teammate`, an `ask_user_question` (for
  hidden mode), but the runner must also be able to skip the ask. It must
  produce a plan-review request whose `detail` contains a plan with at least one
  valid path ref for `citations.json`. Deterministic output only.

## Score (`score/`) and judge (`judge/`)

- `score/plan.mjs`: `extractPlan({ wire, session }) -> { text, source, submitted,
  review }`; `armMarkers(text) -> { budget, brainstorming, teamLead, handoff }`;
  `expectedMarkers(arm) -> same shape`; `checkArmIntegrity(arm, text)`.
- `score/paths.mjs`: `extractPathRefs(text) -> refs[]`;
  `resolvePathRefs({ refs, root, toolCalls }) -> { refs, stats }` (safe path
  resolution, line bounds, corroboration by tool-call argument substring).
- `score/clarify.mjs`: `clarificationStats({ session, questions })`.
- `score/delegation.mjs`: `delegationStats({ session })` (parallel groups by
  `(turn,step)`, planning teammate heuristic).
- `score/quality.mjs`: `handoffStats(text)` and `assumptionStats(text)`
  (headings/keywords only; no LLM).
- `score/aggregate.mjs`: `scoreTask(taskDir) -> metrics` (reads artifacts),
  `scoreRun(runDir) -> { manifest, tasks: metrics[] }`.
- `score/mcnemar.mjs`: `mcnemar(b, c) -> { b, c, p }` (exact two-sided binomial).
- `score/bootstrap.mjs`: `bootstrapMeanCI(values, { seed, iterations })`.
- `score/report.mjs`: `buildReport(scoredRuns, { seed }) -> report` and
  `renderMarkdown(report)`, `renderCsv(report)`.
- `judge/judge.mjs`: `judgeRun({ runDir, fetchImpl, model, promptVersion })`
  optional; off by default; sha256 cache under the run dir; returns
  `{ enabled, scores, usage, errors }`. `judge/prompts.mjs` exports the prompt
  and JSON schema.

## `cli.mjs`

Thin dispatcher; owns all user-facing messages and exit codes. Commands:
`provision`, `fetch-dataset`, `normalize`, `preflight`, `selftest`, `dry-run`,
`run`, `score`, `report`, `judge`, `clean`. `run` exits 2 without
`--confirm-live`, without a green preflight, without model provider/model, or
without a live simulator for `--issue-mode hidden`. It never asks for approval
interactively.

## Tests

- Each owner writes tests for their scope under `eval/test/`.
- Fixtures live under `eval/test/fixtures/` unless a module needs a committed
  fixture (e.g. `dataset/fixtures/tasks.sample.jsonl`).
- Do not touch `test/` (the plugin's 278-test gate), `lib/`, `package.json`,
  `tools/gate.sh`, root READMEs, or `AGENTS.md`; the Lead owns those.
