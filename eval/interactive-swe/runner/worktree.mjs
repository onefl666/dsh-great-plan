/**
 * Git workspace preparation for one evaluation task.
 *
 * A bare mirror is cached under `<cacheRoot>/repos/`; each task gets a
 * detached `git worktree` under `<cacheRoot>/worktrees/`. When `git worktree
 * add` fails the module falls back to a `git archive` export (and then a local
 * shared clone), so a run can still capture a patch. Every command goes
 * through the injected `exec` (`util/proc.mjs` `runCommand` shape) so tests can
 * stay offline and no network is contacted unless the mirror must be cloned.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureDir } from '../util/fsutil.mjs';
import { runCommand } from '../util/proc.mjs';

/** Environment variable that overrides the cache root. */
export const CACHE_ENV = 'GREAT_PLAN_EVAL_CACHE';

/** Default cache root (`~/.cache/great-plan-eval`). */
export function defaultCacheRoot(env = process.env) {
  const override = env?.[CACHE_ENV];
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override);
  return path.join(os.homedir(), '.cache', 'great-plan-eval');
}

/** Resolve an explicit or default cache root to an absolute path. */
export function resolveCacheRoot(cacheRoot) {
  if (typeof cacheRoot === 'string' && cacheRoot.trim() !== '') return path.resolve(cacheRoot);
  return defaultCacheRoot();
}

/** A file-system-safe, deterministic slug for a repository URL or dataset id. */
export function repoSlug(repo) {
  if (typeof repo !== 'string' || repo.trim() === '') throw new TypeError('repo must be a non-empty string');
  const slug = repo
    .trim()
    .replace(/[\\/]+/g, '__')
    .replace(/[^A-Za-z0-9._-]+/g, '_');
  if (slug === '') throw new Error(`cannot derive a cache slug from repo: ${repo}`);
  return slug;
}

/** The clone URL: dataset `owner/name` ids map to GitHub, paths/URLs pass through. */
export function repoUrl(repo) {
  const value = String(repo).trim();
  if (/^(?:https?|file|git|ssh):\/\//.test(value)) return value;
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return value;
  return `https://github.com/${value}.git`;
}

/** Mirror directory for a repository. */
export function mirrorDir({ repo, cacheRoot }) {
  return path.join(resolveCacheRoot(cacheRoot), 'repos', `${repoSlug(repo)}.git`);
}

/** Worktree directory for a task. */
export function worktreePath({ repo, cacheRoot, worker = 'w0', instanceId }) {
  const workerSlug = String(worker).replace(/[^A-Za-z0-9._-]+/g, '_') || 'w0';
  const id = String(instanceId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new Error(`unsafe instance id for a worktree path: ${id}`);
  }
  return path.join(resolveCacheRoot(cacheRoot), 'worktrees', workerSlug, id);
}

function tail(text, limit = 400) {
  const value = String(text ?? '').trim();
  return value.length <= limit ? value : `…${value.slice(-limit)}`;
}

/** Run one command through `exec`, normalizing the result shape. */
async function run(exec, command, args, { cwd, timeoutMs = 10 * 60 * 1000 } = {}) {
  try {
    const result = await exec({ command, args, cwd, timeoutMs });
    const code = typeof result?.code === 'number' ? result.code : null;
    return {
      ok: code === 0,
      code,
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : '',
    };
  } catch (error) {
    return { ok: false, code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

function existsAsDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isNonEmptyDirectory(target) {
  try {
    return fs.readdirSync(target).length > 0;
  } catch {
    return false;
  }
}

function isInside(parent, child) {
  const root = path.resolve(parent);
  const target = path.resolve(child);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * Clone (or refresh) the bare mirror for a repository.
 *
 * @param {{repo: string, cacheRoot: string, exec?: Function, timeoutMs?: number}} options
 * @returns {Promise<{dir: string, repo: string, url: string, created: boolean, warnings: string[]}>}
 */
export async function ensureMirror({ repo, cacheRoot, exec = runCommand, timeoutMs } = {}) {
  const root = resolveCacheRoot(cacheRoot);
  const dir = mirrorDir({ repo, cacheRoot: root });
  const url = repoUrl(repo);
  const warnings = [];
  if (fs.existsSync(path.join(dir, 'HEAD'))) {
    const fetched = await run(exec, 'git', ['-C', dir, 'fetch', '--prune', '--quiet', '--tags'], { timeoutMs });
    if (!fetched.ok) warnings.push(`git fetch failed: ${tail(fetched.stderr)}`);
    return { dir, repo, url, created: false, warnings };
  }
  if (fs.existsSync(dir) && isNonEmptyDirectory(dir)) {
    throw new Error(`mirror path exists but is not a git mirror: ${dir}`);
  }
  ensureDir(path.dirname(dir));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort: a stale empty directory is harmless
  }
  const cloned = await run(exec, 'git', ['clone', '--mirror', '--quiet', url, dir], { timeoutMs });
  if (!cloned.ok) throw new Error(`git clone --mirror failed for ${repo}: ${tail(cloned.stderr)}`);
  return { dir, repo, url, created: true, warnings };
}

/**
 * Export a commit's tree into `dir` with `git archive`, falling back to a
 * shared local clone when tar extraction is unavailable.
 *
 * @param {{repo: string, cacheRoot: string, baseCommit: string, dir: string, exec?: Function, timeoutMs?: number, mirror?: string}} options
 * @returns {Promise<{dir: string, kind: 'export'|'clone', mirror: string, warnings: string[]}>}
 */
export async function copyExport({
  repo,
  cacheRoot,
  baseCommit,
  dir,
  exec = runCommand,
  timeoutMs,
  mirror,
} = {}) {
  if (typeof baseCommit !== 'string' || baseCommit.trim() === '') throw new Error('baseCommit is required');
  const root = resolveCacheRoot(cacheRoot);
  const mirrorPath = mirror ?? (await ensureMirror({ repo, cacheRoot: root, exec, timeoutMs })).dir;
  const target = path.resolve(dir);
  const warnings = [];
  ensureDir(target);
  const archiveFile = path.join(root, 'tmp', `${repoSlug(repo)}-${baseCommit.slice(0, 12)}-${process.pid}.tar`);
  ensureDir(path.dirname(archiveFile));
  const archived = await run(exec, 'git', ['-C', mirrorPath, 'archive', '--format=tar', '-o', archiveFile, baseCommit], {
    timeoutMs,
  });
  if (archived.ok) {
    const extracted = await run(exec, 'tar', ['-xf', archiveFile, '-C', target], { timeoutMs });
    try {
      fs.rmSync(archiveFile, { force: true });
    } catch {
      // the temp archive is disposable
    }
    if (extracted.ok) return { dir: target, kind: 'export', mirror: mirrorPath, warnings };
    warnings.push(`tar extraction failed: ${tail(extracted.stderr)}`);
  } else {
    warnings.push(`git archive failed: ${tail(archived.stderr)}`);
  }
  if (isNonEmptyDirectory(target)) {
    if (!isInside(path.join(root, 'worktrees'), target)) {
      throw new Error(`cannot replace non-empty export directory ${target}: ${warnings.join('; ')}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  ensureDir(path.dirname(target));
  const cloned = await run(exec, 'git', ['clone', '--shared', '--no-checkout', '--quiet', mirrorPath, target], { timeoutMs });
  if (cloned.ok) {
    const checkedOut = await run(exec, 'git', ['-C', target, 'checkout', '--detach', '--quiet', baseCommit], { timeoutMs });
    if (checkedOut.ok) return { dir: target, kind: 'clone', mirror: mirrorPath, warnings };
    warnings.push(`git checkout failed: ${tail(checkedOut.stderr)}`);
  } else {
    warnings.push(`git clone --shared failed: ${tail(cloned.stderr)}`);
  }
  throw new Error(`could not export ${repo}@${baseCommit}: ${warnings.join('; ')}`);
}

/**
 * Create a detached worktree for `baseCommit`, falling back to an export.
 *
 * @param {{repo: string, cacheRoot: string, baseCommit: string, dir: string, exec?: Function, timeoutMs?: number, force?: boolean}} options
 * @returns {Promise<{dir: string, kind: 'worktree'|'export'|'clone', mirror: string, warnings: string[]}>}
 */
export async function addWorktree({
  repo,
  cacheRoot,
  baseCommit,
  dir,
  exec = runCommand,
  timeoutMs,
  force = false,
} = {}) {
  if (typeof baseCommit !== 'string' || baseCommit.trim() === '') throw new Error('baseCommit is required');
  const root = resolveCacheRoot(cacheRoot);
  const target = path.resolve(dir);
  const mirror = await ensureMirror({ repo, cacheRoot: root, exec, timeoutMs });
  if (isNonEmptyDirectory(target) && !force) throw new Error(`worktree directory already exists: ${target}`);
  ensureDir(path.dirname(target));
  const added = await run(exec, 'git', ['-C', mirror.dir, 'worktree', 'add', '--detach', target, baseCommit], {
    timeoutMs,
  });
  if (added.ok) return { dir: target, kind: 'worktree', mirror: mirror.dir, warnings: mirror.warnings };
  const warnings = [...mirror.warnings, `git worktree add failed: ${tail(added.stderr)}`];
  if (force && existsAsDirectory(target) && isInside(path.join(root, 'worktrees'), target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  const exported = await copyExport({ repo, cacheRoot: root, baseCommit, dir: target, exec, timeoutMs, mirror: mirror.dir });
  return { ...exported, warnings: [...warnings, ...(exported.warnings ?? [])] };
}

/**
 * Stage everything and capture a binary-safe patch.
 *
 * @param {{dir: string, exec?: Function, timeoutMs?: number}} options
 * @returns {Promise<{diff: string, ok: boolean, stderr: string}>} the captured patch
 */
export async function captureDiff({ dir, exec = runCommand, timeoutMs } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('captureDiff requires a directory');
  const added = await run(exec, 'git', ['-C', dir, 'add', '-A'], { timeoutMs });
  if (!added.ok) return { diff: '', ok: false, stderr: tail(added.stderr) };
  const diff = await run(exec, 'git', ['-C', dir, 'diff', '--cached', '--binary', '--no-color'], { timeoutMs });
  if (!diff.ok) return { diff: '', ok: false, stderr: tail(diff.stderr) };
  return { diff: diff.stdout, ok: true, stderr: diff.stderr };
}

/**
 * Remove a worktree (and its directory) created under `<cacheRoot>/worktrees`.
 * Never throws; refuses paths outside the managed worktree root.
 *
 * @param {{repo: string, cacheRoot: string, dir: string, exec?: Function, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, removed: boolean, warnings: string[], error?: string}>}
 */
export async function removeWorktree({ repo, cacheRoot, dir, exec = runCommand, timeoutMs } = {}) {
  const root = resolveCacheRoot(cacheRoot);
  const target = path.resolve(dir);
  const worktreesRoot = path.join(root, 'worktrees');
  if (!isInside(worktreesRoot, target)) {
    return { ok: false, removed: false, warnings: [], error: `refusing to remove a path outside ${worktreesRoot}` };
  }
  const warnings = [];
  const mirror = mirrorDir({ repo, cacheRoot: root });
  if (fs.existsSync(path.join(mirror, 'HEAD'))) {
    const removed = await run(exec, 'git', ['-C', mirror, 'worktree', 'remove', '--force', target], { timeoutMs });
    if (!removed.ok) {
      warnings.push(`git worktree remove failed: ${tail(removed.stderr)}`);
      await run(exec, 'git', ['-C', mirror, 'worktree', 'prune'], { timeoutMs });
    }
  }
  let removed = false;
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      removed = true;
    }
  } catch (error) {
    return { ok: false, removed, warnings, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: !fs.existsSync(target), removed, warnings };
}
