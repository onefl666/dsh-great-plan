import crypto from 'node:crypto';

/** Stable JSON: object keys are sorted recursively so hashes are reproducible. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** SHA-256 hex digest of a string or Buffer. */
export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of a JSON value under stable key order. */
export function hashJson(value) {
  return sha256Hex(stableStringify(value));
}
