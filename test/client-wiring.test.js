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

const modules = {};

function materialize(fileName) {
  const registration = registry.get(fileName);
  const require = (spec) => {
    if (spec === 'react') return fakeReact;
    if (spec === 'react-dom') return fakeReactDom;
    if (spec === '@local/dsh-great-plan/client.ui.js') return modules['client.ui.js'];
    if (spec === '@local/dsh-great-plan/client.model.js') return modules['client.model.js'];
    if (spec === '@local/dsh-great-plan/client.preset.js') return modules['client.preset.js'];
    if (spec === '@local/dsh-great-plan/client.actions.js') return modules['client.actions.js'];
    if (spec === '@local/dsh-great-plan/client.panel.js') return modules['client.panel.js'];
    throw new Error(`unexpected require: ${spec}`);
  };
  modules[fileName] = registration.factory(require);
  return modules[fileName];
}

await import('../client.ui.js');
await import('../client.model.js');
await import('../client.preset.js');
await import('../client.actions.js');
await import('../client.panel.js');
await import('../client.js');

materialize('client.ui.js');
materialize('client.model.js');
materialize('client.preset.js');
materialize('client.actions.js');
materialize('client.panel.js');

test('client entry loads every chunk and registers the plan-review action', async () => {
  const entry = registry.get('entry');
  assert.equal(entry.id, '@local/dsh-great-plan');
  const require = () => {
    throw new Error('the entry must use require.async for package chunks');
  };
  require.async = async (spec) => {
    if (spec === './client.ui.js') return modules['client.ui.js'];
    if (spec === './client.model.js') return modules['client.model.js'];
    if (spec === './client.preset.js') return modules['client.preset.js'];
    if (spec === './client.actions.js') return modules['client.actions.js'];
    if (spec === './client.panel.js') return modules['client.panel.js'];
    throw new Error(`unexpected async require: ${spec}`);
  };
  const plugin = entry.factory(require);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.inject.includes('modelDirectories'));
  assert.ok(plugin.inject.includes('uiWorkspace'));

  let registered;
  const directory = {
    store: {
      subscribe: () => () => {},
      getSnapshot: () => ({ current: null, groups: [], status: 'idle', pending: null, error: null, routable: null }),
    },
    load: async () => undefined,
    select: async () => ({ ok: true, value: undefined }),
  };
  const ctx = {
    locale: { register: () => () => {} },
    effect: (run) => {
      const cleanup = run();
      return typeof cleanup === 'function' ? cleanup : () => {};
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        registered = { options, component };
        return () => {};
      },
    },
    modelDirectories: { directoryFor: () => directory },
    sessions: { subagentAddress: () => undefined },
    remote: {
      agentPresets: { list: async () => ({ ok: true, value: { presets: [] } }) },
      session: {},
      commands: {},
    },
    uiWorkspace: {},
  };

  await plugin.apply(ctx);
  assert.ok(registered, 'the action registration did not run');
  assert.equal(registered.options.name, 'conversation.plan-review.actions');
  assert.equal(registered.options.id, 'great-plan-execute-options');
  assert.equal(registered.options.order, -2);
  assert.equal(registered.options.locale, 'great-plan');
  assert.equal(typeof registered.component, 'function');

  const face = registered.options.inject('session-1');
  assert.equal(face.modelAvailable, true);
  assert.equal(typeof face.actions.approveReview, 'function');
  assert.equal(typeof face.actions.composeFreshTitle, 'function');
  assert.equal(typeof face.actions.runCompactCommand, 'function');
  assert.equal(typeof face.actions.createFreshExecution, 'function');
  assert.equal(typeof face.presetStore.load, 'function');
  assert.equal(typeof modules['client.panel.js'].ExecutionTrigger, 'function');
  assert.equal(typeof modules['client.model.js'].ModelListView, 'function');
  assert.equal(typeof modules['client.preset.js'].PresetOptions, 'function');
});
