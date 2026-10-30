import assert from 'node:assert/strict';
import test from 'node:test';

/*
 * Structures-only tests for the model directory chunk: the pure filter, the
 * model list (search input, radiogroup semantics, empty/error paths), and the
 * effort list (provider-default row always present). Fake React hooks keep the
 * search state mutable between direct render calls; a recording fake `ui`
 * exposes the props the chunk passes to the host primitives, so the assertions
 * do not depend on the real `client.ui.js` (covered by client-render.test.js).
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

/** Hook state for direct render calls: reset the index (and optionally the values). */
let hookIndex = 0;
let hookState = {};

function resetHooks(preserveState = false) {
  hookIndex = 0;
  if (preserveState === false) hookState = {};
}

const fakeReact = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState: (initial) => {
    const index = hookIndex;
    hookIndex += 1;
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
    return [hookState[index], (next) => {
      hookState[index] = typeof next === 'function' ? next(hookState[index]) : next;
    }];
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (compute) => compute(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

/*
 * Recording host primitives: they are intrinsic tags in the fake element tree,
 * so the assertions inspect the exact props the chunk passes (role/checked/
 * titles/onClick) without depending on client.ui.js.
 */
const fakeUi = {
  cx: (...parts) => parts.filter(Boolean).join(' '),
  messageOf: (error) => (error instanceof Error ? error.message : String(error)),
  useStore: (store) => store.getSnapshot(),
  ListRow: 'mock-list-row',
  SelectRow: 'mock-select-row',
  GroupHeading: 'mock-group-heading',
  Note: 'mock-note',
  ErrorText: 'mock-error',
  Button: 'mock-button',
  Loading: 'mock-loading',
};

await import('../client.model.js');
const registration = registry.get('client.model.js');
assert.equal(registration.id, '@local/dsh-great-plan');

const model = registration.factory((spec) => {
  if (spec === 'react') return fakeReact;
  if (spec === '@local/dsh-great-plan/client.ui.js') return fakeUi;
  throw new Error(`unexpected require: ${spec}`);
});

const t = (key) => key;

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

function rowsOf(node) {
  return findElements(node, (child) => child.type === 'mock-list-row');
}

function radiosOf(node) {
  return rowsOf(node).map((row) => ({
    title: row.props.title,
    checked: row.props.checked,
    selected: row.props.selected,
    disabled: row.props.disabled,
    role: row.props.role,
  }));
}

function createGroup(id, name, models) {
  return { id, name, models };
}

function createModel(id, name, reasoning) {
  return { id, name, ...reasoning === undefined ? {} : { reasoning } };
}

const ROUTE_REASONING = {
  defaultEffort: 'max',
  efforts: [{ id: 'max', name: 'Max' }, { id: 'low', name: 'Low' }],
};

function createState(overrides = {}) {
  return {
    current: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
    groups: [
      createGroup('spring', 'Spring AI', [createModel('spring-1', 'Spring One')]),
      createGroup('deepseek-official', 'DeepSeek Official', [createModel('deepseek-chat', 'DeepSeek Chat')]),
      createGroup('deepseek-account', 'DeepSeek Account', [
        createModel('deepseek-flash', 'DeepSeek Flash', ROUTE_REASONING),
        createModel('deepseek-reasoner', 'DeepSeek Reasoner'),
      ]),
    ],
    status: 'ready',
    pending: null,
    error: null,
    routable: true,
    ...overrides,
  };
}

function renderModelList(state, props = {}, options = {}) {
  resetHooks(options.preserve === true);
  return model.ModelListView({ state, t, disabled: false, onPick: () => {}, onRetry: () => {}, ...props });
}

function renderEffortList(state, props = {}) {
  resetHooks();
  return model.EffortListView({ state, t, disabled: false, onPick: () => {}, ...props });
}

test('the model chunk registers under the package id and keeps its export surface', () => {
  assert.equal(registration.chunk, 'client.model.js');
  for (const name of [
    'useDirectoryState',
    'currentModelOf',
    'reasoningOf',
    'modelNameOf',
    'effortLabelOf',
    'summaryOf',
    'toModelSelection',
    'orderedGroups',
    'providerName',
    'filterModelGroups',
    'ModelRows',
    'ModelListView',
    'EffortListView',
  ]) {
    assert.equal(typeof model[name], 'function', `${name} must stay exported`);
  }
});

test('filterModelGroups returns the input array itself for an empty query', () => {
  const groups = [createGroup('deepseek-account', 'DeepSeek Account', [createModel('deepseek-flash', 'Flash')])];
  assert.equal(model.filterModelGroups(groups, ''), groups);
  assert.equal(model.filterModelGroups(groups, '   '), groups);
  assert.equal(model.filterModelGroups(groups, '\t\n '), groups);
  assert.equal(model.filterModelGroups(groups, undefined), groups);
  assert.equal(model.filterModelGroups(groups, null), groups);
  assert.equal(model.filterModelGroups(groups, 42), groups);
});

test('filterModelGroups matches model ids and names case-insensitively', () => {
  const groups = [
    createGroup('deepseek-account', 'DeepSeek Account', [
      createModel('deepseek-flash', 'DeepSeek Flash'),
      createModel('deepseek-reasoner', 'DeepSeek Reasoner'),
    ]),
    createGroup('spring', 'Spring AI', [createModel('spring-1', 'Spring One')]),
  ];
  const byId = model.filterModelGroups(groups, 'FLASH');
  assert.equal(byId.length, 1);
  assert.equal(byId[0].id, 'deepseek-account');
  assert.deepEqual(byId[0].models.map((entry) => entry.id), ['deepseek-flash']);

  const byName = model.filterModelGroups(groups, 'spring one');
  assert.equal(byName.length, 1);
  assert.equal(byName[0].id, 'spring');
  assert.deepEqual(byName[0].models.map((entry) => entry.id), ['spring-1']);

  const trimmed = model.filterModelGroups(groups, '  flash  ');
  assert.deepEqual(trimmed[0].models.map((entry) => entry.id), ['deepseek-flash']);

  assert.deepEqual(model.filterModelGroups(groups, 'no-such-model'), []);
});

test('filterModelGroups keeps every model of a provider match', () => {
  const groups = [
    createGroup('deepseek-account', 'DeepSeek Account', [
      createModel('deepseek-flash', 'DeepSeek Flash'),
      createModel('deepseek-reasoner', 'DeepSeek Reasoner'),
    ]),
    createGroup('spring', 'Spring AI', [createModel('spring-1', 'Spring One')]),
  ];

  const byProviderId = model.filterModelGroups(groups, 'DEEPSEEK-ACC');
  assert.equal(byProviderId.length, 1);
  assert.equal(byProviderId[0], groups[0], 'a provider match keeps the group object');
  assert.equal(byProviderId[0].models.length, 2);

  const byDisplayName = model.filterModelGroups(groups, 'account');
  assert.equal(byDisplayName.length, 1);
  assert.equal(byDisplayName[0].models.length, 2);

  const byProviderFragment = model.filterModelGroups(groups, 'spring');
  assert.equal(byProviderFragment.length, 1);
  assert.deepEqual(byProviderFragment[0].models.map((entry) => entry.id), ['spring-1']);
});

test('filterModelGroups drops empty groups, preserves order, and does not mutate the input', () => {
  const groups = [
    createGroup('spring', 'Spring AI', [createModel('spring-1', 'Spring One')]),
    createGroup('empty-provider', 'Empty Provider', []),
    createGroup('deepseek-official', 'DeepSeek Official', [createModel('deepseek-chat', 'DeepSeek Chat')]),
    createGroup('deepseek-account', 'DeepSeek Account', [createModel('deepseek-flash', 'DeepSeek Flash')]),
    createGroup('undefined-models', 'No Models', undefined),
  ];
  const beforeIds = groups.map((group) => group.id);
  const beforeModels = groups.map((group) => group.models);
  const filtered = model.filterModelGroups(groups, 'deepseek');
  assert.deepEqual(filtered.map((group) => group.id), ['deepseek-official', 'deepseek-account']);
  assert.deepEqual(groups.map((group) => group.id), beforeIds);
  for (const index of groups.keys()) {
    assert.equal(groups[index].models, beforeModels[index], 'the input groups must not be mutated');
  }

  const whole = model.filterModelGroups(groups, '');
  assert.equal(whole.length, 5, 'the unfiltered path keeps the empty groups');

  const providerOnly = model.filterModelGroups(groups, 'no models');
  assert.deepEqual(providerOnly, [], 'a provider match without models is still dropped');
});

test('filterModelGroups matches a provider and a model from different groups without reordering', () => {
  const groups = [
    createGroup('spring', 'Spring AI', [createModel('spring-1', 'Spring One')]),
    createGroup('deepseek-account', 'DeepSeek Account', [createModel('deepseek-flash', 'DeepSeek Flash')]),
    createGroup('deepseek-official', 'DeepSeek Official', [
      createModel('deepseek-chat', 'DeepSeek Chat'),
      createModel('other-model', 'Other'),
    ]),
  ];
  const filtered = model.filterModelGroups(groups, 'deepseek');
  assert.deepEqual(filtered.map((group) => group.id), ['deepseek-account', 'deepseek-official']);
  assert.deepEqual(filtered[0].models.map((entry) => entry.id), ['deepseek-flash']);
  assert.equal(filtered[1], groups[2], 'a provider match keeps all models');
});

test('ModelListView renders a search input and a model radiogroup over the ordered catalog', () => {
  const calls = [];
  const node = renderModelList(createState(), { onPick: (group, entry) => calls.push([group.id, entry.id]) });

  const inputs = findElements(node, (child) => child.type === 'input');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].props.type, 'search');
  assert.equal(inputs[0].props.className, 'gp-search');
  assert.equal(inputs[0].props.placeholder, 'panel.searchModels');
  assert.equal(inputs[0].props['aria-label'], 'panel.searchModels');
  assert.equal(inputs[0].props.value, '');

  const groups = findElements(node, (child) => child.props?.role === 'radiogroup');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].props['aria-label'], 'panel.model');

  const headings = findElements(node, (child) => child.type === 'mock-group-heading');
  assert.deepEqual(headings.map(textContent), [
    'model.accountProvider',
    'DeepSeek Official',
    'Spring AI',
  ]);
  for (const heading of headings) assert.equal(heading.props.role, 'presentation');

  const radios = radiosOf(node);
  assert.deepEqual(radios.map((radio) => radio.title), [
    'DeepSeek Flash',
    'DeepSeek Reasoner',
    'DeepSeek Chat',
    'Spring One',
  ]);
  for (const radio of radios) {
    assert.equal(radio.role, 'radio');
    assert.equal(radio.disabled, false);
  }
  assert.deepEqual(radios.map((radio) => radio.checked), [true, false, false, false]);
  assert.deepEqual(radios.map((radio) => radio.selected), [true, false, false, false]);

  findElements(node, (child) => child.type === 'mock-list-row')[0].props.onClick();
  assert.deepEqual(calls, [['deepseek-account', 'deepseek-flash']]);
});

test('ModelListView filters by the search query and restores on clear', () => {
  const state = createState();
  const picking = [];
  const props = { onPick: (group, entry) => picking.push([group.id, entry.id]) };
  let node = renderModelList(state, props);

  let input = findElements(node, (child) => child.type === 'input')[0];
  input.props.onChange({ target: { value: 'flash' } });
  node = renderModelList(state, props, { preserve: true });
  assert.deepEqual(radiosOf(node).map((radio) => radio.title), ['DeepSeek Flash']);
  assert.equal(findElements(node, (child) => child.props?.role === 'radiogroup').length, 1);

  input = findElements(node, (child) => child.type === 'input')[0];
  input.props.onChange({ target: { value: 'ACCOUNT' } });
  node = renderModelList(state, props, { preserve: true });
  assert.deepEqual(radiosOf(node).map((radio) => radio.title), ['DeepSeek Flash', 'DeepSeek Reasoner']);

  input = findElements(node, (child) => child.type === 'input')[0];
  input.props.onChange({ target: { value: '   ' } });
  node = renderModelList(state, props, { preserve: true });
  assert.equal(radiosOf(node).length, 4, 'a whitespace-only query restores the whole catalog');

  input = findElements(node, (child) => child.type === 'input')[0];
  input.props.onChange({ target: { value: '' } });
  node = renderModelList(state, props, { preserve: true });
  assert.equal(radiosOf(node).length, 4);

  findElements(node, (child) => child.type === 'mock-list-row')[3].props.onClick();
  assert.deepEqual(picking, [['spring', 'spring-1']]);
});

test('ModelListView shows the no-matches note when the query yields nothing', () => {
  const state = createState();
  const node = renderModelList(state);
  const input = findElements(node, (child) => child.type === 'input')[0];
  input.props.onChange({ target: { value: 'zzzz' } });
  const filtered = renderModelList(state, {}, { preserve: true });

  assert.equal(findElements(filtered, (child) => child.props?.role === 'radiogroup').length, 0);
  assert.equal(radiosOf(filtered).length, 0);
  const notes = findElements(filtered, (child) => child.type === 'mock-note');
  assert.deepEqual(notes.map(textContent), ['panel.noMatches']);
  assert.equal(findElements(filtered, (child) => child.type === 'input').length, 1, 'the search input stays');
});

test('ModelListView keeps the loading, empty, and error catalog paths', () => {
  const loading = renderModelList(createState({ groups: [], status: 'loading' }));
  assert.equal(radiosOf(loading).length, 0);
  assert.equal(textContent(loading), 'panel.loading');
  assert.equal(findElements(loading, (child) => child.type === 'mock-loading').length, 1);

  const idle = renderModelList(createState({ groups: [], status: 'idle' }));
  assert.equal(findElements(idle, (child) => child.type === 'mock-loading').length, 1);

  const empty = renderModelList(createState({ groups: [], status: 'ready' }));
  assert.equal(textContent(empty), 'panel.modelEmpty');

  let retried = 0;
  const error = renderModelList(createState({ groups: [], status: 'error', error: 'boom' }), { onRetry: () => { retried += 1; } });
  assert.ok(findElements(error, (child) => child.type === 'mock-error').length >= 1);
  const retry = findElements(error, (child) => child.type === 'mock-button');
  assert.equal(retry.length, 1);
  retry[0].props.onClick();
  assert.equal(retried, 1);
  assert.equal(findElements(error, (child) => child.type === 'input').length, 0);

  const stale = renderModelList(createState({ status: 'error', error: 'boom' }));
  assert.equal(radiosOf(stale).length, 4, 'stale groups stay selectable while the error is shown');
  assert.ok(findElements(stale, (child) => child.type === 'mock-error').length >= 1);
});

test('ModelListView disables rows while busy or selecting', () => {
  const disabled = radiosOf(renderModelList(createState(), { disabled: true }));
  assert.deepEqual(disabled.filter((radio) => radio.disabled !== true), []);

  const selecting = radiosOf(renderModelList(createState({ status: 'selecting' })));
  assert.deepEqual(selecting.filter((radio) => radio.disabled !== true), []);
});

test('EffortListView always lists the provider-default row and selects it when no effort is set', () => {
  const state = createState({
    current: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: undefined },
  });
  const node = renderEffortList(state);

  const groups = findElements(node, (child) => child.props?.role === 'radiogroup');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].props['aria-label'], 'panel.effort');

  const radios = radiosOf(node);
  assert.deepEqual(radios.map((radio) => radio.title), ['panel.providerDefault', 'Max', 'Low']);
  assert.deepEqual(radios.map((radio) => radio.checked), [true, false, false]);
  for (const radio of radios) assert.equal(radio.role, 'radio');
});

test('EffortListView selects the explicit effort and reports undefined for the provider default', () => {
  const state = createState();
  const picks = [];
  const node = renderEffortList(state, { onPick: (id) => picks.push(id) });
  const radios = radiosOf(node);
  assert.deepEqual(radios.map((radio) => radio.checked), [false, true, false]);

  findElements(node, (child) => child.type === 'mock-list-row')[0].props.onClick();
  findElements(node, (child) => child.type === 'mock-list-row')[2].props.onClick();
  assert.deepEqual(picks, [undefined, 'low']);

  const low = renderEffortList(createState({
    current: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
  }));
  assert.deepEqual(radiosOf(low).map((radio) => radio.checked), [false, false, true]);
});

test('EffortListView keeps the select-model/no-effort notes and the default-only catalog', () => {
  assert.equal(textContent(renderEffortList(createState({ current: null }))), 'panel.selectModelFirst');
  assert.equal(textContent(renderEffortList(createState({ current: undefined }))), 'panel.selectModelFirst');

  const noReasoning = renderEffortList(createState({
    groups: [createGroup('deepseek-account', 'DeepSeek Account', [createModel('deepseek-flash', 'DeepSeek Flash')])],
  }));
  assert.equal(textContent(noReasoning), 'panel.noEffort');

  const defaultOnly = renderEffortList(createState({
    current: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: undefined },
    groups: [createGroup('deepseek-account', 'DeepSeek Account', [
      createModel('deepseek-flash', 'DeepSeek Flash', { efforts: [] }),
    ])],
  }));
  const radios = radiosOf(defaultOnly);
  assert.equal(radios.length, 1);
  assert.equal(radios[0].title, 'panel.providerDefault');
  assert.equal(radios[0].checked, true);
});

test('EffortListView disables rows while busy or selecting', () => {
  const disabled = radiosOf(renderEffortList(createState(), { disabled: true }));
  assert.deepEqual(disabled.filter((radio) => radio.disabled !== true), []);

  const selecting = radiosOf(renderEffortList(createState({ status: 'selecting' })));
  assert.deepEqual(selecting.filter((radio) => radio.disabled !== true), []);
});

test('the preserved model helpers keep their labels and summaries', () => {
  const state = createState();
  assert.equal(model.modelNameOf(state, t), 'DeepSeek Flash');
  assert.equal(model.effortLabelOf(state, t), 'Max');
  assert.equal(model.summaryOf(state, t), 'DeepSeek Flash · Max');
  assert.deepEqual(model.reasoningOf(state), ROUTE_REASONING);
  assert.deepEqual(model.toModelSelection(state.current), {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  });
  assert.deepEqual(model.toModelSelection({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
  assert.equal(model.toModelSelection(undefined), undefined);

  const noGroups = createState({ current: { provider: 'unknown', model: 'mystery-model' } });
  assert.equal(model.modelNameOf(noGroups, t), 'mystery-model');
  assert.equal(model.effortLabelOf(noGroups, t), undefined);
  assert.equal(model.summaryOf(noGroups, t), 'mystery-model');
  assert.equal(model.modelNameOf(createState({ current: null, status: 'loading' }), t), 'panel.loading');
  assert.equal(model.modelNameOf(createState({ current: null, status: 'ready' }), t), 'panel.selectModel');

  assert.deepEqual(model.orderedGroups(createState().groups).map((group) => group.id), [
    'deepseek-account',
    'deepseek-official',
    'spring',
  ]);
  const byId = Object.fromEntries(model.orderedGroups(createState().groups).map((group) => [group.id, group]));
  assert.equal(model.providerName(byId['deepseek-account'], t), 'model.accountProvider');
  assert.equal(model.providerName(byId['deepseek-official'], t), 'DeepSeek Official');
  assert.equal(model.providerName({ id: 'custom', name: 'Custom Provider' }, t), 'Custom Provider');

  const current = model.currentModelOf(state);
  assert.equal(current.group.id, 'deepseek-account');
  assert.equal(current.model.id, 'deepseek-flash');
  assert.equal(model.currentModelOf(createState({ current: null })), undefined);
});

test('ModelRows renders the model row, the effort row only with reasoning metadata, and the retry path', () => {
  const state = createState();
  const node = model.ModelRows({
    state,
    t,
    disabled: false,
    onOpenModel: () => {},
    onOpenEffort: () => {},
    onRetry: () => {},
  });
  const rows = findElements(node, (child) => child.type === 'mock-select-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].props.value, 'DeepSeek Flash');
  assert.equal(rows[1].props.value, 'Max');

  const withoutReasoning = model.ModelRows({
    state: createState({
      groups: [createGroup('deepseek-account', 'DeepSeek Account', [createModel('deepseek-flash', 'DeepSeek Flash')])],
    }),
    t,
    disabled: false,
    onOpenModel: () => {},
    onOpenEffort: () => {},
    onRetry: () => {},
  });
  assert.equal(findElements(withoutReasoning, (child) => child.type === 'mock-select-row').length, 1);

  const selecting = model.ModelRows({ state: createState({ status: 'selecting' }), t, disabled: false, onOpenModel: () => {}, onOpenEffort: () => {}, onRetry: () => {} });
  const selectingRows = findElements(selecting, (child) => child.type === 'mock-select-row');
  assert.deepEqual(selectingRows.map((row) => row.props.disabled), [true, true]);

  const error = model.ModelRows({ state: createState({ status: 'error', error: 'boom' }), t, disabled: false, onOpenModel: () => {}, onOpenEffort: () => {}, onRetry: () => {} });
  assert.ok(findElements(error, (child) => child.type === 'mock-error').length >= 1);
  assert.equal(findElements(error, (child) => child.type === 'mock-button').length, 1);
});

/*
 * The agent-preset list is the sibling selection surface of the same
 * workstream: it now exposes radiogroup/radio semantics while keeping the
 * loading/error/unavailable/retry states.
 */
await import('../client.preset.js');
const presetRegistration = registry.get('client.preset.js');

const preset = presetRegistration.factory((spec) => {
  if (spec === 'react') return fakeReact;
  if (spec === '@local/dsh-great-plan/client.ui.js') return fakeUi;
  throw new Error(`unexpected require: ${spec}`);
});

function renderPresetOptions(state, props = {}) {
  resetHooks();
  return preset.PresetOptions({ state, t, selectedId: undefined, onPick: () => {}, onRetry: () => {}, ...props });
}

test('the preset chunk registers and keeps its export surface', () => {
  assert.equal(presetRegistration.id, '@local/dsh-great-plan');
  assert.equal(presetRegistration.chunk, 'client.preset.js');
  for (const name of ['createPresetStore', 'usePresetState', 'presetDisplay', 'presetDescription', 'defaultPresetId', 'PresetOptions']) {
    assert.equal(typeof preset[name], 'function', `${name} must stay exported`);
  }
});

test('PresetOptions renders a preset radiogroup with the selected row', () => {
  const picks = [];
  const state = {
    status: 'ready',
    error: null,
    options: [
      { id: 'standard', name: 'Standard', description: 'Standard description', isDefault: true },
      { id: 'minimal', name: '', description: '' },
    ],
  };
  const node = renderPresetOptions(state, { selectedId: 'minimal', onPick: (id) => picks.push(id) });

  const groups = findElements(node, (child) => child.props?.role === 'radiogroup');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].props['aria-label'], 'preset.title');

  const radios = radiosOf(node);
  assert.deepEqual(radios.map((radio) => radio.title), ['Standard', 'preset.minimal']);
  assert.deepEqual(radios.map((radio) => radio.checked), [false, true]);
  assert.deepEqual(radios.map((radio) => radio.selected), [false, true]);
  for (const radio of radios) {
    assert.equal(radio.role, 'radio');
    assert.equal(radio.disabled, undefined);
  }
  const descriptions = findElements(node, (child) => typeof child.props?.description === 'string');
  assert.deepEqual(descriptions.map((row) => row.props.description), ['Standard description', 'preset.minimalDescription']);

  findElements(node, (child) => child.type === 'mock-list-row')[0].props.onClick();
  assert.deepEqual(picks, ['standard']);
});

test('PresetOptions keeps its loading, unavailable, empty, and retry paths', () => {
  const loading = renderPresetOptions({ status: 'loading', options: [], error: null });
  assert.deepEqual(findElements(loading, (child) => child.type === 'mock-loading').map(textContent), ['preset.loading']);
  assert.equal(findElements(loading, (child) => child.props?.role === 'radiogroup').length, 0);

  const idle = renderPresetOptions({ status: 'idle', options: [], error: null });
  assert.equal(findElements(idle, (child) => child.props?.role === 'radiogroup').length, 0);

  const unavailable = renderPresetOptions({ status: 'unavailable', options: [], error: null });
  assert.deepEqual(findElements(unavailable, (child) => child.type === 'mock-note').map(textContent), ['preset.unavailable']);

  const empty = renderPresetOptions({ status: 'ready', options: [], error: null });
  assert.deepEqual(findElements(empty, (child) => child.type === 'mock-note').map(textContent), ['preset.unavailable']);

  let retried = 0;
  const error = renderPresetOptions(
    { status: 'error', options: [], error: 'boom' },
    { onRetry: () => { retried += 1; } },
  );
  assert.deepEqual(findElements(error, (child) => child.type === 'mock-error').map(textContent), ['preset.error']);
  const retry = findElements(error, (child) => child.type === 'mock-button');
  assert.equal(retry.length, 1);
  retry[0].props.onClick();
  assert.equal(retried, 1);

  const stale = renderPresetOptions(
    { status: 'error', options: [{ id: 'standard', name: 'Standard' }], error: 'boom' },
    { selectedId: 'standard' },
  );
  assert.equal(radiosOf(stale).length, 1);
  assert.equal(radiosOf(stale)[0].checked, true);
  assert.deepEqual(findElements(stale, (child) => child.type === 'mock-error').map(textContent), ['preset.error']);
});

test('the preset label helpers keep their builtin names and default lookup', () => {
  assert.equal(preset.presetDisplay({ id: 'cordis', name: '' }, t), 'preset.cordis');
  assert.equal(preset.presetDisplay({ id: 'custom', name: 'Custom' }, t), 'Custom');
  assert.equal(preset.presetDisplay(undefined, t), '');
  assert.equal(preset.presetDescription({ id: 'minimal', description: '' }, t), 'preset.minimalDescription');
  assert.equal(preset.presetDescription({ id: 'custom', description: 'Custom description' }, t), 'Custom description');
  assert.equal(preset.presetDescription(undefined, t), undefined);
  assert.equal(preset.defaultPresetId({
    options: [{ id: 'standard' }, { id: 'minimal', isDefault: true }],
  }), 'minimal');
  assert.equal(preset.defaultPresetId({ options: [] }), undefined);
});
