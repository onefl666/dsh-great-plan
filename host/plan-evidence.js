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
 *
 * @param {object} [options]
 * @param {boolean} [options.brainstorming] whether the brainstorming paragraph is injected.
 * @param {boolean} [options.unlimitedBudget] whether the budget reminder is injected.
 * @returns {string} the assembled section text.
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
 *
 * @param {object | undefined} config the plugin config passed to `apply`.
 * @param {string} field the config field to read.
 * @param {boolean} fallback value used when the field is missing or unreadable.
 * @returns {boolean} the switch value.
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

/**
 * Read the brainstorming switch; defaults to enabled.
 *
 * @param {object | undefined} config the plugin config passed to `apply`.
 * @returns {boolean} whether the brainstorming guidance is injected.
 */
export function readBrainstormingEnabled(config) {
  return readConfigSwitch(config, 'injectBrainstormingPrompt', true);
}

/**
 * Read the unlimited-token-budget switch; defaults to enabled.
 *
 * @param {object | undefined} config the plugin config passed to `apply`.
 * @returns {boolean} whether the budget reminder is injected.
 */
export function readUnlimitedBudgetEnabled(config) {
  return readConfigSwitch(config, 'injectUnlimitedBudgetPrompt', true);
}

/**
 * Resolve the section text from the plan projection and both switches.
 *
 * Mirrors the native `plan:policy` gate: a pending selection wins over the
 * logged state, so both sections appear and disappear at the same step
 * boundary. Every missing or failing input returns empty text; prompt
 * assembly must never fail because plan state is unavailable.
 *
 * @param {object | undefined} planMode the Host plan projection service.
 * @param {object | undefined} agent the agent whose plan state is read.
 * @param {boolean} [brainstorming] whether the brainstorming paragraph is injected.
 * @param {boolean} [unlimitedBudget] whether the budget reminder is injected.
 * @returns {string} the section text, or empty when plan mode is inactive.
 */
export function planEvidenceText(planMode, agent, brainstorming = true, unlimitedBudget = true) {
  if (agent === undefined || agent === null) return '';
  if (planMode === undefined || planMode === null || typeof planMode.get !== 'function') return '';
  let state;
  try {
    state = planMode.get(agent);
  } catch {
    return '';
  }
  if (state === undefined || state === null) return '';
  const active = state.pending === undefined ? state.active === true : state.pending === true;
  if (!active) return '';
  return composePlanGuidance({ brainstorming, unlimitedBudget });
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
 *
 * @param {object | undefined} agent the agent whose session is assembled.
 * @param {() => object | undefined} [getPlanMode] host-plane planMode reader.
 * @param {() => object | undefined} [getSessionProjections] projection service reader.
 * @returns {boolean} whether plan mode is active for this step's assembly.
 */
export function readPlanModeActive(agent, getPlanMode, getSessionProjections) {
  if (agent === undefined || agent === null) return false;
  // 1. The agent-scoped planMode instance: `get()` returns the logged state
  //    plus a pending selection whose boolean is the selected direction.
  try {
    const scoped = agent.ctx?.get?.('planMode');
    if (scoped !== undefined && scoped !== null && typeof scoped.get === 'function') {
      const state = scoped.get(agent);
      if (state !== undefined && state !== null && typeof state === 'object' && typeof state.active === 'boolean') {
        return state.pending === undefined ? state.active : state.pending;
      }
    }
  } catch {
    // Fall through to the next source.
  }
  // 2. The host-plane planMode instance.
  try {
    const host = typeof getPlanMode === 'function' ? getPlanMode() : undefined;
    if (host !== undefined && host !== null && typeof host.get === 'function') {
      const state = host.get(agent);
      if (state !== undefined && state !== null && typeof state === 'object' && typeof state.active === 'boolean') {
        return state.pending === undefined ? state.active : state.pending;
      }
    }
  } catch {
    // Fall through to the next source.
  }
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
 * @returns the Cordis effect disposer.
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
      try {
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
      } catch {
        return '';
      }
    },
  });
}
