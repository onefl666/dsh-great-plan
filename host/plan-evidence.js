/**
 * Evidence-first plan handoff prompt section.
 *
 * Plan mode already renders the deployment's native `plan:policy` guidance.
 * This plugin adds one independent section immediately after it, asking the
 * planner to hand over its investigation together with the plan. It also carries
 * an optional unlimited-token-budget reminder and a brainstorming paragraph,
 * each independently switchable from the Settings page. The native policy text
 * is never replaced or duplicated.
 */

/** Prompt section name; unique in the global prompt layer. */
export const PLAN_EVIDENCE_SECTION = 'great-plan:plan-evidence';

/** Used when the instance cannot resolve the centrally owned PLAN_POLICY order. */
export const PLAN_EVIDENCE_ORDER_FALLBACK = 501;

/** Model-facing collaborative-discovery and Team-Lead guidance; the Settings page can switch it off. */
export const PLAN_BRAINSTORMING_GUIDANCE = `Discovery and delegation:
- Assess the goal, success criteria, constraints, and current state; do not quiz the user with a checklist.
- If an answer could materially change scope or approach, ask one concise question per turn and wait. If the request is clear or the user delegates the choice, proceed.
- You are the Team Lead. Use \`spawn_teammate\` to start at least 2 exploration teammates in parallel, each with one distinct, concrete scope, and require concise findings cited as path:line-range. Do not investigate their scopes yourself; collect all results and resolve conflicts.
- Then spawn 1 separate planning teammate to draft a candidate plan from the consolidated evidence. Verify the evidence and the draft yourself before submitting.
- If \`spawn_teammate\` is unavailable or fails, say so in the plan and continue alone; never invent teammate work.
- Show alternatives and tradeoffs only when they help the user decide; state the key reason for your recommendation.
- Separate user requirements from your recommendations, assumptions, and unverified points. Give a brief rationale, not step-by-step chain-of-thought.`;

/** Model-facing unlimited-token-budget reminder; the Settings page can switch it off. */
export const PLAN_UNLIMITED_BUDGET_GUIDANCE = 'Token budget: unlimited. Never cut investigation, tool calls, or needed questions to save tokens; keep the final plan concise.';

/** Model-facing evidence and executor handoff guidance; always rendered in plan mode. */
export const PLAN_HANDOFF_GUIDANCE = `Plan as handoff (the executor may get only this plan or a compacted history, so make it self-contained):
- Background: request, current behavior, constraints, assumptions.
- Evidence: files/symbols with line ranges (e.g. path/file.js:12-30), searches and commands with key results, docs/skills/URLs used, and how conflicts were resolved. Cite evidence for each design claim; mark anything unverified as an assumption or open question.
- Handoff: what is settled and must not be re-investigated; which unknowns to verify first.
Never present a guess as fact or invent paths, APIs, command output, or test results. Re-check citations before submitting. Keep evidence compact: precise pointers, not raw logs or whole files.`;

/** Default guidance (every switch on) appended while plan mode is active. */
export const PLAN_EVIDENCE_GUIDANCE = `${PLAN_UNLIMITED_BUDGET_GUIDANCE}\n\n${PLAN_BRAINSTORMING_GUIDANCE}\n\n${PLAN_HANDOFF_GUIDANCE}`;

/**
 * Compose the plan-mode guidance from its independently switchable parts.
 *
 * The budget reminder comes first as a general instruction, then the optional
 * brainstorming guidance, and the evidence/handoff guidance always closes the
 * section. Disabled parts are omitted entirely, never replaced by placeholders.
 * With every switch on the precomputed `PLAN_EVIDENCE_GUIDANCE` constant is
 * returned so the common path allocates nothing per prompt assembly.
 */
export function composePlanGuidance({ brainstorming = true, unlimitedBudget = true } = {}) {
  if (brainstorming !== false && unlimitedBudget !== false) return PLAN_EVIDENCE_GUIDANCE;
  const parts = [];
  if (unlimitedBudget !== false) parts.push(PLAN_UNLIMITED_BUDGET_GUIDANCE);
  if (brainstorming !== false) parts.push(PLAN_BRAINSTORMING_GUIDANCE);
  parts.push(PLAN_HANDOFF_GUIDANCE);
  return parts.join('\n\n');
}

/**
 * Read one switch from the plugin config.
 *
 * A volatile field arrives as a reference object; plain booleans are accepted
 * for tests and hand-written rows. Every missing, malformed, or unreadable
 * value keeps the fallback so prompt assembly never fails.
 */
function readConfigSwitch(config, field, fallback) {
  if (config === undefined || config === null || typeof config !== 'object') return fallback;
  let value;
  try {
    value = config[field];
  } catch {
    return fallback;
  }
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value.get === 'function') {
    try {
      const live = value.get();
      return typeof live === 'boolean' ? live : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** Read the brainstorming switch; defaults to enabled. */
export function readBrainstormingEnabled(config) {
  return readConfigSwitch(config, 'injectBrainstormingPrompt', true);
}

/** Read the unlimited-token-budget switch; defaults to enabled. */
export function readUnlimitedBudgetEnabled(config) {
  return readConfigSwitch(config, 'injectUnlimitedBudgetPrompt', true);
}

/**
 * Resolve one boolean-validated plan-mode state from a planMode-like service.
 *
 * A usable state exposes a boolean `active`; a pending selection overrides the
 * logged state. Missing, malformed, or throwing reads return `undefined` so the
 * caller can try its next source.
 */
function readPlanModeState(readService, agent) {
  try {
    const service = readService();
    if (service === undefined || service === null || typeof service.get !== 'function') return undefined;
    const state = service.get(agent);
    if (state !== undefined && state !== null && typeof state === 'object' && typeof state.active === 'boolean') {
      return state.pending === undefined ? state.active : state.pending === true;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Decide whether plan mode is active for the step being assembled.
 *
 * The Host plane cannot rely on its own `planMode` instance: agent presets
 * commonly mount the plan-mode plugin in an isolated group, so the host-plane
 * instance does not see the state that the preset drives. The agent's own
 * scoped context (`agent.ctx`) carries the instance that owns the session's
 * plan state and the pending selection's direction — the same data source the
 * native `plan:policy` section reads. The host-plane instance is the fallback
 * for compositions where plan mode is host-owned, and the shared `plan`
 * session projection (the unit the compaction command also reads) is the final
 * synchronous fallback. Every source degrades to inactive instead of throwing.
 */
export function readPlanModeActive(agent, getPlanMode, getSessionProjections) {
  if (agent === undefined || agent === null) return false;
  // 1. The agent-scoped planMode instance: `get()` returns the logged state
  //    plus a pending selection whose boolean is the selected direction.
  const scoped = readPlanModeState(() => agent.ctx?.get?.('planMode'), agent);
  if (scoped !== undefined) return scoped;
  // 2. The host-plane planMode instance.
  const host = readPlanModeState(() => (typeof getPlanMode === 'function' ? getPlanMode() : undefined), agent);
  if (host !== undefined) return host;
  // 3. The shared `plan` projection's cropped view { active, pending }. The
  //    pending direction is not exposed here, so a pending selection counts as
  //    active; by assembly time the pre-step has already applied pending
  //    selections, which makes this equivalent to the native section's gate.
  try {
    const projections = typeof getSessionProjections === 'function' ? getSessionProjections() : undefined;
    const session = agent?.session;
    if (projections !== undefined && projections !== null && session !== undefined && typeof projections.snapshot === 'function') {
      const state = projections.snapshot(session, ['plan'])?.values?.plan;
      if (state !== undefined && state !== null && typeof state === 'object' && typeof state.active === 'boolean') {
        return state.active === true || state.pending === true;
      }
    }
  } catch {
    // No usable plan state anywhere; treat the step as outside plan mode.
  }
  return false;
}

/**
 * Register the section right after the native plan policy.
 *
 * @param {object} options
 * @param {object} options.systemPrompt the Host `systemPrompt` service.
 * @param {() => object | undefined} options.getPlanMode optional host-plane `planMode` reader.
 * @param {() => object | undefined} [options.getSessionProjections] optional projection service reader.
 * @param {() => object | undefined} options.getConfig optional live plugin config reader.
 */
export function registerPlanEvidenceSection({ systemPrompt, getPlanMode, getSessionProjections, getConfig }) {
  let order = PLAN_EVIDENCE_ORDER_FALLBACK;
  try {
    const resolved = typeof systemPrompt.getSectionOrder === 'function'
      ? systemPrompt.getSectionOrder('PLAN_POLICY')
      : undefined;
    if (Number.isFinite(resolved)) order = resolved + 1;
  } catch {
    // Keep the fallback order; an unavailable central table must not break the plugin.
  }
  return systemPrompt.section({
    name: PLAN_EVIDENCE_SECTION,
    order,
    text: (context) => {
      let config;
      try {
        config = typeof getConfig === 'function' ? getConfig() : undefined;
      } catch {
        config = undefined;
      }
      if (!readPlanModeActive(context?.agent, getPlanMode, getSessionProjections)) return '';
      return composePlanGuidance({
        brainstorming: readBrainstormingEnabled(config),
        unlimitedBudget: readUnlimitedBudgetEnabled(config),
      });
    },
  });
}
