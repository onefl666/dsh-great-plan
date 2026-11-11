import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCompactCommand,
  EXIT_PLAN_MODE_TOOL,
  FAILURES,
  MESSAGES,
  resolveCompactionService,
  USAGE,
} from '../../lib/host/plan-compaction.js';
import {
  EXIT_PLAN_MODE_TOOL as RANGE_EXIT_PLAN_MODE_TOOL,
  selectPlanCompactionRange,
} from '../../lib/host/plan-range.js';

function sessionWith(events) {
  const nodes = [...events.keys()];
  return {
    surface: { nodes },
    eventAt: (seq) => events.get(seq),
  };
}

function assistantWithToolCall() {
  return {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', name: 'exit_plan_mode' }] } },
  };
}

test('selects the last balanced completed surface before the pending plan message', () => {
  const events = new Map([
    [10, { type: 'system/message' }],
    [20, { type: 'user/message' }],
    [30, assistantWithToolCall()],
    [40, { type: 'tool/result' }],
    [50, assistantWithToolCall()],
  ]);
  const session = sessionWith(events);
  const range = selectPlanCompactionRange(session, (_session, seq) => seq === 40);
  assert.deepEqual(range, { start: 20, end: 40 });
});

test('reports empty when only the pending plan message follows a system head', () => {
  const events = new Map([
    [10, { type: 'system/message' }],
    [20, assistantWithToolCall()],
  ]);
  const session = sessionWith(events);
  assert.deepEqual(selectPlanCompactionRange(session, () => false), { error: 'empty' });
});

test('reports no-review unless the last surface node has a pending tool call', () => {
  const session = sessionWith(new Map([[10, { type: 'user/message' }]]));
  assert.deepEqual(selectPlanCompactionRange(session, () => true), { error: 'no-review' });
});

function commandDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      getProjections: () => ({ snapshot: () => ({ values: { plan: { active: true } } }) }),
      getCompaction: () => ({
        compactRegion: async (start, end) => {
          calls.push([start, end]);
          return { shadowedSeqs: [20, 30], shadowedTokenCount: 123 };
        },
      }),
      getBalancedAfter: async () => (_session, seq) => seq === 40,
      ...overrides,
    },
  };
}

function invocation(events) {
  return {
    rawInput: '',
    agent: { session: sessionWith(events) },
    signal: new AbortController().signal,
  };
}

const standardEvents = new Map([
  [10, { type: 'system/message' }],
  [20, { type: 'user/message' }],
  [30, assistantWithToolCall()],
  [40, { type: 'tool/result' }],
  [50, assistantWithToolCall()],
]);

test('compact command compacts the selected range and reports the result', async () => {
  const { deps, calls } = commandDeps();
  const command = createCompactCommand(deps);
  const result = await command.handler(invocation(standardEvents));
  assert.equal(result.kind, 'success');
  assert.deepEqual(calls, [[20, 40]]);
  assert.match(result.text, /2 history items/);
  assert.match(result.text, /123 tokens/);
});

test('compact command prefers the preset-scoped compaction service and forwards agent and signal', async () => {
  const compactCalls = [];
  const serviceForCalls = [];
  const agent = { session: sessionWith(standardEvents) };
  const signal = new AbortController().signal;
  const scopedService = {
    async compactRegion(start, end, receivedAgent, receivedSignal) {
      compactCalls.push([start, end, receivedAgent, receivedSignal]);
      return { shadowedSeqs: [20, 30], shadowedTokenCount: 123 };
    },
  };
  const { deps } = commandDeps({
    getAgentPresets: () => ({
      serviceFor(receivedAgent, serviceName) {
        serviceForCalls.push([receivedAgent, serviceName]);
        return scopedService;
      },
    }),
    getCompaction: () => {
      throw new Error('the host-plane compaction service must not be read');
    },
  });

  const result = await createCompactCommand(deps).handler({ ...invocation(standardEvents), agent, signal });

  assert.equal(result.kind, 'success');
  assert.deepEqual(serviceForCalls, [[agent, 'compaction']]);
  assert.equal(compactCalls.length, 1);
  const [start, end, receivedAgent, receivedSignal] = compactCalls[0];
  assert.equal(start, 20);
  assert.equal(end, 40);
  assert.equal(receivedAgent, agent);
  assert.equal(receivedSignal, signal);
});

const hostService = { compactRegion() {} };
const ctxService = { compactRegion() {} };
const presetService = { compactRegion() {} };

test('resolveCompactionService prefers the preset, then the agent context, then the host fallback', () => {
  const agent = { ctx: { get: () => ctxService } };
  assert.equal(resolveCompactionService(agent, {
    getAgentPresets: () => ({ serviceFor: () => presetService }),
    getCompaction: () => hostService,
  }), presetService);
  assert.equal(resolveCompactionService(agent, {
    getAgentPresets: () => ({ serviceFor: () => undefined }),
    getCompaction: () => hostService,
  }), ctxService);
  assert.equal(resolveCompactionService(agent, {
    getAgentPresets: () => undefined,
    getCompaction: () => hostService,
  }), ctxService);
  assert.equal(resolveCompactionService({}, { getCompaction: () => hostService }), hostService);
  assert.equal(resolveCompactionService({}, {}), undefined);
});

test('invalid or throwing scoped compaction reads fall through to the host fallback', () => {
  for (const accessors of [
    { getAgentPresets: () => { throw new Error('registry unavailable'); } },
    { getAgentPresets: () => ({ serviceFor: () => { throw new Error('serviceFor unavailable'); } }) },
    { getAgentPresets: () => ({ serviceFor: () => ({}) }) },
    { getAgentPresets: () => 'not-a-registry' },
  ]) {
    assert.equal(
      resolveCompactionService({}, { ...accessors, getCompaction: () => hostService }),
      hostService,
    );
  }
  for (const agent of [
    { ctx: { get: () => ({}) } },
    { ctx: { get: () => { throw new Error('scoped context unavailable'); } } },
  ]) {
    assert.equal(resolveCompactionService(agent, { getCompaction: () => hostService }), hostService);
  }
});

test('resolveCompactionService forwards the agent to every source', () => {
  const agent = {};
  const calls = [];
  const resolved = resolveCompactionService(agent, {
    getAgentPresets: () => ({
      serviceFor(receivedAgent, serviceName) {
        calls.push(['preset', receivedAgent, serviceName]);
        return undefined;
      },
    }),
    getCompaction: (receivedAgent) => {
      calls.push(['host', receivedAgent]);
      return hostService;
    },
  });
  assert.equal(resolved, hostService);
  assert.deepEqual(calls, [['preset', agent, 'compaction'], ['host', agent]]);
});

test('an undefined agent skips the scoped sources and forwards to the host fallback', () => {
  const calls = [];
  const resolved = resolveCompactionService(undefined, {
    getAgentPresets: () => {
      calls.push('presets');
      return { serviceFor: () => presetService };
    },
    getCompaction: (receivedAgent) => {
      calls.push(['host', receivedAgent]);
      return hostService;
    },
  });
  assert.equal(resolved, hostService);
  assert.deepEqual(calls, [['host', undefined]]);
});

test('a throwing host compaction read keeps its detail in the error text', async () => {
  const { deps } = commandDeps({
    getCompaction: () => {
      throw new Error('host read exploded');
    },
  });
  const result = await createCompactCommand(deps).handler(invocation(standardEvents));
  assert.deepEqual(result, { kind: 'error', text: 'Compaction is unavailable: host read exploded' });
});

test('compact command refuses when plan mode is inactive', async () => {
  const { deps } = commandDeps({
    getProjections: () => ({ snapshot: () => ({ values: { plan: { active: false } } }) }),
  });
  const result = await createCompactCommand(deps).handler(invocation(standardEvents));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /not active/);
});

test('compact command reports a missing compaction backend', async () => {
  const { deps } = commandDeps({ getCompaction: () => undefined });
  const result = await createCompactCommand(deps).handler(invocation(standardEvents));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /no compaction backend/);
});

test('compact command reports a missing pending review', async () => {
  const { deps } = commandDeps();
  const events = new Map([[10, { type: 'user/message' }], [20, { type: 'user/message' }]]);
  const result = await createCompactCommand(deps).handler(invocation(events));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /no pending plan review/);
});

test('compact command maps a busy compaction failure', async () => {
  const { deps } = commandDeps({
    getCompaction: () => ({
      compactRegion: async () => {
        const error = new Error('busy');
        error.code = 'busy';
        throw error;
      },
    }),
  });
  const result = await createCompactCommand(deps).handler(invocation(standardEvents));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /another compaction/);
});

test('compact command rejects arguments', async () => {
  const { deps } = commandDeps();
  const result = await createCompactCommand(deps).handler({ ...invocation(standardEvents), rawInput: 'now' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Usage/);
  assert.deepEqual(result, { kind: 'error', text: USAGE });
});

test('exports the frozen plan-review tool and user-visible static messages', () => {
  assert.equal(EXIT_PLAN_MODE_TOOL, 'exit_plan_mode');
  assert.equal(USAGE, 'Usage: /great-plan-compact (no arguments)');
  assert.deepEqual(FAILURES, {
    busy: 'Compaction is unavailable because another compaction is running.',
    changed: 'The history selected for compaction changed during the attempt.',
    summary: 'Compaction could not produce a useful summary.',
    commit: 'Compaction did not finish cleanly.',
    persistence: 'Compaction finished, but the session could not be saved.',
    cancelled: 'Compaction was cancelled.',
  });
  assert.deepEqual(MESSAGES, {
    planStateUnavailable: 'Plan state is unavailable in this composition.',
    planInactive: 'Plan mode is not active; nothing to compact.',
    backendUnavailable: 'Compaction is unavailable because no compaction backend is composed.',
    noReview: 'There is no pending plan review to compact.',
    empty: 'No compactable history exists before the pending plan.',
  });
});

function sessionWithLastContent(content) {
  return sessionWith(new Map([
    [10, { type: 'system/message' }],
    [20, { type: 'user/message' }],
    [30, { type: 'tool/result' }],
    [40, { type: 'assistant/message', data: { message: { content } } }],
  ]));
}

const balancedAt30 = (_session, seq) => seq === 30;

test('only an exit_plan_mode tool call on the last node counts as the pending plan review', () => {
  const found = selectPlanCompactionRange(sessionWithLastContent([
    { type: 'text', text: 'Here is the plan.' },
    { type: 'tool-call', name: 'exit_plan_mode' },
  ]), balancedAt30);
  assert.deepEqual(found, { start: 20, end: 30 });

  for (const content of [
    [{ type: 'text', text: 'just text' }],
    [{ type: 'tool-call', name: 'read_file' }],
    [{ type: 'tool-call' }],
    [],
  ]) {
    assert.deepEqual(
      selectPlanCompactionRange(sessionWithLastContent(content), balancedAt30),
      { error: 'no-review' },
    );
  }
});

test('the plan-review tool name is overridable and defaults to exit_plan_mode', () => {
  const session = sessionWithLastContent([{ type: 'tool-call', name: 'ask_question' }]);
  assert.deepEqual(selectPlanCompactionRange(session, balancedAt30), { error: 'no-review' });
  assert.deepEqual(
    selectPlanCompactionRange(session, balancedAt30, { planReviewTool: 'ask_question' }),
    { start: 20, end: 30 },
  );

  const exitSession = sessionWithLastContent([{ type: 'tool-call', name: 'exit_plan_mode' }]);
  assert.deepEqual(
    selectPlanCompactionRange(exitSession, balancedAt30, { planReviewTool: 'ask_question' }),
    { error: 'no-review' },
  );
  assert.deepEqual(
    selectPlanCompactionRange(exitSession, balancedAt30, {}),
    { start: 20, end: 30 },
  );
});

test('plan-range owns the canonical plan-review tool name and plan-compaction re-exports it', () => {
  assert.equal(RANGE_EXIT_PLAN_MODE_TOOL, 'exit_plan_mode');
  assert.equal(EXIT_PLAN_MODE_TOOL, RANGE_EXIT_PLAN_MODE_TOOL);
});

test('compact command only accepts exit_plan_mode as the pending plan review', async () => {
  const { deps } = commandDeps();
  const nonReviewEvents = new Map([
    [10, { type: 'system/message' }],
    [20, { type: 'user/message' }],
    [30, { type: 'tool/result' }],
    [40, { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'read_file' }] } } }],
  ]);
  const result = await createCompactCommand(deps).handler(invocation(nonReviewEvents));
  assert.deepEqual(result, { kind: 'error', text: MESSAGES.noReview });
});

test('non-string rawInput is treated as no arguments', async () => {
  for (const rawInput of [undefined, null, 17, true, {}, [], () => 'x']) {
    const { deps } = commandDeps();
    const result = await createCompactCommand(deps).handler({ ...invocation(standardEvents), rawInput });
    assert.equal(result.kind, 'success', `rawInput ${String(rawInput)} must be ignored`);
  }
  const spaced = await createCompactCommand(commandDeps().deps).handler({
    ...invocation(standardEvents),
    rawInput: '   ',
  });
  assert.equal(spaced.kind, 'success');
});

test('static command failures use the exported message table', async () => {
  const cases = [
    [{ getProjections: () => undefined }, MESSAGES.planStateUnavailable],
    [{ getProjections: () => ({}) }, MESSAGES.planStateUnavailable],
    [{ getProjections: () => ({ snapshot: () => ({ values: { plan: { active: false } } }) }) }, MESSAGES.planInactive],
    [{ getCompaction: () => undefined }, MESSAGES.backendUnavailable],
    [{ getCompaction: () => ({}) }, MESSAGES.backendUnavailable],
  ];
  for (const [overrides, text] of cases) {
    const { deps } = commandDeps(overrides);
    const result = await createCompactCommand(deps).handler(invocation(standardEvents));
    assert.deepEqual(result, { kind: 'error', text });
  }

  const noReview = new Map([[10, { type: 'user/message' }], [20, { type: 'user/message' }]]);
  assert.deepEqual(
    await createCompactCommand(commandDeps().deps).handler(invocation(noReview)),
    { kind: 'error', text: MESSAGES.noReview },
  );

  const empty = new Map([
    [10, { type: 'system/message' }],
    [20, assistantWithToolCall()],
  ]);
  assert.deepEqual(
    await createCompactCommand(commandDeps().deps).handler(invocation(empty)),
    { kind: 'error', text: MESSAGES.empty },
  );
});

test('an unreadable plan projection snapshot degrades to an error instead of throwing', async () => {
  const { deps } = commandDeps({
    getProjections: () => ({
      snapshot() {
        throw new Error('projection exploded');
      },
    }),
  });
  const result = await createCompactCommand(deps).handler(invocation(standardEvents));
  assert.deepEqual(result, { kind: 'error', text: 'Plan state is unavailable: projection exploded' });
});

test('a missing invocation degrades to a command error instead of throwing', async () => {
  const { deps } = commandDeps();
  const command = createCompactCommand(deps);
  for (const invocation of [undefined, null]) {
    const result = await command.handler(invocation);
    assert.equal(result.kind, 'error');
    assert.equal(typeof result.text, 'string');
  }
});

test('stable compaction failure codes map through the exported failure table', async () => {
  for (const code of ['busy', 'changed', 'summary', 'commit', 'persistence', 'cancelled']) {
    const { deps } = commandDeps({
      getCompaction: () => ({
        compactRegion: async () => {
          const error = new Error(code);
          error.code = code;
          throw error;
        },
      }),
    });
    const result = await createCompactCommand(deps).handler(invocation(standardEvents));
    assert.deepEqual(result, { kind: 'error', text: FAILURES[code] });
  }
});

test('an inherited failure-code name does not shadow the real backend message', async () => {
  const { deps } = commandDeps({
    getCompaction: () => ({
      compactRegion: async () => {
        const error = new Error('the backend failed');
        error.code = 'toString';
        throw error;
      },
    }),
  });
  const result = await createCompactCommand(deps).handler(invocation(standardEvents));
  assert.deepEqual(result, { kind: 'error', text: 'the backend failed' });
});

test('an aborted signal reports cancellation even when the backend error has no code', async () => {
  const controller = new AbortController();
  controller.abort();
  const { deps } = commandDeps({
    getCompaction: () => ({
      compactRegion: async () => {
        throw new Error('aborted');
      },
    }),
  });
  const result = await createCompactCommand(deps).handler({
    ...invocation(standardEvents),
    signal: controller.signal,
  });
  assert.deepEqual(result, { kind: 'error', text: FAILURES.cancelled });
});
