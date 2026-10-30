import assert from 'node:assert/strict';
import test from 'node:test';

const registry = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registry.set(value.chunk ?? 'entry', value);
    },
  },
};

await import('../client.js');
await import('../client.actions.js');

/**
 * Materialize the Client entry without running `apply`.
 *
 * The factory body declares the dictionaries and the test surface only; every
 * chunk load happens inside `apply`.
 */
function createPlugin() {
  const entry = registry.get('entry');
  assert.equal(entry.id, '@local/dsh-great-plan');
  return entry.factory(() => {
    throw new Error('client.js must not require a module synchronously');
  });
}

/**
 * Locale keys the 0.3.0 release adds or changes.
 *
 * Keeping this inventory in the test makes a lost key a deterministic failure
 * instead of a silently English or missing string in the running GUI.
 */
const RELEASE_KEYS = [
  'panel.revise',
  'panel.searchModels',
  'panel.noMatches',
  'panel.modelDirectoryLoading',
  'panel.modelDirectoryError',
  'compact.failed',
  'compact.failedHint',
  'compact.retry',
  'compact.retrying',
  'compact.proceed',
  'compact.cancel',
  'compact.success',
  'compact.error.usage',
  'compact.error.planStateUnavailable',
  'compact.error.planInactive',
  'compact.error.backendUnavailable',
  'compact.error.noReview',
  'compact.error.empty',
  'compact.error.busy',
  'compact.error.changed',
  'compact.error.summary',
  'compact.error.commit',
  'compact.error.persistence',
  'compact.error.cancelled',
  'compact.error.unavailable',
  'clear.modelHint',
  'preview.title',
  'preview.plan',
  'preview.viewPlan',
  'preview.hidePlan',
  'preview.blocks',
  'preview.block.intro',
  'preview.block.budget',
  'preview.block.runtime',
  'preview.block.instructions',
  'preview.block.plan',
  'preview.included',
  'preview.excluded',
  'preview.instructionCount',
  'preview.loadingInstructions',
  'preview.instructionsUnavailable',
  'preview.noInstructions',
  'preview.oversized',
  'preview.total',
  'preview.approxTokens',
  'preview.runtimeHint',
  'preview.minimalSwitchHint',
  'preview.switches',
  'preview.switchBudget',
  'preview.switchInstructions',
  'preview.switchMinimal',
  'error.emptyPlan',
  'error.createSessionFailed',
  'error.modelApplyFailed',
  'error.startSessionFailed',
  'error.openSessionFailed',
  'error.dismissFailed',
  'error.cleanupFailed',
  'settings.reset',
  'settings.resetAria',
];

/** Placeholder names used by one translated string. */
function placeholdersOf(value) {
  return [...new Set([...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]))].sort();
}

test('the Client entry exposes both dictionaries through its test surface', () => {
  const plugin = createPlugin();
  assert.equal(registry.get('entry').id, '@local/dsh-great-plan');
  assert.ok(plugin.testSurface, 'testSurface must be exposed by the entry factory');
  const { dictionaries } = plugin.testSurface;
  assert.ok(dictionaries, 'testSurface must expose dictionaries');
  assert.equal(typeof dictionaries.zh, 'object');
  assert.equal(typeof dictionaries.en, 'object');
  assert.ok(Object.keys(dictionaries.zh).length > 100);
  assert.ok(Object.keys(dictionaries.en).length > 100);
});

test('the zh and en dictionaries declare exactly the same keys', () => {
  const { zh, en } = createPlugin().testSurface.dictionaries;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test('every locale value is a non-empty string', () => {
  const { zh, en } = createPlugin().testSurface.dictionaries;
  for (const [locale, dictionary] of [['zh', zh], ['en', en]]) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`);
      assert.notEqual(value.trim(), '', `${locale}.${key} must not be blank`);
    }
  }
});

test('every key uses the same placeholders in both locales', () => {
  const { zh, en } = createPlugin().testSurface.dictionaries;
  for (const key of Object.keys(zh)) {
    assert.deepEqual(
      placeholdersOf(zh[key]),
      placeholdersOf(en[key]),
      `${key} must use the same placeholders in zh and en`,
    );
  }
});

test('the 0.3.0 locale additions are present in both dictionaries', () => {
  const { zh, en } = createPlugin().testSurface.dictionaries;
  for (const key of RELEASE_KEYS) {
    assert.equal(typeof zh[key], 'string', `zh is missing ${key}`);
    assert.equal(typeof en[key], 'string', `en is missing ${key}`);
  }
});

test('the test surface declares the three chunk load waves', () => {
  const plugin = createPlugin();
  assert.deepEqual(plugin.testSurface.loadChunks(), [
    ['./client.ui.js', './client.actions.js'],
    ['./client.settings.js', './client.model.js', './client.preset.js'],
    ['./client.panel.js'],
  ]);
});

/**
 * Materialize the stateless actions chunk (no sync `require` edges) so the
 * cross-side compact-failure mapping can be checked against the dictionaries.
 */
function createActionsChunk() {
  const actionRegistration = registry.get('client.actions.js');
  assert.ok(actionRegistration, 'client.actions.js must register through the module loader');
  assert.equal(actionRegistration.id, '@local/dsh-great-plan');
  return actionRegistration.factory(() => {
    throw new Error('client.actions.js must not require a module');
  });
}

test('every COMPACT_MESSAGE_KEYS mapping points at a key present in both dictionaries', () => {
  const actions = createActionsChunk();
  const { zh, en } = createPlugin().testSurface.dictionaries;
  assert.equal(typeof actions.COMPACT_MESSAGE_KEYS, 'object', 'COMPACT_MESSAGE_KEYS must stay exported');
  const keys = Object.values(actions.COMPACT_MESSAGE_KEYS);
  assert.equal(
    keys.length,
    13,
    'USAGE + the six FAILURES + the five MESSAGES + the client-unavailable message must all be mapped',
  );
  for (const key of keys) {
    assert.match(key, /^compact\.error\./, `${key} must be a compact error locale key`);
    assert.equal(typeof zh[key], 'string', `zh is missing ${key}`);
    assert.equal(typeof en[key], 'string', `en is missing ${key}`);
  }
  assert.equal(
    actions.COMPACT_MESSAGE_KEYS['The /great-plan-compact command is not available.'],
    'compact.error.unavailable',
    'the client-static "command unavailable" message must map to compact.error.unavailable',
  );
});
