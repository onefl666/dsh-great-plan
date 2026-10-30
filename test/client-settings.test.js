import assert from 'node:assert/strict';
import test from 'node:test';

/*
 * Structures-only tests for the settings page chunk.
 *
 * `GreatPlanSection` must stay hook-free (the slot may render it without a
 * settings capability), so the fake React throws on any hook when the flag is
 * off; `GreatPlanForm` owns the store subscription and the busy/failure state.
 * A recording fake `ui` exposes the props the chunk passes to host primitives.
 */

const registry = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registry.set(registration.chunk ?? 'entry', registration);
    },
  },
};

function createElement(type, props, ...children) {
  const normalized = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  return {
    type,
    props: {
      ...(props === null || props === undefined ? {} : props),
      ...normalized === undefined ? {} : { children: normalized },
    },
    children: normalized,
  };
}

let hooksEnabled = true;
let hookIndex = 0;
let hookState = {};

function resetHooks(preserveState = false) {
  hookIndex = 0;
  if (preserveState === false) hookState = {};
}

function hookGuard() {
  if (!hooksEnabled) throw new Error('GreatPlanSection must not call hooks');
}

const fakeReact = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState: (initial) => {
    hookGuard();
    const index = hookIndex;
    hookIndex += 1;
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
    return [hookState[index], (next) => {
      hookState[index] = typeof next === 'function' ? next(hookState[index]) : next;
    }];
  },
  useEffect: () => hookGuard(),
  useLayoutEffect: () => hookGuard(),
  useMemo: (compute) => {
    hookGuard();
    return compute();
  },
  useRef: (value) => {
    hookGuard();
    return { current: value };
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => {
    hookGuard();
    return getSnapshot();
  },
};

/*
 * Recording host primitives: they are intrinsic tags in the fake element tree,
 * so the assertions inspect the exact props the chunk passes without depending
 * on client.ui.js.
 */
const fakeUi = {
  cx: (...parts) => parts.filter(Boolean).join(' '),
  messageOf: (error) => (error instanceof Error ? error.message : String(error)),
  useStore: (store) => {
    hookGuard();
    return store.getSnapshot();
  },
  Note: 'mock-note',
  Loading: 'mock-loading',
  ErrorText: 'mock-error',
  Button: 'mock-button',
};

await import('../client.settings.js');
const registration = registry.get('client.settings.js');
assert.equal(registration.id, '@local/dsh-great-plan');

const settings = registration.factory((spec) => {
  if (spec === 'react') return fakeReact;
  if (spec === '@local/dsh-great-plan/client.ui.js') return fakeUi;
  throw new Error(`unexpected require: ${spec}`);
});

/** Key echo that keeps placeholder parameters visible in assertions. */
const t = (key, params) => {
  if (params === undefined) return key;
  const entries = Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',');
  return `${key}(${entries})`;
};

function findElements(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, found);
    return found;
  }
  if (predicate(node)) found.push(node);
  const children = node.children === undefined ? [] : Array.isArray(node.children) ? node.children : [node.children];
  for (const child of children) findElements(child, predicate, found);
  return found;
}

function textContent(node) {
  if (typeof node === 'string') return node;
  if (node === null || node === undefined || typeof node !== 'object') return '';
  const children = node.children === undefined ? [] : Array.isArray(node.children) ? node.children : [node.children];
  return children.map(textContent).join('');
}

function switchesOf(node) {
  return findElements(node, (child) => child.type === 'button' && child.props?.role === 'switch');
}

function resetsOf(node) {
  return findElements(node, (child) => (
    child.type === 'mock-button'
    && typeof child.props?.['aria-label'] === 'string'
    && child.props['aria-label'].startsWith('settings.resetAria')
  ));
}

function headingOf(node) {
  return findElements(node, (child) => child.type === 'h2');
}

const READY_VALUE = {
  injectBrainstormingPrompt: true,
  injectUnlimitedBudgetPrompt: true,
  includeOriginalUserInstructions: true,
  includeMinimalRuntimeContext: true,
};

function readySnapshot(overrides = {}) {
  return {
    status: 'ready',
    value: { ...READY_VALUE, ...overrides.value },
    writable: overrides.writable ?? true,
  };
}

function createForm(snapshot, setImpl) {
  const calls = [];
  return {
    calls,
    form: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      set: async (field, next) => {
        calls.push([field, next]);
        if (typeof setImpl === 'function') return setImpl(field, next);
        return true;
      },
    },
  };
}

function renderForm(form) {
  resetHooks();
  return settings.GreatPlanForm({ form, t });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('the settings chunk registers and keeps every read helper export', () => {
  assert.equal(registration.chunk, 'client.settings.js');
  assert.deepEqual(settings.FIELDS, {
    brainstorming: 'injectBrainstormingPrompt',
    budget: 'injectUnlimitedBudgetPrompt',
    originalInstructions: 'includeOriginalUserInstructions',
    minimalContext: 'includeMinimalRuntimeContext',
  });
  assert.deepEqual(settings.ROWS.map((row) => row.field), [
    'injectBrainstormingPrompt',
    'injectUnlimitedBudgetPrompt',
    'includeOriginalUserInstructions',
    'includeMinimalRuntimeContext',
  ]);
  for (const name of [
    'readSwitchValue',
    'readBrainstormingValue',
    'readBudgetValue',
    'readOriginalInstructionsValue',
    'readMinimalContextValue',
    'readBudgetSwitch',
    'readOriginalInstructionsSwitch',
    'readMinimalContextSwitch',
    'readFreshPromptSwitches',
    'GreatPlanSection',
    'GreatPlanForm',
  ]) {
    assert.equal(typeof settings[name], 'function', `${name} must stay exported`);
  }
  assert.notEqual(settings.GreatPlanSection, settings.GreatPlanForm);
});

test('GreatPlanSection renders only the heading and the unavailable note without a usable form', () => {
  hooksEnabled = false;
  try {
    for (const form of [undefined, null, {}, { getSnapshot: 'nope' }, 42]) {
      const node = settings.GreatPlanSection({ form, t });
      assert.equal(node.type, 'div');
      assert.equal(headingOf(node).length, 1);
      assert.equal(textContent(headingOf(node)[0]), 'settings.heading');
      assert.deepEqual(findElements(node, (child) => child.type === 'mock-note').map(textContent), ['settings.unavailable']);
      assert.equal(switchesOf(node).length, 0);
      assert.equal(resetsOf(node).length, 0);
      assert.equal(findElements(node, (child) => child.type === 'mock-loading').length, 0);
      assert.equal(findElements(node, (child) => child.type === 'mock-error').length, 0);
    }
  } finally {
    hooksEnabled = true;
  }
});

test('GreatPlanSection stays hook-free even with a readable form and delegates to GreatPlanForm', () => {
  const { form } = createForm(readySnapshot());
  hooksEnabled = false;
  let node;
  try {
    node = settings.GreatPlanSection({ form, t });
  } finally {
    hooksEnabled = true;
  }
  assert.equal(node.type, settings.GreatPlanForm);
  assert.equal(node.props.form, form);
  assert.equal(node.props.t, t);

  hooksEnabled = true;
  const rendered = node.type(node.props);
  assert.equal(switchesOf(rendered).length, 4);
});

test('GreatPlanForm renders the heading and four described switches for a ready form', () => {
  const { form } = createForm(readySnapshot());
  const node = renderForm(form);

  assert.equal(headingOf(node).length, 1);
  assert.equal(headingOf(node)[0].type, 'h2');
  assert.equal(textContent(headingOf(node)[0]), 'settings.heading');

  const switches = switchesOf(node);
  assert.equal(switches.length, 4);
  assert.deepEqual(switches.map((toggle) => toggle.props['aria-label']), [
    'settings.brainstorm.title',
    'settings.budget.title',
    'settings.originalInstructions.title',
    'settings.minimalContext.title',
  ]);
  assert.deepEqual(switches.map((toggle) => toggle.props['aria-checked']), [true, true, true, true]);
  assert.deepEqual(switches.map((toggle) => toggle.props.disabled), [false, false, false, false]);
  assert.deepEqual(resetsOf(node), [], 'no reset buttons while every switch is on');

  const described = findElements(node, (child) => (
    child.type === 'div' && typeof child.props?.id === 'string' && child.props.id.startsWith('gp-setting-desc-')
  ));
  assert.equal(described.length, 4);
  assert.equal(new Set(described.map((element) => element.props.id)).size, 4);
  assert.deepEqual(described.map(textContent), [
    'settings.brainstorm.description',
    'settings.budget.description',
    'settings.originalInstructions.description',
    'settings.minimalContext.description',
  ]);
  assert.deepEqual(
    switches.map((toggle) => toggle.props['aria-describedby']),
    described.map((element) => element.props.id),
  );
});

test('GreatPlanForm reflects disabled switches and offers a reset button only for those rows', () => {
  const { form, calls } = createForm(readySnapshot({
    value: {
      injectBrainstormingPrompt: true,
      injectUnlimitedBudgetPrompt: false,
      includeOriginalUserInstructions: true,
      includeMinimalRuntimeContext: false,
    },
  }));
  const node = renderForm(form);
  const switches = switchesOf(node);
  assert.deepEqual(switches.map((toggle) => toggle.props['aria-checked']), [true, false, true, false]);

  const resets = resetsOf(node);
  assert.equal(resets.length, 2);
  assert.deepEqual(resets.map(textContent), ['settings.reset', 'settings.reset']);
  assert.deepEqual(resets.map((button) => button.props['aria-label']), [
    'settings.resetAria(title=settings.budget.title)',
    'settings.resetAria(title=settings.minimalContext.title)',
  ]);
  for (const button of resets) assert.equal(button.props.disabled, false);

  return (async () => {
    resets[0].props.onClick();
    await flush();
    assert.deepEqual(calls, [['injectUnlimitedBudgetPrompt', true]]);
  })();
});

test('GreatPlanForm writes the toggled value through form.set', async () => {
  const { form, calls } = createForm(readySnapshot());
  const node = renderForm(form);
  switchesOf(node)[0].props.onClick();
  await flush();
  assert.deepEqual(calls, [['injectBrainstormingPrompt', false]]);
});

test('GreatPlanForm keeps the save-failure copy when a write is refused or throws', async () => {
  const refused = createForm(readySnapshot(), () => false);
  let node = renderForm(refused.form);
  switchesOf(node)[0].props.onClick();
  await flush();

  // Re-render from the hook state: failed is set and the switches are enabled again.
  resetHooks(true);
  node = settings.GreatPlanForm({ form: refused.form, t });
  assert.deepEqual(findElements(node, (child) => child.type === 'mock-error').map(textContent), ['settings.saveFailed']);
  assert.deepEqual(switchesOf(node).map((toggle) => toggle.props.disabled), [false, false, false, false]);

  const throws = createForm(readySnapshot(), () => {
    throw new Error('refused');
  });
  resetHooks();
  node = settings.GreatPlanForm({ form: throws.form, t });
  switchesOf(node)[1].props.onClick();
  await flush();
  resetHooks(true);
  node = settings.GreatPlanForm({ form: throws.form, t });
  assert.deepEqual(findElements(node, (child) => child.type === 'mock-error').map(textContent), ['settings.saveFailed']);
});

test('GreatPlanForm disables the controls while a write is in flight and re-enables after it settles', async () => {
  let resolveSet;
  const { form } = createForm(readySnapshot({ value: { injectUnlimitedBudgetPrompt: false } }), () => (
    new Promise((resolve) => {
      resolveSet = resolve;
    })
  ));
  let node = renderForm(form);
  assert.equal(resetsOf(node).length, 1);

  switchesOf(node)[0].props.onClick();
  resetHooks(true);
  node = settings.GreatPlanForm({ form, t });
  assert.deepEqual(switchesOf(node).map((toggle) => toggle.props.disabled), [true, true, true, true]);
  assert.deepEqual(resetsOf(node).map((button) => button.props.disabled), [true]);

  resolveSet(true);
  await flush();
  resetHooks(true);
  node = settings.GreatPlanForm({ form, t });
  assert.deepEqual(switchesOf(node).map((toggle) => toggle.props.disabled), [false, false, false, false]);
});

test('GreatPlanForm keeps the loading, idle, unavailable, and unknown statuses', () => {
  const loading = renderForm(createForm({ status: 'loading', value: undefined, writable: false }).form);
  assert.equal(switchesOf(loading).length, 0);
  assert.deepEqual(findElements(loading, (child) => child.type === 'mock-loading').map(textContent), ['settings.loading']);

  resetHooks();
  const idle = settings.GreatPlanForm({ form: createForm({ status: 'idle', value: undefined }).form, t });
  assert.equal(switchesOf(idle).length, 0);
  assert.deepEqual(findElements(idle, (child) => child.type === 'mock-loading').map(textContent), ['settings.loading']);

  resetHooks();
  const unavailable = settings.GreatPlanForm({ form: createForm({ status: 'unavailable', value: undefined }).form, t });
  assert.equal(switchesOf(unavailable).length, 0);
  assert.deepEqual(findElements(unavailable, (child) => child.type === 'mock-note').map(textContent), ['settings.unavailable']);

  for (const status of ['error', 'something-new']) {
    resetHooks();
    const unknown = settings.GreatPlanForm({ form: createForm({ status, value: undefined }).form, t });
    assert.equal(switchesOf(unknown).length, 0, `${status} must not render switches`);
    assert.deepEqual(
      findElements(unknown, (child) => child.type === 'mock-note').map(textContent),
      ['settings.unavailable'],
      `${status} must fall back to the unavailable copy`,
    );
    assert.equal(findElements(unknown, (child) => child.type === 'mock-error').length, 0);
  }
});

test('GreatPlanForm shows the read-only note and disables every control when unwritable', () => {
  const node = renderForm(createForm(readySnapshot({ value: { injectBudget: false }, writable: false })).form);
  assert.deepEqual(findElements(node, (child) => child.type === 'mock-note').map(textContent), ['settings.readOnly']);
  assert.deepEqual(switchesOf(node).map((toggle) => toggle.props.disabled), [true, true, true, true]);
  assert.deepEqual(resetsOf(node), []);

  const off = renderForm(createForm(readySnapshot({
    value: { injectUnlimitedBudgetPrompt: false },
    writable: false,
  })).form);
  assert.deepEqual(findElements(off, (child) => child.type === 'mock-note').map(textContent), ['settings.readOnly']);
  assert.deepEqual(resetsOf(off).map((button) => button.props.disabled), [true]);
});

test('the switch-state readers keep the defaults-on fallbacks', () => {
  const { readSwitchValue, readBudgetSwitch, readOriginalInstructionsSwitch, readMinimalContextSwitch, readFreshPromptSwitches } = settings;
  assert.equal(readSwitchValue({ value: { injected: false } }, 'injected'), false);
  assert.equal(readSwitchValue({ value: {} }, 'injected'), true);
  assert.equal(readSwitchValue(undefined, 'injected'), true);

  const formOf = (snapshot) => ({ get: () => ({ getSnapshot: () => snapshot }) });
  const allOn = { unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: true };
  const allOff = { unlimitedBudget: false, includeOriginalInstructions: false, includeMinimalContext: false };
  assert.deepEqual(readFreshPromptSwitches(undefined), allOn);
  assert.deepEqual(readFreshPromptSwitches(formOf({ status: 'loading', value: undefined })), allOn);
  assert.deepEqual(readFreshPromptSwitches(formOf({
    status: 'ready',
    value: {
      injectUnlimitedBudgetPrompt: false,
      includeOriginalUserInstructions: false,
      includeMinimalRuntimeContext: false,
    },
  })), allOff);
  assert.deepEqual(readFreshPromptSwitches({ get: () => { throw new Error('no form'); } }), allOn);
  assert.equal(readBudgetSwitch(undefined), true);
  assert.equal(readOriginalInstructionsSwitch(undefined), true);
  assert.equal(readMinimalContextSwitch(undefined), true);
  assert.equal(readBudgetSwitch(formOf({ status: 'ready', value: { injectUnlimitedBudgetPrompt: false } })), false);
  assert.equal(readOriginalInstructionsSwitch(formOf({ status: 'ready', value: { includeOriginalUserInstructions: false } })), false);
  assert.equal(readMinimalContextSwitch(formOf({ status: 'ready', value: { includeMinimalRuntimeContext: false } })), false);
});
