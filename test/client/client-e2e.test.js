/**
 * Cross-half Client flow tests: the REAL panel state machine over REAL action
 * operations, driven through a recording fake transport.
 *
 * The dialog and the action face are real `lib/client.panel.js` /
 * `lib/client.actions.js` code. Only the Host-facing transport
 * (`ctx.remote.*`, `ctx.sessions.*`, `ctx.uiWorkspace.*`), the pending review,
 * the model directory and the preset store are fakes. The React runtime, the
 * portal and the DOM are the same deterministic stand-ins used by
 * `client-render.test.js` (no real React render, no effects scheduling, no
 * DOM events), extended with a manual effect runner so mount/timeout behavior
 * of the dialog itself can be exercised.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FAILURES as HOST_FAILURES } from '../../lib/host/plan-compaction.js';

// ---------------------------------------------------------------- scaffold ----

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

const hookFrames = [];

function currentFrame() {
  return hookFrames[hookFrames.length - 1];
}

function sameDeps(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

/** Run pending effects in render order, honoring dependency arrays. */
function runEffects(frame) {
  const pending = frame.pending;
  frame.pending = [];
  for (const effect of pending) {
    const previous = frame.effects[effect.index];
    const deps = effect.deps;
    const changed = previous === undefined
      || deps === undefined
      || previous.deps === undefined
      || !sameDeps(previous.deps, deps);
    if (!changed) continue;
    if (typeof previous?.cleanup === 'function') previous.cleanup();
    const cleanup = effect.fn();
    frame.effects[effect.index] = {
      deps: deps === undefined ? undefined : [...deps],
      cleanup: typeof cleanup === 'function' ? cleanup : undefined,
    };
  }
}

/**
 * Manual hook-mount harness with an effect runner.
 *
 * `render(props)` re-renders the component function and runs first/changed
 * effects afterwards; `unmount()` runs the stored cleanups in reverse order.
 * No real React commit, portal, DOM or event loop is involved.
 */
function mount(component) {
  const frame = { slots: [], index: 0, pending: [], effects: [], unmounted: false };
  const render = (props) => {
    if (frame.unmounted) throw new Error('component already unmounted');
    frame.index = 0;
    frame.pending = [];
    hookFrames.push(frame);
    let node;
    try {
      node = component(props);
    } finally {
      hookFrames.pop();
    }
    runEffects(frame);
    return node;
  };
  const unmount = () => {
    if (frame.unmounted) return;
    frame.unmounted = true;
    for (let index = frame.effects.length - 1; index >= 0; index -= 1) {
      const effect = frame.effects[index];
      if (effect !== undefined && typeof effect.cleanup === 'function') effect.cleanup();
    }
    frame.effects = [];
  };
  return { render, unmount, frame };
}

const fakeReact = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const frame = currentFrame();
    if (frame === undefined) return [typeof initial === 'function' ? initial() : initial, () => {}];
    const index = frame.index;
    frame.index += 1;
    if (frame.slots.length <= index) {
      frame.slots.push({ value: typeof initial === 'function' ? initial() : initial });
    }
    const slot = frame.slots[index];
    return [slot.value, (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next;
    }];
  },
  useEffect(fn, deps) {
    const frame = currentFrame();
    if (frame === undefined) return;
    const index = frame.index;
    frame.index += 1;
    frame.pending.push({ index, fn, deps: Array.isArray(deps) ? [...deps] : undefined });
  },
  useLayoutEffect: () => {},
  useMemo: (compute) => compute(),
  useRef(initial) {
    const frame = currentFrame();
    if (frame === undefined) return { current: initial };
    const index = frame.index;
    frame.index += 1;
    if (frame.slots.length <= index) frame.slots.push({ current: initial });
    return frame.slots[index];
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

const fakeReactDom = { createPortal: (node) => node };

const modules = {};

function materialize(fileName) {
  const registration = registry.get(fileName);
  assert.ok(registration, `module ${fileName} must be registered`);
  const require = (spec) => {
    if (spec === 'react') return fakeReact;
    if (spec === 'react-dom') return fakeReactDom;
    if (spec === '@onefl666/dsh-great-plan/client.ui.js') return modules['client.ui.js'];
    if (spec === '@onefl666/dsh-great-plan/client.model.js') return modules['client.model.js'];
    if (spec === '@onefl666/dsh-great-plan/client.preset.js') return modules['client.preset.js'];
    if (spec === '@onefl666/dsh-great-plan/client.actions.js') return modules['client.actions.js'];
    throw new Error(`unexpected require: ${spec}`);
  };
  modules[fileName] = registration.factory(require);
  return modules[fileName];
}

await import('../../lib/client.ui.js');
await import('../../lib/client.model.js');
await import('../../lib/client.preset.js');
await import('../../lib/client.actions.js');
await import('../../lib/client.panel.js');

materialize('client.ui.js');
materialize('client.model.js');
materialize('client.preset.js');
materialize('client.actions.js');
materialize('client.panel.js');

const ui = modules['client.ui.js'];
const model = modules['client.model.js'];
const preset = modules['client.preset.js'];
const panel = modules['client.panel.js'];
const realActions = modules['client.actions.js'];

/** Intermediate view components rendered by the dialog body; expand for inspection. */
const INSPECT_COMPONENTS = [model.ModelRows, model.ModelListView, model.EffortListView, preset.PresetOptions];

function expandComponents(node, types) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((child) => expandComponents(child, types));
  if (typeof node.type === 'function' && types.includes(node.type)) {
    return expandComponents(node.type(node.props), types);
  }
  if (node.children === undefined) return node;
  const children = Array.isArray(node.children) ? node.children : [node.children];
  const expanded = children.map((child) => expandComponents(child, types));
  return {
    ...node,
    props: { ...node.props, children: Array.isArray(node.children) ? expanded : expanded[0] },
    children: Array.isArray(node.children) ? expanded : expanded[0],
  };
}

/**
 * Expand the dialog's intermediate row/list components so their `SelectRow`,
 * `ListRow`, `Checkbox` and `Button` elements can be found and clicked. The
 * components are hook-free (or degrade to their initial hook state), so this
 * stays a pure element-tree transformation.
 */
function expandForInspection(node) {
  return expandComponents(node, INSPECT_COMPONENTS);
}

// ---------------------------------------------------------------- helpers ----

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

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node !== 'object') return '';
  return textOf(node.children);
}

function hasText(node, needle) {
  return textOf(node).includes(needle);
}

function findAll(node, type) {
  return findElements(node, (child) => child !== null && child.type === type);
}

function findByType(node, type) {
  return findAll(node, type)[0];
}

function findActionRow(node, titleKey) {
  return findElements(node, (child) => (
    child !== null && child.type === ui.ActionRow && child.props?.title === titleKey
  ))[0];
}

function findUiButton(node, textKey) {
  return findElements(node, (child) => (
    child !== null && child.type === ui.Button && textOf(child).includes(textKey)
  ))[0];
}

function findIconButton(node, labelKey) {
  return findElements(node, (child) => (
    child !== null && child.type === ui.IconButton && child.props?.label === labelKey
  ))[0];
}

function findSelectRow(node, labelKey) {
  return findElements(node, (child) => (
    child !== null && child.type === ui.SelectRow && child.props?.label === labelKey
  ))[0];
}

function findListRow(node, title) {
  return findElements(node, (child) => (
    child !== null && child.type === ui.ListRow && child.props?.title === title
  ))[0];
}

function findCheckbox(node, labelKey) {
  return findElements(node, (child) => (
    child !== null && child.type === ui.Checkbox && child.props?.label === labelKey
  ))[0];
}

function findDialogElement(node) {
  return findElements(node, (child) => child !== null && child.type === ui.Dialog)[0];
}

function findErrorTexts(node) {
  return findAll(node, ui.ErrorText);
}

/** Render the ui.Dialog element into the portal-identity tree and return the role=dialog node. */
function dialogShell(node) {
  const element = findDialogElement(node);
  assert.ok(element, 'expected a rendered ui.Dialog element');
  const rendered = element.type(element.props);
  return findElements(rendered, (child) => child !== null && child.props?.role === 'dialog')[0];
}

/** A translator that records calls and keeps parameter values inspectable. */
function createTranslator() {
  const calls = [];
  const t = (key, params) => {
    calls.push({ key, params });
    if (params === null || typeof params !== 'object') return key;
    return `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`;
  };
  return {
    t,
    calls,
    last(key) {
      for (let index = calls.length - 1; index >= 0; index -= 1) {
        if (calls[index].key === key) return calls[index];
      }
      return undefined;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask run. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------- fixtures ----

const SESSION_ID = 'old-session';
const ALL_ON = { unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: true };

const REVIEW = {
  id: 'plan-review',
  approve: { label: 'Approve' },
  question: 'Which approach should we take?',
  plan: '# Plan\n\nDo the thing.',
};

const PRESET_OPTIONS = [
  { id: 'standard', name: 'Standard', isDefault: true },
  { id: 'minimal', name: 'Minimal', isDefault: false },
];

function planModeEntry(seq = 1) {
  return { type: 'event', event: { type: 'plan/mode', seq, data: { active: true } } };
}

function userTextEntry(text, seq) {
  return {
    type: 'event',
    event: { type: 'user/message', seq, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } },
  };
}

function planWindow(texts = []) {
  return { entries: [planModeEntry(1), ...texts.map((text, index) => userTextEntry(text, index + 2))], hasMore: false };
}

function readyDirectoryState(overrides = {}) {
  return {
    current: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
    groups: [{
      id: 'deepseek-account',
      name: 'DeepSeek Account',
      models: [{
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
        reasoning: {
          defaultEffort: 'max',
          efforts: [{ id: 'max', name: 'Max' }, { id: 'high', name: 'High' }],
        },
      }],
    }],
    status: 'ready',
    pending: null,
    error: null,
    routable: true,
    ...overrides,
  };
}

function createDirectory(options = {}) {
  const state = options.state ?? readyDirectoryState();
  const directory = {
    calls: { load: 0, select: [] },
    store: {
      getSnapshot: () => state,
      subscribe: () => () => {},
    },
    async load() {
      directory.calls.load += 1;
      if (options.load !== undefined) return options.load();
      return undefined;
    },
    async select(payload) {
      directory.calls.select.push(payload);
      if (options.select !== undefined) return options.select(payload);
      return { ok: true, value: undefined };
    },
  };
  return directory;
}

function createPresetStore(options = {}) {
  const state = options.state ?? { status: 'ready', options: PRESET_OPTIONS, error: null };
  const store = {
    calls: { load: [] },
    state,
    store: {
      getSnapshot: () => state,
      subscribe: () => () => {},
    },
    async load(force = false) {
      store.calls.load.push(force);
      if (options.load !== undefined) return options.load(force);
      return undefined;
    },
  };
  return store;
}

function createPending(options = {}) {
  const pending = {
    kind: 'plan-review',
    events: [],
    answers: [],
    dismissCalls: 0,
    snapshot() {
      pending.events.push('snapshot');
      return { channel: options.channel ?? 'waterfall' };
    },
    async answer(payload) {
      pending.events.push('answer');
      pending.answers.push(payload);
      if (options.answer !== undefined) return options.answer(payload);
      return undefined;
    },
    async dismiss() {
      pending.events.push('dismiss');
      pending.dismissCalls += 1;
      if (options.dismiss !== undefined) return options.dismiss();
      return undefined;
    },
  };
  return pending;
}

function createTransport(options = {}) {
  const transport = {
    log: [],
    commands: [],
    selectModelCalls: [],
    created: [],
    usingCalls: [],
    archived: [],
    opened: [],
    prompts: [],
    renames: [],
    bindingCalls: [],
    cancelled: [],
    snapshots: { count: 0 },
    loadOlderCalls: 0,
    async execute(sessionId, name, args, signal) {
      transport.log.push('execute');
      transport.commands.push({ sessionId, name, args, signal });
      if (options.execute !== undefined) return options.execute(sessionId, name, args, signal);
      return { ok: true, value: { result: { kind: 'success', text: 'Compacted 2 history items (~120 tokens).' } } };
    },
    async create(args) {
      transport.log.push('create');
      transport.created.push(args);
      if (options.create !== undefined) return options.create(args);
      return 'new-session';
    },
    async selectModel(payload) {
      transport.log.push('selectModel');
      transport.selectModelCalls.push(payload);
      if (options.selectModel !== undefined) return options.selectModel(payload);
      return { ok: true };
    },
    async using(sessionId, usingOptions, operation) {
      transport.log.push('using');
      transport.usingCalls.push({ sessionId, options: usingOptions });
      if (options.usingGate !== undefined) await options.usingGate;
      const reference = {
        binding: {
          session: {
            async rename(title) {
              transport.log.push('rename');
              transport.renames.push(title);
              if (options.rename !== undefined) return options.rename(title);
              return undefined;
            },
            async prompt(content, mode, signal) {
              transport.log.push('prompt');
              transport.prompts.push({ content, mode, signal });
              if (options.prompt !== undefined) return options.prompt(content, mode, signal);
              return { ok: true };
            },
          },
        },
      };
      return operation(reference);
    },
    binding(sessionId) {
      transport.bindingCalls.push(sessionId);
      return {
        eventSource: {
          getSnapshot() {
            transport.snapshots.count += 1;
            if (options.getSnapshot !== undefined) return options.getSnapshot();
            return options.window ?? planWindow();
          },
        },
        session: {
          async cancel() {
            transport.log.push('cancel');
            const result = options.cancel !== undefined ? await options.cancel() : { ok: true };
            transport.cancelled.push(result);
            return result;
          },
          ...(options.loadOlder === undefined ? {} : {
            async loadOlder() {
              transport.loadOlderCalls += 1;
              transport.log.push('loadOlder');
              return options.loadOlder();
            },
          }),
        },
      };
    },
    open(sessionId) {
      transport.log.push('open');
      transport.opened.push(sessionId);
      if (options.open !== undefined) return options.open(sessionId);
      return undefined;
    },
    async archive(sessionId, archiveOptions) {
      transport.log.push('archive');
      transport.archived.push({ sessionId, options: archiveOptions });
      if (options.archive !== undefined) return options.archive(sessionId, archiveOptions);
      return undefined;
    },
  };
  return transport;
}

function createContext(transport) {
  return {
    remote: {
      commands: { execute: (...args) => transport.execute(...args) },
      session: { selectModel: (payload) => transport.selectModel(payload) },
      agentPresets: { list: async () => ({ ok: true, value: { presets: PRESET_OPTIONS } }) },
    },
    sessions: {
      create: (args) => transport.create(args),
      using: (sessionId, usingOptions, operation) => transport.using(sessionId, usingOptions, operation),
      binding: (sessionId) => transport.binding(sessionId),
      subagentAddress: () => undefined,
    },
    uiWorkspace: {
      openSession: (sessionId) => transport.open(sessionId),
      archiveSession: (sessionId, archiveOptions) => transport.archive(sessionId, archiveOptions),
    },
  };
}

/**
 * Shared cross-half pieces: the real action face bound to the fake transport,
 * the fake model directory, the fake preset store and the recording translator.
 */
function baseSetup(options = {}) {
  const translator = createTranslator();
  const transport = options.transport ?? createTransport(options.transportOptions);
  const directory = options.directory ?? createDirectory(options.directoryOptions);
  const presetStore = options.presetStore ?? createPresetStore(options.presetOptions);
  const switches = options.switches ?? ALL_ON;
  const readPromptSwitches = options.readPromptSwitches ?? (() => ({ ...switches }));
  const ctx = options.ctx ?? createContext(transport);
  const actions = options.actions ?? realActions.createActions(ctx, options.sessionId ?? SESSION_ID, readPromptSwitches);
  return { translator, t: translator.t, transport, directory, presetStore, ctx, actions, readPromptSwitches };
}

/**
 * Build one cross-half scenario: real action face over a fake transport plus
 * every prop `ExecutionDialog` needs. `render()` re-renders the mounted dialog.
 */
function scenario(options = {}) {
  const base = baseSetup(options);
  const { translator, transport, directory, presetStore, ctx, actions, readPromptSwitches } = base;
  const pending = options.settled === true
    ? undefined
    : (options.pending !== undefined ? options.pending : createPending(options.pendingOptions));
  const closed = [];
  const props = {
    open: true,
    onClose: () => closed.push('closed'),
    triggerRef: { current: null },
    pending,
    review: options.review ?? REVIEW,
    directory,
    actions,
    presetStore,
    sessionId: options.sessionId ?? SESSION_ID,
    workspaceId: options.workspaceId ?? 'workspace-1',
    workspaceDirectory: options.workspaceDirectory ?? '/tmp/work',
    cwd: options.cwd ?? '/tmp',
    title: options.title ?? 'Old plan',
    currentPreset: options.currentPreset ?? 'standard',
    modelAvailable: options.modelAvailable ?? true,
    readPromptSwitches,
    t: translator.t,
  };
  const dialog = mount(panel.ExecutionDialog);
  let node = expandForInspection(dialog.render(props));
  const render = (overrides = {}) => {
    node = expandForInspection(dialog.render({ ...props, ...overrides }));
    return node;
  };
  return {
    ...base,
    pending,
    closed,
    props,
    dialog,
    render,
    unmount: dialog.unmount,
    get node() {
      return node;
    },
  };
}

function triggerProps(state, overrides = {}) {
  const pending = Object.hasOwn(overrides, 'pending') ? overrides.pending : createPending();
  const row = overrides.row ?? {
    cwd: '/tmp/row-cwd',
    title: 'Row title',
    projectionValues: { agentPreset: 'standard' },
  };
  const workspaces = overrides.workspaces ?? {
    items: [{ workspaceId: 'ws-9', sessionIds: [SESSION_ID], path: '/tmp/ws-path' }],
  };
  return {
    review: REVIEW,
    requestKey: 'request-1',
    directory: state.directory,
    actions: state.actions,
    presetStore: state.presetStore,
    sessionId: SESSION_ID,
    modelAvailable: true,
    readPromptSwitches: state.readPromptSwitches,
    t: state.t,
    useSessionStatus: (select) => select(new Map([[SESSION_ID, { pendingInteraction: pending }]])),
    useSessions: (select) => select({ byId: { [SESSION_ID]: row } }),
    useWorkspaces: (select) => select(workspaces),
    ...overrides.props,
  };
}

// ---------------------------------------------------------------- execute ----

test('execute: waterfall approval sends the native answer payload and closes once', async () => {
  const flow = scenario();
  const row = findActionRow(flow.node, 'panel.actions.execute.title');
  assert.ok(row, 'the Execute plan row renders');
  await row.props.onClick();
  await flush();

  assert.equal(flow.pending.answers.length, 1);
  assert.deepEqual(flow.pending.answers[0], {
    answers: [{ id: REVIEW.id, selected: [REVIEW.approve.label] }],
  });
  assert.deepEqual(flow.pending.events, ['snapshot', 'answer'], 'waterfall approvals never dismiss');
  assert.equal(flow.pending.dismissCalls, 0);
  assert.equal(flow.closed.length, 1);
  assert.deepEqual(flow.transport.log, [], 'execute must not touch the transport');

  const node = flow.render();
  assert.equal(findDialogElement(node).props.busy, false, 'busy clears after the approval settles');
  assert.equal(findActionRow(node, 'panel.actions.execute.title').props.disabled, false);
});

test('execute: rpc channel dismisses the card after the answer settles', async () => {
  const flow = scenario({ pending: createPending({ channel: 'rpc' }) });
  await findActionRow(flow.node, 'panel.actions.execute.title').props.onClick();
  await flush();

  assert.deepEqual(flow.pending.events, ['snapshot', 'answer', 'dismiss']);
  assert.equal(flow.pending.dismissCalls, 1);
  assert.equal(flow.closed.length, 1);
});

test('execute: a rejected approval renders error.approveFailed, keeps the dialog open and clears busy', async () => {
  const flow = scenario({
    pending: createPending({
      answer: async () => {
        throw new Error('approve exploded');
      },
    }),
  });
  await findActionRow(flow.node, 'panel.actions.execute.title').props.onClick();
  await flush();

  const node = flow.render();
  assert.ok(hasText(node, 'error.approveFailed'), 'the approval failure is localized');
  assert.ok(hasText(node, 'approve exploded'), 'the failure message is shown');
  assert.equal(flow.closed.length, 0, 'a failed approval must not close the dialog');
  assert.equal(findDialogElement(node).props.busy, false);
  assert.equal(findActionRow(node, 'panel.actions.execute.title').props.disabled, false);
});

// ---------------------------------------------------------------- compact ----

test('compact: success forwards the command, shows compact.success while the approval is pending, then closes', async () => {
  const approveGate = deferred();
  const flow = scenario({ pending: createPending({ answer: () => approveGate.promise }) });
  const compactClick = findActionRow(flow.node, 'panel.actions.compact.title').props.onClick();
  await flush();

  assert.equal(flow.transport.commands.length, 1);
  const command = flow.transport.commands[0];
  assert.equal(command.sessionId, SESSION_ID);
  assert.equal(command.name, '/great-plan-compact');
  assert.deepEqual(command.args, []);
  assert.ok(command.signal instanceof AbortSignal, 'the abort signal is forwarded');
  assert.equal(command.signal.aborted, false);

  let node = flow.render();
  assert.ok(hasText(node, 'compact.success'), 'the transient success status is visible');
  assert.equal(findDialogElement(node).props.busy, true, 'the dialog stays busy while approving');

  approveGate.resolve();
  await compactClick;
  await flush();
  node = flow.render();
  assert.equal(flow.pending.answers.length, 1, 'success approves the review');
  assert.equal(flow.closed.length, 1);
  assert.equal(findDialogElement(node).props.busy, false);
});

test('compact: success followed by a rejected approval clears the status and shows error.approveFailed', async () => {
  const flow = scenario({
    pending: createPending({
      answer: async () => {
        throw new Error('approve exploded');
      },
    }),
  });
  await findActionRow(flow.node, 'panel.actions.compact.title').props.onClick();
  await flush();

  const node = flow.render();
  assert.ok(hasText(node, 'error.approveFailed'), 'the approval failure is localized');
  assert.equal(hasText(node, 'compact.success'), false, 'the transient status is cleared on failure');
  assert.equal(flow.closed.length, 0);
  assert.equal(findDialogElement(node).props.busy, false);
});

test('compact: a static host failure stays localized with retry/proceed/cancel and never approves', async () => {
  const flow = scenario({
    transportOptions: {
      execute: async () => ({ ok: true, value: { result: { kind: 'error', text: HOST_FAILURES.busy } } }),
    },
  });
  await findActionRow(flow.node, 'panel.actions.compact.title').props.onClick();
  await flush();

  const node = flow.render();
  assert.ok(hasText(node, 'compact.error.busy'), 'the host static message is localized');
  assert.ok(hasText(node, 'compact.failed'), 'the failure block renders');
  assert.ok(hasText(node, 'compact.failedHint'));
  assert.ok(findUiButton(node, 'compact.retry'), 'Retry is offered');
  assert.ok(findUiButton(node, 'compact.proceed'), 'Execute anyway is offered');
  assert.ok(findUiButton(node, 'compact.cancel'), 'Cancel is offered');
  assert.equal(findActionRow(node, 'panel.actions.execute.title'), undefined, 'normal action rows are hidden');
  assert.equal(flow.pending.answers.length, 0, 'a failure never auto-approves');
  assert.equal(flow.closed.length, 0, 'the dialog stays open');
});

test('compact: retrying a failing command calls the host again and keeps the failure block', async () => {
  const flow = scenario({
    transportOptions: {
      execute: async () => ({ ok: true, value: { result: { kind: 'error', text: HOST_FAILURES.busy } } }),
    },
  });
  await findActionRow(flow.node, 'panel.actions.compact.title').props.onClick();
  await flush();
  await findUiButton(flow.render(), 'compact.retry').props.onClick();
  await flush();

  const node = flow.render();
  assert.equal(flow.transport.commands.length, 2, 'Retry runs the command again');
  assert.ok(hasText(node, 'compact.error.busy'), 'the failure block remains');
  assert.ok(findUiButton(node, 'compact.retry'));
  assert.equal(flow.pending.answers.length, 0);
});

test('compact: Execute anyway approves the review without re-running the command', async () => {
  const flow = scenario({
    transportOptions: {
      execute: async () => ({ ok: true, value: { result: { kind: 'error', text: HOST_FAILURES.busy } } }),
    },
  });
  await findActionRow(flow.node, 'panel.actions.compact.title').props.onClick();
  await flush();
  await findUiButton(flow.render(), 'compact.proceed').props.onClick();
  await flush();

  assert.equal(flow.transport.commands.length, 1);
  assert.deepEqual(flow.pending.answers, [
    { answers: [{ id: REVIEW.id, selected: [REVIEW.approve.label] }] },
  ]);
  assert.equal(flow.closed.length, 1);
});

test('compact: Cancel closes the dialog without approving or running the command again', async () => {
  const flow = scenario({
    transportOptions: {
      execute: async () => ({ ok: true, value: { result: { kind: 'error', text: HOST_FAILURES.busy } } }),
    },
  });
  await findActionRow(flow.node, 'panel.actions.compact.title').props.onClick();
  await flush();
  await findUiButton(flow.render(), 'compact.cancel').props.onClick();
  await flush();

  assert.equal(flow.closed.length, 1);
  assert.equal(flow.pending.answers.length, 0);
  assert.equal(flow.transport.commands.length, 1);

  const node = flow.render();
  assert.ok(findActionRow(node, 'panel.actions.execute.title'), 'cancelling restores the normal action rows');
});

test('compact: closing while the command is in flight aborts the wait and never approves late', async () => {
  const commandGate = deferred();
  const flow = scenario({ transportOptions: { execute: () => commandGate.promise } });
  const pendingClick = findActionRow(flow.node, 'panel.actions.compact.title').props.onClick();
  await flush();

  assert.equal(flow.transport.commands.length, 1);
  const command = flow.transport.commands[0];
  assert.equal(command.signal.aborted, false);

  let node = flow.render();
  const close = findIconButton(node, 'panel.close');
  assert.ok(close, 'the close control exists');
  assert.equal(close.props.disabled, false, 'compaction does not block closing');
  close.props.onClick();

  assert.equal(flow.closed.length, 1);
  assert.equal(command.signal.aborted, true, 'closing aborts the in-flight wait');

  commandGate.resolve({ ok: true, value: { result: { kind: 'success', text: 'ok' } } });
  await pendingClick;
  await flush();

  node = flow.render();
  assert.equal(flow.pending.answers.length, 0, 'a late command success must never approve');
  assert.equal(flow.closed.length, 1);
  assert.equal(hasText(node, 'compact.success'), false, 'no late status is rendered');
});

// ---------------------------------------------------------------- revise -----

test('revise: Back to editing dismisses the pending review and closes exactly once', async () => {
  const flow = scenario();
  const revise = findUiButton(flow.node, 'panel.revise');
  assert.ok(revise, 'the revise button renders while the review can be dismissed');
  await revise.props.onClick();
  await flush();

  assert.equal(flow.pending.dismissCalls, 1, 'the same pending review is dismissed once');
  assert.deepEqual(flow.pending.events, ['dismiss']);
  assert.equal(flow.pending.answers.length, 0, 'revise never approves');
  assert.equal(flow.closed.length, 1);
  assert.deepEqual(flow.transport.log, []);
});

test('revise: a rejected dismissal renders error.dismissFailed and keeps the dialog open', async () => {
  const flow = scenario({
    pending: createPending({
      dismiss: async () => {
        throw new Error('dismiss exploded');
      },
    }),
  });
  await findUiButton(flow.node, 'panel.revise').props.onClick();
  await flush();

  const node = flow.render();
  assert.ok(hasText(node, 'error.dismissFailed'), 'the dismissal failure is localized');
  assert.ok(hasText(node, 'dismiss exploded'));
  assert.equal(flow.closed.length, 0);
  assert.equal(findDialogElement(node).props.busy, false);
  assert.ok(findActionRow(node, 'panel.actions.execute.title'), 'the action rows stay usable');
});

// ------------------------------------------------------- settled reviews -----

test('trigger: returns null when the pending interaction is missing or not a plan review', () => {
  const state = baseSetup();
  assert.equal(panel.ExecutionTrigger(triggerProps(state, { pending: undefined })), null);
  assert.equal(panel.ExecutionTrigger(triggerProps(state, { pending: { kind: 'comment' } })), null);

  const node = panel.ExecutionTrigger(triggerProps(state, { pending: createPending() }));
  assert.ok(node, 'a plan-review interaction renders the trigger');
  assert.equal(node.children[0].type, 'button');
  assert.equal(node.children[1], null, 'the dialog is not mounted while closed');
});

test('settled review: Execute, Compact and the clear confirm report error.reviewGone with zero transport calls', async () => {
  const flow = scenario({
    settled: true,
    switches: { unlimitedBudget: true, includeOriginalInstructions: false, includeMinimalContext: true },
  });
  assert.equal(flow.props.pending, undefined);

  await findActionRow(flow.node, 'panel.actions.execute.title').props.onClick();
  let node = flow.render();
  assert.ok(hasText(node, 'error.reviewGone'), 'Execute reports the settled review');

  await findActionRow(node, 'panel.actions.compact.title').props.onClick();
  node = flow.render();
  assert.ok(hasText(node, 'error.reviewGone'), 'Compact reports the settled review');

  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  node = flow.render();
  const confirm = findUiButton(node, 'clear.confirm');
  assert.ok(confirm, 'the clear view offers the confirm button');
  await confirm.props.onClick();
  node = flow.render();
  assert.ok(hasText(node, 'error.reviewGone'), 'the fresh confirm reports the settled review');

  assert.deepEqual(flow.transport.log, [], 'a settled review triggers no transport operation');
  assert.equal(flow.closed.length, 0, 'nothing closes when the review is gone');
});

test('settled review: a mid-flight fresh execution re-checks pending, archives the new session and never prompts', async () => {
  const createGate = deferred();
  const flow = scenario({ transportOptions: { create: () => createGate.promise } });

  findActionRow(flow.node, 'panel.actions.clear.title').props.onClick();
  await flush();
  let node = flow.render();
  const confirm = findUiButton(node, 'clear.confirm');
  assert.ok(confirm);
  assert.equal(confirm.props.disabled, false, 'the confirm is enabled once the instruction read settles');
  const confirmClick = confirm.props.onClick();
  await flush();
  assert.equal(flow.transport.created.length, 1, 'the new session creation is in flight');

  node = flow.render({ pending: undefined });
  createGate.resolve('new-session');
  await confirmClick;
  await flush();
  node = flow.render();

  assert.ok(hasText(node, 'error.reviewGone'), 'the still-pending re-check reports the settled review');
  assert.deepEqual(flow.transport.archived, [{ sessionId: 'new-session', options: { stopActivity: true } }]);
  assert.equal(flow.transport.prompts.length, 0, 'no prompt is sent into the orphaned session');
  assert.equal(flow.transport.opened.length, 0);
  assert.equal(flow.transport.cancelled.length, 0);
  assert.equal(flow.closed.length, 0);
  assert.equal(findDialogElement(node).props.busy, false);
});

// ---------------------------------------------------------- fresh/clear -----

/** Enter the clear view and return the settled render. */
async function enterClear(flow) {
  findActionRow(flow.node, 'panel.actions.clear.title').props.onClick();
  await flush();
  return flow.render();
}

test('clear: instructions are read once, previewed, then reused for the sent first message', async () => {
  const flow = scenario({ transportOptions: { window: planWindow(['Do X', 'Do Y']) } });
  const node = await enterClear(flow);

  const countCall = flow.translator.last('preview.instructionCount');
  assert.ok(countCall, 'the instruction count is rendered');
  assert.deepEqual(countCall.params, { count: 2, chars: 8 }, 'the read texts drive the preview count');
  assert.equal(flow.transport.snapshots.count, 1, 'the preview reads the event window once');

  const confirm = findUiButton(node, 'clear.confirm');
  assert.equal(confirm.props.disabled, false);
  await confirm.props.onClick();
  await flush();

  assert.equal(flow.transport.prompts.length, 1);
  const text = flow.transport.prompts[0].content[0].text;
  assert.ok(text.includes('Do X'));
  assert.ok(text.includes('Do Y'));
  assert.equal(flow.transport.snapshots.count, 1, 'execution reuses the previewed texts without a second read');
  assert.equal(flow.closed.length, 1);
});

test('clear: the preview total equals the byte-identical sent prompt and composeFreshPrompt text', async () => {
  const flow = scenario({ transportOptions: { window: planWindow(['Do X', 'Do Y']) } });
  const node = await enterClear(flow);

  const totalCall = flow.translator.last('preview.total');
  assert.ok(totalCall, 'the preview renders its total');
  const expected = realActions.composeFreshPrompt({
    plan: REVIEW.plan,
    presetId: 'standard',
    instructions: ['Do X', 'Do Y'],
    workspaceDirectory: '/tmp/work',
    switches: ALL_ON,
  });
  assert.equal(totalCall.params.chars, expected.length, 'the previewed total is the assembled length');

  await findUiButton(node, 'clear.confirm').props.onClick();
  await flush();

  const sent = flow.transport.prompts[0].content[0].text;
  assert.equal(sent, expected, 'the sent text is byte-identical to the previewed assembly');
  assert.equal(sent.length, totalCall.params.chars);
  assert.ok(sent.endsWith(realActions.PLAN_APPROVED_HANDOFF), 'the canonical handoff closes the message');
});

test('clear: the confirm forwards every derived argument and runs the native ordering', async () => {
  const flow = scenario({ transportOptions: { window: planWindow(['Do X', 'Do Y']) } });
  const node = await enterClear(flow);
  await findUiButton(node, 'clear.confirm').props.onClick();
  await flush();

  assert.deepEqual(flow.transport.created[0], { workspaceId: 'workspace-1', agentPreset: 'standard' });
  assert.equal(flow.transport.usingCalls.length, 1);
  assert.equal(flow.transport.usingCalls[0].sessionId, 'new-session');
  assert.equal(flow.transport.usingCalls[0].options.source, 'greatPlan');
  assert.ok(flow.transport.usingCalls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(flow.transport.renames, [realActions.composeFreshTitle('Old plan', 'clear.titleSuffix')]);
  assert.deepEqual(flow.transport.selectModelCalls, [{
    sessionId: 'new-session',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  }]);
  assert.equal(flow.transport.prompts.length, 1);
  assert.equal(flow.transport.prompts[0].mode, 'queue');
  assert.ok(flow.transport.prompts[0].signal instanceof AbortSignal);
  assert.deepEqual(flow.transport.prompts[0].content, [{
    type: 'text',
    text: realActions.composeFreshPrompt({
      plan: REVIEW.plan,
      presetId: 'standard',
      instructions: ['Do X', 'Do Y'],
      workspaceDirectory: '/tmp/work',
      switches: ALL_ON,
    }),
  }]);
  assert.equal(flow.transport.cancelled.length, 1, 'the old session is stopped after the prompt');
  assert.deepEqual(flow.transport.opened, ['new-session']);
  assert.deepEqual(flow.transport.archived, [], 'a successful execution archives nothing');
  assert.equal(flow.closed.length, 1);

  const order = flow.transport.log;
  const before = (first, second) => {
    const firstIndex = order.indexOf(first);
    const secondIndex = order.indexOf(second);
    assert.ok(firstIndex >= 0 && secondIndex >= 0, `expected ${first} and ${second} in ${order.join(',')}`);
    assert.ok(firstIndex < secondIndex, `${first} must happen before ${second}`);
  };
  before('create', 'rename');
  before('create', 'selectModel');
  before('rename', 'prompt');
  before('selectModel', 'prompt');
  before('prompt', 'cancel');
  before('cancel', 'open');
});

test('clear: a prompt failure archives the new session and shows error.startSessionFailed', async () => {
  const flow = scenario({
    transportOptions: {
      window: planWindow(),
      prompt: async () => ({ ok: false, error: { message: 'denied', code: 'not-allowed' } }),
    },
  });
  const node = await enterClear(flow);
  await findUiButton(node, 'clear.confirm').props.onClick();
  await flush();
  const rendered = flow.render();

  assert.ok(hasText(rendered, 'error.startSessionFailed'), 'the prompt failure is localized');
  assert.ok(hasText(rendered, 'denied (not-allowed)'), 'the RPC failure text is included');
  assert.deepEqual(flow.transport.archived, [{ sessionId: 'new-session', options: { stopActivity: true } }]);
  assert.deepEqual(flow.transport.opened, []);
  assert.equal(flow.transport.cancelled.length, 0, 'the old session is not stopped after a failed start');
  assert.equal(flow.closed.length, 0);
  assert.equal(findDialogElement(rendered).props.busy, false);
});

test('clear: an archive cleanup failure keeps the original error and adds the cleanup warning', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const flow = scenario({
      transportOptions: {
        window: planWindow(),
        prompt: async () => ({ ok: false, error: { message: 'denied', code: 'not-allowed' } }),
        archive: async () => {
          throw new Error('archive exploded');
        },
      },
    });
    const node = await enterClear(flow);
    await findUiButton(node, 'clear.confirm').props.onClick();
    await flush();
    const rendered = flow.render();

    assert.ok(hasText(rendered, 'error.startSessionFailed'), 'the original failure is shown');
    assert.ok(hasText(rendered, 'error.cleanupFailed'), 'the cleanup warning is shown');
    assert.ok(hasText(rendered, 'archive exploded'));
    assert.ok(
      warnings.some((args) => typeof args[0] === 'string'
        && args[0].includes('great-plan: the unused new session could not be archived:')),
      'the cleanup failure is logged',
    );
    assert.equal(flow.closed.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test('clear: a refused old-session cancel warns but still opens the new session and closes', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const flow = scenario({
      transportOptions: {
        window: planWindow(),
        cancel: async () => ({ ok: false, error: { message: 'busy', code: 'session-busy' } }),
      },
    });
    const node = await enterClear(flow);
    await findUiButton(node, 'clear.confirm').props.onClick();
    await flush();
    const rendered = flow.render();

    assert.equal(flow.transport.prompts.length, 1, 'the message is sent before stopping the old session');
    assert.deepEqual(flow.transport.opened, ['new-session']);
    assert.equal(flow.closed.length, 1, 'a failed cancel still finishes the flow');
    assert.ok(
      warnings.some((args) => typeof args[0] === 'string'
        && args[0].includes('great-plan: the previous session was not stopped:')),
      'the cancel failure is logged',
    );
    assert.ok(warnings.some((args) => args.some((arg) => String(arg).includes('busy (session-busy)'))));
    assert.equal(findErrorTexts(rendered).length, 0, 'a cancel failure is not a dialog error');
  } finally {
    console.warn = originalWarn;
  }
});

test('clear: this-run switches change the preview and a pending instruction read disables confirm', async () => {
  const loadGate = deferred();
  const flow = scenario({
    transportOptions: {
      window: { entries: [], hasMore: true },
      loadOlder: () => loadGate.promise,
    },
  });
  findActionRow(flow.node, 'panel.actions.clear.title').props.onClick();
  await flush();
  let node = flow.render();

  assert.ok(hasText(node, 'preview.loadingInstructions'), 'the instruction read shows its loading state');
  let confirm = findUiButton(node, 'clear.confirm');
  assert.equal(confirm.props.disabled, true, 'confirm is disabled while instructions load');

  const totalBefore = flow.translator.last('preview.total').params.chars;
  await findCheckbox(node, 'preview.switchBudget').props.onChange(false);
  node = flow.render();
  const totalAfter = flow.translator.last('preview.total').params.chars;
  assert.ok(totalAfter < totalBefore, 'turning the budget reminder off shrinks the previewed message');
  assert.ok(hasText(node, 'preview.excluded'), 'the excluded budget block is marked');
  assert.equal(findCheckbox(node, 'preview.switchBudget').props.checked, false);

  await findCheckbox(node, 'preview.switchInstructions').props.onChange(false);
  node = flow.render();
  confirm = findUiButton(node, 'clear.confirm');
  assert.equal(confirm.props.disabled, false, 'turning the pending instruction read off re-enables confirm');
  assert.ok(hasText(node, 'preview.noInstructions'));

  loadGate.reject(new Error('stop reading'));
  await flush();
  node = flow.render();
  assert.equal(findUiButton(node, 'clear.confirm').props.disabled, false);
  assert.equal(flow.transport.loadOlderCalls, 1, 'only one older-page load was in flight');
});

test('clear: a session without instruction texts shows the unavailable note and executes the plan only', async () => {
  const flow = scenario({ transportOptions: { window: planWindow() } });
  const node = await enterClear(flow);

  assert.ok(hasText(node, 'preview.instructionsUnavailable'), 'the missing instruction texts are explained');
  const confirm = findUiButton(node, 'clear.confirm');
  assert.equal(confirm.props.disabled, false);
  await confirm.props.onClick();
  await flush();

  assert.equal(flow.transport.prompts.length, 1);
  const text = flow.transport.prompts[0].content[0].text;
  assert.equal(text.includes(realActions.PLAN_MODE_INSTRUCTIONS_HEADING), false, 'no empty instructions block is sent');
  assert.ok(text.includes('<approved-plan>'));
  assert.ok(text.includes('Do the thing.'));
  assert.ok(text.endsWith(realActions.PLAN_APPROVED_HANDOFF));
  assert.equal(flow.closed.length, 1);
});

// --------------------------------------------------------- model/effort -----

function openModelView(flow) {
  findSelectRow(flow.node, 'panel.model').props.onClick();
  return flow.render();
}

function openEffortView(flow) {
  findSelectRow(flow.node, 'panel.effort').props.onClick();
  return flow.render();
}

test('model: picking a model forwards provider/model to directory.select and returns to root', async () => {
  const flow = scenario();
  let node = openModelView(flow);
  assert.ok(findListRow(node, 'DeepSeek Flash'), 'the model list renders');
  await findListRow(node, 'DeepSeek Flash').props.onClick();
  await flush();
  node = flow.render();

  assert.deepEqual(flow.directory.calls.select, [{ provider: 'deepseek-account', model: 'deepseek-flash' }]);
  assert.ok(findActionRow(node, 'panel.actions.execute.title'), 'the root view is restored after a successful selection');
  assert.equal(findListRow(node, 'DeepSeek Flash'), undefined, 'the model list is gone');
  assert.equal(findDialogElement(node).props.busy, false);
});

test('model: a refused or throwing selection localizes error.selectModelFailed with the failure detail', async () => {
  const refused = scenario({
    directoryOptions: {
      select: async () => ({ ok: false, error: { message: 'provider rejected', code: 'invalid-model' } }),
    },
  });
  let node = openModelView(refused);
  await findListRow(node, 'DeepSeek Flash').props.onClick();
  await flush();
  node = refused.render();
  assert.ok(hasText(node, 'error.selectModelFailed'), 'the refusal is localized');
  assert.ok(hasText(node, 'provider rejected (invalid-model)'), 'formatRpcFailure text is shown');
  assert.ok(findListRow(node, 'DeepSeek Flash'), 'the list stays open after a refusal');
  assert.equal(findDialogElement(node).props.busy, false);

  const thrown = scenario({
    directoryOptions: {
      select: async () => {
        throw new Error('select exploded');
      },
    },
  });
  node = openModelView(thrown);
  await findListRow(node, 'DeepSeek Flash').props.onClick();
  await flush();
  node = thrown.render();
  assert.ok(hasText(node, 'error.selectModelFailed'));
  assert.ok(hasText(node, 'select exploded'));
});

test('effort: provider default omits reasoningEffort and an explicit row includes it', async () => {
  const flow = scenario();
  let node = openEffortView(flow);
  assert.ok(findListRow(node, 'panel.providerDefault'), 'the provider-default row always exists');
  await findListRow(node, 'panel.providerDefault').props.onClick();
  await flush();

  const defaultPayload = flow.directory.calls.select[0];
  assert.deepEqual(defaultPayload, { provider: 'deepseek-account', model: 'deepseek-flash' });
  assert.equal(Object.hasOwn(defaultPayload, 'reasoningEffort'), false, 'provider default clears the override');

  flow.render();
  node = openEffortView(flow);
  await findListRow(node, 'High').props.onClick();
  await flush();
  assert.deepEqual(flow.directory.calls.select[1], {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  });
});

test('model: closing and going back are blocked while a selection is in flight, then restore', async () => {
  const selectGate = deferred();
  const flow = scenario({ directoryOptions: { select: () => selectGate.promise } });
  let node = openModelView(flow);
  const selectClick = findListRow(node, 'DeepSeek Flash').props.onClick();
  await flush();
  node = flow.render();

  assert.equal(findDialogElement(node).props.blocked, true);
  assert.equal(findDialogElement(node).props.busy, true);
  assert.equal(findIconButton(node, 'panel.close').props.disabled, true);
  assert.equal(findIconButton(node, 'panel.back').props.disabled, true);
  findDialogElement(node).props.onRequestClose();
  assert.equal(flow.closed.length, 0, 'a blocked close is ignored');

  selectGate.resolve({ ok: true });
  await selectClick;
  await flush();
  node = flow.render();
  assert.equal(findDialogElement(node).props.blocked, false);
  assert.equal(findDialogElement(node).props.busy, false);
  assert.equal(findIconButton(node, 'panel.close').props.disabled, false);
  assert.ok(findActionRow(node, 'panel.actions.execute.title'));
  findDialogElement(node).props.onRequestClose();
  assert.equal(flow.closed.length, 1, 'close works again after the selection settles');
});

// ----------------------------------------------------------------- busy -----

test('busy: an in-flight execute marks the dialog blocked/busy and ignores close until it settles', async () => {
  const answerGate = deferred();
  const flow = scenario({ pending: createPending({ answer: () => answerGate.promise }) });
  const executeClick = findActionRow(flow.node, 'panel.actions.execute.title').props.onClick();
  await flush();

  let node = flow.render();
  assert.equal(findDialogElement(node).props.blocked, true);
  assert.equal(findDialogElement(node).props.busy, true);
  assert.equal(dialogShell(node).props['aria-busy'], 'true');
  assert.equal(findIconButton(node, 'panel.close').props.disabled, true);
  assert.equal(findActionRow(node, 'panel.actions.execute.title').props.disabled, true);
  findDialogElement(node).props.onRequestClose();
  assert.equal(flow.closed.length, 0, 'a blocked request close is ignored');

  answerGate.resolve();
  await executeClick;
  await flush();
  assert.equal(flow.closed.length, 1, 'the approval flow completes after the gate resolves');
});

test('busy: an in-flight fresh execution marks the dialog blocked/busy and ignores close/back', async () => {
  const createGate = deferred();
  const flow = scenario({ transportOptions: { create: () => createGate.promise } });
  const node = await enterClear(flow);
  const confirmClick = findUiButton(node, 'clear.confirm').props.onClick();
  await flush();

  let rendered = flow.render();
  assert.equal(findDialogElement(rendered).props.blocked, true);
  assert.equal(findDialogElement(rendered).props.busy, true);
  assert.equal(dialogShell(rendered).props['aria-busy'], 'true');
  assert.equal(findIconButton(rendered, 'panel.close').props.disabled, true);
  assert.equal(findIconButton(rendered, 'panel.back').props.disabled, true);
  findDialogElement(rendered).props.onRequestClose();
  assert.equal(flow.closed.length, 0, 'a blocked close is ignored');

  createGate.resolve('new-session');
  await confirmClick;
  await flush();
  assert.equal(flow.closed.length, 1);
  rendered = flow.render();
  assert.equal(findDialogElement(rendered).props.blocked, false);
});

// -------------------------------------------------------------- trigger -----

test('trigger: derives workspace and row props and forwards them through the fresh execution', async () => {
  const state = baseSetup({ transportOptions: { window: planWindow() } });
  const trigger = mount(panel.ExecutionTrigger);
  const props = triggerProps(state);
  let node = trigger.render(props);
  assert.equal(node.children[1], null, 'the dialog is not mounted while closed');

  node.children[0].props.onClick();
  node = trigger.render(props);
  const dialogElement = node.children[1];
  assert.equal(dialogElement.type, panel.ExecutionDialog);
  assert.equal(dialogElement.props.workspaceId, 'ws-9');
  assert.equal(dialogElement.props.workspaceDirectory, '/tmp/ws-path');
  assert.equal(dialogElement.props.cwd, '/tmp/row-cwd');
  assert.equal(dialogElement.props.title, 'Row title');
  assert.equal(dialogElement.props.currentPreset, 'standard');
  assert.equal(dialogElement.props.pending.kind, 'plan-review');

  const dialog = mount(panel.ExecutionDialog);
  let dialogNode = dialog.render(dialogElement.props);
  findActionRow(dialogNode, 'panel.actions.clear.title').props.onClick();
  await flush();
  dialogNode = dialog.render(dialogElement.props);
  await findUiButton(dialogNode, 'clear.confirm').props.onClick();
  await flush();

  assert.deepEqual(state.transport.created[0], { workspaceId: 'ws-9', agentPreset: 'standard' });
  assert.deepEqual(state.transport.renames, [realActions.composeFreshTitle('Row title', 'clear.titleSuffix')]);
  assert.equal(state.transport.prompts.length, 1, 'the derived props reach the sent first message');
});

test('trigger: falls back to the session row cwd when the workspace is unknown', () => {
  const state = baseSetup();
  const trigger = mount(panel.ExecutionTrigger);
  const props = triggerProps(state, { workspaces: { items: [] } });
  let node = trigger.render(props);
  node.children[0].props.onClick();
  node = trigger.render(props);
  const dialogElement = node.children[1];
  assert.equal(dialogElement.props.workspaceId, undefined);
  assert.equal(dialogElement.props.workspaceDirectory, '/tmp/row-cwd', 'the row cwd is the fallback directory');
});

// --------------------------------------------------------------- effects ----

test('effects: opening loads the model directory once and swallows a rejected load', async () => {
  const flow = scenario({
    directoryOptions: {
      load: async () => {
        throw new Error('load exploded');
      },
    },
  });
  await flush();

  assert.equal(flow.directory.calls.load, 1, 'the open effect loads the directory once');
  const node = flow.render();
  assert.ok(findActionRow(node, 'panel.actions.execute.title'), 'a failed load does not break the dialog');
  assert.equal(flow.directory.calls.load, 1, 'unchanged effect deps do not reload');
});

test('effects: the clear view loads presets without forcing, retry forces, and re-entry never forces', async () => {
  const presetState = { status: 'error', options: [], error: 'preset boom' };
  const presetStore = createPresetStore({ state: presetState });
  const flow = scenario({ presetStore });
  assert.deepEqual(presetStore.calls.load, []);

  findActionRow(flow.node, 'panel.actions.clear.title').props.onClick();
  await flush();
  let node = flow.render();
  assert.deepEqual(presetStore.calls.load, [false], 'entering clear loads without forcing');

  findSelectRow(node, 'clear.preset').props.onClick();
  node = flow.render();
  assert.deepEqual(presetStore.calls.load, [false], 'opening the preset sub-view does not reload');

  const retry = findUiButton(node, 'preset.retry');
  assert.ok(retry, 'the preset error state offers retry');
  await retry.props.onClick();
  await flush();
  assert.deepEqual(presetStore.calls.load, [false, true], 'retry forces a reload');

  findIconButton(node, 'panel.back').props.onClick();
  node = flow.render();
  assert.deepEqual(presetStore.calls.load, [false, true, false], 'returning to clear keeps the non-forced load');

  findIconButton(node, 'panel.back').props.onClick();
  node = flow.render();
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  node = flow.render();
  assert.deepEqual(presetStore.calls.load, [false, true, false, false]);
  assert.equal(presetStore.calls.load.filter(Boolean).length, 1, 'only the explicit retry forces a reload');
});

test('effects: a view change focuses the dialog title element', async () => {
  const flow = scenario();
  const title = findByType(flow.node, 'h2');
  assert.ok(title, 'the dialog title renders as an h2');
  const focusCalls = [];
  title.props.ref.current = { focus: () => focusCalls.push('focus') };

  findSelectRow(flow.node, 'panel.model').props.onClick();
  let node = flow.render();
  assert.equal(focusCalls.length, 1, 'entering the model view focuses the title');
  assert.equal(findByType(node, 'h2').props.title, 'panel.model');

  findIconButton(node, 'panel.back').props.onClick();
  node = flow.render();
  assert.equal(focusCalls.length, 2, 'returning to the root view focuses the title again');
  assert.equal(findByType(node, 'h2').props.title, 'panel.title');
});

test('effects: unmount aborts an in-flight compact wait and never approves late', async () => {
  const commandGate = deferred();
  const flow = scenario({ transportOptions: { execute: () => commandGate.promise } });
  findActionRow(flow.node, 'panel.actions.compact.title').props.onClick();
  await flush();

  assert.equal(flow.transport.commands.length, 1);
  const command = flow.transport.commands[0];
  assert.equal(command.signal.aborted, false);

  flow.unmount();
  assert.equal(command.signal.aborted, true, 'unmount aborts the in-flight command wait');

  commandGate.resolve({ ok: true, value: { result: { kind: 'success', text: 'ok' } } });
  await flush();
  assert.equal(flow.pending.answers.length, 0, 'an unmounted dialog never approves');
  assert.equal(flow.closed.length, 0);
});

test('effects: unmount aborts an in-flight instruction read without late state updates', async () => {
  const loadGate = deferred();
  const flow = scenario({
    transportOptions: {
      window: { entries: [], hasMore: true },
      loadOlder: () => loadGate.promise,
    },
  });
  findActionRow(flow.node, 'panel.actions.clear.title').props.onClick();
  await flush();
  assert.equal(flow.transport.loadOlderCalls, 1, 'the instruction read is in flight');

  flow.unmount();
  loadGate.reject(new Error('the read was aborted'));
  await flush();
  assert.equal(flow.closed.length, 0);
  // The assertions are "no throw, no unhandled rejection, no approval".
  assert.equal(flow.pending.answers.length, 0);
});

