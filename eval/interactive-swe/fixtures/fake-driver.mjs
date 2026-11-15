/**
 * Deterministic synthetic driver used by offline selftests and runner tests.
 *
 * The fake emits the same NDJSON JSON-RPC frame shapes a real SDK child would:
 * initialize, one `session/query`, a planning trace (read/grep tool calls, a
 * spawned teammate, an optional clarification question), a plan review, then a
 * completion and shutdown. No process, network, model, or git command runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../util/time.mjs';
import { classifyQuestionDecision, isPlanReviewQuestion, planReviewApproveLabel } from '../runner/sdk-driver.mjs';

/** Relative paths the fake plan may cite; the first existing one wins. */
export const FAKE_PATH_CANDIDATES = [
  'README.md',
  'package.json',
  'src/index.js',
  'lib/index.js',
  'eval/interactive-swe/CONTRACTS.md',
];

/** Exact plan-evidence marker strings checked by scoring's arm integrity. */
export const FAKE_ARM_MARKERS = {
  budget: 'Token budget: unlimited.',
  brainstorming: 'Discovery and delegation:',
  teamLead: 'You are the Team Lead.',
  handoff: 'Plan as handoff',
};

/**
 * Synthetic `system/message` text for one arm.
 *
 * Dry-run scoring observes the real host prompt only in a live run, so the
 * fake driver emits an arm-shaped system prompt: `native` has no plugin
 * markers, `evidence` keeps the budget reminder and handoff guidance, and
 * `full` carries all four markers. This exercises the real arm-integrity check
 * offline.
 *
 * @param {'native'|'evidence'|'full'} arm run arm
 * @returns {string} deterministic system prompt text
 */
export function fakeSystemPromptText(arm = 'native') {
  const parts = [
    'You are an interactive coding agent. Plan mode is active: explore the repository and present a complete plan through exit_plan_mode.',
  ];
  if (arm === 'evidence' || arm === 'full') {
    parts.push(`${FAKE_ARM_MARKERS.budget} Never cut investigation, tool calls, or needed questions to save tokens; keep the final plan concise.`);
  }
  if (arm === 'full') {
    parts.push(
      `${FAKE_ARM_MARKERS.brainstorming} use spawn_teammate for parallel exploration and a separate planning teammate. ${FAKE_ARM_MARKERS.teamLead} Summarize the recommendation, relevant tradeoffs, and assumptions.`,
    );
  }
  if (arm === 'evidence' || arm === 'full') {
    parts.push(`${FAKE_ARM_MARKERS.handoff}: include background, an evidence chain, assumptions, and an execution handoff.`);
  }
  return parts.join('\n\n');
}

function firstOptionLabel(question) {
  if (!Array.isArray(question?.options) || question.options.length === 0) return '';
  const first = question.options[0];
  const label = typeof first === 'string' ? first : first?.label;
  return typeof label === 'string' ? label : '';
}

/** Pick a citation that exists in the worktree, or `README.md` as a default. */
export function pickFakePathRef(cwd) {
  for (const candidate of FAKE_PATH_CANDIDATES) {
    try {
      if (fs.statSync(path.join(cwd, candidate)).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return 'README.md';
}

/** Build the deterministic plan the fake presents for review. */
export function fakePlanText(cwd) {
  const ref = pickFakePathRef(cwd);
  return [
    '# Plan: fix the reported behavior',
    '',
    '## Background',
    'The issue reports a behavior that the current implementation does not preserve.',
    '',
    '## Evidence',
    `- \`${ref}:1\`: the entry point relevant to the reported behavior.`,
    '- The issue text is the only requirement source; unverified details are marked as assumptions.',
    '',
    '## Steps',
    '1. Reproduce the reported behavior at the cited entry point.',
    '2. Implement the minimal fix and cover it with a regression test.',
    '',
    '## Handoff',
    'Execute the steps in order and verify the regression test passes.',
  ].join('\n');
}

/** The plan-review question, matching the native `exit_plan_mode` review. */
export function fakeReviewQuestion(cwd) {
  const plan = fakePlanText(cwd);
  return {
    id: 'plan-review',
    header: 'Plan review',
    question: 'Approve this plan and leave plan mode?',
    detail: plan,
    options: [
      { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
      { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan-review' },
  };
}

/** Strip policy metadata and keep only the JSON-RPC wire answer. */
function wireOf(policyResult) {
  if (policyResult === null || typeof policyResult !== 'object') throw new Error('question policy returned no answer');
  if (policyResult.cancelled === true) return { cancelled: true };
  if (!Array.isArray(policyResult.answers)) throw new Error('question policy must resolve answers or cancelled');
  return {
    answers: policyResult.answers.map((answer) => ({
      id: String(answer.id),
      selected: Array.isArray(answer.selected) ? answer.selected : [],
      ...(typeof answer.custom === 'string' ? { custom: answer.custom } : {}),
    })),
  };
}

/**
 * Create a deterministic fake driver.
 *
 * @param {{tasks?: object[], answers?: Record<string, unknown>}} [options]
 * @returns {(options: object) => Promise<object>} a `runSdkSession`-compatible driver
 */
export function createFakeDriver({ tasks = [], answers = {} } = {}) {
  return async function fakeDriver(input = {}) {
    const startedAt = nowIso();
    const sessionId = input.sessionId ?? 'fake-session';
    const cwd = input.cwd ?? process.cwd();
    const issueText = String(input.inputText ?? '/plan fix the issue');
    const arm = input.arm ?? 'native';
    const issueMode = input.issueMode ?? 'hidden';
    const runMode = input.runMode ?? 'plan';
    const askCount = Number.isInteger(input.fakeAskCount)
      ? input.fakeAskCount
      : issueMode === 'hidden' && input.askUserQuestion !== false
        ? 1
        : 0;
    const planText = fakePlanText(cwd);
    const reviewQuestion = fakeReviewQuestion(cwd);
    const frames = [];
    const questions = [];
    const errors = [];
    let seq = 0;
    const commandId = 'fake-command-1';

    function emit(dir, kind, fields) {
      const row = { ts: nowIso(), dir, kind, ...fields };
      frames.push(row);
      try {
        input.onFrame?.(row);
      } catch (error) {
        errors.push({ kind: 'on-frame', message: error instanceof Error ? error.message : String(error) });
      }
    }

    function event(type, data) {
      seq += 1;
      emit('in', 'notification', { method: 'session.event', payload: { sessionId, event: { type, seq, data } } });
    }

    function toolResult(callId, name, text) {
      event('tool/result', {
        turn: 1,
        step: 1,
        callId,
        name,
        message: { content: [{ type: 'text', text }] },
      });
    }

    async function ask(requestId, asked, callId) {
      emit('in', 'request', {
        id: requestId,
        method: 'user-question/ask',
        payload: { requestId, sessionId, questions: asked },
      });
      let wire = null;
      let errorText = null;
      let capHit = false;
      let decision = 'answer';
      try {
        const policyResult = await input.questionPolicy?.({ requestId, sessionId, questions: asked });
        wire = wireOf(policyResult);
        capHit = policyResult?.capHit === true;
        decision = classifyQuestionDecision(asked, wire);
        emit('out', 'response', { id: requestId, payload: { result: wire } });
      } catch (error) {
        errorText = error instanceof Error ? error.message : String(error);
        errors.push({ kind: 'question-policy', requestId, message: errorText });
        decision = 'reject';
        emit('out', 'response', { id: requestId, payload: { error: { code: -32603, message: errorText } } });
      }
      questions.push({
        ts: nowIso(),
        requestId,
        questions: asked,
        decision,
        answers: wire?.cancelled === true || wire === null ? [] : wire.answers,
        capHit,
        ...(errorText === null ? {} : { error: errorText }),
      });
      if (callId !== undefined) toolResult(callId, 'ask_user_question', 'The user answered the clarification question.');
      return wire;
    }

    // Handshake and query.
    emit('out', 'request', {
      id: 'fake-init-1',
      method: 'initialize',
      payload: {
        cwd,
        provider: input.model?.provider,
        model: input.model?.model,
        capabilities: { userQuestions: true },
        approvalRequests: false,
      },
    });
    emit('in', 'response', { id: 'fake-init-1', payload: { result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } } });
    emit('out', 'request', {
      id: 'fake-query-1',
      method: 'session/query',
      payload: { sessionId, contentBlocks: [{ type: 'text', text: issueText }] },
    });
    emit('in', 'response', {
      id: 'fake-query-1',
      payload: { result: { kind: 'command', execution: { commandId, result: { kind: 'success', text: 'Plan mode is active.' } } } },
    });

    // Planning trace.
    event('request/header', {
      header: {
        config: { provider: input.model?.provider ?? null, model: input.model?.model ?? null },
        tools: ['read', 'grep', 'ask_user_question', 'spawn_teammate', 'exit_plan_mode', 'edit']
          .filter((name) => !(Array.isArray(input.omitTools) && input.omitTools.includes(name)))
          .map((name) => ({ name })),
      },
    });
    event('system/message', {
      turn: 1,
      step: 0,
      message: { content: [{ type: 'text', text: fakeSystemPromptText(arm) }] },
    });
    event('user/message', { turn: 1, step: 1, content: [{ type: 'text', text: issueText }], source: { kind: 'user' } });
    event('plan/mode', { active: true, pending: false });
    event('assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'I will inspect the repository before proposing a plan.' }] },
      usage: { inputTokens: 120, outputTokens: 24 },
    });
    const ref = pickFakePathRef(cwd);
    event('tool/call', { turn: 1, step: 1, callId: 'call-read', name: 'read', arguments: JSON.stringify({ path: ref }) });
    toolResult('call-read', 'read', 'file contents');
    event('tool/call', { turn: 1, step: 1, callId: 'call-grep', name: 'grep', arguments: JSON.stringify({ pattern: 'plan', path: '.' }) });
    toolResult('call-grep', 'grep', 'one match');
    event('tool/call', {
      turn: 1,
      step: 2,
      callId: 'call-spawn',
      name: 'spawn_teammate',
      arguments: JSON.stringify({ name: 'explorer-one', task: 'inspect the cited file' }),
    });
    event('team/member', { name: 'explorer-one', role: 'explorer' });
    toolResult('call-spawn', 'spawn_teammate', 'explorer-one finished its scope.');
    event('assistant/message', {
      turn: 1,
      step: 2,
      message: { content: [{ type: 'text', text: 'The evidence is consistent; the plan follows.' }] },
      usage: { inputTokens: 80, outputTokens: 16 },
    });

    // Optional clarification questions (hidden issue mode).
    for (let index = 0; index < askCount; index += 1) {
      const callId = `call-ask-${index + 1}`;
      const question = {
        id: `fake-question-${index + 1}`,
        header: 'Clarification',
        question: 'What behavior should the fix preserve?',
        options: [{ label: 'Keep the current behavior' }, { label: 'Change the behavior' }],
      };
      event('tool/call', { turn: 1, step: 2, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [question] }) });
      await ask(`fake-ask-${index + 1}`, [question], callId);
    }

    // Plan submission and review.
    event('tool/call', {
      turn: 1,
      step: 3,
      callId: 'call-plan-review',
      name: 'exit_plan_mode',
      arguments: JSON.stringify({ plan: planText }),
    });
    const reviewWire = await ask('fake-review-1', [reviewQuestion], undefined);
    const approved = reviewWire !== null && !reviewWire.cancelled && reviewWire.answers?.some((answer) =>
      Array.isArray(answer.selected) && answer.selected.includes(planReviewApproveLabel(reviewQuestion)));
    event('tool/result', {
      turn: 1,
      step: 3,
      callId: 'call-plan-review',
      name: 'exit_plan_mode',
      message: { content: [{ type: 'text', text: approved ? 'Plan approved.' : 'The user dismissed the plan review.' }] },
    });
    if (approved) {
      event('plan/mode', { active: false, pending: false });
      if (runMode === 'execute') {
        event('tool/call', { turn: 1, step: 4, callId: 'call-edit', name: 'edit', arguments: JSON.stringify({ path: ref }) });
        toolResult('call-edit', 'edit', 'edit applied');
        event('assistant/message', {
          turn: 1,
          step: 4,
          message: { content: [{ type: 'text', text: 'Implemented the plan and verified the change.' }] },
          usage: { inputTokens: 60, outputTokens: 18 },
        });
      }
    }
    event('turn/end', { reason: { kind: 'completed' } });
    emit('in', 'notification', { method: 'session.status', payload: { sessionId, status: 'idle' } });
    const completion = {
      sessionId,
      commandId,
      finishReason: 'completed',
      finalResponse: approved ? 'Implemented the plan.' : 'Plan mode remains active.',
    };
    emit('in', 'notification', { method: 'session.query.completed', payload: completion });
    emit('out', 'request', { id: 'fake-shutdown-1', method: 'shutdown', payload: {} });
    emit('in', 'response', { id: 'fake-shutdown-1', payload: { result: {} } });

    return {
      frames,
      questions,
      response: { kind: 'command', execution: { commandId, result: { kind: 'success', text: 'Plan mode is active.' } } },
      completion,
      exitCode: 0,
      stderrTail: '',
      startedAt,
      endedAt: nowIso(),
      timedOut: false,
      errors,
      warnings: [],
    };
  };
}

/**
 * Deterministic first-option simulator used for offline dry runs.
 *
 * @param {{cap?: number}} [options]
 * @returns {{kind: string, cap: number, model: null, answer: Function, reset: Function, usage: Function}}
 */
export function createFakeSimulator({ cap = 3 } = {}) {
  let answered = 0;
  let capHits = 0;
  const totals = { inputTokens: 0, outputTokens: 0 };
  return {
    kind: 'fixture',
    cap,
    model: null,
    async answer({ questions = [] } = {}) {
      if (answered >= cap) {
        capHits += 1;
        return { answers: [], usage: { inputTokens: 0, outputTokens: 0 }, capHit: true };
      }
      answered += 1;
      const answers = questions.map((question) => {
        const label = firstOptionLabel(question);
        if (label === '') return { id: String(question.id), selected: [], custom: 'unknown' };
        return { id: String(question.id), selected: [label] };
      });
      totals.inputTokens += 12;
      totals.outputTokens += 6;
      return { answers, usage: { inputTokens: 12, outputTokens: 6 }, capHit: false };
    },
    reset() {
      answered = 0;
      capHits = 0;
      totals.inputTokens = 0;
      totals.outputTokens = 0;
    },
    usage() {
      return { ...totals, answered, capHits };
    },
  };
}

/** Re-exported for tests that build questions without importing the driver. */
export { isPlanReviewQuestion };
