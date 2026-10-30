import { selectPlanCompactionRange } from './plan-range.js';

/** The plan-review tool call that marks the pending plan review surface node. */
export const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode';

/** The command accepts no arguments; this is its user-visible usage line. */
export const USAGE = 'Usage: /great-plan-compact (no arguments)';

/**
 * Stable manual-compaction error codes mapped to user text.
 *
 * Every value is user-visible; the Client mirrors each string in
 * `COMPACT_MESSAGE_KEYS` so it can be localized (cross-side test).
 */
export const FAILURES = {
  busy: 'Compaction is unavailable because another compaction is running.',
  changed: 'The history selected for compaction changed during the attempt.',
  summary: 'Compaction could not produce a useful summary.',
  commit: 'Compaction did not finish cleanly.',
  persistence: 'Compaction finished, but the session could not be saved.',
  cancelled: 'Compaction was cancelled.',
};

/**
 * Static command failure messages, also mirrored by the Client's
 * `COMPACT_MESSAGE_KEYS`. Dynamic messages (`...: ${messageOf(error)}`) are
 * intentionally not listed and fall back to raw English when unmapped.
 */
export const MESSAGES = {
  planStateUnavailable: 'Plan state is unavailable in this composition.',
  planInactive: 'Plan mode is not active; nothing to compact.',
  backendUnavailable: 'Compaction is unavailable because no compaction backend is composed.',
  noReview: 'There is no pending plan review to compact.',
  empty: 'No compactable history exists before the pending plan.',
};

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createCompactCommand({ getProjections, getCompaction, getBalancedAfter }) {
  return {
    name: 'great-plan-compact',
    description: 'Compact older plan history before executing (used by Great Plan).',
    async handler(invocation) {
      const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';
      if (rawInput !== '') return { kind: 'error', text: USAGE };
      const { agent, signal } = invocation ?? {};

      let plan;
      try {
        const projections = getProjections();
        if (projections?.stateOf === undefined) return { kind: 'error', text: MESSAGES.planStateUnavailable };
        plan = projections.stateOf(agent.session, 'plan');
      } catch (error) {
        return { kind: 'error', text: `Plan state is unavailable: ${messageOf(error)}` };
      }
      if (plan?.active !== true) return { kind: 'error', text: MESSAGES.planInactive };

      let compaction;
      try {
        compaction = getCompaction();
      } catch (error) {
        return { kind: 'error', text: `Compaction is unavailable: ${messageOf(error)}` };
      }
      if (compaction?.compactRegion === undefined) return { kind: 'error', text: MESSAGES.backendUnavailable };

      let balancedAfter;
      try {
        balancedAfter = await getBalancedAfter();
      } catch (error) {
        return { kind: 'error', text: `Compaction is unavailable because the compaction package could not be loaded: ${messageOf(error)}` };
      }

      let range;
      try {
        range = selectPlanCompactionRange(agent.session, balancedAfter, { planReviewTool: EXIT_PLAN_MODE_TOOL });
      } catch (error) {
        return { kind: 'error', text: `Unable to inspect plan history: ${messageOf(error)}` };
      }
      if (range.error === 'no-review') return { kind: 'error', text: MESSAGES.noReview };
      if (range.error === 'empty') return { kind: 'error', text: MESSAGES.empty };

      try {
        const result = await compaction.compactRegion(range.start, range.end, agent, signal);
        const items = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : 0;
        const tokens = Number.isFinite(result?.shadowedTokenCount) ? result.shadowedTokenCount : 0;
        return { kind: 'success', text: `Compacted ${items} history items (~${tokens} tokens).` };
      } catch (error) {
        if (signal?.aborted) return { kind: 'error', text: FAILURES.cancelled };
        const code = typeof error?.code === 'string' ? error.code : undefined;
        return { kind: 'error', text: (code !== undefined && FAILURES[code]) || messageOf(error) };
      }
    },
  };
}
