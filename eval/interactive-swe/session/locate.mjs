/**
 * Locate a session's durable log inside a DSH home.
 *
 * The canonical path is
 * `$DSH_HOME/sessions/<normalized-cwd>/<session-id>/session.v4.jsonl.zstd`.
 * The normalized-cwd slug is not part of this harness's contract, so the
 * primary lookup scans the sessions tree for the session id; the deterministic
 * path builder is only a fallback for tests and diagnostics.
 */
import fs from 'node:fs';
import path from 'node:path';

const LOG_FILE = 'session.v4.jsonl.zstd';

/** Replace path separators with `-` and wrap the result in `--`. */
export function cwdSlug(cwd) {
  const normalized = String(cwd).replace(/^[\\/]+/, '').replace(/[\\/]+/g, '-');
  return `--${normalized}--`;
}

/** Deterministic relative log path for a cwd and session id. */
export function sessionLogRelativePath(cwd, sessionId) {
  return path.join('sessions', cwdSlug(cwd), sessionId, LOG_FILE);
}

/**
 * Find the log file for a session id under a DSH home.
 * Returns null when the file is absent; never throws for a missing home.
 */
export function findSessionLog(dshHome, sessionId) {
  if (typeof dshHome !== 'string' || typeof sessionId !== 'string' || sessionId === '') return null;
  if (sessionId.includes('..') || /[\\/]/.test(sessionId)) return null;
  const root = path.join(dshHome, 'sessions');
  let slugs;
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const candidate = path.join(root, slug.name, sessionId, LOG_FILE);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}
