/**
 * Task normalization and deterministic subset selection for interactive-swe.
 *
 * Dataset rows arrive with fifteen string fields. The raw test lists are
 * preserved verbatim and parsed opportunistically; malformed rows are reported
 * instead of silently dropped.
 */
import fs from 'node:fs';
import { hashJson } from '../util/hash.mjs';

export const REQUIRED_TASK_FIELDS = [
  'instance_id',
  'repo',
  'base_commit',
  'version',
  'environment_setup_commit',
  'problem_statement',
  'original_issue',
  'patch',
  'test_patch',
  'FAIL_TO_PASS',
  'PASS_TO_PASS',
  'files',
  'difficulty',
  'hints_text',
  'created_at',
];

export const ISSUE_MODES = ['hidden', 'full'];

function asString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Parse a SWE-bench list field. The dataset stores JSON strings in practice;
 * Python-literal single-quoted lists are accepted as a fallback.
 */
export function parseListString(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, value: [] };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { ok: true, value: parsed.map((item) => String(item)) };
  } catch {
    // fall through to Python-literal conversion
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return { ok: false, value: [] };
  try {
    const converted = trimmed.replace(/'((?:\\.|[^'\\])*)'/g, (_match, content) => JSON.stringify(content.replace(/\\'/g, "'")));
    const parsed = JSON.parse(converted);
    if (Array.isArray(parsed)) return { ok: true, value: parsed.map((item) => String(item)) };
  } catch {
    // ignore
  }
  return { ok: false, value: [] };
}

/**
 * Normalize one dataset row.
 * @throws when a required field is missing or blank
 */
export function normalizeTaskRow(row, index = 0) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`task row ${index} is not an object`);
  }
  const missing = REQUIRED_TASK_FIELDS.filter((field) => !(field in row));
  if (missing.length > 0) throw new Error(`task row ${index} is missing ${missing.join(', ')}`);
  const instanceId = asString(row.instance_id).trim();
  if (instanceId === '') throw new Error(`task row ${index} has a blank instance_id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(instanceId) || instanceId.includes('..')) {
    throw new Error(`task row ${index} has an unsafe instance_id: ${instanceId}`);
  }
  const failToPass = parseListString(row.FAIL_TO_PASS);
  const passToPass = parseListString(row.PASS_TO_PASS);
  const files = parseListString(row.files);
  return {
    instance_id: instanceId,
    repo: asString(row.repo),
    base_commit: asString(row.base_commit),
    version: asString(row.version),
    environment_setup_commit: asString(row.environment_setup_commit),
    problem_statement: asString(row.problem_statement),
    original_issue: asString(row.original_issue),
    patch: asString(row.patch),
    test_patch: asString(row.test_patch),
    failToPass: failToPass.value,
    passToPass: passToPass.value,
    failToPassRaw: asString(row.FAIL_TO_PASS),
    passToPassRaw: asString(row.PASS_TO_PASS),
    files: asString(row.files),
    filesList: files.value,
    difficulty: asString(row.difficulty),
    hintsText: asString(row.hints_text),
    createdAt: asString(row.created_at),
  };
}

/** Normalize rows, collecting per-row errors instead of throwing. */
export function normalizeTasks(rows) {
  const tasks = [];
  const errors = [];
  rows.forEach((row, index) => {
    try {
      tasks.push(normalizeTaskRow(row, index));
    } catch (error) {
      errors.push({ index, message: error.message });
    }
  });
  return { tasks, errors };
}

/** The issue text for one arm. */
export function selectIssue(task, issueMode) {
  if (!ISSUE_MODES.includes(issueMode)) throw new Error(`unknown issue mode: ${issueMode}`);
  const text = issueMode === 'hidden' ? task.problem_statement : task.original_issue;
  if (typeof text !== 'string' || text.trim() === '') throw new Error(`task ${task.instance_id} has no ${issueMode} issue text`);
  return text;
}

/** Parse a committed id list (blank lines and `#` comments ignored). */
export function parseIdList(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(line) || line.includes('..')) throw new Error(`unsafe task id: ${line}`);
      return line;
    });
}

/** Deterministic 32-bit PRNG seeded from a string. */
function mulberry32(seedText) {
  let seed = 2166136261;
  for (const char of String(seedText)) {
    seed ^= char.codePointAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const output = [...items];
  const random = mulberry32(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

function stratifiedSample(tasks, count) {
  const groups = new Map();
  for (const task of tasks) {
    const key = task.repo || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group.sort((left, right) => {
      const difficulty = left.difficulty.localeCompare(right.difficulty);
      return difficulty !== 0 ? difficulty : left.instance_id.localeCompare(right.instance_id);
    }));
  const picked = [];
  let cursor = 0;
  while (picked.length < count) {
    let added = false;
    for (const group of orderedGroups) {
      const task = group[cursor];
      if (task !== undefined) {
        picked.push(task);
        added = true;
        if (picked.length === count) break;
      }
    }
    if (!added) break;
    cursor += 1;
  }
  return picked.sort((left, right) => left.instance_id.localeCompare(right.instance_id));
}

/**
 * Select tasks deterministically.
 *
 * @param {object[]} tasks normalized tasks
 * @param {{ids?: string[], idsFile?: string, limit?: number, offset?: number,
 *          seed?: string|number, sample?: number}} options
 */
export function selectTasks(tasks, options = {}) {
  const { ids, idsFile, limit, offset = 0, seed, sample } = options;
  let selected = [...tasks];
  const requested = ids ?? (idsFile === undefined ? undefined : parseIdList(fs.readFileSync(idsFile, 'utf8')));
  if (requested !== undefined) {
    const byId = new Map(tasks.map((task) => [task.instance_id, task]));
    const missing = requested.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`unknown task ids: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
    selected = requested.map((id) => byId.get(id));
  }
  if (sample !== undefined) {
    if (!Number.isInteger(sample) || sample <= 0) throw new Error('sample must be a positive integer');
    selected = stratifiedSample(selected, sample);
  } else if (seed !== undefined && seed !== null) {
    selected = shuffle(selected, seed);
  }
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  selected = selected.slice(offset);
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
    selected = selected.slice(0, limit);
  }
  return selected;
}

/** SHA-256 over the normalized tasks, independent of input order. */
export function hashTasks(tasks) {
  const ordered = [...tasks].sort((left, right) => left.instance_id.localeCompare(right.instance_id));
  return hashJson(ordered);
}

/** Structural validation of a loaded task set. */
export function validateTaskSet(tasks) {
  const errors = [];
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.instance_id)) errors.push(`duplicate task id: ${task.instance_id}`);
    seen.add(task.instance_id);
    if (task.repo === '') errors.push(`task ${task.instance_id} has no repo`);
    if (task.base_commit === '') errors.push(`task ${task.instance_id} has no base_commit`);
    if (task.problem_statement.trim() === '') errors.push(`task ${task.instance_id} has no problem_statement`);
    if (task.original_issue.trim() === '') errors.push(`task ${task.instance_id} has no original_issue`);
  }
  return { ok: errors.length === 0, errors };
}
