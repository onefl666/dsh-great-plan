/**
 * Download the pinned interactive-swe parquet file.
 *
 * Hugging Face is blocked directly on this host; the default endpoint is the
 * hf-mirror mirror. The revision, byte size, and SHA-256 are pinned so a local
 * cache is either exactly the official file or rejected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, ensureDir, readJsonIfExists } from '../util/fsutil.mjs';
import { sha256Hex } from '../util/hash.mjs';

export const DATASET = 'cmu-lti/interactive-swe';
export const REVISION = 'a56830ede5eee0925cb7d735d422a207927925bd';
export const PARQUET_FILE = 'updated_test-00000-of-00001.parquet';
export const EXPECTED_BYTES = 2194070;
export const EXPECTED_SHA256 = 'bdc6663d3f931d9ea04ea2edaec5eca6e406c2f122d7f1956ef0ec859691b5cd';
export const DEFAULT_ENDPOINT = 'https://hf-mirror.com';
export const BATCH_IDS_COMMIT = 'ee8603e8f4d96ace56abef2ad900c75f25bc59be';

/** Build the pinned parquet URL for an endpoint. */
export function datasetUrl(endpoint = DEFAULT_ENDPOINT) {
  const base = String(endpoint).replace(/\/+$/, '');
  return `${base}/datasets/${DATASET}/resolve/${REVISION}/${PARQUET_FILE}`;
}

/** Build the GitHub contents URL for the paper's batch id list. */
export function batchIdsUrl() {
  return `https://api.github.com/repos/nedwards99/ask-or-assume/contents/analysis/final_batches/batch1_ids.txt?ref=${BATCH_IDS_COMMIT}`;
}

function parquetPath(cacheRoot) {
  return path.join(cacheRoot, 'dataset', `interactive-swe-${REVISION}.parquet`);
}

function verifyBytes(buffer, expectedBytes = EXPECTED_BYTES, expectedSha = EXPECTED_SHA256) {
  if (expectedBytes !== null && buffer.length !== expectedBytes) {
    throw new Error(`dataset size mismatch: expected ${expectedBytes}, got ${buffer.length}`);
  }
  const digest = sha256Hex(buffer);
  if (expectedSha !== null && digest !== expectedSha) {
    throw new Error(`dataset sha256 mismatch: expected ${expectedSha}, got ${digest}`);
  }
  return digest;
}

/**
 * Ensure the pinned parquet exists in the cache.
 * @returns {{path: string, bytes: number, sha256: string, revision: string,
 *            url: string, cached: boolean}}
 */
export async function fetchDataset({
  cacheRoot,
  endpoint = process.env.HF_ENDPOINT || DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  expectedBytes = EXPECTED_BYTES,
  expectedSha256 = EXPECTED_SHA256,
  force = false,
} = {}) {
  if (typeof cacheRoot !== 'string' || cacheRoot === '') throw new Error('cacheRoot is required');
  const url = datasetUrl(endpoint);
  const target = parquetPath(cacheRoot);
  const existing = readJsonIfExists(`${target}.meta.json`, null);
  if (!force && existing !== null && existing.sha256 === expectedSha256) {
    try {
      const buffer = fs.readFileSync(target);
      const digest = verifyBytes(buffer, existing.bytes, existing.sha256);
      return { path: target, bytes: buffer.length, sha256: digest, revision: REVISION, url, cached: true };
    } catch {
      // fall through to a fresh download
    }
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`dataset download failed: HTTP ${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = verifyBytes(buffer, expectedBytes, expectedSha256);
  ensureDir(path.dirname(target));
  atomicWriteFile(target, buffer);
  atomicWriteFile(`${target}.meta.json`, `${JSON.stringify({
    source: DATASET,
    revision: REVISION,
    url,
    bytes: buffer.length,
    sha256: digest,
    fetchedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return { path: target, bytes: buffer.length, sha256: digest, revision: REVISION, url, cached: false };
}

/**
 * Refresh the committed batch id list from GitHub (maintenance only; the
 * harness never depends on this at run time).
 */
export async function refreshBatchIds({ fetchImpl = globalThis.fetch, token = process.env.GITHUB_TOKEN } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(batchIdsUrl(), { headers });
  if (!response.ok) throw new Error(`batch id refresh failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (typeof payload.content !== 'string') throw new Error('batch id refresh returned no content');
  return Buffer.from(payload.content, 'base64').toString('utf8');
}
