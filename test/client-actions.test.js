import assert from 'node:assert/strict';
import test from 'node:test';

let registration;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value;
    },
  },
};

await import('../client.actions.js');

const actions = registration.factory(() => {
  throw new Error('client.actions.js must not require a module');
});

test('client actions chunk registers under the package id', () => {
  assert.equal(registration.id, '@local/dsh-great-plan');
  assert.equal(registration.chunk, 'client.actions.js');
});

test('composeFreshTitle appends the localized suffix', () => {
  assert.equal(actions.composeFreshTitle('Old title', ' · Execute plan'), 'Old title · Execute plan');
});

test('composeFreshTitle does not duplicate an existing suffix', () => {
  assert.equal(actions.composeFreshTitle('Old title · Execute plan', ' · Execute plan'), 'Old title · Execute plan');
});

test('composeFreshTitle ignores an absent or blank title', () => {
  assert.equal(actions.composeFreshTitle(undefined, ' · Execute plan'), undefined);
  assert.equal(actions.composeFreshTitle('   ', ' · Execute plan'), undefined);
});

test('composeFreshTitle stays within the title budget', () => {
  const title = actions.composeFreshTitle('x'.repeat(120), ' · Execute plan');
  assert.ok(title.length <= 80);
  assert.ok(title.endsWith('…'));
});

test('buildPlanExecutionPrompt includes the complete plan and localized intro', () => {
  const prompt = actions.buildPlanExecutionPrompt('# Plan\n\nDo the work.', (key) => (
    key === 'clear.promptIntro' ? 'INTRO' : key
  ));
  assert.match(prompt, /^INTRO/);
  assert.match(prompt, /<approved-plan>\n# Plan\n\nDo the work\.\n<\/approved-plan>$/);
});

test('buildPlanExecutionPrompt rejects an empty plan', () => {
  assert.throws(() => actions.buildPlanExecutionPrompt('   ', (key) => key), /empty/);
});
