import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  runSdkSession,
  isPlanReviewQuestion,
  planReviewApproveLabel,
  classifyQuestionDecision,
} from '../interactive-swe/runner/sdk-driver.mjs';

/** A fake SDK child: EventEmitter streams plus a JSON-RPC console. */
function createFakeChild() {
  const child = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.destroyed = false;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const incoming = [];
  const outgoing = [];
  const api = {
    onMessage: null,
    send(message) {
      outgoing.push(message);
      stdout.emit('data', `${JSON.stringify(message)}\n`);
    },
    respond(id, result) {
      api.send({ jsonrpc: '2.0', id, result });
    },
    errorResponse(id, code, message) {
      api.send({ jsonrpc: '2.0', id, error: { code, message } });
    },
    notify(method, params) {
      api.send({ jsonrpc: '2.0', method, params });
    },
    request(id, method, params) {
      api.send({ jsonrpc: '2.0', id, method, params });
    },
    stderr(text) {
      stderr.emit('data', text);
    },
    exit(code = 0) {
      child.emit('close', code, null);
      child.emit('exit', code, null);
    },
  };
  stdin.write = (chunk, callback) => {
    const line = String(chunk).trim();
    if (line !== '') {
      const message = JSON.parse(line);
      incoming.push(message);
      api.onMessage?.(message);
    }
    if (typeof callback === 'function') callback();
    return true;
  };
  stdin.end = () => {
    stdin.destroyed = true;
    child.stdinEnded = true;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = undefined;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.emit('close', null, signal);
    return true;
  };
  return { child, api, incoming, outgoing };
}

const REVIEW_QUESTION = {
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: '# Plan\n\n1. Do the thing.',
  options: [
    { label: 'Approve', description: 'Leave plan mode.' },
    { label: 'Keep planning', description: 'Stay in plan mode.' },
  ],
  intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-1' },
};

function baseOptions(fake, overrides = {}) {
  return {
    command: '/fake/dsh',
    args: ['--profile', 'eval'],
    cwd: '/fake/worktree',
    env: { DSH_HOME: '/fake/home' },
    model: { provider: 'deepseek-official', model: 'deepseek-chat' },
    sessionId: 'session-1',
    inputText: '/plan fix the bug',
    questionPolicy: async () => ({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }),
    timeoutMs: 2000,
    idleSettleMs: 40,
    spawnImpl: () => fake.child,
    ...overrides,
  };
}

function answerReviewScenario(fake, { reviewAnswer = { answers: [{ id: 'plan-review', selected: ['Approve'] }] }, onReview } = {}) {
  let captured = null;
  fake.api.onMessage = (message) => {
    if (message.method === 'initialize') {
      fake.api.respond(message.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
      return;
    }
    if (message.method === 'session/query') {
      fake.api.respond(message.id, {
        kind: 'command',
        execution: { commandId: 'cmd-1', result: { kind: 'success', text: 'Plan mode is active.' } },
      });
      fake.api.notify('session.status', { sessionId: 'session-1', status: 'running' });
      fake.api.request(7, 'user-question/ask', { requestId: 'request-1', sessionId: 'session-1', questions: [REVIEW_QUESTION] });
      return;
    }
    if (message.id === 7 && ('result' in message || 'error' in message)) {
      captured = message;
      onReview?.(message);
      fake.api.notify('session.event', {
        sessionId: 'session-1',
        event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } },
      });
      fake.api.notify('session.status', { sessionId: 'session-1', status: 'idle' });
      fake.api.notify('session.query.completed', {
        sessionId: 'session-1',
        commandId: 'cmd-1',
        finishReason: 'completed',
        finalResponse: 'done',
      });
      return;
    }
    if (message.method === 'shutdown') {
      fake.api.respond(message.id, {});
      fake.api.exit(0);
    }
  };
  return { capturedAnswer: () => captured, reviewAnswer };
}

test('driver initializes, queries once, approves the review, and shuts down', async () => {
  const fake = createFakeChild();
  const { capturedAnswer } = answerReviewScenario(fake);
  const frames = [];
  const result = await runSdkSession(
    baseOptions(fake, {
      model: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high', maxTokens: 4096 },
      onFrame: (frame) => frames.push(frame),
    }),
  );

  const initialize = fake.incoming.find((message) => message.method === 'initialize');
  assert.deepEqual(initialize.params, {
    cwd: '/fake/worktree',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    capabilities: { userQuestions: true },
    approvalRequests: false,
    reasoningEffort: 'high',
    maxTokens: 4096,
  });
  const query = fake.incoming.find((message) => message.method === 'session/query');
  assert.deepEqual(query.params, {
    sessionId: 'session-1',
    contentBlocks: [{ type: 'text', text: '/plan fix the bug' }],
  });
  assert.equal(fake.incoming.some((message) => message.method === 'shutdown'), true);
  assert.equal(fake.child.stdinEnded, true);

  assert.deepEqual(capturedAnswer(), { jsonrpc: '2.0', id: 7, result: { answers: [{ id: 'plan-review', selected: ['Approve'] }] } });
  assert.equal(result.response.kind, 'command');
  assert.equal(result.completion.commandId, 'cmd-1');
  assert.equal(result.completion.finishReason, 'completed');
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].decision, 'approve');
  assert.deepEqual(result.questions[0].answers, [{ id: 'plan-review', selected: ['Approve'] }]);
  assert.equal(result.frames.length, frames.length);
  assert.equal(result.frames[0].dir, 'out');
  assert.equal(result.frames[0].kind, 'request');
  assert.equal(result.frames.some((frame) => frame.dir === 'in' && frame.kind === 'request' && frame.method === 'user-question/ask'), true);
  assert.equal(result.frames.some((frame) => frame.dir === 'out' && frame.kind === 'response'), true);
  assert.equal(fake.child.killCalls.length, 0);
});

test('driver records a cancelled review and sends {cancelled:true}', async () => {
  const fake = createFakeChild();
  const { capturedAnswer } = answerReviewScenario(fake);
  const result = await runSdkSession(
    baseOptions(fake, { questionPolicy: async () => ({ cancelled: true }) }),
  );
  assert.deepEqual(capturedAnswer().result, { cancelled: true });
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].decision, 'cancel');
  assert.deepEqual(result.questions[0].answers, []);
  assert.equal(result.completion.finishReason, 'completed');
});

test('driver preserves the review decision classification and cap metadata', async () => {
  const fake = createFakeChild();
  answerReviewScenario(fake);
  const result = await runSdkSession(
    baseOptions(fake, {
      questionPolicy: async () => ({ cancelled: true, capHit: true, decision: 'cancel' }),
    }),
  );
  assert.deepEqual(fake.incoming.length > 0, true);
  assert.equal(result.questions[0].capHit, true);
  assert.equal(result.questions[0].decision, 'cancel');
  assert.deepEqual(
    fake.incoming.find((message) => message.id === 7 && 'result' in message),
    { jsonrpc: '2.0', id: 7, result: { cancelled: true } },
  );
});

test('driver tolerates malformed stdout lines and keeps processing frames', async () => {
  const fake = createFakeChild();
  answerReviewScenario(fake);
  let emittedMalformed = false;
  const result = await runSdkSession(
    baseOptions(fake, {
      onFrame: () => {
        if (!emittedMalformed) {
          emittedMalformed = true;
          fake.child.stdout.emit('data', 'this is not json\n');
        }
      },
    }),
  );
  assert.equal(result.errors.some((error) => error.kind === 'malformed'), true);
  assert.equal(result.completion.finishReason, 'completed');
  assert.equal(result.timedOut, false);
});

test('driver timeout closes stdin and kills the child', async () => {
  const fake = createFakeChild();
  fake.api.onMessage = () => {
    // Never respond: the overall timeout must end the session.
  };
  const result = await runSdkSession(baseOptions(fake, { timeoutMs: 50, idleSettleMs: 10 }));
  assert.equal(result.timedOut, true);
  assert.equal(result.errors.some((error) => error.kind === 'timeout'), true);
  assert.equal(fake.child.stdinEnded, true);
  assert.equal(fake.child.killCalls.length > 0, true);
  assert.equal(result.response, null);
});

test('driver reports an initialize JSON-RPC error and never queries', async () => {
  const fake = createFakeChild();
  fake.api.onMessage = (message) => {
    if (message.method === 'initialize') {
      fake.api.errorResponse(message.id, -32603, 'no adapter registered for provider "nope"');
      return;
    }
    if (message.method === 'shutdown') {
      fake.api.respond(message.id, {});
      fake.api.exit(0);
    }
  };
  const result = await runSdkSession(
    baseOptions(fake, { model: { provider: 'nope', model: 'missing' } }),
  );
  assert.equal(result.errors.some((error) => error.kind === 'rpc' && error.method === 'initialize'), true);
  assert.equal(fake.incoming.some((message) => message.method === 'session/query'), false);
  assert.equal(result.completion, null);
});

test('driver rejects approval requests with the cancelled-or-rejected wire answer', async () => {
  const fake = createFakeChild();
  let approvalResult = null;
  fake.api.onMessage = (message) => {
    if (message.method === 'initialize') {
      fake.api.respond(message.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
      return;
    }
    if (message.method === 'session/query') {
      fake.api.respond(message.id, { kind: 'prompt', messageId: 'm1' });
      fake.api.request(9, 'approval/request', { sessionId: 'session-1', toolName: 'bash' });
      return;
    }
    if (message.id === 9 && 'result' in message) {
      approvalResult = message.result;
      fake.api.notify('session.status', { sessionId: 'session-1', status: 'idle' });
      fake.api.notify('session.query.completed', {
        sessionId: 'session-1',
        commandId: 'cmd-1',
        finishReason: 'completed',
        finalResponse: '',
      });
      return;
    }
    if (message.method === 'shutdown') {
      fake.api.respond(message.id, {});
      fake.api.exit(0);
    }
  };
  const result = await runSdkSession(baseOptions(fake));
  assert.deepEqual(approvalResult, { outcome: 'rejected' });
  assert.equal(result.completion.finishReason, 'completed');
});

test('driver settles on idle after a prompt receipt without a completion notification', async () => {
  const fake = createFakeChild();
  fake.api.onMessage = (message) => {
    if (message.method === 'initialize') {
      fake.api.respond(message.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
      return;
    }
    if (message.method === 'session/query') {
      fake.api.respond(message.id, { kind: 'prompt', messageId: 'm1' });
      fake.api.notify('session.status', { sessionId: 'session-1', status: 'running' });
      fake.api.notify('session.event', {
        sessionId: 'session-1',
        event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } },
      });
      fake.api.notify('session.status', { sessionId: 'session-1', status: 'idle' });
      return;
    }
    if (message.method === 'shutdown') {
      fake.api.respond(message.id, {});
      fake.api.exit(0);
    }
  };
  const result = await runSdkSession(baseOptions(fake, { idleSettleMs: 30 }));
  assert.equal(result.response.kind, 'prompt');
  assert.equal(result.completion, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.warnings.some((warning) => warning.includes('session.query.completed')), true);
});

test('driver records policy failures as a rejected question with an error response', async () => {
  const fake = createFakeChild();
  let rejected = null;
  fake.api.onMessage = (message) => {
    if (message.method === 'initialize') {
      fake.api.respond(message.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
      return;
    }
    if (message.method === 'session/query') {
      fake.api.respond(message.id, {
        kind: 'command',
        execution: { commandId: 'cmd-1', result: { kind: 'success', text: 'ok' } },
      });
      fake.api.notify('session.status', { sessionId: 'session-1', status: 'running' });
      fake.api.request(7, 'user-question/ask', { requestId: 'request-1', sessionId: 'session-1', questions: [REVIEW_QUESTION] });
      return;
    }
    if (message.id === 7 && 'error' in message) {
      rejected = message.error;
      fake.api.notify('session.query.completed', {
        sessionId: 'session-1',
        commandId: 'cmd-1',
        finishReason: 'error',
        finalResponse: '',
      });
      return;
    }
    if (message.method === 'shutdown') {
      fake.api.respond(message.id, {});
      fake.api.exit(0);
    }
  };
  const result = await runSdkSession(
    baseOptions(fake, {
      questionPolicy: async () => {
        throw new Error('simulator endpoint is down');
      },
    }),
  );
  assert.equal(rejected.code, -32603);
  assert.match(rejected.message, /simulator endpoint is down/);
  assert.equal(result.questions[0].decision, 'reject');
  assert.match(result.questions[0].error, /simulator endpoint is down/);
  assert.equal(result.errors.some((error) => error.kind === 'question-policy'), true);
});

test('driver rejects a policy answer that misses a question id', async () => {
  const fake = createFakeChild();
  let rejected = null;
  fake.api.onMessage = (message) => {
    if (message.method === 'initialize') {
      fake.api.respond(message.id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
      return;
    }
    if (message.method === 'session/query') {
      fake.api.respond(message.id, { kind: 'command', execution: { commandId: 'cmd-1' } });
      fake.api.request(7, 'user-question/ask', { requestId: 'request-1', sessionId: 'session-1', questions: [REVIEW_QUESTION] });
      return;
    }
    if (message.id === 7 && 'error' in message) {
      rejected = message.error;
      fake.api.notify('session.query.completed', {
        sessionId: 'session-1',
        commandId: 'cmd-1',
        finishReason: 'completed',
        finalResponse: '',
      });
      return;
    }
    if (message.method === 'shutdown') {
      fake.api.respond(message.id, {});
      fake.api.exit(0);
    }
  };
  const result = await runSdkSession(
    baseOptions(fake, { questionPolicy: async () => ({ answers: [{ id: 'other', selected: ['x'] }] }) }),
  );
  assert.match(rejected.message, /unknown question id/);
  assert.equal(result.questions[0].decision, 'reject');
});

test('driver refuses a blank input before spawning', async () => {
  let spawned = 0;
  const result = await runSdkSession(
    baseOptions(createFakeChild(), {
      inputText: '   ',
      spawnImpl: () => {
        spawned += 1;
        return null;
      },
    }),
  );
  assert.equal(spawned, 0);
  assert.equal(result.errors[0].kind, 'input');
});

test('driver reports spawn failures instead of throwing', async () => {
  const result = await runSdkSession(
    baseOptions(createFakeChild(), {
      spawnImpl: () => {
        throw new Error('spawn ENOENT');
      },
    }),
  );
  assert.equal(result.errors.some((error) => error.kind === 'spawn'), true);
  assert.equal(result.exitCode, null);
  assert.equal(result.response, null);
});

test('plan-review detection helpers match the native review intent', () => {
  const byId = { id: 'plan-review' };
  const byIntent = { id: 'other', intent: { kind: 'plan-review' } };
  assert.equal(isPlanReviewQuestion(byId), true);
  assert.equal(isPlanReviewQuestion(byIntent), true);
  assert.equal(isPlanReviewQuestion({ id: 'ask' }), false);
  assert.equal(isPlanReviewQuestion(null), false);

  assert.equal(planReviewApproveLabel(REVIEW_QUESTION), 'Approve');
  assert.equal(planReviewApproveLabel({ intent: { approve: 'Ship it' } }), 'Ship it');
  assert.equal(planReviewApproveLabel({ intent: { approve: { label: 'Go' } } }), 'Go');
  assert.equal(planReviewApproveLabel({}), 'Approve');

  assert.equal(classifyQuestionDecision([REVIEW_QUESTION], { answers: [{ id: 'plan-review', selected: ['Approve'] }] }), 'approve');
  assert.equal(classifyQuestionDecision([REVIEW_QUESTION], { answers: [{ id: 'plan-review', selected: ['Keep planning'] }] }), 'reject');
  assert.equal(classifyQuestionDecision([REVIEW_QUESTION], { cancelled: true }), 'cancel');
  assert.equal(classifyQuestionDecision([{ id: 'ask' }], { answers: [{ id: 'ask', selected: ['Yes'] }] }), 'answer');
});
