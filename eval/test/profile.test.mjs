import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ARM_CONFIGS,
  ARM_NAMES,
  BASE_DISABLED_ROWS,
  BASE_PATCH_TEXT,
  CACHE_ENV,
  PEER_DEPENDENCIES,
  PROFILE_BUNDLES,
  PROFILE_NAME,
  PLUGIN_PACKAGE,
  SCHEMASTERY_PACKAGE,
  SCHEMASTERY_SPEC,
  armPatchPath,
  armPatchText,
  assertSafeHome,
  basePatchPath,
  defaultCacheRoot,
  ensurePeerDependencies,
  homeName,
  profileFileContents,
  provision,
} from '../interactive-swe/profile/provision.mjs';

/** Create a temp directory removed after the test. */
function tempDir(t, prefix = 'gp-profile-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Minimal plugin checkout used as the symlink target. */
function tempWorkspace(t, name = 'workspace') {
  const dir = path.join(tempDir(t), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"@onefl666/dsh-great-plan","version":"0.6.0"}\n');
  return dir;
}

/** Parse the top-level config keys out of one arm patch text. */
function armConfigValues(text) {
  const values = {};
  let inConfig = false;
  for (const line of text.split('\n')) {
    if (/^  config:\s*$/.test(line)) {
      inConfig = true;
      continue;
    }
    if (!inConfig) continue;
    const match = /^    ([A-Za-z0-9_]+):\s*(true|false)\s*$/.exec(line);
    if (match !== null) values[match[1]] = match[2] === 'true';
    else if (line.trim() !== '' && !line.startsWith('    ')) break;
  }
  return values;
}

test('defaultCacheRoot: default path and cache env override', () => {
  assert.equal(defaultCacheRoot({}, '/home/alice'), path.resolve('/home/alice/.cache/great-plan-eval'));
  assert.equal(defaultCacheRoot({ [CACHE_ENV]: '/tmp/eval-cache' }, '/home/alice'), path.resolve('/tmp/eval-cache'));
  assert.equal(defaultCacheRoot({ [CACHE_ENV]: '~/evals' }, '/home/alice'), path.resolve('/home/alice/evals'));
  assert.equal(defaultCacheRoot({ [CACHE_ENV]: '~' }, '/home/alice'), '/home/alice');
  assert.equal(defaultCacheRoot({ [CACHE_ENV]: '   ' }, '/home/alice'), path.resolve('/home/alice/.cache/great-plan-eval'));
});

test('assertSafeHome rejects the real DSH home and its descendants', () => {
  const home = os.homedir();
  assert.equal(assertSafeHome(path.join('/tmp', 'safe-eval-home')), path.resolve('/tmp/safe-eval-home'));
  assert.throws(() => assertSafeHome(path.join(home, '.dsh')), (error) => error.code === 'unsafe-home');
  assert.throws(() => assertSafeHome(path.join(home, '.dsh', 'profiles', 'desktop')), (error) => error.code === 'unsafe-home');
  assert.throws(() => assertSafeHome(''), (error) => error.code === 'invalid-home');
  assert.throws(() => assertSafeHome(undefined), (error) => error.code === 'invalid-home');
});

test('homeName is deterministic per worker', () => {
  assert.equal(homeName(0), 'dsh-home');
  assert.equal(homeName(1), 'dsh-home-w1');
  assert.equal(homeName(2), 'dsh-home-w2');
  assert.throws(() => homeName(-1));
  assert.throws(() => homeName(1.5));
});

test('profileFileContents describes the eval profile exactly', () => {
  const workspace = '/tmp/plugin-checkout';
  const files = profileFileContents({ workspace });
  assert.deepEqual(Object.keys(files).sort(), ['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml']);
  assert.equal(files['cordis.yml'], '[]\n');
  assert.equal(files['cordis.patch.yml'], '[]\n');
  const manifest = JSON.parse(files['package.json']);
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dsh.profile.bundles, [...PROFILE_BUNDLES]);
  assert.equal(manifest.dsh.profile.bundles[0], '@deepseek-ai/dsh-base');
  assert.equal(manifest.dsh.profile.bundles[1], '@deepseek-ai/dsh-sdk-app');
  assert.equal(manifest.dsh.profile.bundles[2], PLUGIN_PACKAGE);
  assert.deepEqual(manifest.dependencies, {
    [PLUGIN_PACKAGE]: `link:${path.resolve(workspace)}`,
    [SCHEMASTERY_PACKAGE]: '~3.18.5',
  });
  assert.deepEqual(PEER_DEPENDENCIES, { [SCHEMASTERY_PACKAGE]: SCHEMASTERY_SPEC });
  assert.equal(SCHEMASTERY_PACKAGE, '@deepseek-ai/schemastery');
  assert.equal(SCHEMASTERY_SPEC, '~3.18.5');
  assert.match(files['pnpm-workspace.yaml'], /^packages:\n {2}- \.\n/);
  assert.equal(files['package.json'].endsWith('\n'), true);
  assert.deepEqual(profileFileContents({ workspace }), files);
  assert.throws(() => profileFileContents({}));
});

test('BASE_PATCH_TEXT inserts the Team rows with the installed config', () => {
  assert.match(BASE_PATCH_TEXT, /- insert:/);
  assert.match(BASE_PATCH_TEXT, /- id: agent-team\n {6}name: '@deepseek-ai\/dsh-experimental-agent-team'\n {6}config:\n {8}maxMembers: 8\n {8}maxTasks: 256\n {8}maxMessageBytes: 65536\n {8}disposalTimeoutMs: 5000/);
  assert.match(BASE_PATCH_TEXT, /- id: tool-agent-team\n {6}name: '@deepseek-ai\/dsh-experimental-tool-agent-team'\n {6}config:\n {8}freshProvider: spawn\n {8}forkProvider: fork/);
  for (const id of BASE_DISABLED_ROWS) {
    assert.match(BASE_PATCH_TEXT, new RegExp(`- id: ${id}\\n {2}disabled: true\\n`), `missing disable row ${id}`);
  }
  assert.match(BASE_PATCH_TEXT, /- id: web\n {2}disabled: true/);
});

test('committed base.patch.yml matches BASE_PATCH_TEXT byte for byte', () => {
  const file = basePatchPath();
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), BASE_PATCH_TEXT);
});

test('armPatchText native disables the row and writes no config', () => {
  const text = armPatchText('native');
  assert.match(text, /- id: great-plan\n {2}disabled: true\n/);
  assert.doesNotMatch(text, /config:/);
  assert.equal(fs.readFileSync(armPatchPath('native'), 'utf8'), text);
});

test('armPatchText evidence restates all four fields with the evidence values', () => {
  const text = armPatchText('evidence');
  assertConfigLines(text);
  assert.deepEqual(armConfigValues(text), {
    injectBrainstormingPrompt: false,
    injectUnlimitedBudgetPrompt: true,
    includeOriginalUserInstructions: true,
    includeMinimalRuntimeContext: true,
  });
  assert.deepEqual(Object.keys(ARM_CONFIGS.evidence), [
    'injectBrainstormingPrompt',
    'injectUnlimitedBudgetPrompt',
    'includeOriginalUserInstructions',
    'includeMinimalRuntimeContext',
  ]);
  assert.equal(fs.readFileSync(armPatchPath('evidence'), 'utf8'), text);
});

test('armPatchText full restates all four fields as true', () => {
  const text = armPatchText('full');
  assertConfigLines(text);
  assert.deepEqual(armConfigValues(text), {
    injectBrainstormingPrompt: true,
    injectUnlimitedBudgetPrompt: true,
    includeOriginalUserInstructions: true,
    includeMinimalRuntimeContext: true,
  });
  assert.equal(fs.readFileSync(armPatchPath('full'), 'utf8'), text);
});

test('armPatchText rejects unknown arms', () => {
  assert.deepEqual([...ARM_NAMES], ['native', 'evidence', 'full']);
  assert.throws(() => armPatchText('bogus'), /unknown arm/);
  assert.throws(() => armPatchPath('bogus'), /unknown arm/);
});

/** Assert the four required config rows appear in one exact order. */
function assertConfigLines(text) {
  const fields = text.split('\n').filter((line) => /^ {4}[A-Za-z0-9_]+:/.test(line));
  assert.deepEqual(fields.map((line) => line.trim().split(':')[0]), [
    'injectBrainstormingPrompt',
    'injectUnlimitedBudgetPrompt',
    'includeOriginalUserInstructions',
    'includeMinimalRuntimeContext',
  ]);
}

test('provision creates one isolated home with profile files and a plugin symlink', (t) => {
  const workspace = tempWorkspace(t);
  const root = tempDir(t);
  const cacheRoot = path.join(root, 'cache');
  const result = provision({ workspace, cacheRoot, homeDir: root });

  assert.equal(result.cacheRoot, path.resolve(cacheRoot));
  assert.equal(result.workspace, path.resolve(workspace));
  assert.equal(result.homes.length, 1);
  assert.equal(result.homes[0].name, 'dsh-home');
  assert.equal(result.homes[0].home, path.join(result.cacheRoot, 'homes', 'dsh-home'));
  assert.equal(result.homes[0].profileDir, path.join(result.homes[0].home, 'profiles', PROFILE_NAME));
  assert.equal(result.copiedCredentials, false);

  const expected = profileFileContents({ workspace });
  for (const [fileName, content] of Object.entries(expected)) {
    assert.equal(fs.readFileSync(path.join(result.homes[0].profileDir, fileName), 'utf8'), content);
  }
  const link = path.join(result.homes[0].home, 'node_modules', ...PLUGIN_PACKAGE.split('/'));
  assert.equal(result.pluginLink, link);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(link), fs.realpathSync(workspace));
  assert.equal(fs.existsSync(path.join(result.homes[0].home, '.credentials.yaml')), false);
});

test('provision isolates multiple workers under distinct homes', (t) => {
  const workspace = tempWorkspace(t);
  const root = tempDir(t);
  const result = provision({ workspace, cacheRoot: path.join(root, 'cache'), workers: 3, homeDir: root });
  assert.deepEqual(result.homes.map((home) => home.name), ['dsh-home', 'dsh-home-w1', 'dsh-home-w2']);
  const homes = new Set(result.homes.map((home) => home.home));
  assert.equal(homes.size, 3);
  for (const home of result.homes) {
    const link = path.join(home.home, 'node_modules', ...PLUGIN_PACKAGE.split('/'));
    assert.equal(fs.realpathSync(link), fs.realpathSync(workspace));
  }
});

test('provision is idempotent without force', (t) => {
  const workspace = tempWorkspace(t);
  const root = tempDir(t);
  const cacheRoot = path.join(root, 'cache');
  const first = provision({ workspace, cacheRoot, homeDir: root });
  const second = provision({ workspace, cacheRoot, homeDir: root });
  assert.deepEqual(second, first);
  assert.equal(fs.realpathSync(second.pluginLink), fs.realpathSync(workspace));
});

test('provision refuses a conflicting link unless forced', (t) => {
  const workspace = tempWorkspace(t, 'workspace-a');
  const other = tempWorkspace(t, 'workspace-b');
  const root = tempDir(t);
  const cacheRoot = path.join(root, 'cache');
  const first = provision({ workspace, cacheRoot, homeDir: root });
  const link = first.pluginLink;
  fs.unlinkSync(link);
  fs.symlinkSync(other, link, 'dir');
  assert.throws(() => provision({ workspace, cacheRoot, homeDir: root }), (error) => error.code === 'link-conflict');
  const forced = provision({ workspace, cacheRoot, homeDir: root, force: true });
  assert.equal(fs.realpathSync(forced.pluginLink), fs.realpathSync(workspace));
});

test('provision replaces a conflicting regular directory only with force', (t) => {
  const workspace = tempWorkspace(t);
  const root = tempDir(t);
  const cacheRoot = path.join(root, 'cache');
  const first = provision({ workspace, cacheRoot, homeDir: root });
  fs.unlinkSync(first.pluginLink);
  fs.mkdirSync(first.pluginLink, { recursive: true });
  assert.throws(() => provision({ workspace, cacheRoot, homeDir: root }), (error) => error.code === 'path-conflict');
  const forced = provision({ workspace, cacheRoot, homeDir: root, force: true });
  assert.equal(fs.lstatSync(forced.pluginLink).isSymbolicLink(), true);
});

test('provision copies credentials explicitly with mode 0600 and never symlinks', (t) => {
  const workspace = tempWorkspace(t);
  const root = tempDir(t);
  const source = path.join(root, '.credentials.yaml');
  fs.writeFileSync(source, 'providers:\n  deepseek:\n    apiKey: test-key\n');
  const result = provision({
    workspace,
    cacheRoot: path.join(root, 'cache'),
    homeDir: root,
    copyCredentials: true,
  });
  const target = path.join(result.homes[0].home, '.credentials.yaml');
  assert.equal(result.copiedCredentials, true);
  const stat = fs.lstatSync(target);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(source, 'utf8'));
});

test('provision does not copy credentials unless asked', (t) => {
  const workspace = tempWorkspace(t);
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, '.credentials.yaml'), 'x: y\n');
  const result = provision({ workspace, cacheRoot: path.join(root, 'cache'), homeDir: root });
  assert.equal(result.copiedCredentials, false);
  assert.equal(fs.existsSync(path.join(result.homes[0].home, '.credentials.yaml')), false);
});

test('provision fails loudly when copyCredentials is requested without a source', (t) => {
  const workspace = tempWorkspace(t);
  const root = tempDir(t);
  assert.throws(
    () => provision({ workspace, cacheRoot: path.join(root, 'cache'), homeDir: root, copyCredentials: true }),
    (error) => error.code === 'credentials-missing',
  );
});

test('provision rejects a missing workspace and invalid worker counts', (t) => {
  const root = tempDir(t);
  assert.throws(
    () => provision({ workspace: path.join(root, 'absent'), cacheRoot: path.join(root, 'cache'), homeDir: root }),
    (error) => error.code === 'workspace-missing',
  );
  const workspace = tempWorkspace(t);
  assert.throws(() => provision({ workspace, cacheRoot: path.join(root, 'cache'), homeDir: root, workers: 0 }), /workers/);
  assert.throws(() => provision({ workspace, cacheRoot: path.join(root, 'cache'), homeDir: root, workers: 1.5 }), /workers/);
});

test('provision refuses to write under the real DSH home', () => {
  const unsafeRoot = path.join(os.homedir(), '.dsh', `gp-eval-provision-test-${process.pid}`);
  assert.equal(fs.existsSync(unsafeRoot), false);
  assert.throws(
    () => provision({ workspace: process.cwd(), cacheRoot: unsafeRoot }),
    (error) => error.code === 'unsafe-home',
  );
  assert.equal(fs.existsSync(unsafeRoot), false);
});

test('ensurePeerDependencies installs only schemastery in every home', async (t) => {
  const workspace = tempWorkspace(t);
  const root = tempDir(t);
  const result = provision({ workspace, cacheRoot: path.join(root, 'cache'), workers: 2, homeDir: root });
  const calls = [];
  const exec = async (spec) => {
    calls.push(spec);
    return { code: 0, signal: null, stdout: 'installed\n', stderr: '', durationMs: 5 };
  };
  const outcome = await ensurePeerDependencies({
    homes: result.homes,
    cliPath: '/app/cli/bin/dsh',
    exec,
    env: { PATH: '/usr/bin', DSH_CLI: '/app/cli/bin/dsh' },
  });

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.command, [
    '/app/cli/bin/dsh',
    'plugin',
    '--profile',
    'eval',
    'add',
    '@deepseek-ai/schemastery@~3.18.5',
  ]);
  assert.equal(outcome.homes.length, 2);
  assert.equal(calls.length, 2);
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const home = result.homes[index];
    assert.equal(call.command, '/app/cli/bin/dsh');
    assert.deepEqual(call.args, ['plugin', '--profile', 'eval', 'add', '@deepseek-ai/schemastery@~3.18.5']);
    assert.equal(call.cwd, home.home);
    assert.equal(call.env.DSH_HOME, home.home);
    assert.equal(call.env.PATH, '/usr/bin');
    assert.equal(call.args.join(' ').includes('dsh-compaction'), false);
    assert.equal(outcome.homes[index].ok, true);
  }
});

test('ensurePeerDependencies reports per-home failures without throwing', async (t) => {
  const workspace = tempWorkspace(t);
  const root = tempDir(t);
  const result = provision({ workspace, cacheRoot: path.join(root, 'cache'), workers: 2, homeDir: root });
  const exec = async (spec) => {
    if (spec.cwd.endsWith('dsh-home-w1')) return { code: 1, stdout: '', stderr: 'pnpm failed: 404' };
    throw new Error('spawn dsh ENOENT');
  };
  const outcome = await ensurePeerDependencies({ homes: result.homes, cliPath: '/app/cli/bin/dsh', exec });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.homes[0].ok, false);
  assert.equal(outcome.homes[0].code, null);
  assert.match(outcome.homes[0].stderr, /spawn dsh ENOENT/);
  assert.equal(outcome.homes[1].code, 1);
  assert.equal(outcome.homes[1].ok, false);
  assert.match(outcome.homes[1].stderr, /404/);
});

test('ensurePeerDependencies validates its inputs', async () => {
  await assert.rejects(() => ensurePeerDependencies({ cliPath: '/x' }), /at least one provisioned home/);
  await assert.rejects(() => ensurePeerDependencies({ homes: [{ name: 'a', home: '/tmp/a' }] }), /cliPath/);
  await assert.rejects(
    () => ensurePeerDependencies({ homes: [{ name: 'a' }], cliPath: '/x', exec: async () => ({ code: 0 }) }),
    /home path/,
  );
});
