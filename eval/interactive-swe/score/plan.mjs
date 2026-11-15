/**
 * Plan extraction and arm-marker integrity.
 *
 * The plan text is snapshotted twice by the runner: as `plan-review.json`
 * `detail` (the pending review payload, preferred) and as the `exit_plan_mode`
 * tool-call arguments in `events.jsonl`. The two are cross-checked here so a
 * report can flag a truncated or stale snapshot. Arm markers are the exact
 * guidance strings injected by the plugin's plan-evidence prompt section; a
 * run is only comparable when the observed system prompt matches the arm's
 * configuration.
 */
import { PLAN_MODE_TOOL, systemPromptText } from '../session/events.mjs';

/** Exact unlimited-token-budget marker from `lib/host/plan-evidence.js`. */
export const MARKER_BUDGET = 'Token budget: unlimited.';

/** Exact brainstorming/Team-Lead guidance opening marker. */
export const MARKER_BRAINSTORMING = 'Discovery and delegation:';

/** Exact Team-Lead instruction marker (inside the brainstorming guidance). */
export const MARKER_TEAM_LEAD = 'You are the Team Lead.';

/** Exact evidence/handoff guidance marker (always injected in plan mode). */
export const MARKER_HANDOFF = 'Plan as handoff';

/** Arm marker strings keyed by the boolean returned by `armMarkers`. */
export const ARM_MARKER_STRINGS = {
  budget: MARKER_BUDGET,
  brainstorming: MARKER_BRAINSTORMING,
  teamLead: MARKER_TEAM_LEAD,
  handoff: MARKER_HANDOFF,
};

/** Recognized arm names; `native` disables the plugin. */
export const ARMS = ['native', 'evidence', 'full'];

/**
 * Join the text of a message-like value.
 *
 * @param {unknown} value string, text block, or array of blocks
 * @returns {string}
 */
export function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join('');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return textOf(value.content);
    if (value.message !== undefined) return textOf(value.message);
    if (value.plan !== undefined) return textOf(value.plan);
  }
  return '';
}

/**
 * Best-effort plan text from a plan-review `detail` payload.
 *
 * The native review serializes the plan under `plan`; a string detail, an
 * object detail, and a wrapped `{ plan: { text } }` shape are all accepted.
 *
 * @param {unknown} detail
 * @returns {string}
 */
export function planTextFromDetail(detail) {
  if (typeof detail === 'string') return detail.trim();
  if (detail === null || typeof detail !== 'object') return '';
  const candidates = [
    detail.plan,
    detail.planText,
    detail.plan_text,
    detail.markdown,
    detail.text,
    detail.content,
    detail.detail,
  ];
  for (const candidate of candidates) {
    const text = textOf(candidate);
    if (text.trim() !== '') return text;
  }
  return '';
}

/**
 * Best-effort plan text from an `exit_plan_mode` tool-call argument object.
 *
 * @param {unknown} args parsed arguments or a raw JSON string
 * @returns {string}
 */
export function planTextFromArgs(args) {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return value.trim();
    }
  }
  if (value === null || typeof value !== 'object') return '';
  for (const key of ['plan', 'plan_text', 'planText', 'text', 'content', 'markdown', 'detail']) {
    const text = textOf(value[key]);
    if (text.trim() !== '') return text;
  }
  return '';
}

/** Tool calls named `exit_plan_mode` in a session-facts object. */
function exitPlanCalls(session) {
  const calls = session !== null && typeof session === 'object' && Array.isArray(session.toolCalls) ? session.toolCalls : [];
  return calls.filter((call) => call !== null && typeof call === 'object' && call.name === PLAN_MODE_TOOL);
}

/**
 * Plan text carried by the last `exit_plan_mode` tool call in the session.
 *
 * @param {object|null} session sessionFacts
 * @returns {{ text: string, callCount: number }}
 */
export function planTextFromSession(session) {
  const calls = exitPlanCalls(session);
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    const text = planTextFromArgs(call.args ?? call.argsRaw ?? null);
    if (text.trim() !== '') return { text, callCount: calls.length };
  }
  return { text: '', callCount: calls.length };
}

/**
 * Plan text from the recorded wire transcript's plan-review request.
 *
 * @param {object[]} wire wire.ndjson rows
 * @returns {{ text: string, review: object|null }}
 */
export function planTextFromWire(wire) {
  const rows = Array.isArray(wire) ? wire : [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    if (row.dir !== 'in') continue;
    const payload = row.payload;
    if (payload === null || typeof payload !== 'object') continue;
    const hasDetail = payload.detail !== undefined || payload.plan !== undefined;
    if (!hasDetail) continue;
    const text = planTextFromDetail(payload.detail ?? payload.plan ?? payload);
    if (text.trim() === '') continue;
    return {
      text,
      review: {
        requestId: payload.requestId ?? payload.id ?? null,
        question: typeof payload.question === 'string' ? payload.question : null,
        options: Array.isArray(payload.options) ? payload.options : null,
        action: null,
        answeredAt: null,
      },
    };
  }
  return { text: '', review: null };
}

/** Normalize whitespace so the two snapshots can be compared meaningfully. */
function normalizeSnapshot(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Extract the submitted plan and cross-check its two snapshots.
 *
 * @param {object} [input]
 * @param {object[]} [input.wire] wire.ndjson rows
 * @param {object|null} [input.session] sessionFacts from `extractSession`
 * @param {object|null} [input.planReview] plan-review.json
 * @param {string} [input.planText] plan.md text
 * @returns {object} `{ text, source, submitted, review, crossCheck, chars, exitPlanCallCount }`
 */
export function extractPlan({ wire = [], session = null, planReview = null, planText = '' } = {}) {
  const reviewDetail = planReview !== null && typeof planReview === 'object' ? planReview.detail : null;
  const detailText = planTextFromDetail(reviewDetail);
  const wirePlan = planTextFromWire(wire);
  const sessionPlan = planTextFromSession(session);
  const planFileText = typeof planText === 'string' ? planText.trim() : '';

  let text = '';
  let source = 'none';
  if (detailText !== '') {
    text = detailText;
    source = 'plan-review';
  } else if (wirePlan.text !== '') {
    text = wirePlan.text;
    source = 'wire';
  } else if (planFileText !== '') {
    text = planFileText;
    source = 'plan-file';
  } else if (sessionPlan.text !== '') {
    text = sessionPlan.text;
    source = 'exit-plan-mode-args';
  }

  let review = null;
  if (planReview !== null && typeof planReview === 'object') {
    review = {
      requestId: planReview.requestId ?? null,
      question: typeof planReview.question === 'string' ? planReview.question : null,
      options: Array.isArray(planReview.options) ? planReview.options : null,
      action: planReview.action ?? null,
      answeredAt: planReview.answeredAt ?? null,
    };
  } else if (wirePlan.review !== null) {
    review = wirePlan.review;
  }

  let crossCheck = null;
  if (detailText !== '' || sessionPlan.text !== '') {
    const detailSnapshot = normalizeSnapshot(detailText);
    const argsSnapshot = normalizeSnapshot(sessionPlan.text);
    crossCheck = {
      argsText: sessionPlan.text !== '',
      detailText: detailText !== '',
      matches: detailSnapshot !== '' && argsSnapshot !== '' ? detailSnapshot === argsSnapshot : null,
      detailChars: detailText.length,
      argsChars: sessionPlan.text.length,
    };
  }

  return {
    text,
    source,
    submitted: sessionPlan.callCount > 0,
    review,
    crossCheck,
    chars: text.length,
    exitPlanCallCount: sessionPlan.callCount,
  };
}

/**
 * Detect the exact arm marker strings in a prompt/plan text.
 *
 * @param {unknown} text
 * @returns {{ budget: boolean, brainstorming: boolean, teamLead: boolean, handoff: boolean }}
 */
export function armMarkers(text) {
  const haystack = typeof text === 'string' ? text : '';
  const markers = {};
  for (const [key, marker] of Object.entries(ARM_MARKER_STRINGS)) {
    markers[key] = haystack.includes(marker);
  }
  return markers;
}

/**
 * Markers a correctly configured arm must show in its injected system prompt.
 *
 * `native` disables the plugin, so the whole guidance section is absent.
 * `evidence` turns off the brainstorming guidance, which also removes the
 * Team-Lead sentence nested inside it, and keeps the budget reminder and the
 * always-on handoff guidance. `full` has every switch on.
 *
 * @param {string} arm arm name (`native`, `evidence`, `full`)
 * @returns {{ budget: boolean, brainstorming: boolean, teamLead: boolean, handoff: boolean }}
 * @throws {Error} on an unknown arm name
 */
export function expectedMarkers(arm) {
  switch (arm) {
    case 'native':
      return { budget: false, brainstorming: false, teamLead: false, handoff: false };
    case 'evidence':
      return { budget: true, brainstorming: false, teamLead: false, handoff: true };
    case 'full':
      return { budget: true, brainstorming: true, teamLead: true, handoff: true };
    default:
      throw new Error(`unknown arm: ${String(arm)}`);
  }
}

/**
 * Compare observed markers against an arm's expectation.
 *
 * @param {string} arm arm name
 * @param {unknown} text injected system-prompt text
 * @returns {object} `{ arm, ok, markers, expected, missing, unexpected }`
 * @throws {Error} on an unknown arm name
 */
export function checkArmIntegrity(arm, text) {
  const expected = expectedMarkers(arm);
  const markers = armMarkers(text);
  const missing = [];
  const unexpected = [];
  for (const key of Object.keys(expected)) {
    if (expected[key] && !markers[key]) missing.push(key);
    if (!expected[key] && markers[key]) unexpected.push(key);
  }
  return {
    arm,
    ok: missing.length === 0 && unexpected.length === 0,
    markers,
    expected,
    missing,
    unexpected,
  };
}

/**
 * Join every recorded system prompt in a session-facts object.
 *
 * @param {object|null} session sessionFacts
 * @returns {string}
 */
export function sessionSystemText(session) {
  if (session === null || typeof session !== 'object') return '';
  return systemPromptText(session);
}
