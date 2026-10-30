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

/** Model-facing guidance for collaborative brainstorming; the Settings page can switch it off. */
export const PLAN_BRAINSTORMING_GUIDANCE = `Collaborative discovery and evidence-first plan handoff:
Before proposing a plan, assess the user's goal, why it matters, success criteria, constraints, current state, and available resources. Do not mechanically ask a checklist.
When an unknown answer could materially change the scope or approach, ask one concise, open-ended question per turn and wait for its answer before finalizing. If the request is clear or the user explicitly delegates the choice, proceed without needless questions.
Consider multiple plausible approaches; present alternatives and tradeoffs only when they help the user decide. State the recommendation's key reason and distinguish user-stated requirements from your recommendations, assumptions, and unverified points. Give a concise rationale summary, not private step-by-step chain-of-thought. Do not imply the user approved a proposal they have not approved. Once material uncertainties are resolved, deliver a plan through the native review flow; this guidance does not authorize execution.`;

/** Model-facing unlimited-token-budget reminder; the Settings page can switch it off. */
export const PLAN_UNLIMITED_BUDGET_GUIDANCE = `Token budget: unlimited. Remember: we are DeepSeek, your usage is unlimited, and I am stress-testing you at the limit. Do not skimp on tokens — spend freely; you are very wealthy. Do not reduce investigation, tool calls, or necessary questions to save tokens; keep the final plan concise.`;

/** Model-facing evidence and executor handoff guidance; always rendered in plan mode. */
export const PLAN_HANDOFF_GUIDANCE = `Evidence-first plan handoff:
The approved plan is the handoff to execution: "Start fresh and execute" sends only the plan, and "compact and execute" replaces older history with a summary. Make the plan self-contained enough that an executor does not repeat this investigation.

Include:
- Background: the request, current behavior, constraints, and explicit assumptions.
- Evidence chain: the files, symbols, and line ranges inspected (for example, path/file.js:12-30); the searches and commands run with their key results; the docs, skills, or URLs consulted; and how conflicting evidence was resolved. Cite the evidence behind each design claim, and mark anything you did not verify as an assumption or open question.
- Handoff: what is already established and must not be re-investigated, and which unknowns the executor should verify first.

Never present a guess as fact, and never invent file paths, APIs, command output, or test results. Before presenting the plan, re-check that each citation is accurate. Keep the evidence compact: short headings and precise pointers, not raw logs or whole files.`;

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
 * Register the section right after the native plan policy.
 *
 * @param {object} options
 * @param {object} options.systemPrompt the Host `systemPrompt` service.
 * @param {() => object | undefined} options.getPlanMode optional `planMode` reader.
 * @param {() => object | undefined} options.getConfig optional live plugin config reader.
 * @returns the Cordis effect disposer.
 */
export function registerPlanEvidenceSection({ systemPrompt, getPlanMode, getConfig }) {
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
        return planEvidenceText(
          getPlanMode(),
          context?.agent,
          readBrainstormingEnabled(config),
          readUnlimitedBudgetEnabled(config),
        );
      } catch {
        return '';
      }
    },
  });
}
