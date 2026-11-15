import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CLI = new URL('../interactive-swe/cli.mjs', import.meta.url).pathname;

function runCli(args, env = {}) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cli-'));
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GREAT_PLAN_EVAL_CACHE: cache, ...env },
    timeout: 60000,
  });
  fs.rmSync(cache, { recursive: true, force: true });
  return result;
}

test('cli help exits zero and lists commands', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /selftest/);
  assert.match(result.stdout, /--confirm-live/);
});

test('cli rejects an unknown command', () => {
  const result = runCli(['nope']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command/);
});

test('run is gated before any live work', () => {
  const result = runCli(['run', '--arm', 'full', '--issue-mode', 'hidden', '--limit', '1']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--confirm-live/);
});

test('clean refuses nothing outside the cache', () => {
  const result = runCli(['clean']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /removed/);
});
