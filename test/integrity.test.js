import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createCompactCommand } from '../lib/host/plan-compaction.js';

/*
 * Cross-file structural invariants ("完整性") for the Great Plan package.
 *
 * These are static/contract assertions for drift that the behavioral suites do
 * not see: files that would not be published, declared chunks that are never
 * loaded or loaded out of order, config field names that stop matching between
 * the Host schema and the Client Settings page, translator keys that do not
 * exist, CSS classes that do not exist in either direction, Host imports
 * missing from `peerDependencies`, the Client command name drifting from the
 * Host command, and the plugin-level service list drifting from the wiring.
 *
 * Everything is offline and deterministic: no DSH, no network, no DOM, no
 * dependencies. `lib/host/config.js` is source-parsed because it imports
 * Schemastery from the running installation and must stay unimportable here.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageName = packageJson.name;
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const chunkFiles = readdirSync(join(root, 'lib'))
  .filter((name) => name !== 'client.js' && name.startsWith('client.') && name.endsWith('.js'))
  .sort();

// ------------------------------------------------- browser module loader ----

/**
 * The Client chunks are plain browser-module factories registered through
 * `window.__ModuleLoader__`. A Map keyed by the declared `chunk` (or `entry`)
 * lets the tests materialize them in load order exactly like the real loader.
 */
const registry = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registry.set(registration.chunk ?? 'entry', registration);
    },
  },
};

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (compute) => compute(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: () => undefined,
};
const fakeReactDom = { createPortal: (node) => node };

/** Materialized module exports, keyed by chunk file name. */
const modules = new Map();

for (const file of ['client.js', ...chunkFiles]) {
  await import(`../lib/${file}`);
}

/** Materialize the Client entry without running `apply`. */
function createEntry() {
  const registration = registry.get('entry');
  assert.ok(registration, 'lib/client.js must register through window.__ModuleLoader__');
  assert.equal(registration.id, packageName, 'the Client entry must register the package id');
  return registration.factory(() => {
    throw new Error('the Client entry must not require a module synchronously');
  });
}

let materializePromise;
let materializedWaves;

/**
 * Materialize every chunk in `CHUNK_WAVES` order.
 *
 * The proxy `require` only returns React, React-DOM, or a sibling chunk that
 * was materialized in an earlier wave. A later-wave (or mistyped) sibling
 * require therefore fails here instead of crashing the slot entry in the GUI,
 * where the three-wave `Promise.all` loads make the registry order
 * non-deterministic.
 */
function materializeAll() {
  materializePromise ??= materializeNow();
  return materializePromise;
}

async function materializeNow() {
  const plugin = createEntry();
  const waves = plugin.testSurface.loadChunks();
  materializedWaves = waves;

  const waveIndex = new Map();
  for (let index = 0; index < waves.length; index += 1) {
    for (const spec of waves[index]) {
      const fileName = spec.replace(/^\.\//, '');
      assert.ok(chunkFiles.includes(fileName), `CHUNK_WAVES declares unknown chunk ${spec}`);
      waveIndex.set(fileName, index);
    }
  }

  for (let index = 0; index < waves.length; index += 1) {
    for (const spec of waves[index]) {
      const fileName = spec.replace(/^\.\//, '');
      const registration = registry.get(fileName);
      assert.ok(registration, `${fileName} did not register through window.__ModuleLoader__`);
      assert.equal(registration.id, packageName, `${fileName} must register the package id`);
      assert.equal(registration.chunk, fileName, `${fileName} must declare its own file name as chunk`);
      modules.set(fileName, registration.factory((requireSpec) => {
        if (requireSpec === 'react') return fakeReact;
        if (requireSpec === 'react-dom') return fakeReactDom;
        assert.ok(requireSpec.startsWith(`${packageName}/`), `${fileName} requires unexpected specifier ${requireSpec}`);
        const target = requireSpec.slice(packageName.length + 1);
        assert.ok(chunkFiles.includes(target), `${fileName} requires a chunk file that does not exist: ${requireSpec}`);
        const targetWave = waveIndex.get(target);
        assert.notEqual(targetWave, undefined, `${fileName} requires a chunk absent from CHUNK_WAVES: ${requireSpec}`);
        assert.ok(
          targetWave < index,
          `${fileName} (wave ${index}) requires ${requireSpec} from wave ${targetWave}; sync requires must target an earlier wave`,
        );
        const value = modules.get(target);
        assert.ok(value !== undefined, `${fileName} requires ${requireSpec} before it is materialized`);
        return value;
      }));
    }
  }

  return { plugin, waves };
}

// --------------------------------------------------------- small helpers ----

/** Recursively list repository files as `a/b.js` style relative paths. */
function walk(dir, base = root) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(absolute, base));
    } else {
      files.push(relative(base, absolute).split(sep).join('/'));
    }
  }
  return files;
}

/**
 * Tiny matcher for the literal/prefix patterns used in `package.json.files`.
 * `*` matches one path segment, which covers every pattern the manifest uses.
 */
function matchesFilePattern(file, pattern) {
  if (!pattern.includes('*')) return file === pattern;
  const star = pattern.indexOf('*');
  assert.equal(pattern.indexOf('*', star + 1), -1, `unsupported multi-wildcard files pattern: ${pattern}`);
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!file.startsWith(prefix) || !file.endsWith(suffix)) return false;
  const middle = file.slice(prefix.length, file.length - suffix.length);
  return middle.length > 0 && !middle.includes('/');
}

function isPacked(file) {
  return (packageJson.files ?? []).some((pattern) => matchesFilePattern(file, pattern));
}

/** Remove `//` and block comments while leaving string/template literals intact. */
function stripComments(source) {
  let result = '';
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      result += char;
      if (char === '\\') {
        result += next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    result += char;
    index += 1;
  }
  return result;
}

/** Locale keys used literally through `t('...')` in one source file. */
function literalTranslatorKeys(file) {
  const source = stripComments(read(`lib/${file}`));
  const keys = [];
  for (const match of source.matchAll(/\bt\('([^']+)'/g)) {
    if (/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(match[1])) keys.push(match[1]);
  }
  return keys;
}

// ----------------------------------------------------- 1. pack inventory ----

const EXPECTED_PACK = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'cordis.patch.yml',
  'icon.svg',
  'lib/client.actions.js',
  'lib/client.js',
  'lib/client.model.js',
  'lib/client.panel.js',
  'lib/client.preset.js',
  'lib/client.settings.js',
  'lib/client.ui.js',
  'lib/host/apply.js',
  'lib/host/config.js',
  'lib/host/plan-compaction.js',
  'lib/host/plan-evidence.js',
  'lib/host/plan-range.js',
  'lib/index.js',
  'locale/en.json',
  'locale/zh.json',
  'package.json',
];

test('pack inventory: package.json files expands to the complete published tree', () => {
  assert.deepEqual(EXPECTED_PACK.slice().sort(), [...new Set(EXPECTED_PACK)].sort(), 'EXPECTED_PACK must be unique');
  assert.equal(EXPECTED_PACK.length, 21, 'published entry count changed; update the frozen inventory deliberately');

  const allFiles = walk(root);
  const packed = ['package.json', ...allFiles.filter((file) => file !== 'package.json' && isPacked(file))].sort();
  assert.deepEqual(packed, EXPECTED_PACK.slice().sort(), 'the derived pack list differs from npm pack --dry-run');

  for (const file of allFiles.filter((name) => name.startsWith('lib/') && name.endsWith('.js'))) {
    assert.ok(isPacked(file), `runtime file lib/${file.slice(4)} is not shipped by package.json files`);
  }

  for (const file of packed) {
    assert.equal(file.startsWith('test/'), false, `test file ${file} must not be packed`);
    assert.equal(file.startsWith('tools/'), false, `tool file ${file} must not be packed`);
    assert.equal(file.startsWith('.github/'), false, `CI file ${file} must not be packed`);
    assert.equal(file.startsWith('docs/'), false, `docs file ${file} must not be packed`);
    assert.equal(file.startsWith('node_modules/'), false, `node_modules file ${file} must not be packed`);
    assert.notEqual(file, 'AGENTS.md', 'AGENTS.md is repository-only');
    assert.notEqual(file, '.DS_Store', '.DS_Store is not a deliverable');
  }
});

// -------------------------------------------------------- 2. chunk graph ----

test('chunk graph: waves cover every chunk and sync requires follow the wave order', async () => {
  const { plugin, waves } = await materializeAll();

  assert.deepEqual(plugin.testSurface.loadChunks(), waves, 'loadChunks must be stable');
  assert.equal(waves.length, 3, 'the Client loads its chunks in three waves');
  assert.ok(waves.every((wave) => wave.length > 0), 'no wave may be empty');

  const flattened = waves.flat().map((spec) => spec.replace(/^\.\//, ''));
  assert.deepEqual(flattened.slice().sort(), chunkFiles.slice().sort(), 'CHUNK_WAVES must load every lib/client.*.js exactly once');
  assert.equal(new Set(flattened).size, flattened.length, 'no chunk may appear in two waves');

  for (const fileName of chunkFiles) {
    const registration = registry.get(fileName);
    assert.ok(registration, `${fileName} is missing from the module registry`);
    assert.equal(registration.id, packageName, `${fileName} must register the package id`);
    assert.equal(registration.chunk, fileName, `${fileName} must register under its own file name`);
  }

  const entrySource = read('lib/client.js');
  assert.equal(/require\('([^']+)'\)/.test(entrySource), false, 'the entry must not require a module synchronously');
  assert.ok(entrySource.includes('require.async('), 'the entry must load chunks through require.async');

  const waveIndex = new Map();
  waves.forEach((wave, index) => {
    for (const spec of wave) waveIndex.set(spec.replace(/^\.\//, ''), index);
  });
  const edges = [];
  for (const fileName of chunkFiles) {
    const source = read(`lib/${fileName}`);
    for (const match of source.matchAll(/require\('([^']+)'\)/g)) {
      const spec = match[1];
      if (spec === 'react' || spec === 'react-dom') continue;
      assert.ok(spec.startsWith(`${packageName}/`), `${fileName} requires an unexpected specifier: ${spec}`);
      const target = spec.slice(packageName.length + 1);
      assert.ok(chunkFiles.includes(target), `${fileName} requires a chunk that does not exist: ${spec}`);
      const fromWave = waveIndex.get(fileName);
      const targetWave = waveIndex.get(target);
      assert.notEqual(targetWave, undefined, `${fileName} requires a chunk absent from CHUNK_WAVES: ${spec}`);
      assert.ok(targetWave < fromWave, `${fileName} (wave ${fromWave}) requires ${spec} from wave ${targetWave}`);
      edges.push(`${fileName}->${target}`);
    }
  }
  assert.ok(edges.length > 0, 'expected at least one sync sibling require');
});

// ------------------------------------------------------ 3. config mirror ----

test('config fields stay mirrored across Host schema, Client Settings, and prompt readers', async () => {
  await materializeAll();

  const configSource = read('lib/host/config.js');
  const configFields = [...configSource.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*z\.boolean\(\)\.default\(true\)\.volatile\(\),\s*$/gm)]
    .map((match) => match[1]);
  assert.equal(configFields.length, 4, 'the Host Config schema must define exactly four boolean switches');
  assert.equal((configSource.match(/default\(true\)/g) ?? []).length, 4, 'every Config switch must default to on');
  assert.equal((configSource.match(/volatile\(\)/g) ?? []).length, 4, 'every Config switch must be volatile');

  const settings = modules.get('client.settings.js');
  assert.deepEqual(
    Object.values(settings.FIELDS).slice().sort(),
    configFields.slice().sort(),
    'Client Settings FIELDS must match the Host Config field names',
  );
  assert.deepEqual(
    settings.ROWS.map((row) => row.field).slice().sort(),
    configFields.slice().sort(),
    'the Settings page must expose every Host Config field',
  );
  assert.equal(settings.ROWS.length, 4, 'the Settings page renders four rows');

  const evidenceSource = read('lib/host/plan-evidence.js');
  const readerFields = [...evidenceSource.matchAll(/readConfigSwitch\(\s*config,\s*'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    readerFields.slice().sort(),
    ['injectBrainstormingPrompt', 'injectUnlimitedBudgetPrompt'],
    'the prompt section reads the two prompt switches by their Host Config field names',
  );
});

// ------------------------------------------------ 4. translator key bijection ----

test('every t() key exists in both dictionaries and no dictionary key is dead', async () => {
  const { plugin } = await materializeAll();
  const { zh, en } = plugin.testSurface.dictionaries;
  const actions = modules.get('client.actions.js');
  const settings = modules.get('client.settings.js');
  const preset = modules.get('client.preset.js');

  const used = new Set();
  for (const file of ['client.js', ...chunkFiles]) {
    for (const key of literalTranslatorKeys(file)) used.add(key);
  }

  // Dynamic families: keys produced through data tables rather than literals.
  const codes = actions.ACTION_ERROR_CODES;
  assert.equal(codes.length, 8, 'ACTION_ERROR_CODES changed; update the cross-file expectations');
  for (const code of codes) used.add(`error.${code}`);

  const blocks = actions.describeFreshPrompt({ plan: '# Plan' }).blocks;
  assert.equal(blocks.length, 6, 'the first-message preview declares six blocks');
  const blockKeys = blocks.map((block) => block.titleKey).filter((key) => typeof key === 'string');
  assert.equal(blockKeys.length, 6, 'every preview block must declare a locale title key');
  for (const key of blockKeys) used.add(key);

  assert.equal(settings.ROWS.length, 4, 'the Settings page declares four rows');
  const rowKeys = settings.ROWS.flatMap((row) => [row.title, row.description]);
  assert.equal(rowKeys.length, 8, 'every Settings row declares a title and description key');
  for (const key of rowKeys) used.add(key);

  const presetIds = ['standard', 'ptc', 'minimal', 'cordis'];
  const presetKeys = [];
  const recordTranslator = (key) => {
    presetKeys.push(key);
    return key;
  };
  for (const id of presetIds) {
    preset.presetDisplay({ id }, recordTranslator);
    preset.presetDescription({ id }, recordTranslator);
  }
  assert.equal(presetKeys.length, 8, 'every built-in preset declares a name and description key');
  for (const key of presetKeys) used.add(key);

  const compactKeys = Object.values(actions.COMPACT_MESSAGE_KEYS);
  assert.equal(compactKeys.length, 13, 'COMPACT_MESSAGE_KEYS changed; update the cross-file expectations');
  for (const key of compactKeys) used.add(key);

  const dictionaryKeys = Object.keys(zh);
  assert.deepEqual(Object.keys(en).slice().sort(), dictionaryKeys.slice().sort(), 'zh and en dictionaries must declare the same keys');
  assert.equal(dictionaryKeys.length, 130, 'dictionary key count changed; update the frozen inventory deliberately');
  assert.equal(used.size, dictionaryKeys.length, 'every dictionary key must be used exactly by the known key families');
  assert.deepEqual(dictionaryKeys.filter((key) => !used.has(key)).sort(), [], 'dead dictionary keys');

  const missing = [...used].filter((key) => !(key in zh) || !(key in en)).sort();
  assert.deepEqual(missing, [], 'used locale keys missing from a dictionary');
});

// ---------------------------------------------------------- 5. error codes ----

test('error codes are all localized and the error.* namespace is fully covered', async () => {
  const { plugin } = await materializeAll();
  const { zh, en } = plugin.testSurface.dictionaries;
  const actions = modules.get('client.actions.js');

  const codes = actions.ACTION_ERROR_CODES;
  for (const code of codes) {
    const key = `error.${code}`;
    assert.equal(typeof zh[key], 'string', `zh is missing ${key}`);
    assert.equal(typeof en[key], 'string', `en is missing ${key}`);
  }

  const expected = [
    ...codes.map((code) => `error.${code}`),
    'error.approveFailed',
    'error.selectModelFailed',
    'error.freshFailed',
  ].sort();
  assert.deepEqual(
    Object.keys(zh).filter((key) => key.startsWith('error.')).sort(),
    expected,
    'the error.* dictionary namespace must contain exactly the coded errors plus the panel fallbacks',
  );
});

// ------------------------------------------------------ 6. imports/peers ----

test('Host runtime imports are covered by peerDependencies and no dependency is installed', () => {
  const hostFiles = ['lib/index.js', ...readdirSync(join(root, 'lib/host')).filter((name) => name.endsWith('.js')).map((name) => `lib/host/${name}`)];
  const imported = new Set();
  for (const file of hostFiles) {
    const source = read(file);
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) imported.add(match[1]);
    for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) imported.add(match[1]);
  }

  const bareHarnessImports = [...imported].filter((spec) => spec.startsWith('@deepseek-ai/')).sort();
  assert.ok(bareHarnessImports.length > 0, 'expected at least one bare Harness import in the Host half');
  const peers = Object.keys(packageJson.peerDependencies ?? {}).sort();
  assert.deepEqual(
    bareHarnessImports.filter((spec) => !peers.includes(spec)),
    [],
    'every bare Harness import must be declared in peerDependencies',
  );

  assert.deepEqual(packageJson.dependencies ?? {}, {}, 'the plugin must not install runtime dependencies');
  assert.deepEqual(packageJson.devDependencies ?? {}, {}, 'the repository must not install dev dependencies');
});

// ----------------------------------------------------------- 7. CSS graph ----

test('CSS classes are defined and used in both directions', () => {
  const uiSource = read('lib/client.ui.js');
  const cssStart = uiSource.indexOf('const CSS = `');
  assert.notEqual(cssStart, -1, 'lib/client.ui.js must declare the CSS template');
  const cssStartEnd = cssStart + 'const CSS = `'.length;
  const cssEnd = uiSource.indexOf('`;', cssStartEnd);
  assert.notEqual(cssEnd, -1, 'the CSS template must be terminated');
  const css = uiSource.slice(cssStartEnd, cssEnd);
  const defined = new Set([...css.matchAll(/\.(gp-[A-Za-z0-9_-]+)/g)].map((match) => match[1]));

  const sourceWithoutCss = uiSource.slice(0, cssStart) + uiSource.slice(cssEnd);
  const rawTokens = new Set();
  const scannedFiles = new Map([['client.ui.js', sourceWithoutCss]]);
  for (const file of chunkFiles) {
    if (file !== 'client.ui.js') scannedFiles.set(file, read(`lib/${file}`));
  }
  scannedFiles.set('client.js', read('lib/client.js'));
  for (const source of scannedFiles.values()) {
    for (const match of source.matchAll(/(?:['"`])(gp-[A-Za-z0-9_-]+)/g)) rawTokens.add(match[1]);
    for (const match of source.matchAll(/(gp-[A-Za-z0-9_-]+)\$\{/g)) rawTokens.add(match[1]);
  }

  // Non-class tokens: an element id (`gp-great-plan-title`, `aria-describedby`
  // ids) and the `@keyframes` animation name that lives inside the CSS block.
  const nonClassTokens = new Set(['gp-great-plan-title', 'gp-setting-desc-', 'gp-pulse']);
  const used = new Set();
  for (const token of rawTokens) {
    if (nonClassTokens.has(token)) continue;
    if (token.endsWith('-')) {
      assert.equal(token, 'gp-button-', `unexpected dynamic CSS class prefix: ${token}`);
      for (const variant of ['primary', 'outline', 'ghost']) used.add(`gp-button-${variant}`);
      continue;
    }
    used.add(token);
  }

  assert.deepEqual([...used].filter((name) => !defined.has(name)).sort(), [], 'CSS classes used in code but never defined');
  assert.deepEqual([...defined].filter((name) => !used.has(name)).sort(), [], 'CSS classes defined but never used in code');
  assert.ok(defined.size >= 70, 'the stylesheet must define the plugin classes');
});

// ----------------------------------------------------- 8. command identity ----

test('the Client command name matches the Host command and both READMEs', async () => {
  await materializeAll();
  const actions = modules.get('client.actions.js');

  const command = createCompactCommand({});
  assert.match(command.name, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'host command names are lowercase kebab-case');
  assert.equal(`/${command.name}`, '/great-plan-compact', 'the compaction command name is frozen');

  const executed = [];
  const ctx = {
    remote: {
      commands: {
        async execute(...args) {
          executed.push(args);
          return { ok: false, error: { message: 'boom' } };
        },
      },
    },
  };
  const result = await actions.runCompactCommand({ ctx, sessionId: 'session-1', signal: undefined });
  assert.equal(result.ok, false, 'a failed RPC reports failure');
  assert.equal(executed.length, 1, 'the compact path runs exactly one command');
  assert.equal(executed[0][0], 'session-1', 'the command runs in the current session');
  assert.equal(executed[0][1], `/${command.name}`, 'the Client must execute the Host command by its registered name');
  assert.deepEqual(executed[0].slice(2, 3), [[]], 'the compact command takes no arguments');

  for (const doc of ['README.md', 'README.zh-CN.md']) {
    assert.ok(read(doc).includes(`/${command.name}`), `${doc} must document /${command.name}`);
  }
});

// ------------------------------------------------------- 9. inject list ----

const FROZEN_INJECT = [
  'slots',
  'locale',
  'sessions',
  'modelDirectories',
  'remote',
  'remote.session',
  'remote.commands',
  'remote.agentPresets',
  'uiWorkspace',
];

test('the Client inject list is the frozen service set', async () => {
  const { plugin } = await materializeAll();
  assert.deepEqual(plugin.inject, FROZEN_INJECT, 'the plugin-level inject list is a frozen contract; update it deliberately');
  assert.equal(plugin.inject.includes('configForms'), false, 'configForms must stay optional through ctx.inject');
  assert.equal(typeof plugin.apply, 'function');
});
