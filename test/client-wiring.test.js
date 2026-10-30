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
    if (spec === '@local/dsh-great-plan/client.settings.js') return modules['client.settings.js'];
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
await import('../client.settings.js');
await import('../client.model.js');
await import('../client.preset.js');
await import('../client.actions.js');
await import('../client.panel.js');
await import('../client.js');

materialize('client.ui.js');
materialize('client.settings.js');
materialize('client.model.js');
materialize('client.preset.js');
materialize('client.actions.js');
materialize('client.panel.js');

const ASYNC_MODULES = {
  './client.ui.js': 'client.ui.js',
  './client.settings.js': 'client.settings.js',
  './client.model.js': 'client.model.js',
  './client.preset.js': 'client.preset.js',
  './client.actions.js': 'client.actions.js',
  './client.panel.js': 'client.panel.js',
};

/**
 * Records the `require.async` calls so the tests can verify the wave grouping:
 * every wave starts its loads synchronously (max in-flight = the largest wave)
 * and a later wave cannot start before the previous one resolved.
 */
function createLoadTracker() {
  const started = [];
  let inflight = 0;
  let maxInflight = 0;
  let finished = 0;
  return {
    started,
    get maxInflight() {
      return maxInflight;
    },
    get finished() {
      return finished;
    },
    start(spec) {
      started.push(spec);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
    },
    end() {
      inflight -= 1;
      finished += 1;
    },
  };
}

function createPlugin(options = {}) {
  const entry = registry.get('entry');
  assert.equal(entry.id, '@local/dsh-great-plan');
  const tracker = options.tracker;
  const require = () => {
    throw new Error('the entry must use require.async for package chunks');
  };
  require.async = async (spec) => {
    const fileName = ASYNC_MODULES[spec];
    if (fileName === undefined) throw new Error(`unexpected async require: ${spec}`);
    if (tracker !== undefined) tracker.start(spec);
    try {
      // One microtask holds the call open, so sibling calls of the same wave
      // overlap and calls of later waves cannot (loadChunks awaits each wave).
      await Promise.resolve();
      return modules[fileName];
    } finally {
      if (tracker !== undefined) tracker.end(spec);
    }
  };
  return entry.factory(require);
}

function createConfigForm(snapshot) {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
  };
}

const READY_SNAPSHOT = {
  status: 'ready',
  value: {
    injectBrainstormingPrompt: true,
    injectUnlimitedBudgetPrompt: true,
    includeOriginalUserInstructions: true,
    includeMinimalRuntimeContext: true,
  },
  writable: true,
};

function createCtx({ configForms, registrations, deliverImmediately = true }) {
  const directory = {
    store: {
      subscribe: () => () => {},
      getSnapshot: () => ({ current: null, groups: [], status: 'idle', pending: null, error: null, routable: null }),
    },
    load: async () => undefined,
    select: async () => ({ ok: true, value: undefined }),
  };
  const injectCalls = [];
  return {
    get() {
      // The entry must never read `configForms` eagerly: it is injected.
      return undefined;
    },
    inject(deps, callback) {
      injectCalls.push({ deps: [...deps], callback });
      if (deliverImmediately && configForms !== undefined) {
        callback({ get: (name) => (name === 'configForms' ? configForms : undefined) });
      }
      return () => {};
    },
    /** Simulate the optional service arriving after `apply` returned. */
    deliverConfigForms(service) {
      for (const call of injectCalls) {
        call.callback({ get: (name) => (name === 'configForms' ? service : undefined) });
      }
    },
    injectCalls,
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    effect: (run) => {
      const cleanup = run();
      return typeof cleanup === 'function' ? cleanup : () => {};
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component });
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
}

function readConfigFormsService(form) {
  return { get: (id) => (id === 'great-plan' ? form : undefined) };
}

test('the client entry loads its chunks in three waves and registers both surfaces', async () => {
  const tracker = createLoadTracker();
  const plugin = createPlugin({ tracker });
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.inject.includes('modelDirectories'));
  assert.ok(plugin.inject.includes('uiWorkspace'));
  assert.equal(plugin.inject.includes('configForms'), false, 'configForms must stay optional');
  assert.equal(typeof plugin.testSurface.loadChunks, 'function');
  assert.deepEqual(plugin.testSurface.loadChunks(), [
    ['./client.ui.js', './client.actions.js'],
    ['./client.settings.js', './client.model.js', './client.preset.js'],
    ['./client.panel.js'],
  ]);
  assert.equal(typeof plugin.testSurface.dictionaries.zh['panel.revise'], 'string');
  assert.equal(typeof plugin.testSurface.dictionaries.en['panel.revise'], 'string');

  const registrations = [];
  const form = createConfigForm(READY_SNAPSHOT);
  const ctx = createCtx({ configForms: readConfigFormsService(form), registrations });
  await plugin.apply(ctx);

  assert.deepEqual(tracker.started, [
    './client.ui.js',
    './client.actions.js',
    './client.settings.js',
    './client.model.js',
    './client.preset.js',
    './client.panel.js',
  ]);
  assert.equal(tracker.maxInflight, 3, 'waves are sequential and parallel only inside a wave');
  assert.equal(tracker.finished, 6);
  assert.equal(ctx.injectCalls.length, 1);
  assert.deepEqual(ctx.injectCalls[0].deps, ['configForms']);

  assert.equal(registrations.length, 2);
  const action = registrations[0];
  assert.equal(action.options.name, 'conversation.plan-review.actions');
  assert.equal(action.options.id, 'great-plan-execute-options');
  assert.equal(action.options.order, -2);
  assert.equal(action.options.locale, 'great-plan');
  assert.equal(typeof action.component, 'function');

  const face = action.options.inject('session-1');
  assert.equal(face.modelAvailable, true);
  assert.equal(typeof face.actions.approveReview, 'function');
  assert.equal(typeof face.actions.composeFreshTitle, 'function');
  assert.equal(typeof face.actions.runCompactCommand, 'function');
  assert.equal(typeof face.actions.createFreshExecution, 'function');
  assert.equal(typeof face.presetStore.load, 'function');
  assert.equal(typeof face.readPromptSwitches, 'function');
  assert.deepEqual(face.readPromptSwitches(), {
    unlimitedBudget: true,
    includeOriginalInstructions: true,
    includeMinimalContext: true,
  });

  const section = registrations[1];
  assert.equal(section.options.name, 'settings.section');
  assert.equal(section.options.id, 'great-plan');
  assert.equal(section.options.order, 25);
  assert.equal(section.options.locale, 'great-plan');
  assert.equal(section.options.label(), 'settings.nav');
  assert.equal(section.options.inject().form, form);
  assert.equal(section.component, modules['client.settings.js'].GreatPlanSection);

  assert.equal(typeof modules['client.panel.js'].ExecutionTrigger, 'function');
  assert.equal(typeof modules['client.model.js'].ModelListView, 'function');
  assert.equal(typeof modules['client.preset.js'].PresetOptions, 'function');
});

test('the plan-review action still registers without the settings capability', async () => {
  const plugin = createPlugin();
  const registrations = [];
  const ctx = createCtx({ configForms: undefined, registrations });

  await plugin.apply(ctx);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, 'conversation.plan-review.actions');
  assert.equal(ctx.injectCalls.length, 1, 'the optional capability is still requested through inject');
  assert.deepEqual(ctx.injectCalls[0].deps, ['configForms']);

  const face = registrations[0].options.inject('session-1');
  assert.deepEqual(face.readPromptSwitches(), {
    unlimitedBudget: true,
    includeOriginalInstructions: true,
    includeMinimalContext: true,
  });
});

test('the settings surface registers when configForms arrives after apply (late injection)', async () => {
  const plugin = createPlugin();
  const registrations = [];
  const ctx = createCtx({ configForms: undefined, registrations });

  await plugin.apply(ctx);
  assert.equal(registrations.length, 1);
  assert.equal(registrations.filter((entry) => entry.options.name === 'settings.section').length, 0);

  const face = registrations[0].options.inject('session-1');
  assert.deepEqual(face.readPromptSwitches(), {
    unlimitedBudget: true,
    includeOriginalInstructions: true,
    includeMinimalContext: true,
  });

  const form = createConfigForm({
    status: 'ready',
    value: {
      injectBrainstormingPrompt: true,
      injectUnlimitedBudgetPrompt: false,
      includeOriginalUserInstructions: false,
      includeMinimalRuntimeContext: true,
    },
    writable: true,
  });
  ctx.deliverConfigForms(readConfigFormsService(form));

  assert.equal(registrations.length, 2);
  const section = registrations[1];
  assert.equal(section.options.name, 'settings.section');
  assert.equal(section.options.id, 'great-plan');
  assert.equal(section.options.inject().form, form);
  assert.equal(section.component, modules['client.settings.js'].GreatPlanSection);

  // The already-built inject face reads the latest injected binding.
  assert.deepEqual(face.readPromptSwitches(), {
    unlimitedBudget: false,
    includeOriginalInstructions: false,
    includeMinimalContext: true,
  });
});

test('the settings surface is not registered when configForms never arrives', async () => {
  const plugin = createPlugin();
  const registrations = [];
  const ctx = createCtx({ configForms: undefined, registrations, deliverImmediately: false });

  await plugin.apply(ctx);
  await Promise.resolve();
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, 'conversation.plan-review.actions');
  assert.equal(ctx.injectCalls.length, 1);
  assert.equal(ctx.injectCalls[0].callback.length, 1, 'the inject callback takes the scope');
});
