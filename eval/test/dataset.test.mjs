import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DATASET,
  DEFAULT_ENDPOINT,
  EXPECTED_SHA256,
  datasetUrl,
  fetchDataset,
  refreshBatchIds,
} from '../interactive-swe/dataset/fetch-dataset.mjs';
import {
  convertParquet,
  normalizeParquet,
  readTasks,
  writeTasks,
} from '../interactive-swe/dataset/normalize.mjs';
import { sha256Hex } from '../interactive-swe/util/hash.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-dataset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sampleRows() {
  return fs
    .readFileSync(new URL('../interactive-swe/dataset/fixtures/tasks.sample.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

test('datasetUrl pins the mirror revision and file', () => {
  const url = datasetUrl(DEFAULT_ENDPOINT);
  assert.ok(url.startsWith(`${DEFAULT_ENDPOINT}/datasets/${DATASET}/resolve/`));
  assert.ok(url.endsWith('/updated_test-00000-of-00001.parquet'));
});

test('fetchDataset validates and caches the pinned bytes', async (t) => {
  const cacheRoot = tempDir(t);
  const payload = Buffer.from('PAR1-demo');
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, arrayBuffer: async () => payload };
  };
  const first = await fetchDataset({ cacheRoot, fetchImpl, expectedBytes: payload.length, expectedSha256: sha256Hex(payload) });
  assert.equal(first.cached, false);
  assert.equal(first.bytes, payload.length);
  assert.equal(fs.readFileSync(first.path).toString(), payload.toString());
  const second = await fetchDataset({
    cacheRoot,
    fetchImpl: async () => {
      throw new Error('should not refetch');
    },
    expectedBytes: payload.length,
    expectedSha256: sha256Hex(payload),
  });
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test('fetchDataset rejects a bad hash and HTTP failure', async (t) => {
  const cacheRoot = tempDir(t);
  const payload = Buffer.from('PAR1-demo');
  await assert.rejects(
    fetchDataset({ cacheRoot, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => payload }), expectedBytes: payload.length, expectedSha256: 'f'.repeat(64) }),
    /sha256 mismatch/,
  );
  await assert.rejects(
    fetchDataset({ cacheRoot, fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/,
  );
});

test('refreshBatchIds decodes the GitHub contents payload', async () => {
  let headers;
  const text = await refreshBatchIds({
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      return { ok: true, json: async () => ({ content: Buffer.from('a__b-1\nc__d-2\n').toString('base64') }) };
    },
  });
  assert.equal(text, 'a__b-1\nc__d-2\n');
  assert.equal(headers.Accept, 'application/vnd.github+json');
});

test('convertParquet falls back through candidate interpreters', async () => {
  const parquetFile = path.join(tempDir({ after() {} }), 'x.parquet');
  fs.writeFileSync(parquetFile, 'PAR1');
  const attempts = [];
  const exec = async ({ command }) => {
    attempts.push(command);
    if (attempts.length === 1) return { code: 1, stdout: '', stderr: 'no pyarrow' };
    return { code: 0, stdout: `${JSON.stringify(sampleRows()[0])}\n`, stderr: '' };
  };
  const rows = await convertParquet({ parquetFile, exec, env: {}, candidates: ['python-a', 'python-b'] });
  assert.equal(rows.length, 1);
  assert.deepEqual(attempts, ['python-a', 'python-b']);
});

test('normalizeParquet writes tasks and meta with a count check', async (t) => {
  const cacheRoot = tempDir(t);
  const rows = sampleRows();
  const parquetFile = path.join(cacheRoot, 'x.parquet');
  fs.writeFileSync(parquetFile, 'PAR1');
  const exec = async () => ({ code: 0, stdout: rows.map((row) => JSON.stringify(row)).join('\n'), stderr: '' });
  const result = await normalizeParquet({
    parquetFile,
    cacheRoot,
    exec,
    expectedCount: rows.length,
    parquetSha256: EXPECTED_SHA256,
  });
  assert.equal(result.tasks.length, 3);
  assert.equal(result.meta.count, 3);
  assert.match(result.meta.license, /local cache only/);
  const read = readTasks(cacheRoot);
  assert.equal(read.tasks.length, 3);
  assert.ok(fs.existsSync(result.tasksFile));
  assert.ok(fs.existsSync(result.metaFile));
  await assert.rejects(
    normalizeParquet({ parquetFile: path.join(cacheRoot, 'x.parquet'), cacheRoot, exec, expectedCount: 4 }),
    /row count mismatch/,
  );
});

test('writeTasks and readTasks round-trip', (t) => {
  const cacheRoot = tempDir(t);
  const tasks = [{ instance_id: 'a__b-1' }];
  writeTasks({ cacheRoot, tasks, meta: { count: 1 } });
  assert.deepEqual(readTasks(cacheRoot).tasks, tasks);
});

test('readTasks fails when setup has not run', (t) => {
  assert.throws(() => readTasks(tempDir(t)), /not normalized yet/);
});
