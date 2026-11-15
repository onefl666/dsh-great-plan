/**
 * Optional LLM judge over recorded plans.
 *
 * The judge is off unless the caller injects both a `fetchImpl` and a model.
 * Each request is validated against the strict JSON schema in `prompts.mjs`,
 * cached under `<runDir>/judge/cache/<sha256>.json`, and isolated per task: one
 * malformed reply or network failure never aborts the run or affects the other
 * tasks. This module never reaches the network on its own — `fetchImpl` is the
 * only transport.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, ensureDir, listDir, readJsonIfExists } from '../util/fsutil.mjs';
import { hashJson } from '../util/hash.mjs';
import { nowIso } from '../util/time.mjs';
import { extractPlan } from '../score/plan.mjs';
import {
  JUDGE_PROMPT_VERSION,
  JUDGE_SCHEMA,
  buildJudgeMessages,
  meanJudgeScore,
  validateJudgeOutput,
} from './prompts.mjs';

/** Usage accumulator with all three counters present. */
function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** Read a numeric usage field tolerantly. */
function readUsageNumber(usage, keys) {
  if (usage === null || typeof usage !== 'object') return 0;
  for (const key of keys) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) return usage[key];
  }
  return 0;
}

/** Normalize an OpenAI-compatible usage payload. */
function normalizeUsage(usage) {
  const promptTokens = readUsageNumber(usage, ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens']);
  const completionTokens = readUsageNumber(usage, [
    'completion_tokens',
    'completionTokens',
    'output_tokens',
    'outputTokens',
  ]);
  const totalTokens = readUsageNumber(usage, ['total_tokens', 'totalTokens']) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** Add one usage payload into the accumulator. */
function addUsage(total, usage) {
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  total.totalTokens += usage.totalTokens;
}

/** Extract the assistant text from a chat-completions response body. */
function responseText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
      .join('');
  }
  return '';
}

/** Build the chat-completions URL from an optional base URL. */
function completionsUrl(baseUrl) {
  const base = typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl.trim().replace(/\/+$/, '') : 'https://api.openai.com/v1';
  return `${base}/chat/completions`;
}

/** Read the plan-review question for a task, if recorded. */
function readQuestion(planReview) {
  if (planReview === null || typeof planReview !== 'object') return '';
  return typeof planReview.question === 'string' ? planReview.question : '';
}

/** Read the judged plan text for one task. */
function readPlan(taskDir) {
  const planReview = readJsonIfExists(path.join(taskDir, 'plan-review.json'), null);
  let planText = '';
  try {
    planText = fs.readFileSync(path.join(taskDir, 'plan.md'), 'utf8');
  } catch {
    planText = '';
  }
  const plan = extractPlan({ planReview, planText });
  return { text: plan.text, question: readQuestion(planReview) };
}

/** Cache key over everything that affects the judged score. */
function cacheKey({ model, promptVersion, messages }) {
  return hashJson({ model, promptVersion, schema: JUDGE_SCHEMA, messages });
}

/** Read a cache entry and return its validated scores, or `null`. */
function readCache(cacheFile, key) {
  const cached = readJsonIfExists(cacheFile, null);
  if (cached === null || typeof cached !== 'object' || cached.key !== key) return null;
  const validated = validateJudgeOutput(cached.scores);
  if (!validated.ok) return null;
  return {
    scores: validated.scores,
    usage: normalizeUsage(cached.usage),
  };
}

/**
 * Optionally judge every plan in a run.
 *
 * Disabled (the default) unless `fetchImpl` is a function and `model` is a
 * non-empty string. When enabled, every task with a plan is judged once and
 * cached by sha256 under the run directory.
 *
 * @param {object} options
 * @param {string} options.runDir run directory
 * @param {Function} [options.fetchImpl] injected fetch implementation
 * @param {string} [options.model] judge model id
 * @param {string} [options.promptVersion] prompt version (defaults to the module version)
 * @param {string} [options.baseUrl] OpenAI-compatible base URL
 * @param {string} [options.apiKey] optional bearer token
 * @param {boolean} [options.force=false] ignore an existing cache entry
 * @param {number} [options.maxTasks=Infinity] cap on judged tasks
 * @returns {Promise<{ enabled: boolean, scores: object, usage: object, errors: object[], cache?: object }>}
 */
export async function judgeRun({
  runDir,
  fetchImpl,
  model,
  promptVersion = JUDGE_PROMPT_VERSION,
  baseUrl,
  apiKey,
  force = false,
  maxTasks = Infinity,
} = {}) {
  const enabled = typeof fetchImpl === 'function' && typeof model === 'string' && model.trim() !== '';
  if (!enabled) {
    return { enabled: false, scores: {}, usage: emptyUsage(), errors: [] };
  }
  const usage = emptyUsage();
  const scores = {};
  const errors = [];
  const cache = { hits: 0, misses: 0, wrote: 0 };
  if (typeof runDir !== 'string' || runDir === '' || !fs.existsSync(runDir)) {
    errors.push({ instanceId: null, code: 'missing-run-dir', message: `run directory not found: ${String(runDir)}` });
    return { enabled, scores, usage, errors, cache };
  }
  const resolvedRunDir = path.resolve(runDir);
  const taskRoot = path.join(resolvedRunDir, 'tasks');
  const cacheDir = path.join(resolvedRunDir, 'judge', 'cache');
  const taskNames = listDir(taskRoot)
    .filter((name) => !name.startsWith('.'))
    .sort();
  let judged = 0;
  for (const name of taskNames) {
    if (judged >= maxTasks) break;
    const taskDir = path.join(taskRoot, name);
    let instanceId = name;
    try {
      const meta = readJsonIfExists(path.join(taskDir, 'meta.json'), null);
      if (meta !== null && typeof meta.instanceId === 'string' && meta.instanceId !== '') instanceId = meta.instanceId;
      const plan = readPlan(taskDir);
      if (plan.text === '') {
        errors.push({ instanceId, code: 'no-plan', message: 'no plan text found for task' });
        continue;
      }
      const messages = buildJudgeMessages({ instanceId, question: plan.question, planText: plan.text });
      const key = cacheKey({ model, promptVersion, messages });
      const cacheFile = path.join(cacheDir, `${key}.json`);
      if (!force) {
        const cached = readCache(cacheFile, key);
        if (cached !== null) {
          scores[instanceId] = { ...cached.scores, mean: meanJudgeScore(cached.scores) };
          addUsage(usage, cached.usage);
          cache.hits += 1;
          judged += 1;
          continue;
        }
      }
      cache.misses += 1;
      const headers = { 'content-type': 'application/json' };
      if (typeof apiKey === 'string' && apiKey !== '') headers.authorization = `Bearer ${apiKey}`;
      const response = await fetchImpl(completionsUrl(baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
      });
      if (response !== null && typeof response === 'object' && response.ok === false) {
        throw new Error(`judge request failed with HTTP ${response.status ?? 'unknown'}`);
      }
      const body = response !== null && typeof response === 'object' && typeof response.json === 'function'
        ? await response.json()
        : response;
      const taskUsage = normalizeUsage(body?.usage);
      addUsage(usage, taskUsage);
      const text = responseText(body);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        errors.push({
          instanceId,
          code: 'invalid-json',
          message: `judge answer is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const validated = validateJudgeOutput(parsed);
      if (!validated.ok) {
        errors.push({ instanceId, code: 'schema', message: validated.errors.join('; ') });
        continue;
      }
      scores[instanceId] = { ...validated.scores, mean: meanJudgeScore(validated.scores) };
      judged += 1;
      try {
        ensureDir(cacheDir);
        atomicWriteFile(
          cacheFile,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              key,
              instanceId,
              model,
              promptVersion,
              scores: validated.scores,
              usage: taskUsage,
              evaluatedAt: nowIso(),
            },
            null,
            2,
          )}\n`,
        );
        cache.wrote += 1;
      } catch (error) {
        errors.push({
          instanceId,
          code: 'cache-write',
          message: `could not write judge cache: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } catch (error) {
      errors.push({
        instanceId,
        code: 'request-error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { enabled, scores, usage, errors, cache };
}

/**
 * Load previously cached judge scores for a run without calling a model.
 *
 * @param {string} runDir run directory
 * @returns {object} scores keyed by instance id
 */
export function readJudgeCache(runDir) {
  if (typeof runDir !== 'string' || runDir === '') return {};
  const cacheDir = path.join(path.resolve(runDir), 'judge', 'cache');
  const scores = {};
  for (const name of listDir(cacheDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const entry = readJsonIfExists(path.join(cacheDir, name), null);
    if (entry === null || typeof entry !== 'object' || typeof entry.instanceId !== 'string') continue;
    const validated = validateJudgeOutput(entry.scores);
    if (!validated.ok) continue;
    scores[entry.instanceId] = { ...validated.scores, mean: meanJudgeScore(validated.scores) };
  }
  return scores;
}
