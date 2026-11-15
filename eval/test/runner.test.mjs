import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from '../interactive-swe/util/proc.mjs';
import { readJsonl } from '../interactive-swe/util/jsonl.mjs';
import { atomicWriteFile } from '../interactive-swe/util/fsutil.mjs';
import { readJsonIfExists } from '../interactive-swe/util/fsutil.mjs';
import { sha256Hex } from '../interactive-swe/util/hash.mjs';
import { extractSession, systemPromptText } from '../interactive-swe/session/events.mjs';
import {
  ensureMirror,
  addWorktree,
  copyExport,
  captureDiff,
  removeWorktree,
  worktreePath,
} from '../interactive-swe/runner/worktree.mjs';
import { createRecorder } from '../interactive-swe/runner/transcript.mjs';
import { runTask, runBatch } from '../interactive-swe/runner/runner.mjs';
import {
  createFakeDriver,
  fakeSystemPromptText,
  FAKE_ARM_MARKERS,
} from '../interactive-swe/fixtures/fake-driver.mjs';
import { createSimulator } from '../interactive-swe/simulator/user-sim.mjs';

const MODEL = { provider: 'deepseek-official', model: 'deepseek-chat' };
const PLAN_REF = 'README.md:1';

function makeTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-eval-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeTask(instanceId = 'owner__repo-1', overrides = {}) {
  return {
    instance_id: instanceId,
    repo: 'owner/repo',
    base_commit: 'abc123',
    version: '1.0',
    environment_setup_commit: 'abc123',
    problem_statement: 'The widget breaks when it is clicked twice.',
    original_issue: 'Full issue: the widget breaks when it is clicked twice.',
    patch: '',
    test_patch: '',
    FAIL_TO_PASS: '[]',
    PASS_TO_PASS: '[]',
    files: [],
    difficulty: 'easy',
    hints_text: '',
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function taskDirFor(root, task) {
  return path.join(root, 'run', 'tasks', task.instance_id);
}

async function git(args, cwd) {
  const result = await runCommand({ command: 'git', args, cwd, timeoutMs: 120000 });
  assert.equal(result.code, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function createSourceRepo(root) {
  const source = path.join(root, 'source-repo');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'hello.txt'), 'hello\n');
  await git(['init', '--quiet'], source);
  await git(['add', '-A'], source);
  await git(['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', 'commit', '--quiet', '-m', 'init'], source);
  const head = await git(['rev-parse', 'HEAD'], source);
  return { source, head };
}

test('worktree: mirror, worktree add, diff capture, and removal run against a local repo', async (t) => {
  const root = makeTemp(t);
  const { source, head } = await createSourceRepo(root);
  const cacheRoot = path.join(root, 'cache');

  const mirror = await ensureMirror({ repo: source, cacheRoot, exec: runCommand });
  assert.equal(mirror.created, true);
  assert.equal(fs.existsSync(path.join(mirror.dir, 'HEAD')), true);

  const again = await ensureMirror({ repo: source, cacheRoot, exec: runCommand });
  assert.equal(again.created, false);

  const dir = path.join(cacheRoot, 'worktrees', 'w0', 'task-1');
  const added = await addWorktree({ repo: source, cacheRoot, baseCommit: head, dir, exec: runCommand });
  assert.equal(added.kind, 'worktree');
  assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'hello\n');

  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello again\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n');
  const captured = await captureDiff({ dir, exec: runCommand });
  assert.equal(captured.ok, true);
  assert.match(captured.diff, /hello\.txt/);
  assert.match(captured.diff, /new\.txt/);

  const removed = await removeWorktree({ repo: source, cacheRoot, dir, exec: runCommand });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(dir), false);
});

test('worktree: falls back to a git archive export when worktree add fails', async (t) => {
  const root = makeTemp(t);
  const { source, head } = await createSourceRepo(root);
  const cacheRoot = path.join(root, 'cache');
  const failingExec = async (options) => {
    if (Array.isArray(options.args) && options.args.includes('worktree') && options.args.includes('add')) {
      return { code: 1, signal: null, stdout: '', stderr: 'worktree add disabled for test', durationMs: 1 };
    }
    return runCommand(options);
  };
  const dir = path.join(cacheRoot, 'worktrees', 'w0', 'task-export');
  const added = await addWorktree({ repo: source, cacheRoot, baseCommit: head, dir, exec: failingExec });
  assert.equal(added.kind, 'export');
  assert.equal(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'hello\n');
  assert.equal(added.warnings.some((warning) => warning.includes('git worktree add failed')), true);

  const exportDir = path.join(cacheRoot, 'worktrees', 'w0', 'task-export-2');
  const exported = await copyExport({ repo: source, cacheRoot, baseCommit: head, dir: exportDir, exec: runCommand });
  assert.equal(exported.kind, 'export');
  assert.equal(fs.readFileSync(path.join(exportDir, 'hello.txt'), 'utf8'), 'hello\n');
});

test('worktree: refuses unsafe paths and unsafe instance ids', async (t) => {
  const root = makeTemp(t);
  const cacheRoot = path.join(root, 'cache');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const result = await removeWorktree({ repo: 'owner/repo', cacheRoot, dir: outside, exec: runCommand });
  assert.equal(result.ok, false);
  assert.match(result.error, /refusing to remove/);
  assert.throws(() => worktreePath({ repo: 'owner/repo', cacheRoot, worker: 'w0', instanceId: '../escape' }), /unsafe/);
});

test('transcript recorder writes the three JSONL artifacts and truncates on recreate', (t) => {
  const root = makeTemp(t);
  const taskDir = path.join(root, 'tasks', 'owner__repo-1');
  const recorder = createRecorder(taskDir);
  recorder.wire('request', { dir: 'out', id: 'rpc_1', method: 'initialize', payload: { cwd: '/tmp' } });
  recorder.wire('response', { dir: 'in', id: 'rpc_1', payload: { result: { serverInfo: { name: 'x' } } } });
  recorder.question({ ts: '2024-01-01T00:00:00Z', requestId: 'q', questions: [], decision: 'answer', answers: [], capHit: false });
  recorder.event({ type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } });
  assert.deepEqual(recorder.flush(), { wire: 2, questions: 1, events: 1 });

  const wire = readJsonl(path.join(taskDir, 'wire.ndjson'));
  assert.equal(wire.length, 2);
  assert.deepEqual(wire[0], {
    ts: wire[0].ts,
    dir: 'out',
    kind: 'request',
    id: 'rpc_1',
    method: 'initialize',
    payload: { cwd: '/tmp' },
  });
  assert.deepEqual(readJsonl(path.join(taskDir, 'questions.ndjson'))[0].decision, 'answer');
  assert.equal(readJsonl(path.join(taskDir, 'events.jsonl')).length, 1);

  const truncated = createRecorder(taskDir);
  assert.equal(truncated.flush().wire, 0);
  assert.deepEqual(readJsonl(path.join(taskDir, 'wire.ndjson')), []);
});

test('runTask dry-run plan mode writes every artifact and cancels the review', async (t) => {
  const root = makeTemp(t);
  const task = makeTask();
  const runDir = path.join(root, 'run');
  const meta = await runTask({
    task,
    runDir,
    arm: 'full',
    issueMode: 'hidden',
    runMode: 'plan',
    home: path.join(root, 'home'),
    dryRun: true,
    model: MODEL,
    sessionId: 'session-plan',
  });

  assert.equal(meta.status, 'ok');
  assert.equal(meta.failureKind, null);
  assert.equal(meta.reviewAction, 'cancel');
  assert.equal(meta.arm, 'full');
  assert.equal(meta.issueMode, 'hidden');
  assert.equal(meta.runMode, 'plan');
  assert.equal(meta.sessionId, 'session-plan');
  assert.equal(meta.turns, 1);
  assert.ok(meta.toolCalls >= 5);
  assert.equal(meta.askCount, 1);
  assert.equal(meta.toolRoster.checked, true);
  assert.equal(meta.toolRoster.ok, true);
  assert.deepEqual(meta.toolRoster.missing, []);
  assert.equal(meta.simulator.kind, 'fixture');
  assert.ok(meta.usage.inputTokens > 0);
  assert.equal(fs.existsSync(meta.worktree), true);

  const taskDir = taskDirFor(root, task);
  for (const file of ['meta.json', 'plan.md', 'plan-review.json', 'citations.json', 'wire.ndjson', 'questions.ndjson', 'events.jsonl']) {
    assert.equal(fs.existsSync(path.join(taskDir, file)), true, `missing ${file}`);
  }
  assert.equal(fs.existsSync(path.join(taskDir, 'diff.patch')), false);
  assert.equal(fs.existsSync(path.join(runDir, 'predictions.jsonl')), false);

  const plan = fs.readFileSync(path.join(taskDir, 'plan.md'), 'utf8');
  assert.match(plan, /^# Plan:/);
  assert.match(plan, new RegExp(PLAN_REF.replace('.', '\\.')));
  const review = readJsonIfExists(path.join(taskDir, 'plan-review.json'));
  assert.equal(review.action, 'cancel');
  assert.equal(review.requestId, 'fake-review-1');
  assert.equal(review.detail, plan);
  assert.equal(review.question, 'Approve this plan and leave plan mode?');

  const questions = readJsonl(path.join(taskDir, 'questions.ndjson'));
  assert.equal(questions.length, 2);
  assert.equal(questions[0].decision, 'answer');
  assert.equal(questions[0].capHit, false);
  assert.equal(questions[1].questions[0].id, 'plan-review');
  assert.equal(questions[1].decision, 'cancel');

  const wire = readJsonl(path.join(taskDir, 'wire.ndjson'));
  assert.equal(wire.some((row) => row.dir === 'out' && row.kind === 'request' && row.method === 'initialize'), true);
  assert.equal(wire.some((row) => row.dir === 'in' && row.kind === 'notification' && row.method === 'session.query.completed'), true);
  assert.equal(wire.every((row) => typeof row.ts === 'string'), true);

  const events = readJsonl(path.join(taskDir, 'events.jsonl'));
  assert.equal(events.length > 0, true);
  const citations = readJsonIfExists(path.join(taskDir, 'citations.json'));
  assert.ok(Array.isArray(citations.refs));
  assert.equal(citations.stats.total, citations.refs.length);
  assert.ok(citations.refs.length >= 1);
});

test('runTask marks a missing required tool as protocol_error', async (t) => {
  const root = makeTemp(t);
  const task = makeTask();
  const meta = await runTask({
    task,
    runDir: path.join(root, 'run'),
    arm: 'full',
    issueMode: 'hidden',
    runMode: 'plan',
    home: path.join(root, 'home'),
    dryRun: true,
    model: MODEL,
    omitTools: ['spawn_teammate'],
  });
  assert.equal(meta.status, 'protocol_error');
  assert.equal(meta.failureKind, 'tool-roster');
  assert.deepEqual(meta.toolRoster.missing, ['spawn_teammate']);
});

test('runTask dry-run execute mode approves, captures a patch, and records a prediction', async (t) => {
  const root = makeTemp(t);
  const task = makeTask();
  const runDir = path.join(root, 'run');
  const meta = await runTask({
    task,
    runDir,
    arm: 'full',
    issueMode: 'hidden',
    runMode: 'execute',
    home: path.join(root, 'home'),
    dryRun: true,
    model: MODEL,
    sessionId: 'session-execute',
  });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.reviewAction, 'approve');
  assert.equal(typeof meta.gitDiffSha256, 'string');

  const taskDir = taskDirFor(root, task);
  const diff = fs.readFileSync(path.join(taskDir, 'diff.patch'), 'utf8');
  assert.match(diff, /README\.md/);
  assert.equal(meta.gitDiffSha256, sha256Hex(diff));
  assert.equal(readJsonIfExists(path.join(taskDir, 'plan-review.json')).action, 'approve');

  const predictions = readJsonl(path.join(runDir, 'predictions.jsonl'));
  assert.equal(predictions.length, 1);
  assert.deepEqual(predictions[0], {
    instance_id: task.instance_id,
    model_name_or_path: 'deepseek-official/deepseek-chat',
    model_patch: diff,
  });
});

test('runTask dry-run skips the clarification ask when configured', async (t) => {
  const root = makeTemp(t);
  const task = makeTask();
  const meta = await runTask({
    task,
    runDir: path.join(root, 'run'),
    arm: 'full',
    issueMode: 'hidden',
    runMode: 'plan',
    home: path.join(root, 'home'),
    dryRun: true,
    model: MODEL,
    askUserQuestion: false,
  });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.askCount, 0);
  const questions = readJsonl(path.join(taskDirFor(root, task), 'questions.ndjson'));
  assert.equal(questions.length, 1);
  assert.equal(questions[0].questions[0].id, 'plan-review');
});

test('runTask dry-run caps simulator answers and records cap hits', async (t) => {
  const root = makeTemp(t);
  const task = makeTask();
  const meta = await runTask({
    task,
    runDir: path.join(root, 'run'),
    arm: 'full',
    issueMode: 'hidden',
    runMode: 'plan',
    home: path.join(root, 'home'),
    dryRun: true,
    model: MODEL,
    fakeAskCount: 4,
    policy: { answersCap: 3 },
  });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.askCount, 4);
  assert.equal(meta.capHits, 1);
  const questions = readJsonl(path.join(taskDirFor(root, task), 'questions.ndjson'));
  assert.equal(questions.length, 5);
  assert.equal(questions[3].capHit, true);
  assert.equal(questions[3].decision, 'cancel');
});

test('runTask marks a simulator failure as simulator_error', async (t) => {
  const root = makeTemp(t);
  const task = makeTask();
  const failingSimulator = {
    kind: 'http',
    model: 'sim',
    cap: 3,
    async answer() {
      throw new Error('simulator endpoint is down');
    },
    reset() {},
  };
  const meta = await runTask({
    task,
    runDir: path.join(root, 'run'),
    arm: 'full',
    issueMode: 'hidden',
    runMode: 'plan',
    home: path.join(root, 'home'),
    dryRun: true,
    model: MODEL,
    simulator: failingSimulator,
  });
  assert.equal(meta.status, 'simulator_error');
  assert.equal(meta.failureKind, 'simulator');
});

test('runTask marks a session without a plan review as plan_missing', async (t) => {
  const root = makeTemp(t);
  const task = makeTask();
  const noPlanDriver = async () => ({
    frames: [],
    questions: [],
    response: { kind: 'command', execution: { commandId: 'cmd-1' } },
    completion: { sessionId: 'session-x', commandId: 'cmd-1', finishReason: 'completed', finalResponse: '' },
    exitCode: 0,
    stderrTail: '',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    timedOut: false,
    errors: [],
    warnings: [],
  });
  const meta = await runTask({
    task,
    runDir: path.join(root, 'run'),
    arm: 'native',
    issueMode: 'hidden',
    runMode: 'plan',
    home: path.join(root, 'home'),
    dryRun: true,
    model: MODEL,
    driver: noPlanDriver,
  });
  assert.equal(meta.status, 'plan_missing');
  assert.equal(meta.failureKind, 'no-plan-review');
  assert.equal(meta.reviewAction, 'none');
  assert.equal(fs.readFileSync(path.join(taskDirFor(root, task), 'plan.md'), 'utf8'), '');
});

test('runTask refuses the real DSH home and records an internal failure', async (t) => {
  const root = makeTemp(t);
  const task = makeTask();
  const meta = await runTask({
    task,
    runDir: path.join(root, 'run'),
    arm: 'native',
    issueMode: 'hidden',
    runMode: 'plan',
    home: path.join(os.homedir(), '.dsh'),
    dryRun: true,
    model: MODEL,
  });
  assert.equal(meta.status, 'internal');
  assert.match(meta.error, /refusing to run against the real DSH home/);
});

test('runTask uses a provided worktree directory and captures a real diff', async (t) => {
  const root = makeTemp(t);
  const { source } = await createSourceRepo(root);
  await git(['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'baseline'], source);
  const task = makeTask();
  const reviewQuestion = {
    id: 'plan-review',
    header: 'Plan review',
    question: 'Approve this plan and leave plan mode?',
    detail: '# Plan\n\nUse `hello.txt:1` as evidence.',
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve' },
  };
  let answerSeen = null;
  const driver = async (options) => {
    answerSeen = await options.questionPolicy({
      requestId: 'review-1',
      sessionId: options.sessionId,
      questions: [reviewQuestion],
    });
    fs.appendFileSync(path.join(options.cwd, 'hello.txt'), 'changed by the agent\n');
    return {
      frames: [],
      questions: [
        {
          ts: new Date().toISOString(),
          requestId: 'review-1',
          questions: [reviewQuestion],
          decision: 'approve',
          answers: [{ id: 'plan-review', selected: ['Approve'] }],
          capHit: false,
        },
      ],
      response: { kind: 'command', execution: { commandId: 'cmd-1' } },
      completion: { sessionId: options.sessionId, commandId: 'cmd-1', finishReason: 'completed', finalResponse: '' },
      exitCode: 0,
      stderrTail: '',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      timedOut: false,
      errors: [],
      warnings: [],
    };
  };
  const meta = await runTask({
    task,
    runDir: path.join(root, 'run'),
    arm: 'full',
    issueMode: 'full',
    runMode: 'execute',
    home: path.join(root, 'home'),
    model: MODEL,
    worktreeDir: source,
    driver,
  });
  assert.deepEqual(answerSeen, { answers: [{ id: 'plan-review', selected: ['Approve'] }], decision: 'approve' });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.worktree, source);
  assert.equal(meta.reviewAction, 'approve');
  const diff = fs.readFileSync(path.join(taskDirFor(root, task), 'diff.patch'), 'utf8');
  assert.match(diff, /changed by the agent/);
  assert.equal(meta.gitDiffSha256, sha256Hex(diff));
});

test('runTask emits synthetic system prompt markers per arm for dry-run arm integrity', async (t) => {
  const root = makeTemp(t);
  const expected = {
    native: { budget: false, brainstorming: false, teamLead: false, handoff: false },
    evidence: { budget: true, brainstorming: false, teamLead: false, handoff: true },
    full: { budget: true, brainstorming: true, teamLead: true, handoff: true },
  };
  for (const arm of ['native', 'evidence', 'full']) {
    const task = makeTask(`arm__repo-${arm}`);
    const runDir = path.join(root, `run-${arm}`);
    const meta = await runTask({
      task,
      runDir,
      arm,
      issueMode: 'hidden',
      runMode: 'plan',
      home: path.join(root, `home-${arm}`),
      dryRun: true,
      model: MODEL,
      sessionId: `session-${arm}`,
    });
    assert.equal(meta.status, 'ok');
    assert.equal(meta.arm, arm);
    const facts = extractSession(readJsonl(path.join(runDir, 'tasks', task.instance_id, 'events.jsonl')));
    const systemText = systemPromptText(facts);
    assert.equal(systemText, fakeSystemPromptText(arm));
    for (const [key, marker] of Object.entries(FAKE_ARM_MARKERS)) {
      assert.equal(systemText.includes(marker), expected[arm][key], `${arm} marker ${key}`);
    }
  }
});

test('runBatch dry-run writes a manifest, counts, and execute-mode predictions', async (t) => {
  const root = makeTemp(t);
  const tasks = [makeTask('owner__repo-1'), makeTask('owner__repo-2')];
  const runDir = path.join(root, 'batch');
  const manifest = await runBatch({
    tasks,
    runId: 'batch-1',
    runDir,
    arm: 'full',
    issueMode: 'hidden',
    runMode: 'execute',
    homes: [],
    concurrency: 2,
    dryRun: true,
    model: MODEL,
    seed: 42,
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.runId, 'batch-1');
  assert.equal(manifest.arm, 'full');
  assert.equal(manifest.runMode, 'execute');
  assert.deepEqual(manifest.model, { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: null, maxTokens: null });
  assert.equal(manifest.sample.count, 2);
  assert.deepEqual(manifest.sample.ids, tasks.map((task) => task.instance_id));
  assert.equal(manifest.seed, 42);
  assert.equal(manifest.policy.review, 'approve');
  assert.equal(manifest.simulator.kind, 'fixture');
  assert.equal(manifest.counts.total, 2);
  assert.equal(manifest.counts.ok, 2);
  assert.equal(manifest.counts.failed, 0);
  assert.deepEqual(manifest.counts.byStatus, { ok: 2 });
  assert.ok(manifest.usage.inputTokens > 0);
  assert.equal(typeof manifest.startedAt, 'string');
  assert.equal(typeof manifest.finishedAt, 'string');
  assert.equal(typeof manifest.env.node, 'string');
  assert.equal(manifest.stopReason, null);

  const onDisk = readJsonIfExists(path.join(runDir, 'manifest.json'));
  assert.deepEqual(onDisk.counts, manifest.counts);
  const predictions = readJsonl(path.join(runDir, 'predictions.jsonl'));
  assert.equal(predictions.length, 2);
  assert.deepEqual(predictions.map((row) => row.instance_id).sort(), ['owner__repo-1', 'owner__repo-2']);
  for (const task of tasks) {
    const meta = readJsonIfExists(path.join(runDir, 'tasks', task.instance_id, 'meta.json'));
    assert.equal(meta.status, 'ok');
  }
});

test('runBatch resume skips completed tasks and refreshes counts', async (t) => {
  const root = makeTemp(t);
  const tasks = [makeTask('owner__repo-1'), makeTask('owner__repo-2')];
  const runDir = path.join(root, 'batch');
  const calls = [];
  const fakeDriver = createFakeDriver({ tasks });
  const countingDriver = async (options) => {
    calls.push(options.task.instance_id);
    return fakeDriver(options);
  };
  const options = {
    tasks,
    runId: 'resume-run',
    runDir,
    arm: 'full',
    issueMode: 'hidden',
    runMode: 'plan',
    homes: [],
    concurrency: 1,
    dryRun: true,
    model: MODEL,
    deps: { driver: countingDriver },
  };
  const first = await runBatch(options);
  assert.deepEqual(calls, ['owner__repo-1', 'owner__repo-2']);
  assert.deepEqual(first.counts, { total: 2, ok: 2, failed: 0, byStatus: { ok: 2 } });

  calls.length = 0;
  const resumed = await runBatch({ ...options, resume: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(resumed.counts, { total: 2, ok: 2, failed: 0, byStatus: { ok: 2 } });

  const failedMeta = readJsonIfExists(path.join(runDir, 'tasks', 'owner__repo-2', 'meta.json'));
  failedMeta.status = 'timeout';
  atomicWriteFile(path.join(runDir, 'tasks', 'owner__repo-2', 'meta.json'), `${JSON.stringify(failedMeta, null, 2)}\n`);

  calls.length = 0;
  const partial = await runBatch({ ...options, resume: true });
  assert.deepEqual(calls, ['owner__repo-2']);
  assert.deepEqual(partial.counts.byStatus, { ok: 2 });
  assert.equal(partial.counts.failed, 0);
});

test('runBatch applies offset and limit to the deterministic input order', async (t) => {
  const root = makeTemp(t);
  const tasks = [makeTask('owner__repo-1'), makeTask('owner__repo-2'), makeTask('owner__repo-3')];
  const manifest = await runBatch({
    tasks,
    runId: 'slice',
    runDir: path.join(root, 'batch'),
    arm: 'native',
    issueMode: 'full',
    runMode: 'plan',
    homes: [],
    dryRun: true,
    model: MODEL,
    offset: 1,
    limit: 1,
  });
  assert.equal(manifest.counts.total, 1);
  assert.deepEqual(manifest.sample.ids, ['owner__repo-2']);
  assert.equal(fs.existsSync(path.join(root, 'batch', 'tasks', 'owner__repo-1')), false);
  assert.equal(fs.existsSync(path.join(root, 'batch', 'tasks', 'owner__repo-2', 'meta.json')), true);
});

test('runBatch requires scratch homes for a live run', async (t) => {
  const root = makeTemp(t);
  await assert.rejects(
    () =>
      runBatch({
        tasks: [makeTask()],
        runId: 'live',
        runDir: path.join(root, 'batch'),
        arm: 'native',
        issueMode: 'hidden',
        runMode: 'plan',
        homes: [],
        model: MODEL,
      }),
    /scratch home/,
  );
});

test('runTask with an unconfigured simulator marks asks cancelled without a cap hit', async (t) => {
  const root = makeTemp(t);
  const task = makeTask();
  const meta = await runTask({
    task,
    runDir: path.join(root, 'run'),
    arm: 'full',
    issueMode: 'hidden',
    runMode: 'plan',
    home: path.join(root, 'home'),
    dryRun: true,
    model: MODEL,
    simulator: createSimulator({ kind: 'none' }),
  });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.capHits, 0);
  assert.equal(meta.simulator.kind, 'none');
  const questions = readJsonl(path.join(taskDirFor(root, task), 'questions.ndjson'));
  assert.equal(questions[0].decision, 'cancel');
  assert.equal(questions[0].capHit, false);
});
