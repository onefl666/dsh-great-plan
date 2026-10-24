export function selectPlanCompactionRange(session, balancedAfter) {
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return { error: 'empty' };
  const last = session.eventAt(nodes[nodes.length - 1]);
  if (last?.type !== 'assistant/message') return { error: 'no-review' };
  const content = last.data?.message?.content;
  if (!Array.isArray(content) || !content.some((block) => block?.type === 'tool-call')) return { error: 'no-review' };

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
