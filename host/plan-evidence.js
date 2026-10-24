/**
 * Evidence-first plan handoff prompt section.
 *
 * Plan mode already renders the deployment's native `plan:policy` guidance.
 * This plugin adds one independent section immediately after it, asking the
 * planner to hand over its investigation together with the plan. The native
 * policy text is never replaced or duplicated.
 */

/** Prompt section name; unique in the global prompt layer. */
export const PLAN_EVIDENCE_SECTION = 'great-plan:plan-evidence';

/** Used when the instance cannot resolve the centrally owned PLAN_POLICY order. */
export const PLAN_EVIDENCE_ORDER_FALLBACK = 501;

/** Model-facing guidance appended while plan mode is active. */
export const PLAN_EVIDENCE_GUIDANCE = `Evidence-first plan handoff:
The approved plan is the handoff to execution: "Start fresh and execute" sends only the plan, and "compact and execute" replaces older history with a summary. Make the plan self-contained enough that an executor does not repeat this investigation.

Include:
- Background: the request, current behavior, constraints, and explicit assumptions.
- Evidence chain: the files, symbols, and line ranges inspected (for example, path/file.js:12-30); the searches and commands run with their key results; the docs, skills, or URLs consulted; and how conflicting evidence was resolved. Cite the evidence behind each design claim, and mark anything you did not verify as an assumption or open question.
- Handoff: what is already established and must not be re-investigated, and which unknowns the executor should verify first.

Never present a guess as fact, and never invent file paths, APIs, command output, or test results. Before presenting the plan, re-check that each citation is accurate. Keep the evidence compact: short headings and precise pointers, not raw logs or whole files.`;

/**
 * Resolve the section text from the plan projection.
 *
 * Mirrors the native `plan:policy` gate: a pending selection wins over the
 * logged state, so both sections appear and disappear at the same step
 * boundary. Every missing or failing input returns empty text; prompt
 * assembly must never fail because plan state is unavailable.
 */
export function planEvidenceText(planMode, agent) {
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
  return active ? PLAN_EVIDENCE_GUIDANCE : '';
}

/**
 * Register the section right after the native plan policy.
 *
 * @param {object} options
 * @param {object} options.systemPrompt the Host `systemPrompt` service.
 * @param {() => object | undefined} options.getPlanMode optional `planMode` reader.
 * @returns the Cordis effect disposer.
 */
export function registerPlanEvidenceSection({ systemPrompt, getPlanMode }) {
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
        return planEvidenceText(getPlanMode(), context?.agent);
      } catch {
        return '';
      }
    },
  });
}
