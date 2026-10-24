import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompactCommand } from '../host/plan-compaction.js';
import { selectPlanCompactionRange } from '../host/plan-range.js';

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
      getProjections: () => ({ stateOf: () => ({ active: true }) }),
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

test('compact command refuses when plan mode is inactive', async () => {
  const { deps } = commandDeps({ getProjections: () => ({ stateOf: () => ({ active: false }) }) });
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
});
