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
  for (const required of ['client.ui.js', 'client.model.js', 'client.preset.js', 'client.actions.js', 'client.panel.js']) {
    assert.ok(chunks.includes(required), `missing ${required}`);
  }
});

test('required delivery files exist', () => {
  for (const relative of [
    'index.js',
    'host/plan-range.js',
    'host/plan-compaction.js',
    'host/plan-evidence.js',
    'client.js',
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
