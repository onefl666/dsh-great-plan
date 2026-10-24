import { selectPlanCompactionRange } from './plan-range.js';

const USAGE = 'Usage: /great-plan-compact (no arguments)';

const FAILURES = {
  busy: 'Compaction is unavailable because another compaction is running.',
  changed: 'The history selected for compaction changed during the attempt.',
  summary: 'Compaction could not produce a useful summary.',
  commit: 'Compaction did not finish cleanly.',
  persistence: 'Compaction finished, but the session could not be saved.',
  cancelled: 'Compaction was cancelled.',
};

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createCompactCommand({ getProjections, getCompaction, getBalancedAfter }) {
  return {
    name: 'great-plan-compact',
    description: 'Compact older plan history before executing (used by Great Plan).',
    async handler(invocation) {
      if (invocation.rawInput.trim() !== '') return { kind: 'error', text: USAGE };
      const { agent, signal } = invocation;

      let plan;
      try {
        const projections = getProjections();
        if (projections?.stateOf === undefined) return { kind: 'error', text: 'Plan state is unavailable in this composition.' };
        plan = projections.stateOf(agent.session, 'plan');
      } catch (error) {
        return { kind: 'error', text: `Plan state is unavailable: ${messageOf(error)}` };
      }
      if (plan?.active !== true) return { kind: 'error', text: 'Plan mode is not active; nothing to compact.' };

      let compaction;
      try {
        compaction = getCompaction();
      } catch (error) {
        return { kind: 'error', text: `Compaction is unavailable: ${messageOf(error)}` };
      }
      if (compaction?.compactRegion === undefined) return { kind: 'error', text: 'Compaction is unavailable because no compaction backend is composed.' };

      let balancedAfter;
      try {
        balancedAfter = await getBalancedAfter();
      } catch (error) {
        return { kind: 'error', text: `Compaction is unavailable because the compaction package could not be loaded: ${messageOf(error)}` };
      }

      let range;
      try {
        range = selectPlanCompactionRange(agent.session, balancedAfter);
      } catch (error) {
        return { kind: 'error', text: `Unable to inspect plan history: ${messageOf(error)}` };
      }
      if (range.error === 'no-review') return { kind: 'error', text: 'There is no pending plan review to compact.' };
      if (range.error === 'empty') return { kind: 'error', text: 'No compactable history exists before the pending plan.' };

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
