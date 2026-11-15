/**
 * Clarification ("ask or assume") statistics.
 *
 * Questions arrive through two recorded channels: `questions.ndjson` rows,
 * which capture each `ask_user_question` exchange and its decision, and the
 * session's `ask_user_question` tool calls. The row file is authoritative for
 * decisions and cap hits; tool calls fill in calls whose question row was never
 * written (for example a cancelled request).
 */
import { ASK_TOOL } from '../session/events.mjs';

/** Round to four decimals for stable report output. */
function round(value) {
  return Math.round(value * 10000) / 10000;
}

/** Number of questions carried by one `ask_user_question` argument object. */
function questionCountFromArgs(args) {
  if (args === null || typeof args !== 'object') return 0;
  if (Array.isArray(args.questions)) return args.questions.length;
  if (args.question !== undefined) return 1;
  return 0;
}

/** Count entries in a `answers` payload of any supported shape. */
function answerCount(answers) {
  if (Array.isArray(answers)) return answers.length;
  if (answers !== null && typeof answers === 'object') return Object.keys(answers).length;
  return 0;
}

/**
 * Compute clarification metrics for one task.
 *
 * @param {object} [input]
 * @param {object|null} [input.session] sessionFacts
 * @param {object[]} [input.questions] questions.ndjson rows
 * @returns {object} clarification stats
 */
export function clarificationStats({ session = null, questions = [] } = {}) {
  const allRows = Array.isArray(questions) ? questions.filter((row) => row !== null && typeof row === 'object') : [];
  // The plan review is recorded in questions.ndjson too; it is not a
  // clarification exchange and must never count toward ask-rate metrics.
  const isPlanReviewRow = (row) => Array.isArray(row.questions)
    && row.questions.length > 0
    && row.questions.every((question) => question?.id === 'plan-review' || question?.intent?.kind === 'plan-review');
  const planReviewRows = allRows.filter(isPlanReviewRow);
  const rows = allRows.filter((row) => !isPlanReviewRow(row));
  const toolCalls =
    session !== null && typeof session === 'object' && Array.isArray(session.toolCalls) ? session.toolCalls : [];
  const askCalls = toolCalls.filter((call) => call !== null && typeof call === 'object' && call.name === ASK_TOOL);

  const callCounts = askCalls.map((call) => questionCountFromArgs(call.args));
  const rowCounts = rows.map((row) => (Array.isArray(row.questions) ? row.questions.length : questionCountFromArgs(row)));
  const questionCounts = rows.length > 0 ? rowCounts : callCounts;
  const askCount = Math.max(askCalls.length, rows.length, questionCounts.length);

  const distribution = {};
  for (const count of questionCounts) {
    const key = String(count);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  const totalQuestions = questionCounts.reduce((sum, count) => sum + count, 0);
  const oneQuestionCalls = questionCounts.filter((count) => count === 1).length;
  const maxQuestions = questionCounts.reduce((max, count) => Math.max(max, count), 0);

  const decisionCounts = { answer: 0, cancel: 0, approve: 0, reject: 0, other: 0 };
  let capHits = 0;
  let errors = 0;
  let answeredQuestions = 0;
  for (const row of rows) {
    const decision = typeof row.decision === 'string' ? row.decision : 'other';
    if (Object.hasOwn(decisionCounts, decision)) decisionCounts[decision] += 1;
    else decisionCounts.other += 1;
    if (row.capHit === true) capHits += 1;
    if (row.error !== undefined && row.error !== null) errors += 1;
    answeredQuestions += answerCount(row.answers);
  }

  return {
    askCalls: askCalls.length,
    askCount,
    questionRows: rows.length,
    planReviewRows: planReviewRows.length,
    planReviewCancelled: planReviewRows.filter((row) => row.decision === 'cancel').length,
    totalQuestions,
    distribution,
    maxQuestions,
    oneQuestionCalls,
    oneQuestionRatio: askCount === 0 ? null : round(oneQuestionCalls / askCount),
    multiQuestionCalls: questionCounts.filter((count) => count > 1).length,
    questionsPerAsk: askCount === 0 ? null : round(totalQuestions / askCount),
    decisionsRecorded: rows.length,
    decisionCounts,
    answeredCalls: decisionCounts.answer,
    approvedCalls: decisionCounts.approve,
    cancelledCalls: decisionCounts.cancel,
    rejectedCalls: decisionCounts.reject,
    answeredQuestions,
    capHits,
    capHit: capHits > 0,
    errors,
    taskWithAsk: askCalls.length > 0 || rows.length > 0,
  };
}
