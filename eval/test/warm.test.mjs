import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { warmRepositories } from '../interactive-swe/runner/warm.mjs';
import { repoSlug } from '../interactive-swe/runner/worktree.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-warm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function task(id, repo, commit) {
  return { instance_id: id, repo, base_commit: commit };
}

test('warmRepositories groups tasks, creates mirrors, and verifies commits', async (t) => {
  const cacheRoot = temp(t);
  // Pretend the mirror already exists so ensureMirror only fetches.
  const mirror = path.join(cacheRoot, 'repos', `${repoSlug('a/a')}.git`);
  fs.mkdirSync(mirror, { recursive: true });
  fs.writeFileSync(path.join(mirror, 'HEAD'), 'ref: refs/heads/main\n');
  const calls = [];
  const exec = async ({ command, args }) => {
    calls.push([command, ...args].join(' '));
    if (args.includes('cat-file')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await warmRepositories({
    tasks: [task('a-1', 'a/a', '1'.repeat(40)), task('a-2', 'a/a', '2'.repeat(40)), task('b-1', 'b/b', '3'.repeat(40))],
    cacheRoot,
    exec,
  });
  assert.equal(result.ok, true);
  assert.equal(result.repos.length, 2);
  assert.equal(result.repos.find((repo) => repo.repo === 'a/a').tasks, 2);
  assert.ok(calls.some((call) => call.startsWith('git -C') && call.includes('cat-file')));
});

test('warmRepositories reports a missing commit after a failed fetch', async (t) => {
  const cacheRoot = temp(t);
  const mirror = path.join(cacheRoot, 'repos', `${repoSlug('a/a')}.git`);
  fs.mkdirSync(mirror, { recursive: true });
  fs.writeFileSync(path.join(mirror, 'HEAD'), 'ref: refs/heads/main\n');
  const exec = async ({ args }) => {
    if (args.includes('cat-file')) return { code: 1, stdout: '', stderr: 'missing' };
    if (args.includes('fetch')) return { code: 128, stdout: '', stderr: 'not found' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await warmRepositories({ tasks: [task('a-1', 'a/a', '4'.repeat(40))], cacheRoot, exec });
  assert.equal(result.ok, false);
  assert.equal(result.repos[0].missingCommits.length, 1);
  assert.match(result.repos[0].missingCommits[0].error, /not found/);
});

test('warmRepositories rejects bad input', async () => {
  await assert.rejects(() => warmRepositories({ tasks: [], cacheRoot: '' }), /cacheRoot/);
  await assert.rejects(() => warmRepositories({ tasks: null, cacheRoot: '/tmp/x' }), /tasks array/);
});
