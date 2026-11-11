import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packageName = '@onefl666/dsh-great-plan';
const libDir = new URL('../lib/', import.meta.url);
const clientExport = packageJson.exports['./client'];
const chunkNames = readdirSync(libDir).filter((name) => name !== 'client.js' && name.startsWith('client.') && name.endsWith('.js'));

test('package manifest declares the Host bundle and the Client half', () => {
  assert.equal(packageJson.name, packageName);
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.equal(packageJson.dsh.client.immediately, true);
  assert.equal(packageJson.dsh.client.external, undefined, 'the baseline module table covers every runtime import');
  assert.equal(packageJson.main, 'lib/index.js');
  assert.equal(packageJson.exports['.'], './lib/index.js');
  assert.equal(clientExport, './lib/client.js');
  assert.equal(packageJson.exports['./icon'], './icon.svg');
  assert.equal(packageJson.files.includes('lib/index.js'), true);
  assert.equal(packageJson.files.includes('lib/client.js'), true);
  assert.equal(packageJson.files.includes('lib/client.*.js'), true);
  assert.equal(packageJson.files.includes('lib/host/*.js'), true);
});

test('runtime code lives under lib/ and the package root stays clean', () => {
  // The DSH client loader serves package-local chunks from the directory of
  // the resolved `exports["./client"]` artifact, so the chunks must stay
  // siblings of the client entry while keeping the bare `client.<name>.js`
  // file names the module registration validates.
  assert.equal(dirname(clientExport).replace(/^\.\//, ''), 'lib');
  assert.ok(existsSync(new URL('../lib/index.js', import.meta.url)), 'missing lib/index.js');
  assert.ok(existsSync(new URL(`../${clientExport}`, import.meta.url)), `missing ${clientExport}`);
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.js')), [], 'package root must ship no JavaScript runtime files');
  assert.equal(existsSync(join(root, 'host')), false, 'the Host half lives under lib/host/');
});

test('cordis patch inserts the Host row', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /id: great-plan/);
  assert.ok(patch.includes(packageJson.name), 'bundle patch row name must equal the package name');
});

test('locale metadata is present in both languages', () => {
  for (const locale of ['en', 'zh']) {
    const json = JSON.parse(readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'));
    assert.equal(typeof json.meta.title, 'string');
    assert.ok(json.meta.title.length > 0);
    assert.equal(typeof json.meta.description, 'string');
    assert.ok(json.meta.description.length > 0);
  }
});

test('icon is present and small enough', () => {
  const icon = new URL('../icon.svg', import.meta.url);
  assert.equal(packageJson.icon, './icon.svg');
  assert.ok(existsSync(icon));
  assert.ok(statSync(icon).size < 256 * 1024);
});

test('every Client chunk follows the package-local chunk naming rule', () => {
  assert.ok(chunkNames.length >= 5);
  for (const chunk of chunkNames) {
    assert.match(chunk, /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/);
    // Served as siblings of the client entry: `<plugins>/<pkg>/client.<name>.js`.
    assert.ok(existsSync(new URL(`../lib/${chunk}`, import.meta.url)), `missing lib/${chunk}`);
  }
  for (const required of ['client.ui.js', 'client.settings.js', 'client.model.js', 'client.preset.js', 'client.actions.js', 'client.panel.js']) {
    assert.ok(chunkNames.includes(required), `missing ${required}`);
  }
});

test('required delivery files exist', () => {
  for (const relative of [
    'lib/index.js',
    'lib/host/plan-range.js',
    'lib/host/plan-compaction.js',
    'lib/host/plan-evidence.js',
    'lib/host/apply.js',
    'lib/host/config.js',
    'lib/client.js',
    'lib/client.settings.js',
    'cordis.patch.yml',
    'locale/en.json',
    'locale/zh.json',
    'icon.svg',
    'README.md',
    'README.zh-CN.md',
  ]) {
    assert.ok(existsSync(new URL(`../${relative}`, import.meta.url)), `missing ${relative}`);
  }
});

test('Client sources do not import Harness Client packages', () => {
  const files = ['client.js', ...chunkNames];
  for (const file of files) {
    const source = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
    assert.equal(source.includes('dsh-client-ui-primitives'), false, `${file} imports primitives`);
    assert.equal(source.includes("require('@deepseek-ai/"), false, `${file} requires a Harness package`);
    assert.equal(source.includes('require("@deepseek-ai/'), false, `${file} requires a Harness package`);
  }
});

test('the linked package declares the Harness packages its Host code imports as peers', () => {
  // A linked local plugin resolves bare Harness imports to the running
  // installation only when its own manifest lists them as peer dependencies;
  // otherwise Node falls back to the workspace and activation fails with
  // ERR_MODULE_NOT_FOUND.
  const peers = packageJson.peerDependencies ?? {};
  for (const name of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-compaction']) {
    assert.equal(typeof peers[name], 'string', `missing peer dependency ${name}`);
    assert.ok(peers[name].trim().length > 0, `empty peer range for ${name}`);
    assert.equal(packageJson.dependencies?.[name], undefined, `${name} must be a peer, not an installed dependency`);
  }
});

test('the Host entry exports Config plus apply and the Client orders the settings packages', () => {
  const entry = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(entry, /export \{ Config \} from '\.\/host\/config\.js'/);
  assert.match(entry, /export \{ apply \} from '\.\/host\/apply\.js'/);

  const config = readFileSync(new URL('../lib/host/config.js', import.meta.url), 'utf8');
  for (const field of [
    'injectBrainstormingPrompt',
    'injectUnlimitedBudgetPrompt',
    'includeOriginalUserInstructions',
    'includeMinimalRuntimeContext',
  ]) {
    assert.match(config, new RegExp(field));
  }
  assert.equal((config.match(/default\(true\)/g) ?? []).length, 4, 'all switches default to on');
  assert.equal((config.match(/volatile\(\)/g) ?? []).length, 4, 'all switches are volatile');

  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'));
});

test('package identity and publish metadata stay consistent', () => {
  assert.equal(packageJson.name, packageName);
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.publishConfig?.access, 'public');
  assert.equal(packageJson.author, 'onefl666');
  assert.equal(packageJson.license, 'MIT');
  assert.ok(Array.isArray(packageJson.keywords) && packageJson.keywords.length >= 3, 'keywords must be present');
  assert.equal(packageJson.exports['./package.json'], './package.json');
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);

  for (const entry of [
    'lib/index.js',
    'lib/host/*.js',
    'lib/client.js',
    'lib/client.*.js',
    'cordis.patch.yml',
    'locale/*.json',
    'icon.svg',
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
  ]) {
    assert.equal(packageJson.files.includes(entry), true, `files must ship ${entry}`);
  }

  // The browser module name is the package name: the entry and every chunk
  // must register exactly that id, and package-qualified sibling requires must
  // use it as the prefix. Other `id` values are business ids (slot, plan
  // blocks), so match only the registration block.
  const clientFiles = ['client.js', ...chunkNames];
  assert.ok(clientFiles.length >= 7, 'expected the entry plus six chunks');
  for (const file of clientFiles) {
    const source = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
    const registration = source.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/);
    assert.ok(registration, `${file} must register through __ModuleLoader__.load`);
    assert.equal(registration[1], packageName, `${file} must register the package name`);

    const specs = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
    for (const spec of specs) {
      if (!spec.startsWith('@')) continue;
      assert.ok(spec.startsWith(`${packageName}/client.`), `${file} requires an unexpected package: ${spec}`);
    }
  }
});
