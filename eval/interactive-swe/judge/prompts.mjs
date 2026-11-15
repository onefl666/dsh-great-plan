/**
 * Judge prompt and strict output schema.
 *
 * The optional LLM judge scores each submitted plan on four 0-2 dimensions.
 * Scoring is intentionally separated from the deterministic metrics: the judge
 * is off by default, uses an injected `fetch`, and any malformed answer is
 * rejected instead of being coerced. The prompt version participates in the
 * cache key so a prompt change never reuses stale scores.
 */

/** Bump when the prompt or schema changes in a way that invalidates scores. */
export const JUDGE_PROMPT_VERSION = '1';

/** Dimension names in output order. */
export const JUDGE_DIMENSIONS = [
  'evidenceSupport',
  'assumptionQuality',
  'handoffExecutability',
  'clarificationRelevance',
];

/** Human-readable definition of each dimension (also in the system prompt). */
export const JUDGE_DIMENSION_DEFINITIONS = {
  evidenceSupport:
    'Does the plan ground its claims in concrete evidence (paths with line ranges, commands/searches with results, docs) rather than unsupported assertions?',
  assumptionQuality:
    'Does the plan separate settled facts from assumptions, unverified points, and open questions, and are those marked honestly instead of presented as fact?',
  handoffExecutability:
    'Could an executor with only this plan continue the work: is there enough background, settled decisions, and a concrete next step?',
  clarificationRelevance:
    'Are the questions the plan says it asked relevant to material ambiguities, and does the plan avoid needless questioning?',
};

/** Strict JSON schema the judge answer must satisfy. */
export const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: JUDGE_DIMENSIONS,
  properties: Object.fromEntries(
    JUDGE_DIMENSIONS.map((dimension) => [
      dimension,
      { type: 'integer', minimum: 0, maximum: 2 },
    ]),
  ),
};

/** System prompt for the judge. */
export const JUDGE_SYSTEM_PROMPT = `You are grading a software-planning agent's plan for one repository task.
Score the plan on four dimensions, each as an integer from 0 to 2:
- evidenceSupport: ${JUDGE_DIMENSION_DEFINITIONS.evidenceSupport}
- assumptionQuality: ${JUDGE_DIMENSION_DEFINITIONS.assumptionQuality}
- handoffExecutability: ${JUDGE_DIMENSION_DEFINITIONS.handoffExecutability}
- clarificationRelevance: ${JUDGE_DIMENSION_DEFINITIONS.clarificationRelevance}

Scoring anchors: 0 = absent or actively misleading, 1 = partial or superficial, 2 = clearly present and useful.
Judge only the plan text. Do not reward length. Do not use outside knowledge of the repository.
Return exactly one JSON object with these four integer keys and no other keys:
${JSON.stringify(JUDGE_DIMENSIONS)}.
Output JSON only, with no Markdown fences, no commentary, and no extra fields.`;

/**
 * Build the user message for one plan.
 *
 * @param {object} input
 * @param {string} input.instanceId task instance id
 * @param {string} [input.question] plan-review question
 * @param {string} [input.planText] submitted plan
 * @param {object|null} [input.metadata] optional extra task context
 * @returns {string}
 */
export function buildJudgeUserPrompt({ instanceId, question = '', planText = '', metadata = null } = {}) {
  const lines = [];
  lines.push(`Task instance: ${typeof instanceId === 'string' ? instanceId : 'unknown'}`);
  if (typeof question === 'string' && question.trim() !== '') {
    lines.push('');
    lines.push('Plan-review question:');
    lines.push(question.trim());
  }
  if (metadata !== null && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
    try {
      lines.push('');
      lines.push('Task metadata:');
      lines.push(JSON.stringify(metadata));
    } catch {
      // ignore unserializable metadata
    }
  }
  lines.push('');
  lines.push('Plan text:');
  lines.push('<<<PLAN');
  lines.push(typeof planText === 'string' ? planText : '');
  lines.push('PLAN>>>');
  return lines.join('\n');
}

/**
 * Build the full chat message list for one judge request.
 *
 * @param {object} input same as `buildJudgeUserPrompt`
 * @returns {Array<{ role: string, content: string }>}
 */
export function buildJudgeMessages(input) {
  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: buildJudgeUserPrompt(input) },
  ];
}

/**
 * Validate one judge answer against the strict schema.
 *
 * @param {unknown} value parsed JSON value
 * @returns {{ ok: boolean, errors: string[], scores: object|null }}
 */
export function validateJudgeOutput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['output is not a JSON object'], scores: null };
  }
  const errors = [];
  const scores = {};
  for (const key of Object.keys(value)) {
    if (!JUDGE_DIMENSIONS.includes(key)) errors.push(`unexpected key: ${key}`);
  }
  for (const dimension of JUDGE_DIMENSIONS) {
    if (!(dimension in value)) {
      errors.push(`missing dimension: ${dimension}`);
      continue;
    }
    const score = value[dimension];
    if (!Number.isInteger(score) || score < 0 || score > 2) {
      errors.push(`invalid score for ${dimension}: ${String(score)}`);
      continue;
    }
    scores[dimension] = score;
  }
  if (errors.length > 0) return { ok: false, errors, scores: null };
  return { ok: true, errors: [], scores };
}

/**
 * Mean of the four judged dimensions, rounded to four decimals.
 *
 * @param {object} scores validated dimension scores
 * @returns {number}
 */
export function meanJudgeScore(scores) {
  const values = JUDGE_DIMENSIONS.map((dimension) => scores[dimension]).filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 10000) / 10000;
}
