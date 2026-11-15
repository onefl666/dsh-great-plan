/**
 * Input construction for the plan-mode driving turn.
 *
 * The SDK routes `/plan <message>` through the native plan command, so the
 * driver sends exactly one text block whose first line is the command and
 * whose remainder is the dataset issue text.
 */

/** The single native command prefix used by every run. */
export const PLAN_COMMAND = '/plan';

/**
 * Validate one text payload for the SDK query.
 *
 * @param {string} text raw input text
 * @returns {string} the trimmed text
 * @throws {TypeError} when the value is not a string
 * @throws {Error} when the text is blank or contains a NUL byte
 */
export function assertSingleTextBlock(text) {
  if (typeof text !== 'string') throw new TypeError('plan input must be a string');
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('plan input must not be blank');
  if (trimmed.includes('\u0000')) throw new Error('plan input must not contain NUL bytes');
  return trimmed;
}

/**
 * Build the native plan command line `"/plan <trimmed issue>"`.
 *
 * @param {string} issueText the issue the agent must plan against
 * @returns {string} the command line for one SDK text block
 */
export function buildPlanInput(issueText) {
  return `${PLAN_COMMAND} ${assertSingleTextBlock(issueText)}`;
}

/**
 * Build the exact `session/query` content-block array for a plan input.
 *
 * @param {string} inputText a command line produced by {@link buildPlanInput}
 * @returns {{type: 'text', text: string}[]} one text block
 */
export function planContentBlocks(inputText) {
  return [{ type: 'text', text: assertSingleTextBlock(inputText) }];
}
