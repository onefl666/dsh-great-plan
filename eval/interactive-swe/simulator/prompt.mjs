/**
 * Prompts for the scripted user simulator.
 *
 * The simulator plays the issue reporter, not an engineer: it may only reveal
 * information present in the original issue text and must never propose a fix.
 * This mirrors the Ask-or-Assume? evaluation setup, where a constrained user
 * answers clarification questions with withheld information only.
 */

/** Fixed system prompt for every simulated answer. */
export const SIMULATOR_SYSTEM_PROMPT = [
  'You simulate the person who filed the issue below while an engineer plans a fix.',
  'The issue text is your entire authorized knowledge.',
  '- Answer only from the issue text.',
  '- Do not invent requirements, versions, commands, logs, environments, or expected behavior that the issue does not state.',
  '- If the issue does not contain the requested information, say plainly that you do not know or that it is not in the report.',
  '- Never write code, patches, diffs, file names, designs, or implementation steps; you are not the engineer.',
  '- Be concise: one or two sentences per answer.',
  '- Answer every question id exactly once and use the required JSON shape.',
].join('\n');

function issueTextOf(input) {
  if (typeof input?.issueText === 'string' && input.issueText.trim() !== '') return input.issueText.trim();
  const task = input?.task ?? {};
  if (typeof task.original_issue === 'string' && task.original_issue.trim() !== '') return task.original_issue.trim();
  if (typeof task.problem_statement === 'string' && task.problem_statement.trim() !== '') {
    return task.problem_statement.trim();
  }
  return '(missing)';
}

function optionLabels(question) {
  if (!Array.isArray(question?.options)) return [];
  return question.options
    .map((option) => (typeof option === 'string' ? option : option?.label))
    .filter((label) => typeof label === 'string');
}

function renderQuestions(questions) {
  return questions.map((question) => ({
    id: String(question?.id ?? ''),
    question: typeof question?.question === 'string' ? question.question : '',
    options: optionLabels(question),
  }));
}

function renderHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return '(none)';
  const lines = [];
  for (const entry of history) {
    const questions = Array.isArray(entry?.questions) ? entry.questions : [];
    const answers = Array.isArray(entry?.answers) ? entry.answers : [];
    for (const question of questions) {
      lines.push(`Q (${String(question?.id ?? '')}): ${String(question?.question ?? '')}`);
    }
    for (const answer of answers) {
      const selected = Array.isArray(answer?.selected) ? answer.selected.join(', ') : '';
      const custom = typeof answer?.custom === 'string' && answer.custom !== '' ? ` | custom: ${answer.custom}` : '';
      lines.push(`A (${String(answer?.id ?? '')}): ${selected}${custom}`);
    }
  }
  return lines.length === 0 ? '(none)' : lines.join('\n');
}

/**
 * Build the OpenAI-compatible chat messages for one simulator call.
 *
 * @param {{task?: object, questions?: object[], history?: object[], issueText?: string}} input
 * @returns {{role: 'system'|'user', content: string}[]} chat messages
 */
export function buildSimulatorMessages(input = {}) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const questionIds = renderQuestions(questions).map((question) => question.id);
  const content = [
    '## Original issue',
    issueTextOf(input),
    '',
    '## Conversation so far',
    renderHistory(input.history),
    '',
    '## Questions to answer',
    JSON.stringify(renderQuestions(questions), null, 2),
    '',
    '## Response format',
    'Reply with only a JSON object, no prose and no code fences:',
    '{"answers":[{"id":"<question id>","selected":["<option label or your own wording>"]}]}',
    `Answer ids exactly once, in any order: ${JSON.stringify(questionIds)}.`,
    'Use "custom" only when the answer cannot be expressed by an option label.',
  ].join('\n');
  return [
    { role: 'system', content: SIMULATOR_SYSTEM_PROMPT },
    { role: 'user', content },
  ];
}

/** Strip surrounding markdown code fences from a model reply. */
function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Pull the first JSON object out of a reply that contains surrounding prose. */
function extractJsonObject(text) {
  const stripped = stripCodeFences(text);
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('simulator reply contains no JSON object');
    return JSON.parse(stripped.slice(start, end + 1));
  }
}

/**
 * Parse and validate a simulator reply.
 *
 * @param {string} text raw model text
 * @param {string[]} questionIds ids that must be answered exactly once
 * @returns {{id: string, selected: string[], custom?: string}[]} normalized answers
 * @throws {Error} when the reply is malformed, missing an id, or duplicates one
 */
export function parseSimulatorAnswer(text, questionIds) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('simulator reply is empty');
  const expected = (Array.isArray(questionIds) ? questionIds : []).map((id) => String(id));
  const expectedSet = new Set(expected);
  let payload;
  try {
    payload = extractJsonObject(text);
  } catch (error) {
    throw new Error(`simulator reply is not valid JSON: ${error.message}`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.answers)) {
    throw new Error('simulator reply must be an object with an answers array');
  }
  const seen = new Set();
  const answers = [];
  for (const raw of payload.answers) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('simulator answer must be an object');
    if (typeof raw.id !== 'string' || !expectedSet.has(raw.id)) throw new Error(`simulator answered an unknown question id: ${String(raw.id)}`);
    if (seen.has(raw.id)) throw new Error(`simulator answered question id more than once: ${raw.id}`);
    if (!Array.isArray(raw.selected) || !raw.selected.every((label) => typeof label === 'string')) {
      throw new Error(`simulator answer ${raw.id} must have a selected string array`);
    }
    const answer = { id: raw.id, selected: [...raw.selected] };
    if (raw.custom !== undefined) {
      if (typeof raw.custom !== 'string') throw new Error(`simulator answer ${raw.id} custom must be a string`);
      answer.custom = raw.custom;
    }
    if (answer.selected.length === 0 && (answer.custom === undefined || answer.custom.trim() === '')) {
      throw new Error(`simulator answer ${raw.id} must select an option or provide custom text`);
    }
    seen.add(raw.id);
    answers.push(answer);
  }
  for (const id of expected) {
    if (!seen.has(id)) throw new Error(`simulator did not answer question id: ${id}`);
  }
  return answers;
}
