import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIMULATOR_SYSTEM_PROMPT,
  buildSimulatorMessages,
  parseSimulatorAnswer,
} from '../interactive-swe/simulator/prompt.mjs';
import { createSimulator } from '../interactive-swe/simulator/user-sim.mjs';
import { callOpenAiCompatible } from '../interactive-swe/simulator/http-sim.mjs';

const CJK = /[\u3400-\u9fff]/u;

function question(id, text = 'Which behavior?', options = [{ label: 'Keep it' }, { label: 'Change it' }]) {
  return { id, header: 'Clarify', question: text, options };
}

test('simulator system prompt is fixed English and constrained to the issue', () => {
  assert.equal(typeof SIMULATOR_SYSTEM_PROMPT, 'string');
  assert.ok(SIMULATOR_SYSTEM_PROMPT.length > 100);
  assert.match(SIMULATOR_SYSTEM_PROMPT, /issue/);
  assert.match(SIMULATOR_SYSTEM_PROMPT, /Never write code/);
  assert.match(SIMULATOR_SYSTEM_PROMPT, /JSON/);
  assert.equal(CJK.test(SIMULATOR_SYSTEM_PROMPT), false);
});

test('buildSimulatorMessages embeds the issue, history, and question ids', () => {
  const messages = buildSimulatorMessages({
    task: { original_issue: 'The frobnicator fails on Wednesdays.' },
    questions: [question('q1', 'When does it fail?'), question('q2', 'What should stay?')],
    history: [{ questions: [question('q0', 'Earlier?')], answers: [{ id: 'q0', selected: ['Earlier answer'] }] }],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, SIMULATOR_SYSTEM_PROMPT);
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /frobnicator fails on Wednesdays/);
  assert.match(messages[1].content, /"q1"/);
  assert.match(messages[1].content, /"q2"/);
  assert.match(messages[1].content, /Earlier answer/);
});

test('parseSimulatorAnswer accepts fenced JSON and normalizes answers', () => {
  const text = [
    '```json',
    JSON.stringify({ answers: [{ id: 'q1', selected: ['Keep it'] }, { id: 'q2', selected: [], custom: 'No idea' }] }),
    '```',
  ].join('\n');
  const answers = parseSimulatorAnswer(text, ['q1', 'q2']);
  assert.deepEqual(answers, [
    { id: 'q1', selected: ['Keep it'] },
    { id: 'q2', selected: [], custom: 'No idea' },
  ]);
});

test('parseSimulatorAnswer rejects malformed batches', () => {
  assert.throws(() => parseSimulatorAnswer('', ['q1']), /empty/);
  assert.throws(() => parseSimulatorAnswer('not json', ['q1']), /not valid JSON/);
  assert.throws(() => parseSimulatorAnswer('{"answers":[]}', ['q1']), /did not answer/);
  assert.throws(
    () => parseSimulatorAnswer(JSON.stringify({ answers: [{ id: 'q2', selected: ['x'] }] }), ['q1']),
    /unknown question id/,
  );
  assert.throws(
    () =>
      parseSimulatorAnswer(
        JSON.stringify({ answers: [{ id: 'q1', selected: ['x'] }, { id: 'q1', selected: ['y'] }] }),
        ['q1'],
      ),
    /more than once/,
  );
  assert.throws(
    () => parseSimulatorAnswer(JSON.stringify({ answers: [{ id: 'q1', selected: 'x' }] }), ['q1']),
    /selected string array/,
  );
  assert.throws(
    () => parseSimulatorAnswer(JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: 4 }] }), ['q1']),
    /custom must be a string/,
  );
  assert.throws(
    () => parseSimulatorAnswer(JSON.stringify({ answers: [{ id: 'q1', selected: [] }] }), ['q1']),
    /select an option/,
  );
  assert.throws(() => parseSimulatorAnswer(JSON.stringify({ nope: true }), ['q1']), /answers array/);
});

test('kind none declines every batch without consuming cap', async () => {
  const simulator = createSimulator({ kind: 'none' });
  const result = await simulator.answer({ questions: [question('q1')] });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.answers, []);
  assert.equal(result.capHit, false);
  assert.equal(simulator.usage().answered, 0);
});

test('fixture answers by id, by question text, and by call index', async () => {
  const byId = createSimulator({
    kind: 'fixture',
    fixture: {
      t1: { answers: [{ id: 'q1', selected: ['Keep it'] }, { id: 'q2', selected: ['Change it'] }] },
    },
  });
  const first = await byId.answer({ task: { instance_id: 't1' }, questions: [question('q1'), question('q2')] });
  assert.deepEqual(first.answers, [
    { id: 'q1', selected: ['Keep it'] },
    { id: 'q2', selected: ['Change it'] },
  ]);
  assert.deepEqual(first.usage, { inputTokens: 0, outputTokens: 0 });

  const byText = createSimulator({
    kind: 'fixture',
    fixture: { t2: { 'Which behavior?': 'Change it' } },
  });
  const second = await byText.answer({ task: { instance_id: 't2' }, questions: [question('q1')] });
  assert.deepEqual(second.answers, [{ id: 'q1', selected: ['Change it'] }]);

  const byIndex = createSimulator({ kind: 'fixture', fixture: { t3: [['Keep it'], ['Change it']] } });
  const one = question('a');
  const firstCall = await byIndex.answer({ task: { instance_id: 't3' }, questions: [one] });
  const secondCall = await byIndex.answer({ task: { instance_id: 't3' }, questions: [one] });
  assert.deepEqual(firstCall.answers, [{ id: 'a', selected: ['Keep it'] }]);
  assert.deepEqual(secondCall.answers, [{ id: 'a', selected: ['Change it'] }]);
});

test('fixture mode fails loudly when the task has no fixture, and fills uncovered questions', async () => {
  const missingTask = createSimulator({ kind: 'fixture', fixture: { other: [['x']] } });
  await assert.rejects(
    () => missingTask.answer({ task: { instance_id: 't1' }, questions: [question('q1')] }),
    /fixture answer is missing/,
  );
  const partial = createSimulator({ kind: 'fixture', fixture: { t1: { q9: 'x' } } });
  const filled = await partial.answer({ task: { instance_id: 't1' }, questions: [question('q1')] });
  assert.deepEqual(filled.answers, [{ id: 'q1', selected: ['Keep it'] }]);
});

test('simulator cap is enforced per answered batch', async () => {
  const simulator = createSimulator({ kind: 'fixture', cap: 2, fixture: { t1: [['a'], ['b'], ['c']] } });
  const asked = [question('q1')];
  const one = await simulator.answer({ task: { instance_id: 't1' }, questions: asked });
  const two = await simulator.answer({ task: { instance_id: 't1' }, questions: asked });
  const three = await simulator.answer({ task: { instance_id: 't1' }, questions: asked });
  assert.equal(one.capHit, false);
  assert.equal(two.capHit, false);
  assert.equal(three.capHit, true);
  assert.deepEqual(three.answers, []);
  assert.equal(simulator.usage().capHits, 1);
  simulator.reset();
  assert.equal(simulator.usage().answered, 0);
});

test('http simulator calls an OpenAI-compatible endpoint and tracks usage', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ answers: [{ id: 'q1', selected: ['Keep it'] }] }) } }],
          usage: { prompt_tokens: 40, completion_tokens: 7 },
        }),
    };
  };
  const simulator = createSimulator({
    kind: 'http',
    model: 'sim-model',
    baseUrl: 'http://simulator.test/v1/',
    apiKey: 'secret',
    fetchImpl,
  });
  const result = await simulator.answer({ task: { problem_statement: 'Broken.' }, questions: [question('q1')] });
  assert.deepEqual(result.answers, [{ id: 'q1', selected: ['Keep it'] }]);
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 7 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://simulator.test/v1/chat/completions');
  assert.equal(requests[0].body.model, 'sim-model');
  assert.equal(requests[0].init.headers.authorization, 'Bearer secret');
  assert.equal(requests[0].body.messages[0].content, SIMULATOR_SYSTEM_PROMPT);
  assert.equal(requests[0].body.messages[1].content.includes('Broken.'), true);
  assert.deepEqual(simulator.usage(), { inputTokens: 40, outputTokens: 7, answered: 1, capHits: 0 });
});

test('http simulator rejects an unparseable model answer', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: 'I would rather not.' } }] }),
  });
  const simulator = createSimulator({ kind: 'http', model: 'm', baseUrl: 'http://sim.test/v1', fetchImpl });
  await assert.rejects(() => simulator.answer({ questions: [question('q1')] }), /simulator reply was rejected/);
});

test('callOpenAiCompatible surfaces HTTP failures and transport faults', async () => {
  await assert.rejects(
    () =>
      callOpenAiCompatible({
        baseUrl: 'http://sim.test/v1',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'upstream down' }),
      }),
    /HTTP 503: upstream down/,
  );
  await assert.rejects(
    () =>
      callOpenAiCompatible({
        baseUrl: 'http://sim.test/v1',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: async () => {
          throw new Error('connection refused');
        },
      }),
    /connection refused/,
  );
  await assert.rejects(
    () => callOpenAiCompatible({ baseUrl: '', model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    /baseUrl is required/,
  );
});
