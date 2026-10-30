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

/**
 * Tiny hook harness for direct component-function calls.
 *
 * Without a mounted frame the hooks behave like the original fake React (fixed
 * initial state, no effects). Inside `mount()` the hook cells persist across
 * manual re-renders, so tests can activate click handlers and observe the next
 * render without a DOM renderer. Effects are intentionally not executed.
 */
const hookFrames = [];

function currentFrame() {
  return hookFrames[hookFrames.length - 1];
}

function mount(component) {
  const frame = { slots: [], index: 0 };
  const render = (props) => {
    frame.index = 0;
    hookFrames.push(frame);
    try {
      return component(props);
    } finally {
      hookFrames.pop();
    }
  };
  return { render };
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
  useEffect() {
    const frame = currentFrame();
    if (frame !== undefined) frame.index += 1;
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
  const require = (spec) => {
    if (spec === 'react') return fakeReact;
    if (spec === 'react-dom') return fakeReactDom;
    if (spec === '@local/dsh-great-plan/client.ui.js') return modules['client.ui.js'];
    if (spec === '@local/dsh-great-plan/client.settings.js') return modules['client.settings.js'];
    if (spec === '@local/dsh-great-plan/client.model.js') return modules['client.model.js'];
    if (spec === '@local/dsh-great-plan/client.preset.js') return modules['client.preset.js'];
    if (spec === '@local/dsh-great-plan/client.actions.js') return modules['client.actions.js'];
    throw new Error(`unexpected require: ${spec}`);
  };
  modules[fileName] = registration.factory(require);
}

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

const actionsModule = modules['client.actions.js'];

/**
 * Contract-faithful stand-ins for the WS-A helpers while that workstream is
 * still landing; the real exports win as soon as they exist, so these tests
 * exercise the frozen interface in both states.
 */
const ACTION_ERROR_CODES = [
  'emptyPlan',
  'reviewGone',
  'createSessionFailed',
  'modelApplyFailed',
  'startSessionFailed',
  'openSessionFailed',
  'dismissFailed',
  'cleanupFailed',
];

function stubActionHelpers() {
  if (typeof actionsModule.planPreviewText !== 'function') {
    actionsModule.planPreviewText = (plan) => {
      if (typeof plan !== 'string' || plan.trim() === '') return { preview: '', chars: 0 };
      const lines = plan.split(/\r?\n/);
      let index = 0;
      while (index < lines.length && lines[index].trim() === '') index += 1;
      let heading = '';
      if (index < lines.length && /^#{1,6}\s/.test(lines[index].trim())) {
        heading = lines[index].trim().replace(/^#+\s*/, '');
        index += 1;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() !== '' && !/^#{1,6}\s/.test(lines[index].trim())) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      const stripped = `${heading}${paragraph.length === 0 ? '' : `\n${paragraph.join(' ')}`}`
        .replace(/\*\*|__|`/g, '')
        .replace(/[*_]/g, '')
        .trim();
      const preview = stripped.length > 240 ? `${stripped.slice(0, 240)}…` : stripped;
      return { preview, chars: plan.length };
    };
  }
  if (typeof actionsModule.describeActionError !== 'function') {
    actionsModule.describeActionError = (t, error) => {
      if (error === null || error === undefined || typeof error !== 'object') return undefined;
      if (typeof error.code !== 'string' || !ACTION_ERROR_CODES.includes(error.code)) return undefined;
      return t(`error.${error.code}`, { message: error.message ?? String(error) });
    };
  }
  if (typeof actionsModule.describeCompactFailure !== 'function') {
    actionsModule.describeCompactFailure = (_t, message) => message;
  }
  if (typeof actionsModule.describeFreshPrompt !== 'function') {
    actionsModule.describeFreshPrompt = (input = {}) => {
      const { plan, t, presetId, instructions, workspaceDirectory, runtimeFacts, switches } = input;
      const values = switches ?? {};
      const all = Array.isArray(instructions)
        ? instructions.filter((text) => typeof text === 'string' && text.trim() !== '')
        : [];
      let text = '';
      try {
        text = actionsModule.composeFreshPrompt({
          plan,
          t,
          presetId,
          instructions: all,
          workspaceDirectory,
          runtimeFacts,
          switches: values,
        });
      } catch {
        text = '';
      }
      const includeInstructions = values.includeOriginalInstructions !== false && all.length > 0;
      const includeRuntime = values.includeMinimalContext !== false && presetId === 'minimal';
      const blocks = [
        { id: 'intro', titleKey: 'preview.block.intro', included: true, chars: 0 },
        { id: 'budget', titleKey: 'preview.block.budget', included: values.unlimitedBudget !== false, chars: 0 },
        { id: 'runtime', titleKey: 'preview.block.runtime', included: includeRuntime, chars: 0 },
        {
          id: 'instructions',
          titleKey: 'preview.block.instructions',
          included: includeInstructions,
          chars: 0,
          count: includeInstructions ? all.length : 0,
        },
        { id: 'plan', titleKey: 'preview.block.plan', included: true, chars: 0 },
      ];
      const totalChars = text.length;
      return {
        text,
        blocks,
        instructionCount: all.length,
        instructionChars: all.reduce((sum, item) => sum + item.length, 0),
        totalChars,
        approxTokens: Math.ceil(totalChars / 3.5),
        oversized: totalChars > 32000,
      };
    };
  }
}

stubActionHelpers();
materialize('client.panel.js');

const ui = modules['client.ui.js'];
const panel = modules['client.panel.js'];

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

function nodeText(node) {
  return textOf(node);
}

function findButton(node, text) {
  return findElements(node, (child) => child !== null && child.type === 'button' && textOf(child).includes(text))[0];
}

function findUiButton(node, text) {
  return findElements(node, (child) => child !== null && child.type === ui.Button && textOf(child).includes(text))[0];
}

function findActionRow(node, title) {
  return findElements(node, (child) => (
    child !== null && child.type === ui.ActionRow && child.props?.title === title
  ))[0];
}

function findCheckbox(node, label) {
  return findElements(node, (child) => (
    child !== null && child.type === ui.Checkbox && child.props?.label === label
  ))[0];
}

function findDialog(node) {
  return findElements(node, (child) => child !== null && child.type === ui.Dialog)[0];
}

function findByType(node, type) {
  return findElements(node, (child) => child !== null && child.type === type)[0];
}

function createDirectory(snapshot) {
  const state = snapshot;
  return {
    store: {
      getSnapshot: () => state,
      subscribe: () => () => {},
    },
    load: async () => undefined,
    select: async () => ({ ok: true, value: undefined }),
  };
}

function readyDirectoryState() {
  return {
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
  };
}

function createPresetStore(options) {
  return {
    store: {
      getSnapshot: () => ({ status: 'ready', options, error: null }),
      subscribe: () => () => {},
    },
    load: async () => undefined,
  };
}

const PRESET_OPTIONS = [
  { id: 'standard', name: 'Standard', isDefault: true },
  { id: 'minimal', name: 'Minimal', isDefault: false },
];

function createActions(overrides = {}) {
  const calls = {
    approvals: 0,
    compacts: 0,
    dismissals: 0,
    fresh: [],
  };
  const actions = {
    composeFreshTitle: () => 'Old plan · Execute plan',
    approveReview: async () => {
      calls.approvals += 1;
    },
    runCompactCommand: async () => {
      calls.compacts += 1;
      return { ok: true, message: 'Compacted 2 history items (~120 tokens).' };
    },
    readPlanModeInstructions: async () => ({ texts: [], found: false, kind: undefined, pagesLoaded: 0 }),
    dismissReview: async () => {
      calls.dismissals += 1;
    },
    createFreshExecution: async (args) => {
      calls.fresh.push(args);
      return { sessionId: 'new-session' };
    },
    ...overrides,
  };
  return { actions, calls };
}

function createPending() {
  return {
    kind: 'plan-review',
    snapshot: () => ({ channel: 'waterfall' }),
    answer: async () => undefined,
    dismiss: async () => undefined,
  };
}

function hostProps(overrides = {}) {
  const { actions } = createActions();
  return {
    open: true,
    onClose: () => {},
    triggerRef: { current: null },
    pending: createPending(),
    review: {
      id: 'plan-review',
      approve: { label: 'Approve' },
      question: 'Which approach should we take?',
      plan: '# Plan\nDo it',
    },
    directory: createDirectory(readyDirectoryState()),
    actions,
    presetStore: createPresetStore(PRESET_OPTIONS),
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    workspaceDirectory: '/tmp/work',
    cwd: '/tmp',
    title: 'Old plan',
    currentPreset: 'standard',
    modelAvailable: true,
    readPromptSwitches: () => ({ unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: true }),
    t: (key) => key,
    ...overrides,
  };
}

async function flush() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
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

function createTriggerProps(overrides = {}) {
  const row = {
    cwd: '/tmp',
    title: 'Old plan',
    projectionValues: { agentPreset: 'standard' },
  };
  return {
    review: { id: 'plan-review', approve: { label: 'Approve' }, question: 'Q?', plan: '# Plan\nDo it' },
    requestKey: 'request-1',
    directory: createDirectory(readyDirectoryState()),
    actions: createActions().actions,
    presetStore: createPresetStore(PRESET_OPTIONS),
    sessionId: 'session-1',
    modelAvailable: true,
    readPromptSwitches: () => ({ unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: true }),
    useSessionStatus: (select) => select(new Map([['session-1', { pendingInteraction: createPending() }]])),
    useSessions: (select) => select({ byId: { 'session-1': row } }),
    useWorkspaces: (select) => select({ items: [{ workspaceId: 'workspace-1', sessionIds: ['session-1'], path: '/tmp/work' }] }),
    t: (key) => key,
    ...overrides,
  };
}

test('ExecutionTrigger renders only the closed trigger while the dialog is closed', () => {
  const node = panel.ExecutionTrigger(createTriggerProps());
  assert.ok(node);
  assert.equal(node.type, fakeReact.Fragment);
  assert.equal(node.children[0].type, 'button');
  assert.equal(node.children[0].props['aria-expanded'], false);
  assert.equal(node.children[1], null, 'closed trigger must not render the dialog tree');
});

test('ExecutionTrigger opens the dialog after activation and clears it again', () => {
  const trigger = mount(panel.ExecutionTrigger);
  const props = createTriggerProps();
  let node = trigger.render(props);
  assert.equal(node.children[1], null);

  node.children[0].props.onClick();
  node = trigger.render(props);
  assert.equal(node.children[1].type, panel.ExecutionDialog, 'open trigger renders one dialog');

  node.children[1].props.onClose();
  node = trigger.render(props);
  assert.equal(node.children[1], null, 'closing removes the dialog tree (state resets on unmount)');

  node.children[0].props.onClick();
  node = trigger.render(props);
  assert.equal(node.children[1].type, panel.ExecutionDialog);
});

test('ExecutionDialog renders the root view with an h2 dialog title', () => {
  const node = panel.ExecutionDialog(hostProps());
  assert.ok(node);
  assert.equal(typeof node.type, 'function');
  const rendered = node.type(node.props);
  assert.ok(rendered);
  assert.equal(rendered.type, fakeReact.Fragment);
  assert.equal(rendered.children.length, 2);
  assert.equal(rendered.children[1].props.role, 'dialog');
  const title = findElements(node, (child) => child !== null && child.type === 'h2')[0];
  assert.equal(title.props.id, 'gp-great-plan-title');
  assert.equal(title.props.tabIndex, -1);
});

test('the root plan section expands and collapses the full plan', () => {
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps();
  let node = dialog.render(props);
  assert.ok(nodeText(node).includes('preview.plan'));
  assert.ok(nodeText(node).includes('preview.viewPlan'));
  assert.ok(findActionRow(node, 'panel.actions.execute.title'));
  assert.ok(findActionRow(node, 'panel.actions.compact.title'));
  assert.ok(findActionRow(node, 'panel.actions.clear.title'));
  assert.equal(findByType(node, 'pre'), undefined, 'the full plan starts collapsed');

  findUiButton(node, 'preview.viewPlan').props.onClick();
  node = dialog.render(props);
  assert.ok(nodeText(node).includes('preview.hidePlan'));
  const planBody = findByType(node, 'pre');
  assert.ok(planBody, 'expanded plan renders the pre body');
  assert.equal(planBody.props.className, 'gp-plan-body');
  assert.ok(nodeText(planBody).includes('# Plan'));
  const region = findElements(node, (child) => child !== null && child.props?.role === 'region')[0];
  assert.ok(region, 'expanded plan is an announced region');

  findUiButton(node, 'preview.hidePlan').props.onClick();
  node = dialog.render(props);
  assert.equal(findByType(node, 'pre'), undefined);
  assert.ok(nodeText(node).includes('preview.viewPlan'));
});

test('返回修改 dismisses the review and closes the dialog', async () => {
  const dismissals = [];
  const closed = [];
  const { actions } = createActions({
    dismissReview: async (args) => {
      dismissals.push(args);
    },
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => closed.push('closed') });
  let node = dialog.render(props);
  const revise = findUiButton(node, 'panel.revise');
  assert.ok(revise, 'the revise button renders when the pending review can be dismissed');
  await revise.props.onClick();
  assert.equal(dismissals.length, 1);
  assert.equal(dismissals[0].pending, props.pending);
  assert.equal(closed.length, 1);

  const noDismiss = hostProps({ pending: { kind: 'plan-review' } });
  node = panel.ExecutionDialog(noDismiss);
  assert.equal(findUiButton(node, 'panel.revise'), undefined, 'no revise without pending.dismiss');
});

test('a failed 返回修改 localizes the error with the dismiss fallback', async () => {
  const { actions } = createActions({
    dismissReview: async () => {
      throw new Error('dismiss exploded');
    },
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => {} });
  let node = dialog.render(props);
  await findUiButton(node, 'panel.revise').props.onClick();
  node = dialog.render(props);
  const error = findByType(node, ui.ErrorText);
  assert.ok(error);
  assert.ok(nodeText(error).includes('error.dismissFailed'));
});

test('compaction failure keeps the dialog open with retry/proceed/cancel and no action rows', async () => {
  let compactCalls = 0;
  const { actions, calls } = createActions({
    runCompactCommand: async () => {
      compactCalls += 1;
      if (compactCalls === 1) {
        return { ok: false, message: 'Compaction is unavailable because no compaction backend is composed.', code: 'unavailable' };
      }
      return { ok: true, message: 'ok' };
    },
  });
  const closed = [];
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => closed.push('closed') });
  let node = dialog.render(props);

  await findActionRow(node, 'panel.actions.compact.title').props.onClick();
  node = dialog.render(props);

  assert.ok(nodeText(node).includes('compact.failed'));
  assert.ok(nodeText(node).includes('compact.failedHint'));
  assert.ok(findByType(node, ui.WarningBox), 'the failure block uses the announced WarningBox');
  assert.ok(findUiButton(node, 'compact.retry'));
  assert.ok(findUiButton(node, 'compact.proceed'));
  assert.ok(findUiButton(node, 'compact.cancel'));
  assert.equal(findActionRow(node, 'panel.actions.execute.title'), undefined, 'normal action rows are hidden');
  assert.equal(findActionRow(node, 'panel.actions.clear.title'), undefined);
  assert.equal(calls.approvals, 0, 'no automatic approval after failure');
  assert.equal(closed.length, 0, 'the dialog stays open');

  await findUiButton(node, 'compact.retry').props.onClick();
  assert.equal(compactCalls, 2);
  assert.equal(calls.approvals, 1);
  assert.equal(closed.length, 1);
});

test('a thrown compaction command is shown as a failure too', async () => {
  const { actions, calls } = createActions({
    runCompactCommand: async () => {
      throw new Error('rpc exploded');
    },
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => {} });
  let node = dialog.render(props);
  await findActionRow(node, 'panel.actions.compact.title').props.onClick();
  node = dialog.render(props);
  assert.ok(nodeText(node).includes('compact.failed'));
  assert.ok(findUiButton(node, 'compact.retry'));
  assert.equal(calls.approvals, 0);
});

test('仍然执行 approves immediately and 取消 closes without approving', async () => {
  const { actions, calls } = createActions({
    runCompactCommand: async () => ({ ok: false, message: 'backend missing' }),
  });
  const proceedClosed = [];
  const proceedDialog = mount(panel.ExecutionDialog);
  let proceedProps = hostProps({ actions, onClose: () => proceedClosed.push('closed') });
  let node = proceedDialog.render(proceedProps);
  await findActionRow(node, 'panel.actions.compact.title').props.onClick();
  node = proceedDialog.render(proceedProps);
  await findUiButton(node, 'compact.proceed').props.onClick();
  assert.equal(calls.approvals, 1);
  assert.equal(proceedClosed.length, 1);

  const cancelCalls = createActions({
    runCompactCommand: async () => ({ ok: false, message: 'backend missing' }),
  });
  const cancelClosed = [];
  const cancelDialog = mount(panel.ExecutionDialog);
  const cancelProps = hostProps({ actions: cancelCalls.actions, onClose: () => cancelClosed.push('closed') });
  node = cancelDialog.render(cancelProps);
  await findActionRow(node, 'panel.actions.compact.title').props.onClick();
  node = cancelDialog.render(cancelProps);
  await findUiButton(node, 'compact.cancel').props.onClick();
  assert.equal(cancelCalls.calls.approvals, 0);
  assert.equal(cancelClosed.length, 1);
  node = cancelDialog.render(cancelProps);
  assert.ok(findActionRow(node, 'panel.actions.execute.title'), 'cancelling restores the action rows');
});

test('a retried compaction shows its loading label while the command is busy', async () => {
  const secondRun = deferred();
  let compactCalls = 0;
  const { actions, calls } = createActions({
    runCompactCommand: async () => {
      compactCalls += 1;
      if (compactCalls === 1) return { ok: false, message: 'backend missing' };
      return secondRun.promise;
    },
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => {} });
  let node = dialog.render(props);
  await findActionRow(node, 'panel.actions.compact.title').props.onClick();
  node = dialog.render(props);

  const retryPromise = findUiButton(node, 'compact.retry').props.onClick();
  node = dialog.render(props);
  assert.ok(nodeText(node).includes('compact.retrying'), 'retry button shows the loading label');
  assert.equal(findUiButton(node, 'compact.retry').props.disabled, true);
  assert.equal(findDialog(node).props.busy, true, 'the dialog is marked busy while compacting');

  secondRun.resolve({ ok: true, message: 'ok' });
  await retryPromise;
  assert.equal(calls.approvals, 1);
});

test('compaction success shows the transient status line, then approves', async () => {
  const approve = deferred();
  const { actions, calls } = createActions({
    approveReview: () => {
      calls.approvals += 1;
      return approve.promise;
    },
  });
  const closed = [];
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => closed.push('closed') });
  let node = dialog.render(props);
  const compactPromise = findActionRow(node, 'panel.actions.compact.title').props.onClick();
  await flush();
  node = dialog.render(props);
  assert.ok(nodeText(node).includes('compact.success'), 'success status is visible while approving');
  assert.equal(findDialog(node).props.busy, true);

  approve.resolve();
  await compactPromise;
  assert.equal(calls.approvals, 1);
  assert.equal(closed.length, 1);
});

test('the clear view renders the plan, the block list and the char totals', async () => {
  const { actions, calls } = createActions({
    readPlanModeInstructions: async () => ({ texts: ['do X', 'do Y'], found: true, kind: 'plan-mode', pagesLoaded: 0 }),
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => {} });
  let node = dialog.render(props);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = dialog.render(props);

  assert.ok(nodeText(node).includes('preview.title'));
  assert.ok(nodeText(node).includes('preview.blocks'));
  assert.ok(nodeText(node).includes('preview.switches'));
  assert.ok(nodeText(node).includes('preview.viewPlan'), 'the clear view keeps the expandable plan');
  assert.equal(nodeText(node).includes('preview.runtimeHint'), false, 'no runtime hint outside Minimal');
  for (const key of [
    'preview.block.intro',
    'preview.block.budget',
    'preview.block.runtime',
    'preview.block.instructions',
    'preview.block.plan',
  ]) {
    assert.ok(nodeText(node).includes(key), `preview lists ${key}`);
  }
  assert.ok(nodeText(node).includes('preview.instructionCount'));
  assert.ok(nodeText(node).includes('preview.total'));
  assert.ok(nodeText(node).includes('preview.approxTokens'));
  assert.ok(nodeText(node).includes('clear.modelHint'));

  const excluded = (nodeText(node).match(/preview\.excluded/g) ?? []).length;
  assert.equal(excluded, 1, 'only the runtime block is excluded for a non-Minimal preset');

  const checkboxes = findElements(node, (child) => child !== null && child.type === ui.Checkbox);
  assert.equal(checkboxes.length, 3);
  assert.deepEqual(checkboxes.map((checkbox) => checkbox.props.label), [
    'preview.switchBudget',
    'preview.switchInstructions',
    'preview.switchMinimal',
  ]);
  assert.equal(checkboxes[0].props.checked, true);
  assert.equal(checkboxes[1].props.checked, true);
  assert.equal(checkboxes[2].props.disabled, true);
  assert.equal(checkboxes[2].props.hint, 'preview.minimalSwitchHint');

  checkboxes[0].props.onChange(false);
  node = dialog.render(props);
  assert.equal(findCheckbox(node, 'preview.switchBudget').props.checked, false);

  const confirm = findUiButton(node, 'clear.confirm');
  assert.equal(confirm.props.disabled, false);
  await confirm.props.onClick();
  assert.equal(calls.fresh.length, 1);
  const callsArgs = calls.fresh[0];
  assert.deepEqual(callsArgs.instructions, ['do X', 'do Y']);
  assert.deepEqual(callsArgs.switches, {
    unlimitedBudget: false,
    includeOriginalInstructions: true,
    includeMinimalContext: true,
  });
  assert.equal(typeof callsArgs.stillPending, 'function');
  assert.equal(callsArgs.stillPending(), true);
  assert.equal(Object.prototype.hasOwnProperty.call(callsArgs, 'runtimeFacts'), false, 'execution re-reads runtime facts');
});

test('the clear view disables confirm while instructions load and localizes a missing read', async () => {
  const read = deferred();
  const { actions } = createActions({
    readPlanModeInstructions: () => read.promise,
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => {} });
  let node = dialog.render(props);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  node = dialog.render(props);
  assert.ok(nodeText(node).includes('preview.loadingInstructions'));
  assert.equal(findUiButton(node, 'clear.confirm').props.disabled, true);

  read.resolve({ texts: [], found: false, kind: undefined, pagesLoaded: 0 });
  await flush();
  node = dialog.render(props);
  assert.ok(nodeText(node).includes('preview.instructionsUnavailable'));
  assert.equal(findUiButton(node, 'clear.confirm').props.disabled, false);
  const excluded = (nodeText(node).match(/preview\.excluded/g) ?? []).length;
  assert.equal(excluded, 2, 'runtime and instructions blocks are excluded');
});

test('a rejected instruction read degrades to the unavailable copy', async () => {
  const { actions } = createActions({
    readPlanModeInstructions: async () => {
      throw new Error('no session binding');
    },
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => {} });
  let node = dialog.render(props);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = dialog.render(props);
  assert.ok(nodeText(node).includes('preview.instructionsUnavailable'));
  assert.equal(findUiButton(node, 'clear.confirm').props.disabled, false);
});

test('the clear view keeps the instructions switch off until the user turns it on', async () => {
  let reads = 0;
  const { actions } = createActions({
    readPlanModeInstructions: async () => {
      reads += 1;
      return { texts: ['do X'], found: true, kind: 'plan-mode', pagesLoaded: 0 };
    },
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({
    actions,
    onClose: () => {},
    readPromptSwitches: () => ({ unlimitedBudget: true, includeOriginalInstructions: false, includeMinimalContext: true }),
  });
  let node = dialog.render(props);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  node = dialog.render(props);
  assert.equal(reads, 0, 'no read while the switch is off');
  assert.ok(nodeText(node).includes('preview.noInstructions'));
  assert.equal(findUiButton(node, 'clear.confirm').props.disabled, false);

  findCheckbox(node, 'preview.switchInstructions').props.onChange(true);
  await flush();
  node = dialog.render(props);
  assert.equal(reads, 1, 'turning the switch on reads the instructions');
  assert.ok(nodeText(node).includes('preview.instructionCount'));
});

test('the clear view gates confirm on the model-directory state', async () => {
  const loading = createActions();
  const loadingDialog = mount(panel.ExecutionDialog);
  let loadingProps = hostProps({
    actions: loading.actions,
    directory: createDirectory({ ...readyDirectoryState(), status: 'loading' }),
    onClose: () => {},
  });
  let node = loadingDialog.render(loadingProps);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = loadingDialog.render(loadingProps);
  assert.equal(findUiButton(node, 'clear.confirm').props.disabled, true);
  assert.ok(nodeText(node).includes('panel.modelDirectoryLoading'));

  const errorActions = createActions();
  const errorDialog = mount(panel.ExecutionDialog);
  const errorProps = hostProps({
    actions: errorActions.actions,
    directory: createDirectory({ ...readyDirectoryState(), status: 'error', error: 'boom' }),
    onClose: () => {},
  });
  node = errorDialog.render(errorProps);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = errorDialog.render(errorProps);
  assert.equal(findUiButton(node, 'clear.confirm').props.disabled, false);
  assert.ok(nodeText(node).includes('panel.modelDirectoryError'));

  const idleActions = createActions();
  const idleDialog = mount(panel.ExecutionDialog);
  const idleProps = hostProps({
    actions: idleActions.actions,
    directory: createDirectory({ ...readyDirectoryState(), status: 'idle' }),
    onClose: () => {},
  });
  node = idleDialog.render(idleProps);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = idleDialog.render(idleProps);
  assert.equal(findUiButton(node, 'clear.confirm').props.disabled, true);
  assert.ok(nodeText(node).includes('panel.modelDirectoryLoading'));
});

test('the clear view includes runtime context only with the Minimal preset', async () => {
  const { actions } = createActions({
    readPlanModeInstructions: async () => ({ texts: [], found: false, kind: undefined, pagesLoaded: 0 }),
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, currentPreset: 'minimal', onClose: () => {} });
  let node = dialog.render(props);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = dialog.render(props);
  assert.ok(nodeText(node).includes('preview.runtimeHint'));
  assert.equal(findCheckbox(node, 'preview.switchMinimal').props.disabled, false);
  assert.equal(findCheckbox(node, 'preview.switchMinimal').props.hint, undefined);
  const excluded = (nodeText(node).match(/preview\.excluded/g) ?? []).length;
  assert.equal(excluded, 1, 'only the unavailable instructions block is excluded');
});

test('the clear view warns when the first message is oversized', async () => {
  const { actions } = createActions({
    readPlanModeInstructions: async () => ({
      texts: ['x'.repeat(40000)],
      found: true,
      kind: 'plan-mode',
      pagesLoaded: 0,
    }),
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => {} });
  let node = dialog.render(props);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = dialog.render(props);
  assert.ok(nodeText(node).includes('preview.oversized'));
});

test('a createFreshExecution cleanup error surfaces as an error and a warning', async () => {
  const failure = Object.assign(new Error('prompt failed'), { cleanupError: 'archive failed' });
  const { actions } = createActions({
    createFreshExecution: async () => {
      throw failure;
    },
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => {} });
  let node = dialog.render(props);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = dialog.render(props);
  await findUiButton(node, 'clear.confirm').props.onClick();
  node = dialog.render(props);
  const errors = findElements(node, (child) => child !== null && child.type === ui.ErrorText);
  const warnings = findElements(node, (child) => child !== null && child.type === ui.WarningText);
  assert.ok(errors.some((error) => nodeText(error).includes('error.freshFailed')));
  assert.ok(warnings.some((warning) => nodeText(warning).includes('error.cleanupFailed')));
});

test('a known ActionError code is localized through describeActionError', async () => {
  const failure = Object.assign(new Error('selectModel RPC failed'), { code: 'modelApplyFailed' });
  const { actions } = createActions({
    createFreshExecution: async () => {
      throw failure;
    },
  });
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => {} });
  let node = dialog.render(props);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = dialog.render(props);
  await findUiButton(node, 'clear.confirm').props.onClick();
  node = dialog.render(props);
  const error = findByType(node, ui.ErrorText);
  assert.ok(error);
  assert.ok(nodeText(error).includes('error.modelApplyFailed'));
});

test('an empty plan degrades without throwing in the root and clear views', async () => {
  const { actions } = createActions();
  const props = hostProps({
    actions,
    review: { id: 'plan-review', approve: { label: 'Approve' }, question: 'Q?', plan: '' },
    onClose: () => {},
  });
  let node = panel.ExecutionDialog(props);
  assert.ok(node);
  assert.equal(findUiButton(node, 'preview.viewPlan'), undefined, 'no expandable plan for empty text');

  const dialog = mount(panel.ExecutionDialog);
  node = dialog.render(props);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = dialog.render(props);
  assert.ok(findUiButton(node, 'clear.confirm'));
});

test('the back button returns from the clear view to the root rows', async () => {
  const { actions } = createActions();
  const dialog = mount(panel.ExecutionDialog);
  const props = hostProps({ actions, onClose: () => {} });
  let node = dialog.render(props);
  findActionRow(node, 'panel.actions.clear.title').props.onClick();
  await flush();
  node = dialog.render(props);
  const back = findElements(node, (child) => child !== null && child.type === ui.IconButton && child.props?.label === 'panel.back')[0];
  assert.ok(back);
  back.props.onClick();
  node = dialog.render(props);
  assert.ok(findActionRow(node, 'panel.actions.execute.title'));
  assert.equal(findUiButton(node, 'clear.confirm'), undefined);
});

test('Checkbox renders a native checkbox inside its label', () => {
  const changes = [];
  const element = ui.Checkbox({
    label: 'Include',
    checked: true,
    disabled: false,
    hint: 'Only with Minimal',
    onChange: (checked) => changes.push(checked),
  });
  assert.equal(element.type, 'label');
  assert.ok(element.props.className.includes('gp-check'));
  const input = findElements(element, (child) => child !== null && child.type === 'input')[0];
  assert.equal(input.props.type, 'checkbox');
  assert.equal(input.props.checked, true);
  assert.equal(input.props.disabled, false);
  input.props.onChange({ target: { checked: false } });
  assert.deepEqual(changes, [false]);
  assert.ok(nodeText(element).includes('Only with Minimal'));
});

test('ListRow exposes radio semantics when asked and aria-pressed otherwise', () => {
  const radio = ui.ListRow({ title: 'Model', role: 'radio', checked: true, selected: true });
  assert.equal(radio.type, 'button');
  assert.equal(radio.props.role, 'radio');
  assert.equal(radio.props['aria-checked'], true);
  assert.equal(radio.props['aria-pressed'], undefined);

  const pressed = ui.ListRow({ title: 'Model', selected: true });
  assert.equal(pressed.props['aria-pressed'], true);
  assert.equal(pressed.props['aria-checked'], undefined);
  assert.equal(pressed.props.role, undefined);
});

test('SelectRow, StaticRow and GroupHeading expose titles and optional roles', () => {
  const select = ui.SelectRow({ label: 'Model', value: 'DeepSeek Flash · Max' });
  const selectValue = findElements(select, (child) => child !== null && child.props?.className === 'gp-row-value')[0];
  assert.equal(selectValue.props.title, 'DeepSeek Flash · Max');

  const staticRow = ui.StaticRow({ label: 'Title', value: 'Long title text' });
  const staticValue = findElements(staticRow, (child) => child !== null && child.props?.className === 'gp-static-value')[0];
  assert.equal(staticValue.props.title, 'Long title text');
  assert.equal(staticValue.props.title, 'Long title text');

  const heading = ui.GroupHeading({ children: 'Provider', role: 'presentation' });
  assert.equal(heading.props.role, 'presentation');
});

test('Dialog marks itself busy and WarningBox is announced', () => {
  const dialog = ui.Dialog({ open: true, busy: true, onRequestClose: () => {}, labelledBy: 'x', children: null });
  const dialogNode = dialog.children[1];
  assert.equal(dialogNode.props.role, 'dialog');
  assert.equal(dialogNode.props['aria-busy'], 'true');

  const idle = ui.Dialog({ open: true, onRequestClose: () => {}, labelledBy: 'x', children: null });
  assert.equal(idle.children[1].props['aria-busy'], undefined);

  const warning = ui.WarningBox({ children: 'warning' });
  assert.equal(warning.props.role, 'status');
});

test('a blocked Escape is consumed and never closes the dialog', () => {
  function eventOf(key) {
    return {
      key,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
    };
  }
  let closed = 0;
  const blocked = eventOf('Escape');
  ui.handleDialogKeyDown(blocked, { blocked: true, onClose: () => { closed += 1; }, panel: null });
  assert.equal(blocked.defaultPrevented, true);
  assert.equal(blocked.propagationStopped, true);
  assert.equal(closed, 0, 'blocked Escape must not close');

  const idle = eventOf('Escape');
  ui.handleDialogKeyDown(idle, { blocked: false, onClose: () => { closed += 1; }, panel: null });
  assert.equal(idle.defaultPrevented, true);
  assert.equal(idle.propagationStopped, true);
  assert.equal(closed, 1);
});

function renderSettingsSection(form, t) {
  const settings = modules['client.settings.js'];
  const section = settings.GreatPlanSection({ form, t });
  if (section !== null && typeof section === 'object' && typeof section.type === 'function') {
    return section.type(section.props);
  }
  return section;
}

test('GreatPlanSection renders all four accessible switches and reflects the config', () => {
  const snapshot = {
    status: 'ready',
    value: {
      injectBrainstormingPrompt: true,
      injectUnlimitedBudgetPrompt: true,
      includeOriginalUserInstructions: true,
      includeMinimalRuntimeContext: true,
    },
    writable: true,
  };
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
  };
  const node = renderSettingsSection(form, (key) => key);
  const toggles = findElements(node, (child) => child.props?.role === 'switch');
  assert.equal(toggles.length, 4, 'all four switches must render');
  for (const toggle of toggles) {
    assert.equal(toggle.type, 'button');
    assert.equal(toggle.props['aria-checked'], true);
    assert.equal(toggle.props.disabled, false);
  }
  assert.deepEqual(toggles.map((toggle) => toggle.props['aria-label']), [
    'settings.brainstorm.title',
    'settings.budget.title',
    'settings.originalInstructions.title',
    'settings.minimalContext.title',
  ]);

  const readers = modules['client.settings.js'];
  assert.equal(readers.readBrainstormingValue({ status: 'ready', value: { injectBrainstormingPrompt: false } }), false);
  assert.equal(readers.readBrainstormingValue({ status: 'ready', value: {} }), true);
  assert.equal(readers.readBudgetValue({ status: 'ready', value: { injectUnlimitedBudgetPrompt: false } }), false);
  assert.equal(readers.readBudgetValue({ status: 'ready', value: {} }), true);
  assert.equal(readers.readOriginalInstructionsValue({ status: 'ready', value: { includeOriginalUserInstructions: false } }), false);
  assert.equal(readers.readOriginalInstructionsValue({ status: 'ready', value: {} }), true);
  assert.equal(readers.readMinimalContextValue({ status: 'ready', value: { includeMinimalRuntimeContext: false } }), false);
  assert.equal(readers.readMinimalContextValue({ status: 'ready', value: {} }), true);
});

test('GreatPlanSection shows the unavailable copy when no form is supplied', () => {
  const section = modules['client.settings.js'].GreatPlanSection({ form: undefined, t: (key) => key });
  assert.ok(nodeText(section).includes('settings.unavailable'));
  assert.equal(findElements(section, (child) => child.props?.role === 'switch').length, 0);
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

test('readFreshPromptSwitches reads all three fresh-session switches from one snapshot', () => {
  const readFreshPromptSwitches = modules['client.settings.js'].readFreshPromptSwitches;
  const formOf = (snapshot) => ({ get: () => ({ getSnapshot: () => snapshot }) });
  const allOn = { unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: true };
  const allOff = { unlimitedBudget: false, includeOriginalInstructions: false, includeMinimalContext: false };

  assert.deepEqual(readFreshPromptSwitches(undefined), allOn);
  assert.deepEqual(readFreshPromptSwitches(formOf({ status: 'loading', value: undefined })), allOn);
  assert.deepEqual(readFreshPromptSwitches(formOf({ status: 'ready', value: {} })), allOn);
  assert.deepEqual(readFreshPromptSwitches(formOf({
    status: 'ready',
    value: {
      injectUnlimitedBudgetPrompt: false,
      includeOriginalUserInstructions: false,
      includeMinimalRuntimeContext: false,
    },
  })), allOff);
  assert.deepEqual(readFreshPromptSwitches({ get: () => { throw new Error('no form'); } }), allOn);
});

test('GreatPlanSection hides the switches while the form is loading', () => {
  const form = {
    getSnapshot: () => ({ status: 'loading', value: undefined, writable: false }),
    subscribe: () => () => {},
    set: async () => true,
  };
  const node = renderSettingsSection(form, (key) => key);
  assert.equal(findElements(node, (child) => child.props?.role === 'switch').length, 0);
});
