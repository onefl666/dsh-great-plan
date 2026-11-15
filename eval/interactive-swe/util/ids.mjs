import crypto from 'node:crypto';

/** A fresh session id; the SDK accepts any non-empty string. */
export function newSessionId() {
  return crypto.randomUUID();
}

/** Reject ids that could escape a directory or collide with shell syntax. */
export function assertSafeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..')) {
    throw new Error(`unsafe identifier: ${String(value)}`);
  }
  return value;
}
