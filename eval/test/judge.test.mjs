/**
 * Offline tests for the optional judge: injected fake fetch, sha256 cache,
 * strict schema validation, and failure isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { judgeRun, readJudgeCache } from '../interactive-swe/judge/judge.mjs';
import {
  JUDGE_DIMENSIONS,
  JUDGE_SCHEMA,
  buildJudgeMessages,
  buildJudgeUserPrompt,
  meanJudgeScore,
  validateJudgeOutput,
} from '../interactive-swe/judge/prompts.mjs';
import { makeTempDir, writeRun } from './fixtures/score/fixtures.mjs';

/** A valid judge answer for every dimension. */
const VALID_SCORES = {
  evidenceSupport: 2,
  assumptionQuality: 1,
  handoffExecutability: 2,
  clarificationRelevance: 0,
};

/** One OpenAI-compatible chat-completions response body. */
function chatBody(content, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return { choices: [{ message: { content } }], usage };
}

/** Build a fake `fetch` that replays the given items in order. */
function makeFetch(items) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: typeof options?.body === 'string' ? JSON.parse(options.body) : options?.body });
    const index = Math.min(calls.length - 1, items.length - 1);
    const item = items[index];
    if (item instanceof Error) throw item;
    return typeof item === 'function' ? item() : item;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('judgeRun scores with an injected fetch and caches by sha256', async (t) => {
  const root = makeTempDir(t, 'judge');
  const runDir = writeRun(root, {
    runId: 'judge-run',
    arm: 'full',
    tasks: [
      { instanceId: 'j1', arm: 'full' },
      { instanceId: 'j2', arm: 'full' },
    ],
  });
  const fetchImpl = makeFetch([chatBody(JSON.stringify(VALID_SCORES))]);
  const result = await judgeRun({ runDir, fetchImpl, model: 'judge-model' });
  assert.equal(result.enabled, true);
  assert.deepEqual(Object.keys(result.scores).sort(), ['j1', 'j2']);
  assert.equal(result.scores.j1.mean, 1.25);
  assert.equal(result.errors.length, 0);
  assert.equal(result.cache.misses, 2);
  assert.equal(result.cache.wrote, 2);
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0].url, /\/chat\/completions$/);
  assert.equal(fetchImpl.calls[0].body.model, 'judge-model');
  assert.equal(fetchImpl.calls[0].body.messages[0].role, 'system');
  assert.equal(result.usage.promptTokens, 20);
  assert.equal(result.usage.completionTokens, 10);
  assert.equal(result.usage.totalTokens, 30);
  const cacheDir = path.join(runDir, 'judge', 'cache');
  assert.equal(fs.readdirSync(cacheDir).length, 2);
  assert.deepEqual(readJudgeCache(runDir).j1, { ...VALID_SCORES, mean: 1.25 });
});

test('judgeRun reuses the cache without any network access', async (t) => {
  const root = makeTempDir(t, 'judge-cache');
  const runDir = writeRun(root, {
    runId: 'judge-cache-run',
    arm: 'full',
    tasks: [{ instanceId: 'j1', arm: 'full' }],
  });
  const first = await judgeRun({
    runDir,
    fetchImpl: makeFetch([chatBody(JSON.stringify(VALID_SCORES))]),
    model: 'judge-model',
  });
  let calls = 0;
  const throwingFetch = async () => {
    calls += 1;
    throw new Error('network must not be used');
  };
  const second = await judgeRun({ runDir, fetchImpl: throwingFetch, model: 'judge-model' });
  assert.equal(calls, 0);
  assert.equal(second.cache.hits, 1);
  assert.equal(second.cache.misses, 0);
  assert.equal(second.errors.length, 0);
  assert.deepEqual(second.scores, first.scores);

  const forcedFetch = makeFetch([chatBody(JSON.stringify(VALID_SCORES))]);
  const forced = await judgeRun({ runDir, fetchImpl: forcedFetch, model: 'judge-model', force: true });
  assert.equal(forcedFetch.calls.length, 1);
  assert.equal(forced.cache.misses, 1);
});

test('a different prompt version invalidates the cache', async (t) => {
  const root = makeTempDir(t, 'judge-version');
  const runDir = writeRun(root, {
    runId: 'judge-version-run',
    arm: 'full',
    tasks: [{ instanceId: 'j1', arm: 'full' }],
  });
  const firstFetch = makeFetch([chatBody(JSON.stringify(VALID_SCORES))]);
  await judgeRun({ runDir, fetchImpl: firstFetch, model: 'judge-model' });
  const secondFetch = makeFetch([chatBody(JSON.stringify(VALID_SCORES))]);
  const second = await judgeRun({ runDir, fetchImpl: secondFetch, model: 'judge-model', promptVersion: '2' });
  assert.equal(secondFetch.calls.length, 1);
  assert.equal(second.cache.misses, 1);
  assert.equal(second.cache.hits, 0);
});

test('judgeRun rejects schema violations without caching them', async (t) => {
  const root = makeTempDir(t, 'judge-schema');
  const runDir = writeRun(root, {
    runId: 'judge-schema-run',
    arm: 'full',
    tasks: [{ instanceId: 'j1', arm: 'full' }],
  });
  const invalid = { ...VALID_SCORES, evidenceSupport: 5 };
  const result = await judgeRun({
    runDir,
    fetchImpl: makeFetch([chatBody(JSON.stringify(invalid))]),
    model: 'judge-model',
  });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.scores, {});
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'schema');
  assert.equal(fs.existsSync(path.join(runDir, 'judge', 'cache')), false);
});

test('judgeRun rejects non-JSON answers', async (t) => {
  const root = makeTempDir(t, 'judge-json');
  const runDir = writeRun(root, {
    runId: 'judge-json-run',
    arm: 'full',
    tasks: [{ instanceId: 'j1', arm: 'full' }],
  });
  const result = await judgeRun({
    runDir,
    fetchImpl: makeFetch([chatBody('this is not json')]),
    model: 'judge-model',
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'invalid-json');
});

test('judgeRun isolates per-task request failures', async (t) => {
  const root = makeTempDir(t, 'judge-isolation');
  const runDir = writeRun(root, {
    runId: 'judge-isolation-run',
    arm: 'full',
    tasks: [
      { instanceId: 'j1', arm: 'full' },
      { instanceId: 'j2', arm: 'full' },
    ],
  });
  const result = await judgeRun({
    runDir,
    fetchImpl: makeFetch([new Error('boom'), chatBody(JSON.stringify(VALID_SCORES))]),
    model: 'judge-model',
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'request-error');
  assert.equal(result.errors[0].instanceId, 'j1');
  assert.deepEqual(Object.keys(result.scores), ['j2']);
  assert.equal(result.usage.promptTokens, 10);
});

test('judgeRun reports malformed HTTP responses as request errors', async (t) => {
  const root = makeTempDir(t, 'judge-http');
  const runDir = writeRun(root, {
    runId: 'judge-http-run',
    arm: 'full',
    tasks: [{ instanceId: 'j1', arm: 'full' }],
  });
  const result = await judgeRun({
    runDir,
    fetchImpl: makeFetch([{ ok: false, status: 401, json: async () => ({}) }]),
    model: 'judge-model',
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'request-error');
  assert.match(result.errors[0].message, /401/);
});

test('judgeRun skips tasks without a plan', async (t) => {
  const root = makeTempDir(t, 'judge-noplan');
  const runDir = writeRun(root, {
    runId: 'judge-noplan-run',
    arm: 'full',
    tasks: [{ instanceId: 'j1', arm: 'full', plan: '', omit: ['plan-review.json'] }],
  });
  const result = await judgeRun({
    runDir,
    fetchImpl: makeFetch([chatBody(JSON.stringify(VALID_SCORES))]),
    model: 'judge-model',
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'no-plan');
  assert.deepEqual(result.scores, {});
});

test('judge is disabled by default and never writes', async (t) => {
  const root = makeTempDir(t, 'judge-off');
  const runDir = writeRun(root, {
    runId: 'judge-off-run',
    arm: 'full',
    tasks: [{ instanceId: 'j1', arm: 'full' }],
  });
  const withoutFetch = await judgeRun({ runDir, model: 'judge-model' });
  assert.equal(withoutFetch.enabled, false);
  assert.deepEqual(withoutFetch.scores, {});
  assert.deepEqual(withoutFetch.errors, []);
  assert.deepEqual(withoutFetch.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  assert.equal(fs.existsSync(path.join(runDir, 'judge')), false);

  const withoutModel = await judgeRun({ runDir, fetchImpl: makeFetch([chatBody('{}')]) });
  assert.equal(withoutModel.enabled, false);

  const missingRunDir = await judgeRun({
    runDir: path.join(root, 'missing'),
    fetchImpl: makeFetch([chatBody('{}')]),
    model: 'judge-model',
  });
  assert.equal(missingRunDir.errors[0].code, 'missing-run-dir');
});

test('judge prompt and schema are strict', () => {
  assert.deepEqual(JUDGE_SCHEMA.required, JUDGE_DIMENSIONS);
  assert.equal(JUDGE_SCHEMA.additionalProperties, false);
  for (const dimension of JUDGE_DIMENSIONS) {
    assert.deepEqual(JUDGE_SCHEMA.properties[dimension], { type: 'integer', minimum: 0, maximum: 2 });
  }

  const valid = validateJudgeOutput({ ...VALID_SCORES });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.scores, VALID_SCORES);
  assert.equal(meanJudgeScore(VALID_SCORES), 1.25);

  assert.equal(validateJudgeOutput({ ...VALID_SCORES, extra: 1 }).ok, false);
  const missing = { ...VALID_SCORES };
  delete missing.handoffExecutability;
  assert.match(validateJudgeOutput(missing).errors.join('; '), /missing dimension: handoffExecutability/);
  assert.match(validateJudgeOutput({ ...VALID_SCORES, evidenceSupport: 1.5 }).errors.join('; '), /invalid score/);
  assert.match(validateJudgeOutput(null).errors.join('; '), /not a JSON object/);
  assert.match(validateJudgeOutput([]).errors.join('; '), /not a JSON object/);

  const messages = buildJudgeMessages({ instanceId: 'task-1', question: 'Why?', planText: 'The plan.' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[1].content, /Task instance: task-1/);
  assert.match(messages[1].content, /Plan text:/);
  assert.match(messages[1].content, /The plan\./);
  const userPrompt = buildJudgeUserPrompt({ instanceId: 'task-2', planText: 'P' });
  assert.match(userPrompt, /<<<PLAN/);
  assert.match(userPrompt, /PLAN>>>/);
});
