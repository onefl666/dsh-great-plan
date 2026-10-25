import assert from 'node:assert/strict';
import test from 'node:test';

const registry = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registry.set(registration.chunk ?? 'entry', registration);
    },
  },
};
globalThis.document = { body: {} };

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

const fakeReact = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (compute) => compute(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

const fakeReactDom = { createPortal: (node) => node };

function materialize(fileName) {
  const registration = registry.get(fileName);
  const require = (spec) => {
    if (spec === 'react') return fakeReact;
    if (spec === 'react-dom') return fakeReactDom;
    if (spec === '@local/dsh-great-plan/client.ui.js') return modules['client.ui.js'];
    if (spec === '@local/dsh-great-plan/client.settings.js') return modules['client.settings.js'];
    if (spec === '@local/dsh-great-plan/client.model.js') return modules['client.model.js'];
    if (spec === '@local/dsh-great-plan/client.preset.js') return modules['client.preset.js'];
    throw new Error(`unexpected require: ${spec}`);
  };
  modules[fileName] = registration.factory(require);
}

const modules = {};
await import('../client.ui.js');
await import('../client.settings.js');
await import('../client.model.js');
await import('../client.preset.js');
await import('../client.actions.js');
await import('../client.panel.js');
materialize('client.ui.js');
materialize('client.settings.js');
materialize('client.model.js');
materialize('client.preset.js');
materialize('client.actions.js');
materialize('client.panel.js');

test('ExecutionTrigger renders its closed trigger for a plan review', () => {
  const pending = { kind: 'plan-review' };
  const row = {
    cwd: '/tmp',
    title: 'Old plan',
    projectionValues: { agentPreset: 'standard' },
  };
  const props = {
    review: { id: 'plan-review', approve: { label: 'Approve' }, plan: '# Plan\nDo it' },
    requestKey: 'request-1',
    directory: {},
    actions: { composeFreshTitle: () => 'Old plan · Execute plan' },
    presetStore: { store: {} },
    sessionId: 'session-1',
    modelAvailable: true,
    useSessionStatus: (select) => select(new Map([['session-1', { pendingInteraction: pending }]])),
    useSessions: (select) => select({ byId: { 'session-1': row } }),
    useWorkspaces: (select) => select({ items: [{ workspaceId: 'workspace-1', sessionIds: ['session-1'] }] }),
    t: (key) => key,
  };
  const node = modules['client.panel.js'].ExecutionTrigger(props);
  assert.ok(node);
  assert.equal(node.type, fakeReact.Fragment);
  assert.equal(node.children[0].type, 'button');
});

test('ExecutionDialog renders the root options without throwing', () => {
  const directory = {
    store: {
      getSnapshot: () => ({
        current: {
          provider: 'deepseek-account',
          model: 'deepseek-flash',
          reasoningEffort: 'max',
        },
        groups: [{
          id: 'deepseek-account',
          name: 'DeepSeek Account',
          models: [{
            id: 'deepseek-flash',
            name: 'DeepSeek Flash',
            reasoning: { defaultEffort: 'max', efforts: [{ id: 'max', name: 'Max' }] },
          }],
        }],
        status: 'ready',
        pending: null,
        error: null,
        routable: true,
      }),
      subscribe: () => () => {},
    },
    load: async () => undefined,
    select: async () => ({ ok: true }),
  };
  const presetStore = {
    store: {
      getSnapshot: () => ({
        status: 'ready',
        options: [{ id: 'standard', name: 'Standard', isDefault: true }],
        error: null,
      }),
      subscribe: () => () => {},
    },
    load: async () => undefined,
  };
  const pending = {
    kind: 'plan-review',
    snapshot: () => ({ channel: 'waterfall' }),
    answer: async () => undefined,
    dismiss: async () => undefined,
  };
  const node = modules['client.panel.js'].ExecutionDialog({
    open: true,
    onClose: () => {},
    triggerRef: { current: null },
    pending,
    review: { id: 'plan-review', approve: { label: 'Approve' }, plan: '# Plan\nDo it' },
    directory,
    actions: {
      composeFreshTitle: () => 'Old plan · Execute plan',
      approveReview: async () => undefined,
      runCompactCommand: async () => ({ ok: true }),
      createFreshExecution: async () => ({ sessionId: 'new-session' }),
    },
    presetStore,
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    cwd: '/tmp',
    title: 'Old plan',
    currentPreset: 'standard',
    modelAvailable: true,
    t: (key) => key,
  });
  assert.ok(node);
  assert.equal(typeof node.type, 'function');
  const rendered = node.type(node.props);
  assert.ok(rendered);
  assert.equal(rendered.type, fakeReact.Fragment);
  assert.equal(rendered.children.length, 2);
  assert.equal(rendered.children[1].props.role, 'dialog');
});

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

test('GreatPlanSection renders both accessible switches and reflects the config', () => {
  const snapshot = {
    status: 'ready',
    value: { injectBrainstormingPrompt: true, injectUnlimitedBudgetPrompt: true },
    writable: true,
  };
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
  };
  const node = modules['client.settings.js'].GreatPlanSection({ form, t: (key) => key });
  const toggles = findElements(node, (child) => child.props?.role === 'switch');
  assert.equal(toggles.length, 2, 'both switches must render');
  for (const toggle of toggles) {
    assert.equal(toggle.type, 'button');
    assert.equal(toggle.props['aria-checked'], true);
    assert.equal(toggle.props.disabled, false);
  }
  assert.deepEqual(toggles.map((toggle) => toggle.props['aria-label']), [
    'settings.brainstorm.title',
    'settings.budget.title',
  ]);

  const readers = modules['client.settings.js'];
  assert.equal(readers.readBrainstormingValue({ status: 'ready', value: { injectBrainstormingPrompt: false } }), false);
  assert.equal(readers.readBrainstormingValue({ status: 'ready', value: {} }), true);
  assert.equal(readers.readBudgetValue({ status: 'ready', value: { injectUnlimitedBudgetPrompt: false } }), false);
  assert.equal(readers.readBudgetValue({ status: 'ready', value: {} }), true);
});

test('readBudgetSwitch reads the shared configuration mirror with a safe default', () => {
  const readBudgetSwitch = modules['client.settings.js'].readBudgetSwitch;
  const formOf = (snapshot) => ({ get: () => ({ getSnapshot: () => snapshot }) });

  assert.equal(readBudgetSwitch(undefined), true);
  assert.equal(readBudgetSwitch(formOf({ status: 'ready', value: { injectUnlimitedBudgetPrompt: true } })), true);
  assert.equal(readBudgetSwitch(formOf({ status: 'ready', value: { injectUnlimitedBudgetPrompt: false } })), false);
  assert.equal(readBudgetSwitch(formOf({ status: 'ready', value: {} })), true);
  assert.equal(readBudgetSwitch(formOf({ status: 'loading', value: undefined })), true);
  assert.equal(readBudgetSwitch({ get: () => { throw new Error('no form'); } }), true);
  assert.equal(readBudgetSwitch({ get: () => ({ getSnapshot: () => { throw new Error('no snapshot'); } }) }), true);
});

test('GreatPlanSection hides the switches while the form is loading', () => {
  const form = {
    getSnapshot: () => ({ status: 'loading', value: undefined, writable: false }),
    subscribe: () => () => {},
    set: async () => true,
  };
  const node = modules['client.settings.js'].GreatPlanSection({ form, t: (key) => key });
  assert.equal(findElements(node, (child) => child.props?.role === 'switch').length, 0);
});
