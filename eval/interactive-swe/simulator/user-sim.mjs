/**
 * Scripted, constrained user simulator.
 *
 * Three kinds are supported:
 * - `none`: no answerer; every question batch is declined (cancelled).
 * - `fixture`: deterministic answers read from a per-task fixture, used by
 *   offline selftests and tests.
 * - `http`: answers produced by an OpenAI-compatible model through
 *   {@link callOpenAiCompatible} with an injected `fetchImpl`.
 *
 * The simulator enforces its own cap of answered question batches (default 3)
 * in addition to the runner's policy cap; exceeding it returns `capHit`.
 */

import { callOpenAiCompatible } from './http-sim.mjs';
import { buildSimulatorMessages, parseSimulatorAnswer } from './prompt.mjs';

export const DEFAULT_ANSWER_CAP = 3;

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0 };
}

function firstOptionLabel(question) {
  if (!Array.isArray(question?.options) || question.options.length === 0) return '';
  const first = question.options[0];
  const label = typeof first === 'string' ? first : first?.label;
  return typeof label === 'string' ? label : '';
}

function ensureAnswerShape(answer, questions) {
  const expected = questions.map((question) => String(question.id));
  const byId = new Map();
  for (const entry of Array.isArray(answer) ? answer : []) {
    if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') byId.set(entry.id, entry);
  }
  const answers = [];
  for (const question of questions) {
    const id = String(question.id);
    const entry = byId.get(id);
    if (entry === undefined) {
      const fallback = firstOptionLabel(question);
      if (fallback === '') throw new Error(`fixture has no answer for question ${id}`);
      answers.push({ id, selected: [fallback] });
      continue;
    }
    const selected = Array.isArray(entry.selected) ? entry.selected.filter((label) => typeof label === 'string') : [];
    const normalized = { id, selected };
    if (typeof entry.custom === 'string') normalized.custom = entry.custom;
    if (normalized.selected.length === 0 && normalized.custom === undefined) {
      const fallback = firstOptionLabel(question);
      if (fallback === '') throw new Error(`fixture answer for ${id} selects nothing`);
      normalized.selected = [fallback];
    }
    answers.push(normalized);
  }
  return answers;
}

/** Normalize one fixture value (map or array) into answers for the questions. */
function fixtureAnswersFor(value, questions, callIndex) {
  if (value === undefined || value === null) throw new Error('fixture answer is missing');
  let current = value;
  const looksLikeAnswerList =
    Array.isArray(current) && current.length > 0 && current.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  if (Array.isArray(current) && !looksLikeAnswerList) {
    current = current[Math.min(callIndex, current.length - 1)];
  }
  if (current === null || current === undefined) throw new Error('fixture answer is missing for this call');
  if (typeof current === 'string' || Array.isArray(current)) {
    const first = questions[0];
    if (first === undefined) return [];
    const selected = Array.isArray(current) ? current.filter((label) => typeof label === 'string') : [current];
    const whole = ensureAnswerShape([{ id: String(first.id), selected }], questions);
    return whole;
  }
  if (typeof current !== 'object') throw new Error('fixture answer must be a string, array, or object');
  if (Array.isArray(current.answers)) return ensureAnswerShape(current.answers, questions);
  const mapped = [];
  for (const question of questions) {
    const id = String(question.id);
    const byId = current[id];
    const byText = typeof question.question === 'string' ? current[question.question] : undefined;
    const picked = byId ?? byText;
    if (picked === undefined) continue;
    if (typeof picked === 'string') mapped.push({ id, selected: [picked] });
    else if (Array.isArray(picked)) mapped.push({ id, selected: picked.filter((label) => typeof label === 'string') });
    else if (picked !== null && typeof picked === 'object') {
      mapped.push({
        id,
        selected: Array.isArray(picked.selected) ? picked.selected.filter((label) => typeof label === 'string') : [],
        ...(typeof picked.custom === 'string' ? { custom: picked.custom } : {}),
      });
    }
  }
  return ensureAnswerShape(mapped, questions);
}

/**
 * Create a simulator.
 *
 * @param {object} [options]
 * @param {'fixture'|'http'|'none'} [options.kind] simulator kind, defaults to `none`
 * @param {string|null} [options.model] model id (http kind)
 * @param {typeof fetch} [options.fetchImpl] injected fetch (http kind, tests)
 * @param {object|null} [options.fixture] per-instance answers (fixture kind)
 * @param {number} [options.cap] maximum answered question batches, defaults to 3
 * @param {string|null} [options.baseUrl] OpenAI-compatible base URL (http kind)
 * @param {string|null} [options.apiKey] bearer token (http kind)
 * @param {number} [options.timeoutMs] HTTP deadline
 * @returns {{kind: string, cap: number, model: string|null, answer: Function, reset: Function, usage: Function}}
 */
export function createSimulator({
  kind = 'none',
  model = null,
  fetchImpl,
  fixture = null,
  cap = DEFAULT_ANSWER_CAP,
  baseUrl = null,
  apiKey = null,
  timeoutMs,
} = {}) {
  if (!['fixture', 'http', 'none'].includes(kind)) throw new TypeError(`unknown simulator kind: ${String(kind)}`);
  if (!Number.isInteger(cap) || cap < 0) throw new TypeError('simulator cap must be a non-negative integer');
  let answered = 0;
  let capHits = 0;
  let fixtureIndex = 0;
  let totals = zeroUsage();

  function reset() {
    answered = 0;
    capHits = 0;
    fixtureIndex = 0;
    totals = zeroUsage();
  }

  /**
   * Answer one clarification batch.
   *
   * @param {{task?: object, questions?: object[], history?: object[]}} input
   * @returns {Promise<{answers: object[], usage: object, capHit: boolean, cancelled?: boolean}>}
   */
  async function answer(input = {}) {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    if (questions.length === 0) return { answers: [], usage: zeroUsage(), capHit: false };
    const questionIds = questions.map((question) => String(question.id));
    if (kind === 'none') return { answers: [], usage: zeroUsage(), capHit: false, cancelled: true };
    if (answered >= cap) {
      capHits += 1;
      return { answers: [], usage: zeroUsage(), capHit: true };
    }

    if (kind === 'fixture') {
      const instanceId = input.task?.instance_id;
      const entry = fixture !== null && typeof fixture === 'object' ? fixture[instanceId] : undefined;
      const answers = fixtureAnswersFor(entry, questions, fixtureIndex);
      fixtureIndex += 1;
      answered += 1;
      const validated = ensureAnswerShape(answers, questions);
      return { answers: validated, usage: zeroUsage(), capHit: false };
    }

    answered += 1;
    let response;
    try {
      response = await callOpenAiCompatible({
        baseUrl,
        apiKey,
        model,
        messages: buildSimulatorMessages(input),
        fetchImpl,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (error) {
      throw new Error(`simulator request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    totals = {
      inputTokens: totals.inputTokens + response.usage.inputTokens,
      outputTokens: totals.outputTokens + response.usage.outputTokens,
    };
    let answers;
    try {
      answers = parseSimulatorAnswer(response.text, questionIds);
    } catch (error) {
      throw new Error(`simulator reply was rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { answers, usage: response.usage, capHit: false };
  }

  return {
    kind,
    cap,
    model: typeof model === 'string' ? model : null,
    answer,
    reset,
    usage: () => ({ ...totals, answered, capHits }),
  };
}
