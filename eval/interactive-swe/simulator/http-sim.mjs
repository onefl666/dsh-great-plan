/**
 * Minimal OpenAI-compatible chat-completions client for the user simulator.
 *
 * No dependency is installed: the caller may inject `fetchImpl` (tests do),
 * otherwise the global `fetch` is used. The endpoint is
 * `<baseUrl>/chat/completions`, where `baseUrl` normally ends in `/v1`.
 */

const DEFAULT_TIMEOUT_MS = 120000;

function truncate(text, limit = 500) {
  const value = String(text);
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function readUsage(payload) {
  const usage = payload !== null && typeof payload === 'object' ? payload.usage ?? {} : {};
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

/**
 * Call an OpenAI-compatible chat-completions endpoint once.
 *
 * @param {object} options
 * @param {string} options.baseUrl API base, e.g. `https://api.example.com/v1`
 * @param {string} [options.apiKey] bearer token when set
 * @param {string} options.model model id
 * @param {{role: string, content: string}[]} options.messages chat messages
 * @param {typeof fetch} [options.fetchImpl] injected fetch (tests)
 * @param {number} [options.timeoutMs] abort deadline, defaults to 120000
 * @param {{role: string, content: string}[]|object} [options.responseFormat] optional request field
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number}}>}
 */
export async function callOpenAiCompatible({
  baseUrl,
  apiKey,
  model,
  messages,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  responseFormat,
} = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') throw new Error('simulator baseUrl is required');
  if (typeof model !== 'string' || model.trim() === '') throw new Error('simulator model is required');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('simulator messages are required');
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('no fetch implementation is available for the simulator');

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (typeof apiKey === 'string' && apiKey !== '') headers.authorization = `Bearer ${apiKey}`;
  const body = { model, messages, temperature: 0, stream: false };
  if (responseFormat !== undefined) body.response_format = responseFormat;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(new Error(`simulator request timed out after ${timeoutMs}ms`)), timeoutMs)
    : null;
  let response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(controller === null ? {} : { signal: controller.signal }),
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  let raw;
  try {
    raw = await response.text();
  } catch {
    raw = '';
  }
  if (response.ok === false) {
    throw new Error(`simulator HTTP ${response.status ?? 'error'}: ${truncate(raw)}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`simulator returned a non-JSON response: ${truncate(raw)}`);
  }
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.trim() === '') throw new Error('simulator returned no message text');
  return { text, usage: readUsage(payload) };
}
