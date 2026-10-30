import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packageName = '@local/dsh-great-plan';

test('package manifest declares the Host bundle and the Client half', () => {
  assert.equal(packageJson.name, packageName);
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.equal(packageJson.dsh.client.immediately, true);
  assert.equal(packageJson.exports['./client'], './client.js');
  assert.equal(packageJson.exports['./icon'], './icon.svg');
  assert.equal(packageJson.files.includes('client.js'), true);
  assert.equal(packageJson.files.includes('client.*.js'), true);
  assert.equal(packageJson.files.includes('host/*.js'), true);
});

test('cordis patch inserts the Host row', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /id: great-plan/);
  assert.match(patch, /@local\/dsh-great-plan/);
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
  assert.ok(existsSync(icon));
  assert.ok(statSync(icon).size < 256 * 1024);
});

test('every Client chunk follows the package-local chunk naming rule', () => {
  const chunks = readdirSync(root).filter((name) => name !== 'client.js' && name.startsWith('client.') && name.endsWith('.js'));
  assert.ok(chunks.length >= 5);
  for (const chunk of chunks) {
    assert.match(chunk, /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/);
  }
  for (const required of ['client.ui.js', 'client.settings.js', 'client.model.js', 'client.preset.js', 'client.actions.js', 'client.panel.js']) {
    assert.ok(chunks.includes(required), `missing ${required}`);
  }
});

test('required delivery files exist', () => {
  for (const relative of [
    'index.js',
    'host/plan-range.js',
    'host/plan-compaction.js',
    'host/plan-evidence.js',
    'host/apply.js',
    'host/config.js',
    'client.js',
    'client.settings.js',
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
  const files = readdirSync(root).filter((name) => name === 'client.js' || (name.startsWith('client.') && name.endsWith('.js')));
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
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
  const entry = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(entry, /export \{ Config \} from '\.\/host\/config\.js'/);
  assert.match(entry, /export \{ apply \} from '\.\/host\/apply\.js'/);

  const config = readFileSync(new URL('../host/config.js', import.meta.url), 'utf8');
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
