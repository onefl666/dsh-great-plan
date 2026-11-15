/**
 * Turn the pinned parquet into normalized `tasks.jsonl`.
 *
 * Parquet is converted by the one Python helper through `uv` (no repository
 * dependency); every other step is Node. The converter is injectable so the
 * offline tests never need pyarrow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../util/proc.mjs';
import { atomicWriteFile, ensureDir } from '../util/fsutil.mjs';
import { hashJson } from '../util/hash.mjs';
import { normalizeTasks, validateTaskSet } from '../tasks/schema.mjs';
import { DATASET, REVISION, EXPECTED_SHA256, fetchDataset } from './fetch-dataset.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'parquet-to-jsonl.py');

/** Candidate interpreters for the conversion fallback chain. */
export function pythonCandidates(env = process.env) {
  const candidates = [];
  if (env.EVAL_PYTHON) candidates.push(env.EVAL_PYTHON);
  for (const home of [env.DSH_HOME, path.join(env.HOME ?? '', '.dsh')]) {
    if (!home) continue;
    const runtimes = path.join(home, 'dsh-runtimes');
    try {
      for (const entry of fs.readdirSync(runtimes)) {
        candidates.push(path.join(runtimes, entry, 'dependencies', 'python', 'bin', 'python3'));
      }
    } catch {
      // no runtimes
    }
  }
  return [...new Set(candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }))];
}

function parseJsonl(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

/**
 * Convert parquet to raw rows through an injected executor.
 * @returns {Promise<object[]>}
 */
export async function convertParquet({ parquetFile, env = process.env, exec = runCommand, uv = env.EVAL_UV || 'uv', candidates = pythonCandidates(env) } = {}) {
  if (typeof parquetFile !== 'string' || !fs.existsSync(parquetFile)) throw new Error(`parquet file not found: ${parquetFile}`);
  const attempts = [];
  for (const python of candidates) attempts.push({ command: python, args: [SCRIPT, parquetFile], label: python });
  attempts.push({ command: uv, args: ['run', '--quiet', '--python', '3.12', '--with', 'pyarrow', 'python', SCRIPT, parquetFile], label: `${uv} + pyarrow` });
  const failures = [];
  for (const attempt of attempts) {
    let result;
    try {
      result = await exec({ command: attempt.command, args: attempt.args, env, timeoutMs: 600000 });
    } catch (error) {
      failures.push(`${attempt.label}: ${error.message}`);
      continue;
    }
    if (result.code !== 0) {
      failures.push(`${attempt.label}: exit ${result.code} ${String(result.stderr ?? '').trim().split('\n').at(-1) ?? ''}`);
      continue;
    }
    try {
      return parseJsonl(result.stdout);
    } catch (error) {
      failures.push(`${attempt.label}: invalid output (${error.message})`);
    }
  }
  throw new Error(`parquet conversion failed:\n${failures.join('\n')}`);
}

/** Write tasks.jsonl and tasks.meta.json; returns the normalized tasks. */
export function writeTasks({ cacheRoot, tasks, meta }) {
  if (typeof cacheRoot !== 'string' || cacheRoot === '') throw new Error('cacheRoot is required');
  const dir = path.join(cacheRoot, 'dataset');
  ensureDir(dir);
  const tasksFile = path.join(dir, 'tasks.jsonl');
  const metaFile = path.join(dir, 'tasks.meta.json');
  atomicWriteFile(tasksFile, tasks.map((task) => JSON.stringify(task)).join('\n') + '\n');
  atomicWriteFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  return { tasksFile, metaFile };
}

/** Read normalized tasks from the cache. */
export function readTasks(cacheRoot) {
  const file = path.join(cacheRoot, 'dataset', 'tasks.jsonl');
  if (!fs.existsSync(file)) throw new Error(`tasks not normalized yet: ${file}`);
  const tasks = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  return { tasks, file };
}

/**
 * Convert, validate, and persist a parquet file.
 *
 * @returns {Promise<{tasks: object[], tasksFile: string, metaFile: string, meta: object}>}
 */
export async function normalizeParquet({
  parquetFile,
  cacheRoot,
  source = DATASET,
  revision = REVISION,
  parquetSha256 = EXPECTED_SHA256,
  expectedCount = 500,
  env = process.env,
  exec = runCommand,
  allowCountMismatch = false,
} = {}) {
  const rows = await convertParquet({ parquetFile, env, exec });
  const { tasks, errors } = normalizeTasks(rows);
  if (errors.length > 0) {
    throw new Error(`invalid dataset rows: ${errors.slice(0, 5).map((error) => `#${error.index} ${error.message}`).join('; ')}`);
  }
  const validation = validateTaskSet(tasks);
  if (!validation.ok) throw new Error(`invalid task set: ${validation.errors.slice(0, 5).join('; ')}`);
  if (!allowCountMismatch && tasks.length !== expectedCount) {
    throw new Error(`dataset row count mismatch: expected ${expectedCount}, got ${tasks.length}`);
  }
  const meta = {
    schemaVersion: 1,
    source,
    revision,
    parquetSha256,
    count: tasks.length,
    license: 'none declared (local cache only; do not redistribute)',
    tasksSha256: hashJson(tasks.map((task) => task.instance_id).sort()),
    createdAt: new Date().toISOString(),
  };
  const written = writeTasks({ cacheRoot, tasks, meta });
  return { tasks, ...written, meta };
}

/** Ensure the cache holds fetched + normalized tasks (setup convenience). */
export async function prepareDataset({ cacheRoot, endpoint, fetchImpl, expectedCount = 500, force = false, exec, env = process.env, allowCountMismatch = false } = {}) {
  const download = await fetchDataset({ cacheRoot, endpoint, fetchImpl, force });
  const normalized = await normalizeParquet({
    parquetFile: download.path,
    cacheRoot,
    parquetSha256: download.sha256,
    expectedCount,
    exec,
    env,
    allowCountMismatch,
  });
  return { ...normalized, download };
}
