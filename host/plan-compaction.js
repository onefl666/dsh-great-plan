import { EXIT_PLAN_MODE_TOOL, selectPlanCompactionRange } from './plan-range.js';

// The canonical name lives in plan-range.js; re-exported for existing importers.
export { EXIT_PLAN_MODE_TOOL };

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

/**
 * Resolve the composed compaction service for one agent.
 *
 * Presets isolate their mounted services, so the agent's preset group owns its
 * `compaction` instance while the host-plane read only sees globally mounted
 * compositions. The agent-scoped context is the middle step; the preset
 * registry is the authoritative source when it exposes the service.
 *
 * @param {object | undefined} agent the agent executing the command.
 * @param {object} [accessors] service readers supplied by the composition.
 * @param {() => object | undefined} [accessors.getAgentPresets] host-plane preset registry reader.
 * @param {(agent: object | undefined) => object | undefined} [accessors.getCompaction] host-plane compaction reader.
 * @returns {object | undefined} the first service that exposes `compactRegion`.
 */
export function resolveCompactionService(agent, { getAgentPresets, getCompaction } = {}) {
  if (agent !== undefined && agent !== null) {
    // 1. The service mounted in the agent's preset group.
    try {
      const scoped = typeof getAgentPresets === 'function'
        ? getAgentPresets()?.serviceFor?.(agent, 'compaction')
        : undefined;
      if (scoped?.compactRegion !== undefined) return scoped;
    } catch {
      // An absent or unreadable preset registry falls through.
    }
    // 2. The service mounted in the agent's scoped context.
    try {
      const scoped = agent?.ctx?.get?.('compaction');
      if (scoped?.compactRegion !== undefined) return scoped;
    } catch {
      // An unreadable scoped context falls through.
    }
  }
  // 3. The host-plane service; a throwing read stays visible to the caller.
  const fallback = typeof getCompaction === 'function' ? getCompaction(agent) : undefined;
  return fallback?.compactRegion !== undefined ? fallback : undefined;
}

export function createCompactCommand({ getProjections, getCompaction, getBalancedAfter, getAgentPresets }) {
  return {
    name: 'great-plan-compact',
    description: 'Compact older plan history before executing (used by Great Plan).',
    async handler(invocation) {
      const args = invocation ?? {};
      const rawInput = typeof args.rawInput === 'string' ? args.rawInput.trim() : '';
      if (rawInput !== '') return { kind: 'error', text: USAGE };
      const { agent, signal } = args;

      let plan;
      try {
        const projections = getProjections();
        if (typeof projections?.snapshot !== 'function') return { kind: 'error', text: MESSAGES.planStateUnavailable };
        plan = projections.snapshot(agent.session, ['plan'])?.values?.plan;
      } catch (error) {
        return { kind: 'error', text: `Plan state is unavailable: ${messageOf(error)}` };
      }
      if (plan?.active !== true) return { kind: 'error', text: MESSAGES.planInactive };

      let compaction;
      try {
        compaction = resolveCompactionService(agent, { getAgentPresets, getCompaction });
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
        return { kind: 'error', text: Object.hasOwn(FAILURES, code) ? FAILURES[code] : messageOf(error) };
      }
    },
  };
}
