import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteFile, ensureDir } from '../util/fsutil.mjs';
import { runCommand } from '../util/proc.mjs';

/**
 * Profile provisioning for the interactive-swe evaluation harness.
 *
 * Every worker gets its own DSH home under the eval cache root, so a crashed or
 * stopped worker cannot leak state into another home and the real `~/.dsh` is
 * never touched. A home holds one profile named `eval`:
 *
 *   <cacheRoot>/homes/<name>/
 *     .credentials.yaml                 (optional, explicit --copy-credentials)
 *     profiles/eval/
 *       package.json                    (bundles base + sdk-app + this plugin)
 *       cordis.yml                      (empty root list)
 *       cordis.patch.yml                (empty user layer)
 *       pnpm-workspace.yaml             (hoisted workspace)
 *     node_modules/@onefl666/dsh-great-plan -> <workspace>
 *       profiles/eval/node_modules/@deepseek-ai/schemastery
 *                                       (peer; `dsh plugin add` runs pnpm
 *                                        inside the profile directory)
 *
 * The base and arm patch layers are applied per run with `--patch` overlays;
 * `BASE_PATCH_TEXT` / `armPatchText(arm)` are the single source of truth for the
 * committed YAML files under this directory.
 *
 * @module profile/provision
 */

/** Environment variable that overrides the evaluation cache root. */
export const CACHE_ENV = 'GREAT_PLAN_EVAL_CACHE';

/** The only profile provisioned inside every eval home. */
export const PROFILE_NAME = 'eval';

/** Arm names accepted by {@link armPatchText} and `--arm` selection. */
export const ARM_NAMES = Object.freeze(['native', 'evidence', 'full']);

/** Absolute directory containing this module (and the committed patch files). */
export const PROFILE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The plugin bundle the eval profile always links and enables. */
export const PLUGIN_PACKAGE = '@onefl666/dsh-great-plan';

/**
 * The only peer dependency the linked plugin needs installed into the eval
 * profile. `@deepseek-ai/schemastery` resolves the plugin's Host import; do not
 * add `@deepseek-ai/dsh-compaction` (the installed 0.2.2-rc.1 runtime rejects it
 * and it is not needed to load the plugin).
 */
export const SCHEMASTERY_PACKAGE = '@deepseek-ai/schemastery';

/** Version range installed for {@link SCHEMASTERY_PACKAGE}. */
export const SCHEMASTERY_SPEC = '~3.18.5';

/** Peer dependencies the eval profile declares and installs. */
export const PEER_DEPENDENCIES = Object.freeze({
  [SCHEMASTERY_PACKAGE]: SCHEMASTERY_SPEC,
});

/** Bundle order for the eval profile; the user plugin always comes last. */
export const PROFILE_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-sdk-app',
  PLUGIN_PACKAGE,
]);

/** Row ids the base patch disables in the eval profile. */
export const BASE_DISABLED_ROWS = Object.freeze([
  'tool-subagent-control',
  'tool-subagent',
  'tool-subagent-fork',
  'web',
  'tool-web',
  'web-search-deepseek',
  'web-deepseek-api',
  'web-fetch-http',
  'workflow-ptc',
  'tool-workflow',
  'plugin-manager',
  'tool-plugin-manager',
  'skill-office',
  'workspace-dependencies',
]);

/** Team rows the base patch inserts (host rows only; there is no browser UI). */
export const BASE_INSERTED_ROWS = Object.freeze(['agent-team', 'tool-agent-team']);

/**
 * Volatile Config values per arm. `native` disables the row instead of writing
 * config; `evidence` and `full` must restate all four fields because a Cordis
 * patch replaces a row's whole `config` rather than merging into it.
 */
export const ARM_CONFIGS = Object.freeze({
  native: null,
  evidence: Object.freeze({
    injectBrainstormingPrompt: false,
    injectUnlimitedBudgetPrompt: true,
    includeOriginalUserInstructions: true,
    includeMinimalRuntimeContext: true,
  }),
  full: Object.freeze({
    injectBrainstormingPrompt: true,
    injectUnlimitedBudgetPrompt: true,
    includeOriginalUserInstructions: true,
    includeMinimalRuntimeContext: true,
  }),
});

/**
 * Base patch layer shared by every arm. It swaps the direct-subagent tools for
 * the deterministic Team tools, and disables the surfaces an offline evaluation
 * must not exercise (network tools, workflows, the plugin manager, Office and
 * workspace dependency installation).
 */
export const BASE_PATCH_TEXT = `# Base layer for the interactive-swe eval profile.
# Applied after the profile's bundle layers (dsh-base, dsh-sdk-app, the plugin
# bundle) and before the arm patch. Host rows only: the eval profile boots the
# SDK app, so no browser surface is present.

- insert:
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config:
        maxMembers: 8
        maxTasks: 256
        maxMessageBytes: 65536
        disposalTimeoutMs: 5000

    - id: tool-agent-team
      name: '@deepseek-ai/dsh-experimental-tool-agent-team'
      config:
        freshProvider: spawn
        forkProvider: fork

# Direct subagent tools are replaced by the Team tools above.
- id: tool-subagent-control
  disabled: true

- id: tool-subagent
  disabled: true

- id: tool-subagent-fork
  disabled: true

# Network-facing surfaces stay off: no model/tool web access in an offline run.
- id: web
  disabled: true

- id: tool-web
  disabled: true

- id: web-search-deepseek
  disabled: true

- id: web-deepseek-api
  disabled: true

- id: web-fetch-http
  disabled: true

# Workflows and the plugin manager are not part of the evidence workflow.
- id: workflow-ptc
  disabled: true

- id: tool-workflow
  disabled: true

- id: plugin-manager
  disabled: true

- id: tool-plugin-manager
  disabled: true

# Office skill assets and workspace dependency installation are not needed and
# would reach outside the isolated homes.
- id: skill-office
  disabled: true

- id: workspace-dependencies
  disabled: true
`;

/**
 * Resolve the evaluation cache root: `GREAT_PLAN_EVAL_CACHE`, else
 * `<homeDir>/.cache/great-plan-eval`. `~` and `~/` prefixes are expanded against
 * `homeDir`; the result is absolute.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment to read (defaults to `process.env`).
 * @param {string} [homeDir] Home directory for the default and `~` expansion.
 * @returns {string} Absolute cache root.
 */
export function defaultCacheRoot(env = process.env, homeDir = os.homedir()) {
  const configured = env === undefined || env === null ? undefined : env[CACHE_ENV];
  if (typeof configured === 'string' && configured.trim() !== '') {
    let value = configured.trim();
    if (value === '~') value = homeDir;
    else if (value.startsWith('~/')) value = path.join(homeDir, value.slice(2));
    return path.resolve(value);
  }
  return path.resolve(homeDir, '.cache', 'great-plan-eval');
}

/**
 * Reject the real DSH home (`<homeDir>/.dsh`) and anything below it. Every eval
 * home must live under the eval cache root instead, so a bug can never write a
 * real profile, credential file, or session log.
 *
 * @param {string} home Candidate home path.
 * @param {{ homeDir?: string }} [options]
 * @returns {string} The resolved, safe path.
 * @throws {Error & { code: 'unsafe-home' | 'invalid-home' }} When rejected.
 */
export function assertSafeHome(home, options = {}) {
  if (typeof home !== 'string' || home.trim() === '') {
    const error = new Error('eval home must be a non-empty path string');
    error.code = 'invalid-home';
    throw error;
  }
  const homeDir = options.homeDir ?? os.homedir();
  const resolved = path.resolve(home);
  const forbidden = path.resolve(homeDir, '.dsh');
  if (resolved === forbidden || resolved.startsWith(`${forbidden}${path.sep}`)) {
    const error = new Error(`refusing to use the real DSH home or a path inside it: ${resolved}`);
    error.code = 'unsafe-home';
    throw error;
  }
  return resolved;
}

/**
 * Deterministic home directory name per worker. Worker 0 uses `dsh-home`;
 * workers 1..n-1 use `dsh-home-w<index>`.
 *
 * @param {number} workerIndex Zero-based worker index.
 * @returns {string} Home directory name.
 */
export function homeName(workerIndex) {
  if (!Number.isInteger(workerIndex) || workerIndex < 0) {
    throw new Error(`worker index must be a non-negative integer (got ${String(workerIndex)})`);
  }
  return workerIndex === 0 ? 'dsh-home' : `dsh-home-w${workerIndex}`;
}

/**
 * Contents of the four files provisioned into `profiles/eval/`. Kept as a pure
 * function so tests (and the CLI) can inspect what will be written without
 * touching the filesystem.
 *
 * @param {{ workspace: string }} options Absolute plugin checkout to link.
 * @returns {Record<string, string>} File name to exact contents.
 */
export function profileFileContents({ workspace }) {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new Error('profileFileContents requires an absolute workspace path');
  }
  const manifest = {
    name: 'dsh-profile-eval',
    private: true,
    dependencies: {
      [PLUGIN_PACKAGE]: `link:${path.resolve(workspace)}`,
      ...PEER_DEPENDENCIES,
    },
    dsh: {
      profile: {
        bundles: [...PROFILE_BUNDLES],
      },
    },
  };
  return {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'cordis.yml': '[]\n',
    'cordis.patch.yml': '[]\n',
    'pnpm-workspace.yaml': `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n`,
  };
}

/**
 * Absolute path of the committed base patch layer.
 *
 * @returns {string} Path to `base.patch.yml`.
 */
export function basePatchPath() {
  return path.join(PROFILE_DIR, 'base.patch.yml');
}

/**
 * Absolute path of a committed arm patch layer.
 *
 * @param {string} arm One of {@link ARM_NAMES}.
 * @returns {string} Path to `arms/<arm>.yml`.
 */
export function armPatchPath(arm) {
  if (!ARM_NAMES.includes(arm)) {
    throw new Error(`unknown arm ${JSON.stringify(arm)} (expected ${ARM_NAMES.join(', ')})`);
  }
  return path.join(PROFILE_DIR, 'arms', `${arm}.yml`);
}

/**
 * Render the patch text for one arm. `native` disables `great-plan`; `evidence`
 * and `full` restate all four volatile Config fields because patches replace the
 * whole config.
 *
 * @param {string} arm One of {@link ARM_NAMES}.
 * @returns {string} YAML patch text (ends with a newline).
 */
export function armPatchText(arm) {
  if (!ARM_NAMES.includes(arm)) {
    throw new Error(`unknown arm ${JSON.stringify(arm)} (expected ${ARM_NAMES.join(', ')})`);
  }
  if (arm === 'native') {
    return "# Native arm: the Great Plan plugin loads but its contribution is disabled.\n- id: great-plan\n  disabled: true\n";
  }
  const config = ARM_CONFIGS[arm];
  const lines = [
    `# ${arm === 'evidence' ? 'Evidence' : 'Full'} arm: restate all four volatile Config fields.`,
    '# A Cordis patch replaces the whole config, so every field must be present.',
    '- id: great-plan',
    '  config:',
    ...Object.entries(config).map(([key, value]) => `    ${key}: ${value}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Point `linkPath` at `target`, creating parent directories. Existing correct
 * links are left alone; a conflicting link or path is replaced only with
 * `force`, otherwise the call throws instead of guessing.
 *
 * @param {string} linkPath Link to create.
 * @param {string} target Absolute link target.
 * @param {{ force?: boolean }} [options]
 * @returns {void}
 */
function ensureSymlink(linkPath, target, { force = false } = {}) {
  ensureDir(path.dirname(linkPath));
  let stat;
  try {
    stat = fs.lstatSync(linkPath);
  } catch {
    stat = null;
  }
  if (stat === null) {
    fs.symlinkSync(target, linkPath, 'dir');
    return;
  }
  if (stat.isSymbolicLink()) {
    const current = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    if (current === path.resolve(target)) return;
    if (!force) {
      const error = new Error(`refusing to replace a different plugin link at ${linkPath} (use force)`);
      error.code = 'link-conflict';
      throw error;
    }
    fs.unlinkSync(linkPath);
    fs.symlinkSync(target, linkPath, 'dir');
    return;
  }
  if (!force) {
    const error = new Error(`refusing to replace a non-symlink at ${linkPath} (use force)`);
    error.code = 'path-conflict';
    throw error;
  }
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(target, linkPath, 'dir');
}

/**
 * Copy one credentials document into an eval home as a regular file with mode
 * 0600. A pre-existing symlink at the destination is removed first, so the eval
 * home never shares the real `~/.dsh/.credentials.yaml`.
 *
 * @param {string} source Source credentials file.
 * @param {string} target Destination path.
 * @returns {void}
 */
function copyCredentialsFile(source, target) {
  ensureDir(path.dirname(target));
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    stat = null;
  }
  if (stat !== null) {
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.unlinkSync(target);
  }
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
  const written = fs.lstatSync(target);
  if (!written.isFile() || written.isSymbolicLink()) {
    throw new Error(`failed to materialize credentials as a regular file at ${target}`);
  }
}

/**
 * Provision one isolated DSH home per worker under the eval cache root.
 * Synchronous by design: the work is bounded filesystem setup and callers (the
 * CLI) need the homes before spawning anything.
 *
 * Idempotent: re-running with unchanged inputs rewrites the derived profile
 * files and leaves a correct plugin symlink alone. `force` replaces conflicting
 * links/paths; it never deletes sessions or logs in an existing home.
 *
 * @param {object} options
 * @param {string} options.workspace Absolute plugin checkout directory.
 * @param {string} [options.cacheRoot] Cache root; defaults to {@link defaultCacheRoot}.
 * @param {number} [options.workers] Number of isolated homes (>= 1).
 * @param {boolean} [options.copyCredentials] Explicitly copy the real credentials file.
 * @param {boolean} [options.force] Replace conflicting links/paths.
 * @param {string} [options.homeDir] Real home directory (credentials source and safety check).
 * @param {string} [options.sourceCredentials] Explicit credentials source; defaults to `<homeDir>/.credentials.yaml`.
 * @returns {{
 *   cacheRoot: string,
 *   workspace: string,
 *   homes: Array<{ name: string, home: string, profileDir: string }>,
 *   pluginLink: string,
 *   copiedCredentials: boolean,
 * }}
 */
export function provision(options = {}) {
  const workspace = options.workspace;
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new Error('provision requires a workspace path');
  }
  const resolvedWorkspace = path.resolve(workspace);
  const workspaceStat = fs.statSync(resolvedWorkspace, { throwIfNoEntry: false });
  if (workspaceStat === undefined || !workspaceStat.isDirectory()) {
    const error = new Error(`workspace is not a directory: ${resolvedWorkspace}`);
    error.code = 'workspace-missing';
    throw error;
  }

  const homeDir = options.homeDir ?? os.homedir();
  const workers = options.workers ?? 1;
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`workers must be a positive integer (got ${String(workers)})`);
  }

  const requestedRoot = options.cacheRoot === undefined
    ? defaultCacheRoot(process.env, homeDir)
    : options.cacheRoot;
  // Check the root before writing anything so a bad env var cannot create a
  // directory tree inside the real DSH home.
  const cacheRoot = assertSafeHome(requestedRoot, { homeDir });

  const files = profileFileContents({ workspace: resolvedWorkspace });
  const homes = [];
  let pluginLink = '';
  let copiedCredentials = false;

  for (let index = 0; index < workers; index += 1) {
    const name = homeName(index);
    const home = assertSafeHome(path.join(cacheRoot, 'homes', name), { homeDir });
    const profileDir = path.join(home, 'profiles', PROFILE_NAME);
    ensureDir(profileDir);
    for (const [fileName, content] of Object.entries(files)) {
      atomicWriteFile(path.join(profileDir, fileName), content);
    }

    const linkPath = path.join(home, 'node_modules', ...PLUGIN_PACKAGE.split('/'));
    ensureSymlink(linkPath, resolvedWorkspace, { force: options.force === true });
    if (index === 0) pluginLink = linkPath;

    if (options.copyCredentials === true) {
      const source = options.sourceCredentials ?? path.join(homeDir, '.credentials.yaml');
      const sourceStat = fs.statSync(source, { throwIfNoEntry: false });
      if (sourceStat === undefined || !sourceStat.isFile()) {
        const error = new Error(`credentials file not found: ${source}`);
        error.code = 'credentials-missing';
        throw error;
      }
      copyCredentialsFile(source, path.join(home, '.credentials.yaml'));
      copiedCredentials = true;
    }

    homes.push({ name, home, profileDir });
  }

  return {
    cacheRoot,
    workspace: resolvedWorkspace,
    homes,
    pluginLink,
    copiedCredentials,
  };
}

/**
 * Install the profile peer dependencies into every eval home with the installed
 * CLI. A manual `node_modules` symlink is not enough for a linked plugin: the
 * Host's import of `@deepseek-ai/schemastery` resolves through the profile's own
 * installed packages, so `dsh plugin --profile eval add ...` must run in each
 * home; pnpm installs into `<home>/profiles/eval/node_modules`. Only
 * `@deepseek-ai/schemastery` is required; `@deepseek-ai/dsh-compaction` is
 * deliberately not installed (the 0.2.2-rc.1 runtime rejects it and it is not
 * needed to load the plugin).
 *
 * Never throws for a non-zero CLI exit: the caller gets per-home results so it
 * can fail with its own message. A rejected `exec` (spawn failure) is reported
 * as `code: null` for that home.
 *
 * @param {object} options
 * @param {Array<{ name?: string, home: string }>} options.homes Eval homes from {@link provision}.
 * @param {string} options.cliPath Installed `dsh` CLI path.
 * @param {(spec: object) => Promise<object>} [options.exec] Injected `runCommand`.
 * @param {NodeJS.ProcessEnv} [options.env] Full child environment (defaults to `process.env`).
 * @param {number} [options.timeoutMs] Per-home CLI timeout.
 * @returns {Promise<{
 *   ok: boolean,
 *   command: string[],
 *   homes: Array<{ name: string|null, home: string, ok: boolean, code: number|null, stdout: string, stderr: string }>,
 * }>}
 */
export async function ensurePeerDependencies(options = {}) {
  const homes = options.homes;
  if (!Array.isArray(homes) || homes.length === 0) {
    throw new Error('ensurePeerDependencies requires at least one provisioned home');
  }
  const cliPath = options.cliPath;
  if (typeof cliPath !== 'string' || cliPath.trim() === '') {
    throw new Error('ensurePeerDependencies requires a cliPath');
  }
  const exec = options.exec ?? runCommand;
  const env = options.env ?? process.env;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 300000;
  const pnpmArgs = ['plugin', '--profile', PROFILE_NAME, 'add', `${SCHEMASTERY_PACKAGE}@${SCHEMASTERY_SPEC}`];
  const results = [];

  for (const home of homes) {
    if (home === null || typeof home !== 'object' || typeof home.home !== 'string' || home.home === '') {
      throw new Error('ensurePeerDependencies received a home without a home path');
    }
    let result;
    try {
      result = await exec({
        command: cliPath,
        args: [...pnpmArgs],
        cwd: home.home,
        env: { ...env, DSH_HOME: home.home },
        timeoutMs,
      });
    } catch (error) {
      results.push({
        name: typeof home.name === 'string' ? home.name : null,
        home: home.home,
        ok: false,
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    results.push({
      name: typeof home.name === 'string' ? home.name : null,
      home: home.home,
      ok: result?.code === 0,
      code: typeof result?.code === 'number' ? result.code : null,
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : '',
    });
  }

  return {
    ok: results.every((result) => result.ok),
    command: [cliPath, ...pnpmArgs],
    homes: results,
  };
}
