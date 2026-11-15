/**
 * Per-task transcript recorder.
 *
 * Writes the three JSONL artifacts consumed by scoring:
 * - `wire.ndjson` — every JSON-RPC frame in both directions
 * - `questions.ndjson` — every user-question request with its decision
 * - `events.jsonl` — decoded durable session events
 *
 * Files are truncated when the recorder is created (a re-run of a failed task
 * replaces its transcript) and appended row by row, so a crashed task still
 * leaves a usable partial transcript.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../util/fsutil.mjs';
import { nowIso } from '../util/time.mjs';

function appendRow(file, row) {
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/**
 * Create the transcript recorder for one task directory.
 *
 * @param {string} taskDir directory that receives the artifacts
 * @returns {{dir: string, files: object, wire: Function, question: Function, event: Function, flush: Function, counts: object}}
 */
export function createRecorder(taskDir) {
  if (typeof taskDir !== 'string' || taskDir.trim() === '') throw new TypeError('createRecorder requires a task directory');
  const dir = path.resolve(taskDir);
  ensureDir(dir);
  const files = {
    wire: path.join(dir, 'wire.ndjson'),
    questions: path.join(dir, 'questions.ndjson'),
    events: path.join(dir, 'events.jsonl'),
  };
  for (const file of Object.values(files)) fs.writeFileSync(file, '');
  const counts = { wire: 0, questions: 0, events: 0 };

  /**
   * Append one wire frame.
   * @param {'request'|'response'|'notification'} kind the frame kind
   * @param {{ts?: string, dir: 'in'|'out', kind?: string, id?: string|number, method?: string, payload?: object}} frame
   */
  function wire(kind, frame = {}) {
    const row = {
      ts: typeof frame.ts === 'string' ? frame.ts : nowIso(),
      dir: frame.dir,
      kind: kind ?? frame.kind,
    };
    if (frame.id !== undefined) row.id = frame.id;
    if (frame.method !== undefined) row.method = frame.method;
    row.payload = frame.payload === undefined ? null : frame.payload;
    appendRow(files.wire, row);
    counts.wire += 1;
  }

  /** Append one answered question row. */
  function question(row) {
    appendRow(files.questions, row);
    counts.questions += 1;
  }

  /** Append one decoded durable session event. */
  function event(sessionEvent) {
    appendRow(files.events, sessionEvent);
    counts.events += 1;
  }

  /** Flush is synchronous; return the artifact counts for diagnostics. */
  function flush() {
    return { ...counts };
  }

  return { dir, files, wire, question, event, flush, counts };
}
