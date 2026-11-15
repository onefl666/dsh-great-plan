/**
 * Warm the repository mirror cache before a live run.
 *
 * The runner clones a bare mirror lazily on the first task for a repository and
 * verifies the task's `base_commit` when it creates a worktree. Doing that
 * during a measured run conflates network/clone failures with model behavior,
 * so this helper fetches every mirror and checks every base commit up front.
 * It is purely a cache operation: no repository content is written into the
 * plugin checkout.
 */
import { ensureMirror } from './worktree.mjs';
import { runCommand } from '../util/proc.mjs';

async function git(exec, args, { cwd, timeoutMs = 10 * 60 * 1000 } = {}) {
  try {
    const result = await exec({ command: 'git', args, cwd, timeoutMs });
    return {
      ok: result?.code === 0,
      code: typeof result?.code === 'number' ? result.code : null,
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : '',
    };
  } catch (error) {
    return { ok: false, code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Ensure every distinct repository in `tasks` has a mirror and every
 * `base_commit` is present.
 *
 * @param {{tasks: object[], cacheRoot: string, exec?: Function}} options
 * @returns {Promise<{ok: boolean, repos: object[]}>}
 */
export async function warmRepositories({ tasks = [], cacheRoot, exec = runCommand } = {}) {
  if (!Array.isArray(tasks)) throw new TypeError('warmRepositories requires a tasks array');
  if (typeof cacheRoot !== 'string' || cacheRoot === '') throw new TypeError('warmRepositories requires a cacheRoot');
  const groups = new Map();
  for (const task of tasks) {
    const repo = typeof task?.repo === 'string' ? task.repo.trim() : '';
    if (repo === '') continue;
    if (!groups.has(repo)) groups.set(repo, { repo, tasks: [], commits: new Set() });
    const group = groups.get(repo);
    group.tasks.push(task.instance_id);
    if (typeof task.base_commit === 'string' && task.base_commit !== '') group.commits.add(task.base_commit);
  }
  const repos = [];
  for (const [repo, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const mirror = await ensureMirror({ repo, cacheRoot, exec });
    const missingCommits = [];
    const fetchedCommits = [];
    for (const commit of [...group.commits].sort()) {
      const present = await git(exec, ['-C', mirror.dir, 'cat-file', '-e', `${commit}^{commit}`]);
      if (present.ok) continue;
      const fetched = await git(exec, ['-C', mirror.dir, 'fetch', 'origin', commit]);
      if (!fetched.ok) {
        missingCommits.push({ commit, error: fetched.stderr.trim().split('\n').at(-1) ?? `exit ${fetched.code}` });
        continue;
      }
      const recheck = await git(exec, ['-C', mirror.dir, 'cat-file', '-e', `${commit}^{commit}`]);
      if (recheck.ok) fetchedCommits.push(commit);
      else missingCommits.push({ commit, error: 'commit still missing after fetch' });
    }
    repos.push({
      repo,
      mirror: mirror.dir,
      created: mirror.created,
      tasks: group.tasks.length,
      commits: group.commits.size,
      fetchedCommits,
      missingCommits,
      warnings: mirror.warnings,
    });
  }
  return { ok: repos.every((entry) => entry.missingCommits.length === 0), repos };
}
