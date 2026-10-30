import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAILURES as HOST_FAILURES,
  MESSAGES as HOST_MESSAGES,
  USAGE as HOST_USAGE,
} from '../host/plan-compaction.js';

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

test('buildPlanExecutionPrompt includes the intro, budget reminder, and complete plan', () => {
  const prompt = actions.buildPlanExecutionPrompt('# Plan\n\nDo the work.', (key) => (
    key === 'clear.promptIntro' ? 'INTRO' : key
  ));
  assert.match(prompt, /^INTRO\n\nToken budget: unlimited\./);
  assert.match(prompt, /Do not skimp on tokens/);
  assert.match(prompt, /<approved-plan>\n# Plan\n\nDo the work\.\n<\/approved-plan>$/);
});

test('buildPlanExecutionPrompt omits the budget reminder when the switch is off', () => {
  const prompt = actions.buildPlanExecutionPrompt('# Plan\n\nDo the work.', (key) => (
    key === 'clear.promptIntro' ? 'INTRO' : key
  ), false);
  assert.equal(prompt.includes('Token budget: unlimited'), false);
  assert.match(prompt, /^INTRO\n\n<approved-plan>/);
});

test('the fresh-session budget reminder has the same intent as the plan-mode one', () => {
  assert.match(actions.UNLIMITED_BUDGET_REMINDER, /Token budget: unlimited/);
  assert.match(actions.UNLIMITED_BUDGET_REMINDER, /tool calls/);
  assert.match(actions.UNLIMITED_BUDGET_REMINDER, /keep the final summary concise/);
});

test('buildPlanExecutionPrompt rejects an empty plan', () => {
  assert.throws(() => actions.buildPlanExecutionPrompt('   ', (key) => key), /empty/);
});

function event(type, data, seq = 0) {
  return { type: 'event', event: { type, seq, data } };
}

function userMessage(text, seq, source = { kind: 'user' }) {
  return event('user/message', {
    role: 'user',
    ...source === undefined ? {} : { source },
    content: [{ type: 'text', text }],
  }, seq);
}

function injectedMessage(kind, text, seq) {
  return userMessage(text, seq, { kind });
}

test('collectPlanModeInstructions keeps every real user text after the latest plan-mode marker', () => {
  const entries = [
    userMessage('before plan mode', 1),
    event('plan/mode', { active: true }, 2),
    injectedMessage('runtime-context', 'runtime context', 3),
    userMessage('first instruction', 4),
    injectedMessage('agent-instructions', 'AGENTS.md', 5),
    userMessage('second instruction', 6),
  ];
  const start = actions.findPlanModeStart(entries);
  assert.equal(start.kind, 'plan-mode');
  assert.deepEqual(
    actions.collectPlanModeInstructions(entries, start),
    ['first instruction', 'second instruction'],
  );
});

test('the latest plan-mode marker wins over an earlier plan command', () => {
  const entries = [
    event('command/run', { name: 'plan', args: 'command request' }, 1),
    userMessage('command request', 2),
    userMessage('old plan message', 3),
    event('plan/mode', { active: true }, 4),
    userMessage('current plan message', 5),
  ];
  const start = actions.findPlanModeStart(entries);
  assert.equal(start.kind, 'plan-mode');
  assert.deepEqual(actions.collectPlanModeInstructions(entries, start), ['current plan message']);
});

test('a /plan off command is not treated as a plan-mode start', () => {
  const entries = [
    event('plan/mode', { active: true }, 1),
    userMessage('request', 2),
    event('command/run', { name: 'plan', args: 'off' }, 3),
  ];
  const start = actions.findPlanModeStart(entries);
  assert.equal(start.kind, 'plan-mode');
});

test('a plan command without a following user message falls back to its arguments', () => {
  const entries = [event('command/run', { name: 'plan', args: 'do the work' }, 1)];
  const start = actions.findPlanModeStart(entries);
  assert.equal(start.kind, 'plan-command');
  assert.deepEqual(actions.collectPlanModeInstructions(entries, start), ['do the work']);
});

test('findPlanModeStart leaves the current turn as a separate last-resort marker', () => {
  const entries = [
    event('turn/start', { turn: 1 }, 1),
    userMessage('current text', 2),
  ];
  assert.equal(actions.findPlanModeStart(entries), undefined);
  assert.equal(actions.findTurnStart(entries).kind, 'turn-start');
});

test('without a marker only the latest real user text is used', () => {
  const entries = [
    userMessage('older task', 1),
    injectedMessage('time-context', 'clock', 2),
    userMessage('latest request', 3),
  ];
  assert.deepEqual(actions.collectPlanModeInstructions(entries, undefined), ['latest request']);
});

test('the collector skips empty and attachment-only user messages and legacy messages still count', () => {
  const entries = [
    event('plan/mode', { active: true }, 1),
    event('user/message', { role: 'user', content: [{ type: 'text', text: '   ' }] }, 2),
    event('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', data: 'x' }] }, 3),
    event('user/message', { role: 'user', content: [{ type: 'text', text: 'legacy' }] }, 4),
    event('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }, 5),
  ];
  const start = actions.findPlanModeStart(entries);
  assert.deepEqual(actions.collectPlanModeInstructions(entries, start), ['legacy', 'first\nsecond']);
});

test('readPlanModeInstructions reads the binding and loads older pages until it finds the start', async () => {
  let calls = 0;
  let window = { entries: [], hasMore: true };
  const binding = {
    eventSource: { getSnapshot: () => window },
    session: {
      async loadOlder() {
        calls += 1;
        window = {
          entries: [
            event('plan/mode', { active: true }, 1),
            userMessage('found instruction', 2),
          ],
          hasMore: false,
        };
      },
    },
  };
  const result = await actions.readPlanModeInstructions(
    { sessions: { binding: () => binding } },
    'session-1',
    { maxPages: 1 },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    texts: ['found instruction'],
    found: true,
    kind: 'plan-mode',
    pagesLoaded: 1,
  });
});

test('readPlanModeInstructions loads past a turn start until it finds the plan-mode marker', async () => {
  let calls = 0;
  let window = {
    entries: [
      event('turn/start', { turn: 2 }, 1),
      userMessage('current turn text', 2),
    ],
    hasMore: true,
  };
  const binding = {
    eventSource: { getSnapshot: () => window },
    session: {
      async loadOlder() {
        calls += 1;
        window = {
          entries: [
            event('plan/mode', { active: true }, 0),
            userMessage('earlier plan-mode text', 1),
            event('turn/start', { turn: 2 }, 2),
            userMessage('current turn text', 3),
          ],
          hasMore: false,
        };
      },
    },
  };
  const result = await actions.readPlanModeInstructions(
    { sessions: { binding: () => binding } },
    'session-1',
    { maxPages: 1 },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    texts: ['earlier plan-mode text', 'current turn text'],
    found: true,
    kind: 'plan-mode',
    pagesLoaded: 1,
  });
});

test('readPlanModeInstructions degrades safely without a binding or when loading fails', async () => {
  const empty = { texts: [], found: false, kind: undefined, pagesLoaded: 0 };
  assert.deepEqual(await actions.readPlanModeInstructions({}, 'session-1'), empty);
  assert.deepEqual(await actions.readPlanModeInstructions({ sessions: { binding: () => undefined } }, 'session-1'), empty);

  let calls = 0;
  const failing = {
    eventSource: {
      getSnapshot: () => ({ entries: [userMessage('already loaded', 1)], hasMore: true }),
    },
    session: {
      async loadOlder() {
        calls += 1;
        throw new Error('load failed');
      },
    },
  };
  assert.deepEqual(
    await actions.readPlanModeInstructions({ sessions: { binding: () => failing } }, 'session-1'),
    { texts: ['already loaded'], found: true, kind: undefined, pagesLoaded: 0 },
  );
  assert.equal(calls, 1);

  const throwingSource = {
    eventSource: { getSnapshot() { throw new Error('no window'); } },
    session: {},
  };
  assert.deepEqual(
    await actions.readPlanModeInstructions({ sessions: { binding: () => throwingSource } }, 'session-1'),
    empty,
  );
});

test('buildPlanExecutionPrompt places instructions between the context and the approved plan', () => {
  const t = (key) => {
    if (key === 'clear.promptIntro') return 'INTRO';
    if (key === 'clear.instructionsIntro') return 'INSTRUCTIONS';
    return key;
  };
  const context = '<fresh-session-context>\nWorkspace directory: /tmp\n</fresh-session-context>';
  const prompt = actions.buildPlanExecutionPrompt('# Plan\nDo it.', t, {
    unlimitedBudget: false,
    instructions: ['first', 'second'],
    runtimeContext: context,
  });
  assert.match(prompt, /^INTRO\n\n<fresh-session-context>/);
  assert.match(prompt, /INSTRUCTIONS\n\n<plan-mode-user-instructions>\nfirst\n\n---\n\nsecond\n<\/plan-mode-user-instructions>\n\n<approved-plan>/);
  assert.ok(prompt.indexOf(context) < prompt.indexOf('INSTRUCTIONS'));
  assert.equal(prompt.includes('Token budget: unlimited'), false);
});

test('buildPlanExecutionPrompt omits empty optional blocks', () => {
  const t = (key) => (key === 'clear.promptIntro' ? 'INTRO' : key);
  const prompt = actions.buildPlanExecutionPrompt('# Plan', t, {
    instructions: ['  ', ''],
    runtimeContext: '   ',
  });
  assert.equal(prompt.includes('plan-mode-user-instructions'), false);
  assert.equal(prompt.includes('fresh-session-context'), false);
  assert.match(prompt, /^INTRO\n\nToken budget: unlimited\./);
  assert.match(prompt, /<approved-plan>\n# Plan\n<\/approved-plan>$/);
});

test('composeFreshPrompt includes the minimal runtime context only for the minimal preset', () => {
  const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`);
  const base = {
    plan: '# Plan',
    t,
    instructions: ['original request'],
    workspaceDirectory: '/tmp/project',
    runtimeFacts: { system: 'macOS (MacIntel)', time: '2026-10-27T22:30:00+08:00[Asia/Shanghai]' },
    switches: { unlimitedBudget: false, includeOriginalInstructions: true, includeMinimalContext: true },
  };
  const minimal = actions.composeFreshPrompt({ ...base, presetId: 'minimal' });
  assert.match(minimal, /<fresh-session-context>/);
  assert.match(minimal, /clear\.context\.workspace/);
  assert.match(minimal, /\/tmp\/project/);
  assert.match(minimal, /macOS \(MacIntel\)/);
  assert.match(minimal, /2026-10-27T22:30:00\+08:00\[Asia\/Shanghai\]/);
  assert.match(minimal, /<plan-mode-user-instructions>/);
  assert.match(minimal, /original request/);
  assert.equal(minimal.includes('Token budget: unlimited'), false);

  const standard = actions.composeFreshPrompt({ ...base, presetId: 'standard' });
  assert.equal(standard.includes('<fresh-session-context>'), false);
  assert.match(standard, /original request/);

  const disabled = actions.composeFreshPrompt({
    ...base,
    presetId: 'minimal',
    switches: { unlimitedBudget: false, includeOriginalInstructions: false, includeMinimalContext: false },
  });
  assert.equal(disabled.includes('<fresh-session-context>'), false);
  assert.equal(disabled.includes('<plan-mode-user-instructions>'), false);
  assert.equal(disabled.includes('Token budget: unlimited'), false);
});

test('buildMinimalRuntimeContext localizes fields and always keeps the cleared note', () => {
  const t = (key, params) => `${key}:${JSON.stringify(params ?? {})}`;
  const context = actions.buildMinimalRuntimeContext({
    workspaceDirectory: '/tmp/project',
    system: 'macOS',
    time: '2026-10-27T22:30:00+08:00[Asia/Shanghai]',
  }, t);
  assert.match(context, /^<fresh-session-context>\n/);
  assert.match(context, /clear\.context\.workspace:{"path":"\/tmp\/project"}/);
  assert.match(context, /clear\.context\.system:{"system":"macOS"}/);
  assert.match(context, /clear\.context\.time:{"time":"2026-10-27T22:30:00\+08:00\[Asia\/Shanghai\]"}/);
  assert.match(context, /clear\.context\.cleared:\{\}/);
  assert.match(context, /<\/fresh-session-context>$/);

  const empty = actions.buildMinimalRuntimeContext({}, t);
  assert.equal(empty.includes('clear.context.workspace'), false);
  assert.equal(empty.includes('clear.context.system'), false);
  assert.equal(empty.includes('clear.context.time'), false);
  assert.match(empty, /clear\.context\.cleared/);
});

test('formatTimestamp renders the local wall time, offset, and IANA zone', () => {
  assert.equal(
    actions.formatTimestamp(new Date('2026-10-27T14:30:00.000Z'), 'Asia/Shanghai'),
    '2026-10-27T22:30:00+08:00[Asia/Shanghai]',
  );
  assert.equal(
    actions.formatTimestamp(new Date('2026-10-27T14:30:00.000Z'), 'UTC'),
    '2026-10-27T14:30:00+00:00[UTC]',
  );
  assert.equal(
    actions.formatTimestamp(new Date('2026-10-27T14:30:00.000Z'), 'America/New_York'),
    '2026-10-27T10:30:00-04:00[America/New_York]',
  );
});

test('readSystemName and readRuntimeFacts read the browser safely', () => {
  assert.equal(actions.readSystemName({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }), 'macOS (MacIntel)');
  assert.equal(actions.readSystemName({ platform: 'MacIntel' }), 'MacIntel');
  assert.equal(actions.readSystemName({ userAgent: 'Test Agent' }), 'Test Agent');
  assert.equal(actions.readSystemName({}), undefined);
  assert.equal(actions.readSystemName(null), undefined);

  const facts = actions.readRuntimeFacts({
    nav: { platform: 'MacIntel' },
    now: new Date('2026-10-27T14:30:00.000Z'),
    timeZone: 'UTC',
  });
  assert.equal(facts.system, 'MacIntel');
  assert.equal(facts.time, '2026-10-27T14:30:00+00:00[UTC]');
});

test('normalizePromptSwitches defaults every missing or unreadable switch to on', () => {
  const allOn = { unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: true };
  assert.deepEqual(actions.normalizePromptSwitches(undefined), allOn);
  assert.deepEqual(actions.normalizePromptSwitches(() => false), {
    unlimitedBudget: false,
    includeOriginalInstructions: true,
    includeMinimalContext: true,
  });
  assert.deepEqual(actions.normalizePromptSwitches(() => ({ includeOriginalInstructions: false })), {
    unlimitedBudget: true,
    includeOriginalInstructions: false,
    includeMinimalContext: true,
  });
  assert.deepEqual(actions.normalizePromptSwitches(() => {
    throw new Error('config failed');
  }), allOn);
});

test('createFreshExecution composes the fresh prompt and keeps the existing session flow', async () => {
  const prompts = [];
  let created;
  let opened;
  const oldBinding = {
    eventSource: {
      getSnapshot: () => ({
        entries: [
          event('plan/mode', { active: true }, 1),
          userMessage('original request', 2),
        ],
        hasMore: false,
      }),
    },
    session: {
      cancel: async () => ({ ok: true }),
    },
  };
  const ctx = {
    sessions: {
      create: async (args) => {
        created = args;
        return 'new-session';
      },
      using: async (_id, _options, operation) => operation({
        binding: {
          session: {
            rename: async () => undefined,
            prompt: async (content) => {
              prompts.push(content);
              return { ok: true };
            },
          },
        },
      }),
      binding: (id) => (id === 'old-session' ? oldBinding : undefined),
    },
    remote: { session: { selectModel: async () => ({ ok: true }) } },
    uiWorkspace: {
      archiveSession: async () => undefined,
      openSession: (id) => {
        opened = id;
      },
    },
  };
  const result = await actions.createFreshExecution({
    ctx,
    sessionId: 'old-session',
    review: { plan: '# Plan\nDo it.' },
    presetId: 'minimal',
    workspaceId: 'workspace-1',
    workspaceDirectory: '/tmp/project',
    cwd: '/tmp/project',
    selection: null,
    title: 'Old title',
    titleSuffix: ' · Execute plan',
    signal: new AbortController().signal,
    t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    readPromptSwitches: () => ({
      unlimitedBudget: false,
      includeOriginalInstructions: true,
      includeMinimalContext: true,
    }),
    runtimeFacts: { system: 'macOS (MacIntel)', time: '2026-10-27T22:30:00+08:00[Asia/Shanghai]' },
  });
  assert.equal(result.sessionId, 'new-session');
  assert.equal(result.cancelError, undefined);
  assert.deepEqual(created, { workspaceId: 'workspace-1', agentPreset: 'minimal' });
  assert.equal(opened, 'new-session');
  assert.equal(prompts.length, 1);
  const text = prompts[0][0].text;
  assert.match(text, /<fresh-session-context>/);
  assert.match(text, /\/tmp\/project/);
  assert.match(text, /<plan-mode-user-instructions>/);
  assert.match(text, /original request/);
  assert.match(text, /<approved-plan>\n# Plan\nDo it\.\n<\/approved-plan>$/);
  assert.equal(text.includes('Token budget: unlimited'), false);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const previewT = (key, params) => {
  if (key === 'clear.promptIntro') return 'INTRO';
  if (key === 'clear.instructionsIntro') return 'INSTR';
  return params === undefined ? key : `${key}:${JSON.stringify(params)}`;
};

function freshExecutionHarness(options = {}) {
  const log = [];
  const prompts = [];
  const archived = [];
  const state = {
    created: undefined,
    opened: undefined,
    usingOptions: undefined,
    promptMode: undefined,
    promptSignal: undefined,
    renamed: undefined,
  };
  const entries = options.windowEntries ?? [
    event('plan/mode', { active: true }, 1),
    userMessage('original request', 2),
  ];
  const hasMore = options.windowHasMore ?? false;
  const oldBinding = {
    eventSource: {
      getSnapshot: () => {
        if (options.snapshotThrows) throw new Error('snapshot failed');
        return { entries, hasMore };
      },
    },
    session: {
      cancel: async () => {
        log.push('cancel');
        if (options.cancelThrows) throw new Error('cancel threw');
        return options.cancelResult ?? { ok: true };
      },
    },
  };
  if (options.loadOlderThrows === true || typeof options.onLoadOlder === 'function') {
    oldBinding.session.loadOlder = async () => {
      log.push('loadOlder');
      if (options.loadOlderThrows === true) throw new Error('load older failed');
      await options.onLoadOlder?.();
    };
  }
  const reference = {
    binding: {
      session: {
        rename: async (value) => {
          log.push('rename');
          state.renamed = value;
          if (options.renameThrows === true) throw new Error('rename failed');
          return value;
        },
        prompt: async (content, mode, signal) => {
          log.push('prompt');
          prompts.push(content);
          state.promptMode = mode;
          state.promptSignal = signal;
          if (options.promptThrows === true) throw new Error('prompt threw');
          return options.promptResult ?? { ok: true };
        },
      },
    },
  };
  const ctx = {
    sessions: {
      create: async (args) => {
        log.push('create');
        state.created = args;
        if (options.createThrows === true) throw new Error('create failed');
        return 'new-session';
      },
      using: async (_sessionId, usingOptions, operation) => {
        log.push('using');
        state.usingOptions = usingOptions;
        try {
          return await operation(reference);
        } finally {
          log.push('using-exit');
        }
      },
      binding: (id) => {
        log.push('binding');
        if (options.bindingThrows === true) throw new Error('binding failed');
        return id === 'old-session' ? oldBinding : undefined;
      },
    },
    remote: {
      session: {
        selectModel: async () => {
          log.push('selectModel');
          if (options.selectThrows === true) throw new Error('select threw');
          return options.selectResult ?? { ok: true };
        },
      },
    },
    uiWorkspace: {
      archiveSession: async (id, archiveOptions) => {
        log.push('archive');
        archived.push({ id, options: archiveOptions });
        if (options.archiveThrows === true) throw new Error('archive failed');
      },
      openSession: (id) => {
        log.push('open');
        state.opened = id;
        if (options.openThrows === true) throw new Error('open failed');
      },
    },
  };
  return { ctx, log, prompts, archived, state };
}

function freshExecutionArgs(ctx, overrides = {}) {
  return {
    ctx,
    sessionId: 'old-session',
    review: { plan: '# Plan\nDo it.' },
    presetId: 'standard',
    workspaceId: 'workspace-1',
    workspaceDirectory: '/tmp/project',
    cwd: '/tmp/project',
    selection: null,
    title: 'Old title',
    titleSuffix: ' · Execute plan',
    signal: new AbortController().signal,
    t: previewT,
    readPromptSwitches: () => ({
      unlimitedBudget: false,
      includeOriginalInstructions: false,
      includeMinimalContext: false,
    }),
    runtimeFacts: { system: 'macOS (MacIntel)', time: '2026-10-27T22:30:00+08:00[Asia/Shanghai]' },
    ...overrides,
  };
}

// ---------------------------------------------------------------- preview ----

test('FRESH_PROMPT_WARN_CHARS is the frozen preview threshold', () => {
  assert.equal(actions.FRESH_PROMPT_WARN_CHARS, 32000);
});

test('describeFreshPrompt keeps five ordered blocks whose chars sum to the text length', () => {
  const plan = '# Plan\n\nExecute the approved work.';
  const instructions = ['first instruction', '   ', 'second instruction', ''];
  const runtimeFacts = { system: 'macOS (MacIntel)', time: '2026-10-27T22:30:00+08:00[Asia/Shanghai]' };
  const scenarios = [];
  for (const presetId of [undefined, 'standard', 'minimal']) {
    for (const unlimitedBudget of [true, false]) {
      for (const includeOriginalInstructions of [true, false]) {
        for (const includeMinimalContext of [true, false]) {
          scenarios.push({
            presetId,
            switches: { unlimitedBudget, includeOriginalInstructions, includeMinimalContext },
          });
        }
      }
    }
  }
  assert.equal(scenarios.length, 24);

  for (const { presetId, switches } of scenarios) {
    const input = {
      plan,
      t: previewT,
      presetId,
      instructions,
      workspaceDirectory: '/tmp/project',
      runtimeFacts,
      switches,
    };
    const described = actions.describeFreshPrompt(input);
    assert.equal(described.text, actions.composeFreshPrompt(input));

    assert.deepEqual(described.blocks.map((block) => block.id), [
      'intro', 'budget', 'runtime', 'instructions', 'plan',
    ]);
    assert.deepEqual(described.blocks.map((block) => block.titleKey), [
      'preview.block.intro',
      'preview.block.budget',
      'preview.block.runtime',
      'preview.block.instructions',
      'preview.block.plan',
    ]);

    const [intro, budgetBlock, runtime, instructionBlock, planBlock] = described.blocks;
    const runtimeIncluded = switches.includeMinimalContext && presetId === 'minimal';
    assert.equal(intro.included, true);
    assert.equal(planBlock.included, true);
    assert.equal(budgetBlock.included, switches.unlimitedBudget);
    assert.equal(runtime.included, runtimeIncluded);
    assert.equal(instructionBlock.included, switches.includeOriginalInstructions);
    assert.equal(instructionBlock.count, switches.includeOriginalInstructions ? 2 : 0);
    assert.equal('count' in instructionBlock, true);
    for (const block of [intro, budgetBlock, runtime, planBlock]) assert.equal('count' in block, false);

    assert.equal(described.instructionCount, 2);
    assert.equal(described.instructionChars, 'first instruction'.length + 'second instruction'.length);
    assert.equal(described.totalChars, described.text.length);
    assert.equal(
      described.blocks.reduce((sum, block) => sum + block.chars, 0),
      described.totalChars,
    );
    assert.equal(described.approxTokens, Math.ceil(described.totalChars / 3.5));
    assert.equal(described.oversized, described.totalChars > actions.FRESH_PROMPT_WARN_CHARS);

    assert.equal(intro.chars, 'INTRO\n\n'.length);
    assert.equal(budgetBlock.chars, switches.unlimitedBudget ? `${actions.UNLIMITED_BUDGET_REMINDER}\n\n`.length : 0);
    if (runtimeIncluded) {
      const context = actions.buildMinimalRuntimeContext({
        workspaceDirectory: '/tmp/project',
        system: runtimeFacts.system,
        time: runtimeFacts.time,
      }, previewT);
      assert.equal(runtime.chars, `${context}\n\n`.length);
      assert.ok(described.text.includes(context));
    } else {
      assert.equal(runtime.chars, 0);
    }
    if (instructionBlock.included) {
      const expected = `INSTR\n\n<${actions.PLAN_MODE_INSTRUCTIONS_TAG}>\nfirst instruction\n\n---\n\nsecond instruction\n</${actions.PLAN_MODE_INSTRUCTIONS_TAG}>\n\n`;
      assert.equal(instructionBlock.chars, expected.length);
      assert.ok(described.text.includes(expected));
    } else {
      assert.equal(instructionBlock.chars, 0);
    }
    assert.equal(planBlock.chars, `<approved-plan>\n${plan}\n</approved-plan>`.length);
  }
});

test('describeFreshPrompt text stays identical to buildPlanExecutionPrompt for the same blocks', () => {
  const plan = '# Plan\nDo it.';
  const instructions = ['first', 'second'];
  const t = previewT;
  const described = actions.describeFreshPrompt({
    plan,
    t,
    presetId: 'standard',
    instructions,
    switches: { unlimitedBudget: false, includeOriginalInstructions: true, includeMinimalContext: false },
  });
  const built = actions.buildPlanExecutionPrompt(plan, t, {
    unlimitedBudget: false,
    instructions,
  });
  assert.equal(described.text, built);
});

test('describeFreshPrompt flags the oversized boundary at exactly the frozen threshold', () => {
  const t = (key) => (key === 'clear.promptIntro' ? 'INTRO' : key);
  const base = {
    t,
    presetId: 'standard',
    instructions: [],
    switches: { unlimitedBudget: false, includeOriginalInstructions: false, includeMinimalContext: false },
  };
  const probe = actions.describeFreshPrompt({ ...base, plan: 'p' });
  const overhead = probe.totalChars - 1;
  const atLimit = actions.describeFreshPrompt({
    ...base,
    plan: 'p'.repeat(actions.FRESH_PROMPT_WARN_CHARS - overhead),
  });
  assert.equal(atLimit.totalChars, actions.FRESH_PROMPT_WARN_CHARS);
  assert.equal(atLimit.oversized, false);

  const overLimit = actions.describeFreshPrompt({
    ...base,
    plan: 'p'.repeat(actions.FRESH_PROMPT_WARN_CHARS - overhead + 1),
  });
  assert.equal(overLimit.totalChars, actions.FRESH_PROMPT_WARN_CHARS + 1);
  assert.equal(overLimit.oversized, true);
  assert.equal(overLimit.approxTokens, Math.ceil((actions.FRESH_PROMPT_WARN_CHARS + 1) / 3.5));
});

test('describeFreshPrompt never truncates a huge first message', () => {
  const longInstruction = 'x'.repeat(50000);
  const described = actions.describeFreshPrompt({
    plan: '# Plan',
    t: previewT,
    presetId: 'standard',
    instructions: [longInstruction],
    workspaceDirectory: '/tmp/project',
    switches: { unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: false },
  });
  assert.ok(described.text.includes(longInstruction));
  assert.equal(described.instructionChars, 50000);
  assert.equal(described.instructionCount, 1);
  assert.equal(described.oversized, true);
  assert.ok(described.totalChars > 50000);

  const composed = actions.composeFreshPrompt({
    plan: '# Plan',
    t: previewT,
    presetId: 'standard',
    instructions: [longInstruction],
    workspaceDirectory: '/tmp/project',
    switches: { unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: false },
  });
  assert.ok(composed.includes(longInstruction));
  assert.equal(composed, described.text);
});

test('describeFreshPrompt and composeFreshPrompt reject an empty plan with emptyPlan', () => {
  for (const plan of ['', '   ', undefined, null, 42]) {
    assert.throws(
      () => actions.describeFreshPrompt({ plan, t: previewT }),
      (error) => {
        assert.ok(error instanceof actions.ActionError);
        assert.equal(error.code, 'emptyPlan');
        return true;
      },
    );
    assert.throws(() => actions.composeFreshPrompt({ plan, t: previewT }), (error) => error.code === 'emptyPlan');
  }
});

test('planPreviewText summarizes the first heading and its first paragraph', () => {
  const plan = '# Execute the approved plan\n\nThe plan does **important** work with __careful__ `code` steps.\nIt continues on the next line.\n\nSecond paragraph is ignored.';
  assert.deepEqual(actions.planPreviewText(plan), {
    preview: 'Execute the approved plan\nThe plan does important work with careful code steps. It continues on the next line.',
    chars: plan.length,
  });
});

test('planPreviewText handles headings without paragraphs and plans without headings', () => {
  assert.deepEqual(actions.planPreviewText('# Only a heading'), {
    preview: 'Only a heading',
    chars: '# Only a heading'.length,
  });
  assert.deepEqual(actions.planPreviewText('\n\n# Title\n\n'), {
    preview: 'Title',
    chars: '\n\n# Title\n\n'.length,
  });
  assert.deepEqual(actions.planPreviewText('Just prose here.\nMore prose.\n\nA second paragraph.'), {
    preview: 'Just prose here. More prose.',
    chars: 'Just prose here.\nMore prose.\n\nA second paragraph.'.length,
  });
  assert.deepEqual(actions.planPreviewText('## First heading ##\n\nBody\n# Second heading\nMore'), {
    preview: 'First heading ##\nBody',
    chars: '## First heading ##\n\nBody\n# Second heading\nMore'.length,
  });
  assert.deepEqual(actions.planPreviewText('# T\r\n\r\npara line one\r\npara line two'), {
    preview: 'T\npara line one para line two',
    chars: '# T\r\n\r\npara line one\r\npara line two'.length,
  });
});

test('planPreviewText caps the preview and leaves empty input empty', () => {
  const long = `# ${'a'.repeat(300)}`;
  const capped = actions.planPreviewText(long);
  assert.equal(capped.chars, long.length);
  assert.equal(capped.preview, `${'a'.repeat(240)}…`);
  assert.equal(capped.preview.length, 241);

  assert.deepEqual(actions.planPreviewText(''), { preview: '', chars: 0 });
  assert.deepEqual(actions.planPreviewText('   '), { preview: '', chars: 3 });
  for (const value of [undefined, null, 42, {}, []]) {
    assert.deepEqual(actions.planPreviewText(value), { preview: '', chars: 0 });
  }
});

// ------------------------------------------------------------- ActionError ----

test('ActionError carries the frozen code, params, and English fallback message', () => {
  assert.deepEqual(actions.ACTION_ERROR_CODES, [
    'emptyPlan',
    'reviewGone',
    'createSessionFailed',
    'modelApplyFailed',
    'startSessionFailed',
    'openSessionFailed',
    'dismissFailed',
    'cleanupFailed',
  ]);
  for (const code of actions.ACTION_ERROR_CODES) {
    assert.equal(typeof actions.ACTION_ERROR_MESSAGES[code], 'string');
  }

  const error = new actions.ActionError('createSessionFailed', { message: 'boom' });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'ActionError');
  assert.equal(error.code, 'createSessionFailed');
  assert.deepEqual(error.params, { message: 'boom' });
  assert.equal(error.message, 'Creating the new session failed: boom');

  assert.equal(new actions.ActionError('emptyPlan').message, 'The reviewed plan is empty.');
  assert.equal(new actions.ActionError('reviewGone').message, 'The plan review has ended.');
  assert.deepEqual(new actions.ActionError('reviewGone').params, {});
  assert.equal(
    new actions.ActionError('dismissFailed', { message: 'gone' }).message,
    'Could not return to editing; please try again: gone',
  );
  assert.equal(
    new actions.ActionError('cleanupFailed', { message: 'locked' }).message,
    'The unused new session could not be cleaned up: locked',
  );
});

test('describeActionError localizes a known code with the underlying message parameter', () => {
  const calls = [];
  const t = (key, params) => {
    calls.push([key, params]);
    return `${key}:${params.message}`;
  };
  const error = new actions.ActionError('startSessionFailed', { message: 'host refused' });
  assert.equal(actions.describeActionError(t, error), 'error.startSessionFailed:host refused');
  assert.deepEqual(calls, [['error.startSessionFailed', { message: 'host refused' }]]);

  const withoutParams = new actions.ActionError('reviewGone');
  assert.equal(
    actions.describeActionError(t, withoutParams),
    'error.reviewGone:The plan review has ended.',
  );

  assert.equal(actions.describeActionError(t, new Error('plain')), undefined);
  assert.equal(actions.describeActionError(t, { code: 'not-a-code' }), undefined);
  assert.equal(actions.describeActionError(t, { code: 42 }), undefined);
  assert.equal(actions.describeActionError(t, undefined), undefined);
  assert.equal(actions.describeActionError(t, null), undefined);
});

test('describeActionError never throws and falls back to the error message', () => {
  const error = new actions.ActionError('dismissFailed', { message: 'pending gone' });
  assert.equal(actions.describeActionError(undefined, error), error.message);
  assert.equal(actions.describeActionError(null, error), error.message);
  assert.equal(actions.describeActionError(() => {
    throw new Error('t is unavailable');
  }, error), error.message);
  assert.equal(actions.describeActionError(() => '', error), error.message);

  const hostile = {};
  Object.defineProperty(hostile, 'code', {
    get() {
      throw new Error('hostile code getter');
    },
  });
  assert.doesNotThrow(() => actions.describeActionError((key) => key, hostile));
  assert.equal(actions.describeActionError((key) => key, hostile), undefined);
});

// ------------------------------------------- readPlanModeInstructions metadata ----

test('readPlanModeInstructions reports the start kind and pages loaded', async () => {
  const bindingOf = (window) => ({
    eventSource: { getSnapshot: () => window },
    session: {},
  });

  const commandWindow = {
    entries: [event('command/run', { name: 'plan', args: 'do the work' }, 1)],
    hasMore: false,
  };
  assert.deepEqual(
    await actions.readPlanModeInstructions({ sessions: { binding: () => bindingOf(commandWindow) } }, 'session-1'),
    { texts: ['do the work'], found: true, kind: 'plan-command', pagesLoaded: 0 },
  );

  const turnWindow = {
    entries: [event('turn/start', { turn: 1 }, 1), userMessage('latest request', 2)],
    hasMore: false,
  };
  assert.deepEqual(
    await actions.readPlanModeInstructions({ sessions: { binding: () => bindingOf(turnWindow) } }, 'session-1'),
    { texts: ['latest request'], found: true, kind: 'turn-start', pagesLoaded: 0 },
  );

  const unmarkedWindow = {
    entries: [userMessage('older task', 1), injectedMessage('time-context', 'clock', 2), userMessage('latest request', 3)],
    hasMore: false,
  };
  assert.deepEqual(
    await actions.readPlanModeInstructions({ sessions: { binding: () => bindingOf(unmarkedWindow) } }, 'session-1'),
    { texts: ['latest request'], found: true, kind: undefined, pagesLoaded: 0 },
  );

  const emptyWindow = { entries: [], hasMore: false };
  assert.deepEqual(
    await actions.readPlanModeInstructions({ sessions: { binding: () => bindingOf(emptyWindow) } }, 'session-1'),
    { texts: [], found: false, kind: undefined, pagesLoaded: 0 },
  );
});

test('readPlanModeInstructions caps older-page loads at maxPages and at the default', async () => {
  let calls = 0;
  const binding = {
    eventSource: { getSnapshot: () => ({ entries: [], hasMore: true }) },
    session: {
      async loadOlder() {
        calls += 1;
      },
    },
  };
  const ctx = { sessions: { binding: () => binding } };

  const capped = await actions.readPlanModeInstructions(ctx, 'session-1', { maxPages: 3 });
  assert.equal(calls, 3);
  assert.deepEqual(capped, { texts: [], found: false, kind: undefined, pagesLoaded: 3 });

  calls = 0;
  const defaulted = await actions.readPlanModeInstructions(ctx, 'session-1');
  assert.equal(calls, 8);
  assert.equal(defaulted.pagesLoaded, 8);

  calls = 0;
  assert.deepEqual(
    await actions.readPlanModeInstructions(ctx, 'session-1', { maxPages: 0 }),
    { texts: [], found: false, kind: undefined, pagesLoaded: 0 },
  );
  assert.equal(calls, 0);
});

test('readPlanModeInstructions aborts between older-page loads', async () => {
  const preAbortedController = new AbortController();
  preAbortedController.abort();
  let calls = 0;
  const visibleBinding = {
    eventSource: { getSnapshot: () => ({ entries: [userMessage('visible text', 1)], hasMore: true }) },
    session: {
      async loadOlder() {
        calls += 1;
      },
    },
  };
  assert.deepEqual(
    await actions.readPlanModeInstructions(
      { sessions: { binding: () => visibleBinding } },
      'session-1',
      { signal: preAbortedController.signal, maxPages: 4 },
    ),
    { texts: ['visible text'], found: true, kind: undefined, pagesLoaded: 0 },
  );
  assert.equal(calls, 0);

  const controller = new AbortController();
  let resumedCalls = 0;
  let loaded = false;
  const midBinding = {
    eventSource: {
      getSnapshot: () => ({
        entries: loaded
          ? [event('plan/mode', { active: true }, 1), userMessage('after the aborted page', 2)]
          : [],
        hasMore: true,
      }),
    },
    session: {
      async loadOlder() {
        resumedCalls += 1;
        loaded = true;
        controller.abort();
      },
    },
  };
  const midResult = await actions.readPlanModeInstructions(
    { sessions: { binding: () => midBinding } },
    'session-1',
    { signal: controller.signal, maxPages: 4 },
  );
  assert.equal(resumedCalls, 1);
  assert.equal(midResult.pagesLoaded, 1);
  assert.equal(midResult.texts.includes('after the aborted page'), true);
});

test('readPlanModeInstructions stops when a page refresh throws', async () => {
  let calls = 0;
  let failSnapshot = false;
  const binding = {
    eventSource: {
      getSnapshot: () => {
        if (failSnapshot) throw new Error('window is gone');
        return { entries: [userMessage('first page', 1)], hasMore: true };
      },
    },
    session: {
      async loadOlder() {
        calls += 1;
        failSnapshot = true;
      },
    },
  };
  const result = await actions.readPlanModeInstructions({ sessions: { binding: () => binding } }, 'session-1');
  assert.equal(calls, 1);
  assert.deepEqual(result, { texts: ['first page'], found: true, kind: undefined, pagesLoaded: 1 });
});

// ------------------------------------------------------------ Intl caching ----

test('Intl formatters are cached per zone and the timestamp output is unchanged', () => {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  let constructions = 0;
  function CountingDateTimeFormat(...args) {
    constructions += 1;
    return new RealDateTimeFormat(...args);
  }
  CountingDateTimeFormat.prototype = RealDateTimeFormat.prototype;
  Intl.DateTimeFormat = CountingDateTimeFormat;
  try {
    const first = actions.formatTimestamp(new Date('2026-10-27T14:30:00.000Z'), 'Asia/Tokyo');
    assert.equal(first, '2026-10-27T23:30:00+09:00[Asia/Tokyo]');
    assert.equal(constructions, 2);

    const second = actions.formatTimestamp(new Date('2026-10-27T14:30:00.000Z'), 'Asia/Tokyo');
    assert.equal(second, first);
    assert.equal(constructions, 2);

    actions.formatTimestamp(new Date('2026-10-27T14:30:00.000Z'), 'Asia/Seoul');
    assert.equal(constructions, 4);
  } finally {
    Intl.DateTimeFormat = RealDateTimeFormat;
  }
});

// ------------------------------------------------- compact command mapping ----

const CLIENT_COMPACT_UNAVAILABLE = 'The /great-plan-compact command is not available.';

const COMPACT_MAPPING = [
  [HOST_USAGE, 'compact.error.usage'],
  [HOST_FAILURES.busy, 'compact.error.busy'],
  [HOST_FAILURES.changed, 'compact.error.changed'],
  [HOST_FAILURES.summary, 'compact.error.summary'],
  [HOST_FAILURES.commit, 'compact.error.commit'],
  [HOST_FAILURES.persistence, 'compact.error.persistence'],
  [HOST_FAILURES.cancelled, 'compact.error.cancelled'],
  [HOST_MESSAGES.planStateUnavailable, 'compact.error.planStateUnavailable'],
  [HOST_MESSAGES.planInactive, 'compact.error.planInactive'],
  [HOST_MESSAGES.backendUnavailable, 'compact.error.backendUnavailable'],
  [HOST_MESSAGES.noReview, 'compact.error.noReview'],
  [HOST_MESSAGES.empty, 'compact.error.empty'],
  [CLIENT_COMPACT_UNAVAILABLE, 'compact.error.unavailable'],
];

function compactCtx(execute) {
  return { remote: { commands: { execute } } };
}

test('every host-visible compact message maps to the frozen client locale key', () => {
  for (const [message, key] of COMPACT_MAPPING) {
    assert.equal(actions.COMPACT_MESSAGE_KEYS[message], key);
    assert.match(key, /^compact\.error\./);
  }
  assert.equal(Object.keys(actions.COMPACT_MESSAGE_KEYS).length, COMPACT_MAPPING.length);
});

test('describeCompactFailure localizes only exact host messages', () => {
  const t = (key) => `LOC:${key}`;
  for (const [message, key] of COMPACT_MAPPING) {
    assert.equal(actions.describeCompactFailure(t, message), `LOC:${key}`);
  }
  assert.equal(actions.describeCompactFailure(t, 'Plan state is unavailable: exploded'), 'Plan state is unavailable: exploded');
  assert.equal(actions.describeCompactFailure(t, `${HOST_MESSAGES.noReview} `), `${HOST_MESSAGES.noReview} `);
  assert.equal(actions.describeCompactFailure(undefined, HOST_MESSAGES.noReview), HOST_MESSAGES.noReview);
  assert.equal(actions.describeCompactFailure(() => {
    throw new Error('t is unavailable');
  }, HOST_MESSAGES.noReview), HOST_MESSAGES.noReview);
  assert.equal(actions.describeCompactFailure(() => '', HOST_MESSAGES.noReview), HOST_MESSAGES.noReview);
  assert.equal(actions.describeCompactFailure(t, undefined), undefined);
  assert.equal(actions.describeCompactFailure(t, null), null);
  assert.equal(actions.describeCompactFailure(t, 42), 42);
});

test('runCompactCommand returns a mapped warning instead of throwing', async () => {
  const success = await actions.runCompactCommand({
    ctx: compactCtx(async () => ({
      ok: true,
      value: { result: { kind: 'success', text: 'Compacted 2 history items (~10 tokens).' } },
    })),
    sessionId: 'session-1',
  });
  assert.deepEqual(success, { ok: true, message: 'Compacted 2 history items (~10 tokens).' });

  const rpcFailure = await actions.runCompactCommand({
    ctx: compactCtx(async () => ({ ok: false, error: { message: 'boom', code: 'busy' } })),
    sessionId: 'session-1',
  });
  assert.deepEqual(rpcFailure, { ok: false, message: 'boom (busy)', code: 'busy' });

  const thrown = await actions.runCompactCommand({
    ctx: compactCtx(async () => {
      throw new Error('the rpc channel is down');
    }),
    sessionId: 'session-1',
  });
  assert.deepEqual(thrown, { ok: false, message: 'the rpc channel is down' });

  const unavailable = await actions.runCompactCommand({
    ctx: compactCtx(async () => ({ ok: true })),
    sessionId: 'session-1',
  });
  assert.deepEqual(unavailable, { ok: false, message: CLIENT_COMPACT_UNAVAILABLE });
  assert.equal(
    actions.describeCompactFailure((key) => key, unavailable.message),
    'compact.error.unavailable',
  );

  const missingRpc = await actions.runCompactCommand({ ctx: {}, sessionId: 'session-1' });
  assert.equal(missingRpc.ok, false);
  assert.equal(typeof missingRpc.message, 'string');
});

test('runCompactCommand keeps the raw host failure text for localization', async () => {
  const hostFailure = await actions.runCompactCommand({
    ctx: compactCtx(async () => ({ ok: true, value: { result: { kind: 'error', text: HOST_MESSAGES.noReview } } })),
    sessionId: 'session-1',
  });
  assert.deepEqual(hostFailure, { ok: false, message: HOST_MESSAGES.noReview, raw: HOST_MESSAGES.noReview });
  assert.equal(
    actions.describeCompactFailure((key) => key, hostFailure.message),
    'compact.error.noReview',
  );

  const dynamic = 'Compaction is unavailable: the backend exploded';
  const dynamicFailure = await actions.runCompactCommand({
    ctx: compactCtx(async () => ({ ok: true, value: { result: { kind: 'error', text: dynamic } } })),
    sessionId: 'session-1',
  });
  assert.deepEqual(dynamicFailure, { ok: false, message: dynamic, raw: dynamic });
  assert.equal(actions.describeCompactFailure((key) => key, dynamicFailure.message), dynamic);

  const emptyOutcome = await actions.runCompactCommand({
    ctx: compactCtx(async () => ({ ok: true, value: {} })),
    sessionId: 'session-1',
  });
  assert.deepEqual(emptyOutcome, { ok: false, message: '', raw: '' });
});

// ---------------------------------------------------------------- dismiss ----

test('dismissReview dismisses the pending plan review like the native Discuss action', async () => {
  let calls = 0;
  await actions.dismissReview({ pending: { dismiss: async () => { calls += 1; } } });
  assert.equal(calls, 1);
  await actions.dismissReview({ pending: { dismiss: () => { calls += 1; } } });
  assert.equal(calls, 2);

  await assert.rejects(
    () => actions.dismissReview({ pending: undefined }),
    (error) => {
      assert.ok(error instanceof actions.ActionError);
      assert.equal(error.code, 'dismissFailed');
      assert.equal(typeof error.params.message, 'string');
      return true;
    },
  );
  await assert.rejects(
    () => actions.dismissReview({}),
    (error) => error.code === 'dismissFailed',
  );
  await assert.rejects(
    () => actions.dismissReview({
      pending: {
        dismiss: async () => {
          throw new Error('the review is already gone');
        },
      },
    }),
    (error) => {
      assert.equal(error.code, 'dismissFailed');
      assert.equal(error.params.message, 'the review is already gone');
      return true;
    },
  );
});

// ------------------------------------------------------ createFreshExecution ----

test('createFreshExecution prompts, then cancels the old session before opening the new one', async () => {
  const harness = freshExecutionHarness();
  const result = await actions.createFreshExecution(freshExecutionArgs(harness.ctx, {
    selection: { provider: 'provider', model: 'model', reasoningEffort: 'high' },
    instructions: ['reused plan-mode instruction'],
    switches: { unlimitedBudget: false, includeOriginalInstructions: true, includeMinimalContext: false },
    stillPending: async () => {
      harness.log.push('stillPending');
      return true;
    },
  }));

  assert.deepEqual(result, { sessionId: 'new-session', cancelError: undefined });
  const order = harness.log;
  assert.ok(order.indexOf('create') < order.indexOf('using'));
  assert.ok(order.indexOf('rename') < order.indexOf('stillPending'));
  assert.ok(order.indexOf('selectModel') < order.indexOf('stillPending'));
  assert.equal(order.indexOf('prompt'), order.indexOf('stillPending') + 1);
  assert.ok(order.indexOf('using-exit') < order.indexOf('cancel'));
  assert.ok(order.indexOf('cancel') < order.indexOf('open'));
  assert.deepEqual(harness.state.created, { workspaceId: 'workspace-1', agentPreset: 'standard' });
  assert.equal(harness.state.renamed, 'Old title · Execute plan');
  assert.equal(harness.state.usingOptions.source, 'greatPlan');
  assert.ok(harness.state.usingOptions.signal instanceof AbortSignal);
  assert.equal(harness.state.promptMode, 'queue');
  assert.ok(harness.state.promptSignal instanceof AbortSignal);
  assert.equal(harness.prompts.length, 1);
  assert.match(harness.prompts[0][0].text, /reused plan-mode instruction/);
  assert.deepEqual(harness.archived, []);
});

test('createFreshExecution reads plan-mode instructions in parallel with session creation', async () => {
  const createGate = deferred();
  const loadGate = deferred();
  let createStarted = false;
  let loadStarted = false;
  let loaded = false;
  const prompts = [];
  const ctx = {
    sessions: {
      create: async () => {
        createStarted = true;
        return createGate.promise;
      },
      using: async (_sessionId, _options, operation) => operation({
        binding: {
          session: {
            rename: async () => undefined,
            prompt: async (content) => {
              prompts.push(content);
              return { ok: true };
            },
          },
        },
      }),
      binding: () => ({
        eventSource: {
          getSnapshot: () => (loaded
            ? { entries: [event('plan/mode', { active: true }, 1), userMessage('parallel instruction', 2)], hasMore: false }
            : { entries: [], hasMore: true }),
        },
        session: {
          cancel: async () => ({ ok: true }),
          loadOlder: async () => {
            loadStarted = true;
            await loadGate.promise;
            loaded = true;
          },
        },
      }),
    },
    remote: { session: { selectModel: async () => ({ ok: true }) } },
    uiWorkspace: { archiveSession: async () => undefined, openSession: () => undefined },
  };

  const execution = actions.createFreshExecution(freshExecutionArgs(ctx, {
    readPromptSwitches: () => ({ unlimitedBudget: false, includeOriginalInstructions: true, includeMinimalContext: false }),
  }));
  let settled = false;
  execution.then(() => {
    settled = true;
  }).catch(() => {
    settled = true;
  });

  assert.equal(createStarted, true);
  assert.equal(loadStarted, true);
  assert.equal(settled, false);

  createGate.resolve('new-session');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(prompts.length, 0);

  loadGate.resolve();
  const result = await execution;
  assert.deepEqual(result, { sessionId: 'new-session', cancelError: undefined });
  assert.match(prompts[0][0].text, /parallel instruction/);
});

test('createFreshExecution tolerates a failed title rename', async () => {
  const harness = freshExecutionHarness({ renameThrows: true });
  const result = await actions.createFreshExecution(freshExecutionArgs(harness.ctx));
  assert.deepEqual(result, { sessionId: 'new-session', cancelError: undefined });
  assert.equal(harness.log.includes('prompt'), true);
  assert.equal(harness.log.includes('open'), true);
  assert.deepEqual(harness.archived, []);
});

test('createFreshExecution archives the new session when the model cannot be applied', async () => {
  const harness = freshExecutionHarness({
    selectResult: { ok: false, error: { message: 'provider rejected', code: 'invalid-model' } },
  });
  await assert.rejects(
    () => actions.createFreshExecution(freshExecutionArgs(harness.ctx, {
      selection: { provider: 'provider', model: 'model' },
    })),
    (error) => {
      assert.ok(error instanceof actions.ActionError);
      assert.equal(error.code, 'modelApplyFailed');
      assert.equal(error.params.message, 'provider rejected (invalid-model)');
      assert.equal(error.message, 'Applying the model selection failed: provider rejected (invalid-model)');
      return true;
    },
  );
  assert.deepEqual(harness.archived, [{ id: 'new-session', options: { stopActivity: true } }]);
  assert.equal(harness.log.includes('prompt'), false);
  assert.equal(harness.log.includes('cancel'), false);
  assert.equal(harness.log.includes('open'), false);
});

test('createFreshExecution archives the new session when selectModel throws', async () => {
  const harness = freshExecutionHarness({ selectThrows: true });
  await assert.rejects(
    () => actions.createFreshExecution(freshExecutionArgs(harness.ctx, {
      selection: { provider: 'provider', model: 'model' },
    })),
    (error) => {
      assert.equal(error.code, 'modelApplyFailed');
      assert.equal(error.params.message, 'select threw');
      return true;
    },
  );
  assert.deepEqual(harness.archived, [{ id: 'new-session', options: { stopActivity: true } }]);
});

test('createFreshExecution archives the new session when starting execution fails', async () => {
  const harness = freshExecutionHarness({
    promptResult: { ok: false, error: { message: 'denied', code: 'not-allowed' } },
  });
  await assert.rejects(
    () => actions.createFreshExecution(freshExecutionArgs(harness.ctx)),
    (error) => {
      assert.ok(error instanceof actions.ActionError);
      assert.equal(error.code, 'startSessionFailed');
      assert.equal(error.params.message, 'denied (not-allowed)');
      assert.equal(error.message, 'Starting execution in the new session failed: denied (not-allowed)');
      return true;
    },
  );
  assert.deepEqual(harness.archived, [{ id: 'new-session', options: { stopActivity: true } }]);
  assert.equal(harness.log.includes('open'), false);
  assert.equal(harness.log.includes('cancel'), false);
});

test('createFreshExecution archives the new session when prompt throws', async () => {
  const harness = freshExecutionHarness({ promptThrows: true });
  await assert.rejects(
    () => actions.createFreshExecution(freshExecutionArgs(harness.ctx)),
    (error) => {
      assert.equal(error.code, 'startSessionFailed');
      assert.equal(error.params.message, 'prompt threw');
      return true;
    },
  );
  assert.deepEqual(harness.archived, [{ id: 'new-session', options: { stopActivity: true } }]);
});

test('createFreshExecution aborts and archives when the review settled before prompting', async () => {
  const harness = freshExecutionHarness();
  await assert.rejects(
    () => actions.createFreshExecution(freshExecutionArgs(harness.ctx, { stillPending: async () => false })),
    (error) => {
      assert.ok(error instanceof actions.ActionError);
      assert.equal(error.code, 'reviewGone');
      assert.equal(error.message, 'The plan review has ended.');
      return true;
    },
  );
  assert.deepEqual(harness.archived, [{ id: 'new-session', options: { stopActivity: true } }]);
  assert.equal(harness.log.includes('prompt'), false);
});

test('createFreshExecution falls back to readPending and aborts when the review is gone', async () => {
  const harness = freshExecutionHarness();
  await assert.rejects(
    () => actions.createFreshExecution(freshExecutionArgs(harness.ctx, { readPending: () => null })),
    (error) => error.code === 'reviewGone',
  );
  assert.deepEqual(harness.archived, [{ id: 'new-session', options: { stopActivity: true } }]);
  assert.equal(harness.log.includes('prompt'), false);

  const present = await actions.createFreshExecution(freshExecutionArgs(harness.ctx, {
    readPending: async () => ({ key: 'review-key' }),
  }));
  assert.deepEqual(present, { sessionId: 'new-session', cancelError: undefined });

  let readPendingCalls = 0;
  const both = await actions.createFreshExecution(freshExecutionArgs(harness.ctx, {
    stillPending: () => true,
    readPending: () => {
      readPendingCalls += 1;
      return null;
    },
  }));
  assert.deepEqual(both, { sessionId: 'new-session', cancelError: undefined });
  assert.equal(readPendingCalls, 0);
});

test('createFreshExecution archives and warns when opening the new session fails', async () => {
  const harness = freshExecutionHarness({ openThrows: true });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await assert.rejects(
      () => actions.createFreshExecution(freshExecutionArgs(harness.ctx)),
      (error) => {
        assert.ok(error instanceof actions.ActionError);
        assert.equal(error.code, 'openSessionFailed');
        assert.equal(error.params.message, 'open failed');
        assert.equal(error.message, 'The new session was created but could not be opened: open failed');
        return true;
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(harness.archived, [{ id: 'new-session', options: { stopActivity: true } }]);
  assert.equal(harness.log.includes('prompt'), true);
  assert.ok(harness.log.indexOf('cancel') < harness.log.indexOf('open'));
  assert.ok(warnings.some(([first]) => typeof first === 'string' && first.startsWith('great-plan:')));
});

test('createFreshExecution attaches cleanupError when archiving the failed session fails', async () => {
  const harness = freshExecutionHarness({
    selectResult: { ok: false, error: { message: 'rejected', code: 'invalid-model' } },
    archiveThrows: true,
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let thrown;
  try {
    thrown = await actions.createFreshExecution(freshExecutionArgs(harness.ctx, {
      selection: { provider: 'provider', model: 'model' },
    })).then(() => undefined, (error) => error);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(thrown instanceof actions.ActionError);
  assert.equal(thrown.code, 'modelApplyFailed');
  assert.equal(thrown.cleanupError, 'archive failed');
  assert.ok(warnings.some(([first]) => typeof first === 'string' && first.startsWith('great-plan:')));
});

test('createFreshExecution reports the creation failure without archiving', async () => {
  const harness = freshExecutionHarness({ createThrows: true });
  await assert.rejects(
    () => actions.createFreshExecution(freshExecutionArgs(harness.ctx)),
    (error) => {
      assert.ok(error instanceof actions.ActionError);
      assert.equal(error.code, 'createSessionFailed');
      assert.equal(error.params.message, 'create failed');
      assert.equal(error.message, 'Creating the new session failed: create failed');
      return true;
    },
  );
  assert.deepEqual(harness.archived, []);
  assert.equal(harness.log.includes('using'), false);
});

test('createFreshExecution rejects an empty plan before creating a session', async () => {
  const harness = freshExecutionHarness();
  for (const review of [{ plan: '   ' }, { plan: '' }, {}, undefined]) {
    await assert.rejects(
      () => actions.createFreshExecution(freshExecutionArgs(harness.ctx, { review })),
      (error) => {
        assert.ok(error instanceof actions.ActionError);
        assert.equal(error.code, 'emptyPlan');
        assert.equal(error.message, 'The reviewed plan is empty.');
        return true;
      },
    );
  }
  assert.deepEqual(harness.log, []);
  assert.deepEqual(harness.archived, []);
});

test('createFreshExecution returns cancelError when the old session cannot be stopped', async () => {
  const failing = freshExecutionHarness({
    cancelResult: { ok: false, error: { message: 'stop failed', code: 'busy' } },
  });
  const failed = await actions.createFreshExecution(freshExecutionArgs(failing.ctx));
  assert.deepEqual(failed, { sessionId: 'new-session', cancelError: 'stop failed (busy)' });
  assert.equal(failing.state.opened, 'new-session');

  const throwing = freshExecutionHarness({ cancelThrows: true });
  const thrown = await actions.createFreshExecution(freshExecutionArgs(throwing.ctx));
  assert.deepEqual(thrown, { sessionId: 'new-session', cancelError: 'cancel threw' });
  assert.equal(throwing.state.opened, 'new-session');
});

test('createFreshExecution forwards the workspace location and tolerates a missing selection', async () => {
  const harness = freshExecutionHarness();
  const result = await actions.createFreshExecution(freshExecutionArgs(harness.ctx, {
    workspaceId: undefined,
    presetId: undefined,
  }));
  assert.deepEqual(result, { sessionId: 'new-session', cancelError: undefined });
  assert.equal(harness.log.includes('selectModel'), false);
  assert.deepEqual(harness.state.created, { cwd: '/tmp/project' });
});

test('createFreshExecution honors this-run switches over the settings reader', async () => {
  const harness = freshExecutionHarness({ bindingThrows: true });
  const result = await actions.createFreshExecution(freshExecutionArgs(harness.ctx, {
    presetId: 'minimal',
    readPromptSwitches: () => ({ unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: true }),
    switches: { unlimitedBudget: false, includeOriginalInstructions: false, includeMinimalContext: false },
  }));
  assert.deepEqual(result, { sessionId: 'new-session', cancelError: 'binding failed' });
  const text = harness.prompts[0][0].text;
  assert.equal(text.includes('Token budget: unlimited'), false);
  assert.equal(text.includes('<fresh-session-context>'), false);
  assert.equal(text.includes('<plan-mode-user-instructions>'), false);
});

test('createFreshExecution defaults partial this-run switches on and reads from the bound reader', async () => {
  const harness = freshExecutionHarness();
  const result = await actions.createFreshExecution(freshExecutionArgs(harness.ctx, {
    presetId: 'minimal',
    instructions: ['reused plan-mode instruction'],
    readPromptSwitches: () => ({}),
    switches: { includeMinimalContext: false },
  }));
  assert.deepEqual(result, { sessionId: 'new-session', cancelError: undefined });
  const text = harness.prompts[0][0].text;
  assert.match(text, /Token budget: unlimited/);
  assert.match(text, /reused plan-mode instruction/);
  assert.equal(text.includes('<fresh-session-context>'), false);

  const bound = freshExecutionHarness();
  await actions.createFreshExecution(freshExecutionArgs(bound.ctx, {
    instructions: ['reused plan-mode instruction'],
    readPromptSwitches: () => ({ unlimitedBudget: false, includeOriginalInstructions: false, includeMinimalContext: false }),
  }));
  assert.equal(bound.prompts[0][0].text.includes('Token budget: unlimited'), false);
  assert.equal(bound.prompts[0][0].text.includes('reused plan-mode instruction'), false);
});

test('createFreshExecution reuses preview instructions without reading the session again', async () => {
  const harness = freshExecutionHarness({ bindingThrows: true });
  const result = await actions.createFreshExecution(freshExecutionArgs(harness.ctx, {
    instructions: ['previewed instruction', '   ', 42],
    readPromptSwitches: () => ({ unlimitedBudget: false, includeOriginalInstructions: true, includeMinimalContext: false }),
  }));
  assert.deepEqual(result, { sessionId: 'new-session', cancelError: 'binding failed' });
  const text = harness.prompts[0][0].text;
  assert.match(text, /previewed instruction/);
  assert.equal(text.includes('42'), false);
  assert.equal(text.includes('original request'), false);
});

// ------------------------------------------------------------ createActions ----

test('createActions exposes the frozen action face and binds the session', async () => {
  const executed = [];
  const ctx = {
    sessions: {
      binding: () => ({
        eventSource: {
          getSnapshot: () => ({
            entries: [event('plan/mode', { active: true }, 1), userMessage('bound instruction', 2)],
            hasMore: false,
          }),
        },
        session: {},
      }),
    },
    remote: {
      commands: {
        execute: async (...args) => {
          executed.push(args);
          return { ok: true, value: { result: { kind: 'success', text: 'ok' } } };
        },
      },
    },
  };
  const face = actions.createActions(ctx, 'session-1', () => ({ unlimitedBudget: false }));
  for (const name of [
    'approveReview',
    'composeFreshTitle',
    'runCompactCommand',
    'createFreshExecution',
    'readPlanModeInstructions',
    'dismissReview',
  ]) {
    assert.equal(typeof face[name], 'function', `${name} must be part of the actions face`);
  }

  assert.deepEqual(await face.readPlanModeInstructions({ maxPages: 2 }), {
    texts: ['bound instruction'],
    found: true,
    kind: 'plan-mode',
    pagesLoaded: 0,
  });

  assert.deepEqual(await face.runCompactCommand({}), { ok: true, message: 'ok' });
  assert.equal(executed[0][0], 'session-1');
  assert.equal(executed[0][1], '/great-plan-compact');
  assert.deepEqual(executed[0][2], []);
  assert.equal(executed[0][3], undefined);

  let dismissed = false;
  await face.dismissReview({ pending: { dismiss: async () => { dismissed = true; } } });
  assert.equal(dismissed, true);
});

test('createActions.createFreshExecution forwards this-run options and the bound switch reader', async () => {
  const harness = freshExecutionHarness();
  const face = actions.createActions(harness.ctx, 'old-session', () => ({
    unlimitedBudget: true,
    includeOriginalInstructions: true,
    includeMinimalContext: true,
  }));
  const result = await face.createFreshExecution({
    review: { plan: '# Plan' },
    presetId: 'minimal',
    workspaceId: 'workspace-1',
    workspaceDirectory: '/tmp/project',
    cwd: '/tmp/project',
    selection: null,
    title: 'Old title',
    titleSuffix: ' · Execute plan',
    signal: new AbortController().signal,
    t: previewT,
    runtimeFacts: { system: 'macOS (MacIntel)', time: '2026-10-27T22:30:00+08:00[Asia/Shanghai]' },
    switches: { unlimitedBudget: false, includeOriginalInstructions: false, includeMinimalContext: false },
  });
  assert.deepEqual(result, { sessionId: 'new-session', cancelError: undefined });
  const text = harness.prompts[0][0].text;
  assert.equal(text.includes('Token budget: unlimited'), false);
  assert.equal(text.includes('<fresh-session-context>'), false);
  assert.equal(text.includes('<plan-mode-user-instructions>'), false);
  assert.match(text, /<approved-plan>\n# Plan\n<\/approved-plan>$/);
});
