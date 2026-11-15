/** The plan-review tool call that marks the pending plan review surface node. */
export const EXIT_PLAN_MODE_TOOL = 'exit_plan_mode';

/** The PTC Program executor tool; nested dispatches run inside its call. */
const RUN_CODE_TOOL = 'run_code';

/**
 * Whether a PTC turn started a nested plan-review dispatch that has not settled.
 *
 * Under the PTC executor the native plan-review tool is dispatched inside a
 * `run_code` program, so the surface only carries the parent `run_code` call
 * while the nested `exit_plan_mode` starts (and settles) as log-only
 * `tool/ptc-dispatch-start` / `tool/ptc-dispatch` events. This scans only the
 * events after the last surface node, pairs the dispatch events by
 * `subCallId`, and reports true while one plan-review dispatch is still open.
 *
 * Missing or throwing synchronous readers degrade to false; the caller then
 * keeps its canonical `no-review` result.
 */
function hasUnsettledNestedPlanReview(session, planReviewTool) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  const lastSeq = nodes[nodes.length - 1];
  const last = typeof session.eventAt === 'function' ? session.eventAt(lastSeq) : undefined;
  if (last?.type !== 'assistant/message') return false;
  const content = last.data?.message?.content;
  if (!Array.isArray(content) || !content.some((block) => block?.type === 'tool-call' && block.name === RUN_CODE_TOOL)) {
    return false;
  }
  if (typeof session.snapshotEvents !== 'function') return false;
  let events;
  try {
    events = session.snapshotEvents(lastSeq + 1);
  } catch {
    return false;
  }
  if (events === null || events === undefined || typeof events[Symbol.iterator] !== 'function') return false;
  const pending = new Set();
  for (const event of events) {
    if (event?.type === 'tool/ptc-dispatch-start' && event.data?.name === planReviewTool) {
      const subCallId = event.data?.subCallId;
      if (typeof subCallId === 'string' && subCallId !== '') pending.add(subCallId);
    } else if (event?.type === 'tool/ptc-dispatch') {
      const subCallId = event.data?.subCallId;
      if (typeof subCallId === 'string') pending.delete(subCallId);
    }
  }
  return pending.size > 0;
}

/**
 * Pure plan-compaction range selection.
 *
 * The pending plan review is the last surface node: an assistant message
 * carrying the plan-review tool call (`exit_plan_mode`), or a PTC `run_code`
 * turn with an unsettled nested plan-review dispatch. The compactable range
 * starts right after the leading system messages and ends at the last balanced
 * node before that review, snapping backwards until the tool pairing holds.
 */
export function selectPlanCompactionRange(session, balancedAfter, options = {}) {
  const planReviewTool = typeof options.planReviewTool === 'string'
    ? options.planReviewTool
    : EXIT_PLAN_MODE_TOOL;
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return { error: 'empty' };
  const last = session.eventAt(nodes[nodes.length - 1]);
  const nativeReview = last?.type === 'assistant/message'
    && Array.isArray(last.data?.message?.content)
    && last.data.message.content.some((block) => block?.type === 'tool-call' && block.name === planReviewTool);
  if (!nativeReview && !hasUnsettledNestedPlanReview(session, planReviewTool)) {
    return { error: 'no-review' };
  }

  let startIndex = 0;
  while (startIndex < nodes.length && session.eventAt(nodes[startIndex])?.type === 'system/message') startIndex += 1;

  let endIndex = nodes.length - 2;
  while (endIndex >= startIndex) {
    if (balancedAfter(session, nodes[endIndex]) === true) break;
    endIndex -= 1;
  }
  if (endIndex < startIndex) return { error: 'empty' };
  return { start: nodes[startIndex], end: nodes[endIndex] };
}
