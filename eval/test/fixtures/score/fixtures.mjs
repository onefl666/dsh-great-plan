/**
 * Synthetic run-artifact builders shared by the scoring, report, and judge
 * tests. Everything is written under a temporary directory; no fixture touches
 * the network, `~/.dsh`, or a model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../../../interactive-swe/util/hash.mjs';
import { writeJsonl } from '../../../interactive-swe/util/jsonl.mjs';
import {
  MARKER_BRAINSTORMING,
  MARKER_BUDGET,
  MARKER_HANDOFF,
  MARKER_TEAM_LEAD,
} from '../../../interactive-swe/score/plan.mjs';

/** Exact system-prompt lives for each arm. */
export const SYSTEM_PROMPTS = {
  full: `${MARKER_BUDGET} Never cut investigation.\n\n${MARKER_BRAINSTORMING}\n- You are the Team Lead. Use spawn_teammate.\n\n${MARKER_HANDOFF} (self-contained)\n- Background\n- Evidence\n- Handoff`,
  evidence: `${MARKER_BUDGET} Never cut investigation.\n\n${MARKER_HANDOFF} (self-contained)\n- Background\n- Evidence\n- Handoff`,
  native: 'You are a helpful planning assistant. Investigate the repository and submit a plan.',
};

/** A plan with background, evidence, assumptions, and handoff sections. */
export const DEFAULT_PLAN = [
  '## Background',
  'Add the requested feature to the handler.',
  '',
  '## Evidence',
  '- `src/a.js:2` contains the handler entry point.',
  '- `src/missing.js:4` is an invented path.',
  '',
  '## Assumptions',
  '- The API is stable. Open question: retry policy. Unverified: the timeout value.',
  '',
  '## Handoff',
  'Do not re-investigate `src/a.js`; verify first with a focused test.',
].join('\n');

/** A fresh temporary directory removed when the test finishes. */
export function makeTempDir(t, prefix = 'score') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gp-eval-${prefix}-`));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Write a UTF-8 text file, creating parent directories. */
export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Write a JSON file, creating parent directories. */
export function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** One decoded session event for a tool call. */
export function toolCallEvent(seq, name, args, { turn = 1, step = 1 } = {}) {
  return {
    seq,
    type: 'tool/call',
    data: {
      turn,
      step,
      callId: `call-${seq}`,
      name,
      arguments: JSON.stringify(args ?? {}),
    },
  };
}

/** One decoded session event for an assistant message. */
export function assistantEvent(seq, text, usage = null, { turn = 1, step = 1 } = {}) {
  return {
    seq,
    type: 'assistant/message',
    data: { turn, step, message: { content: [{ type: 'text', text }] }, usage: usage ?? undefined },
  };
}

/** One decoded system-message event carrying the prompt text. */
export function systemEvent(seq, text, { turn = 1, step = 1 } = {}) {
  return {
    seq,
    type: 'system/message',
    data: { turn, step, message: { content: [{ type: 'text', text }] } },
  };
}

/** One plan-mode state event. */
export function planModeEvent(seq, active) {
  return { seq, type: 'plan/mode', data: { active } };
}

/** Default options for a synthetic task. */
export function taskOptions(overrides = {}) {
  const arm = overrides.arm ?? 'full';
  return {
    arm,
    runMode: 'plan',
    issueMode: 'hidden',
    status: 'ok',
    question: 'Add the requested feature',
    plan: DEFAULT_PLAN,
    systemText: overrides.systemText ?? SYSTEM_PROMPTS[arm] ?? '',
    planMode: true,
    submitted: true,
    askCalls: [],
    spawnCalls: [],
    questions: [],
    citations: { refs: [], stats: {} },
    worktree: null,
    diff: null,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    turns: 2,
    toolCalls: 3,
    reviewAction: 'cancel',
    extraEvents: [],
    omit: [],
    ...overrides,
  };
}

/** Write one task directory and return its path. */
export function writeTask(root, instanceId, overrides = {}) {
  const options = taskOptions(overrides);
  const taskDir = path.join(root, instanceId);
  fs.mkdirSync(taskDir, { recursive: true });
  const omitted = new Set(Array.isArray(options.omit) ? options.omit : []);
  const events = [];
  let seq = 1;
  if (options.systemText !== '') events.push(systemEvent(seq++, options.systemText));
  events.push(planModeEvent(seq++, options.planMode === true));
  for (const ask of options.askCalls) {
    events.push(
      toolCallEvent(seq++, 'ask_user_question', ask.args ?? { questions: ask.questions }, {
        turn: ask.turn ?? 1,
        step: ask.step ?? 2,
      }),
    );
  }
  for (const spawn of options.spawnCalls) {
    events.push(
      toolCallEvent(seq++, 'spawn_teammate', spawn.args ?? {}, {
        turn: spawn.turn ?? 1,
        step: spawn.step ?? 3,
      }),
    );
  }
  if (options.submitted !== false) {
    events.push(
      toolCallEvent(seq++, 'exit_plan_mode', { plan: options.plan }, {
        turn: 2,
        step: 1,
      }),
    );
  }
  for (const event of options.extraEvents) events.push({ ...event, seq: seq++ });
  events.push(assistantEvent(seq++, 'Plan submitted for review.', options.usage, { turn: 2, step: 1 }));

  const diff = typeof options.diff === 'string' ? options.diff : null;
  const meta = {
    schemaVersion: 1,
    instanceId,
    arm: options.arm,
    issueMode: options.issueMode,
    runMode: options.runMode,
    status: options.status,
    failureKind: options.status === 'ok' ? null : 'synthetic',
    sessionId: `session-${instanceId}`,
    baseCommit: 'deadbeef',
    worktree: options.worktree,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60000,
    turns: options.turns,
    toolCalls: options.toolCalls,
    usage: options.usage,
    reviewAction: options.reviewAction,
    askCount: options.askCalls.length,
    capHits: options.questions.filter((row) => row.capHit === true).length,
    simulator: { kind: 'fixture' },
    gitDiffSha256: diff === null ? null : sha256Hex(diff),
  };
  if (typeof options.resolved === 'boolean') meta.resolved = options.resolved;

  if (!omitted.has('meta.json')) writeJson(path.join(taskDir, 'meta.json'), meta);
  if (!omitted.has('plan.md')) writeText(path.join(taskDir, 'plan.md'), `${options.plan}\n`);
  if (!omitted.has('plan-review.json')) {
    writeJson(path.join(taskDir, 'plan-review.json'), {
      requestId: `request-${instanceId}`,
      question: options.question,
      options: [
        { label: 'Approve', description: 'Approve the plan' },
        { label: 'Discuss', description: 'Keep editing' },
      ],
      detail: { plan: options.plan },
      action: options.reviewAction,
      answeredAt: '2026-01-01T00:00:30.000Z',
    });
  }
  if (!omitted.has('citations.json')) writeJson(path.join(taskDir, 'citations.json'), options.citations);
  if (!omitted.has('questions.ndjson')) writeJsonl(path.join(taskDir, 'questions.ndjson'), options.questions);
  if (!omitted.has('events.jsonl')) writeJsonl(path.join(taskDir, 'events.jsonl'), events);
  if (!omitted.has('wire.ndjson')) {
    writeJsonl(path.join(taskDir, 'wire.ndjson'), [
      {
        ts: '2026-01-01T00:00:00.000Z',
        dir: 'in',
        kind: 'request',
        method: 'user-question/ask',
        payload: {
          requestId: `request-${instanceId}`,
          question: options.question,
          options: [{ label: 'Approve' }],
          detail: { plan: options.plan },
        },
      },
    ]);
  }
  if (diff !== null && !omitted.has('diff.patch')) writeText(path.join(taskDir, 'diff.patch'), diff);
  return taskDir;
}

/** Write a whole run directory and return its path. */
export function writeRun(root, { runId = 'run-1', arm = 'full', runMode = 'plan', issueMode = 'hidden', tasks = [] } = {}) {
  const runDir = path.join(root, runId);
  const taskRoot = path.join(runDir, 'tasks');
  fs.mkdirSync(taskRoot, { recursive: true });
  writeJson(path.join(runDir, 'manifest.json'), {
    schemaVersion: 1,
    runId,
    arm,
    issueMode,
    runMode,
    model: { provider: 'fake', model: 'fake-model', reasoningEffort: null, maxTokens: null },
    workspace: { root: '/tmp/workspace', pluginHead: 'abc123', pluginDirty: false },
    env: { node: 'v24.0.0', dshCli: '/tmp/dsh', dshHome: '/tmp/home', appVersion: '0.6.0', platform: 'darwin', cpus: 8 },
    patches: [],
    sample: { tasksFile: 'tasks.jsonl', sha256: 'abc', ids: tasks.map((task) => task.instanceId), count: tasks.length },
    policy: { review: 'cancel', answersCap: 3, taskTimeoutMs: 1000, idleSettleMs: 10, approvals: false },
    simulator: { kind: 'fixture', model: null },
    seed: 42,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    counts: { total: tasks.length, ok: tasks.length, failed: 0, byStatus: { ok: tasks.length } },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: null,
  });
  for (const task of tasks) {
    if (typeof task?.instanceId !== 'string' || task.instanceId === '') {
      throw new Error('writeRun task requires an instanceId');
    }
    writeTask(taskRoot, task.instanceId, task);
  }
  return runDir;
}
