import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

/*
 * Host entry/apply smoke.
 *
 * `lib/index.js` re-exports `Config` from `lib/host/config.js`, which imports
 * `@deepseek-ai/schemastery`; `lib/host/apply.js` lazily imports
 * `@deepseek-ai/dsh-compaction` inside the command handler. Neither package is
 * installed in this offline test project, so a resolve hook maps exactly those
 * two bare specifiers to the fixtures in `./fixtures/`. Every other specifier
 * keeps Node's default resolution.
 *
 * Node 24 (the gate and CI runtime) provides `module.registerHooks`
 * (Node >= 22.15). There is intentionally no skip fallback: a missing API must
 * fail loudly instead of silently dropping this coverage.
 */
assert.equal(
  typeof registerHooks,
  'function',
  'host-entry.test.js requires module.registerHooks (Node >= 22.15; CI pins Node 24)',
);

function fixtureUrl(name) {
  return new URL(`./fixtures/${name}`, import.meta.url).href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: fixtureUrl('schemastery.js'), shortCircuit: true };
    }
    if (specifier === '@deepseek-ai/dsh-compaction') {
      return { url: fixtureUrl('dsh-compaction.js'), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// The hooks must be installed before these imports: lib/index.js reaches
// lib/host/config.js, whose bare Schemastery import is rewritten above.
const { Config, apply } = await import('../../lib/index.js');
const {
  composePlanGuidance,
  PLAN_EVIDENCE_GUIDANCE,
  PLAN_EVIDENCE_SECTION,
} = await import('../../lib/host/plan-evidence.js');
const { MESSAGES, USAGE } = await import('../../lib/host/plan-compaction.js');

const CONFIG_FIELDS = [
  'injectBrainstormingPrompt',
  'injectUnlimitedBudgetPrompt',
  'includeOriginalUserInstructions',
  'includeMinimalRuntimeContext',
];

const PLAN_SECTION_ORDER = 500;

/** The pending plan review: the last surface node is an `exit_plan_mode` tool call. */
function planReviewNode() {
  return {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call', name: 'exit_plan_mode' }] } },
  };
}

/** system(10), user(20), tool-result(30), pending plan review(50). */
function sessionWithPlanHistory() {
  const events = new Map([
    [10, { type: 'system/message' }],
    [20, { type: 'user/message' }],
    [30, { type: 'tool/result' }],
    [50, planReviewNode()],
  ]);
  return {
    surface: { nodes: [...events.keys()] },
    eventAt: (seq) => events.get(seq),
  };
}

/**
 * A fake Host context that dispatches `ctx.inject` callbacks synchronously and
 * records the service registrations `apply()` makes.
 *
 * `options.services` overrides individual `ctx.get(name)` readers; by default
 * plan mode is active and the `plan` projection is active.
 */
function createApplyContext(options = {}) {
  const commands = [];
  const sections = [];
  const policies = [];
  const sectionOrderQueries = [];
  const injectedDependencies = [];
  const fiber = Symbol('great-plan fiber');
  const services = {
    planMode: { get: () => ({ active: true }) },
    sessionProjections: {
      snapshot: () => ({ values: { plan: { active: true } } }),
    },
    ...options.services,
  };
  const ctx = {
    fiber,
    get(name) {
      return services[name];
    },
    inject(dependencies, callback) {
      injectedDependencies.push([...dependencies]);
      if (dependencies.includes('commands')) {
        callback({
          commands: {
            register(command) {
              commands.push(command);
              return () => {};
            },
          },
        });
      }
      if (dependencies.includes('systemPrompt')) {
        callback({
          systemPrompt: {
            getSectionOrder(name) {
              sectionOrderQueries.push(name);
              return PLAN_SECTION_ORDER;
            },
            section(section) {
              sections.push(section);
              return () => {};
            },
          },
        });
      }
      if (dependencies.includes('settings')) {
        callback({
          effect(run) {
            const cleanup = run();
            return typeof cleanup === 'function' ? cleanup : () => {};
          },
          settings: {
            configure(presentation, owner) {
              policies.push({ presentation, owner });
              return () => {};
            },
          },
        });
      }
    },
  };
  return { ctx, commands, sections, policies, sectionOrderQueries, injectedDependencies, fiber };
}

test('the real Host entry exports a four-field volatile Config plus apply', () => {
  assert.equal(typeof apply, 'function');
  assert.deepEqual(Object.keys(Config), CONFIG_FIELDS);
  for (const field of CONFIG_FIELDS) {
    assert.equal(Config[field].defaultValue, true, `${field} must default to on`);
    assert.equal(Config[field].isVolatile, true, `${field} must be volatile`);
    assert.equal(Config[field].get(), true, `${field} must read its default value`);
  }
});

test('the real apply registers the command, the evidence section, and the settings policy', () => {
  const { ctx, commands, sections, policies, sectionOrderQueries, injectedDependencies, fiber } = createApplyContext();

  apply(ctx, Config);

  assert.deepEqual(injectedDependencies, [['commands'], ['systemPrompt'], ['settings']]);

  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'great-plan-compact');
  assert.equal(typeof commands[0].description, 'string');
  assert.notEqual(commands[0].description.trim(), '');
  assert.equal(typeof commands[0].handler, 'function');

  assert.equal(PLAN_EVIDENCE_SECTION, 'great-plan:plan-evidence');
  assert.deepEqual(sectionOrderQueries, ['PLAN_POLICY']);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, PLAN_EVIDENCE_SECTION);
  assert.equal(sections[0].order, PLAN_SECTION_ORDER + 1);
  assert.equal(typeof sections[0].text, 'function');

  assert.deepEqual(policies, [{ presentation: { auto: false }, owner: fiber }]);
});

test('the wired command uses the preset-scoped compaction service and forwards the range', async () => {
  const agent = { session: sessionWithPlanHistory() };
  const signal = new AbortController().signal;
  const serviceForCalls = [];
  const compactCalls = [];
  const scopedCompaction = {
    async compactRegion(start, end, receivedAgent, receivedSignal) {
      compactCalls.push([start, end, receivedAgent, receivedSignal]);
      return { shadowedSeqs: [30], shadowedTokenCount: 77 };
    },
  };
  const { ctx, commands } = createApplyContext({
    services: {
      agentPresets: {
        serviceFor(receivedAgent, serviceName) {
          serviceForCalls.push([receivedAgent, serviceName]);
          return scopedCompaction;
        },
      },
      // The preset-scoped service must win; the host-plane read stays untouched.
      compaction: undefined,
    },
  });
  apply(ctx, Config);

  const result = await commands[0].handler({ rawInput: '', agent, signal });

  assert.deepEqual(serviceForCalls, [[agent, 'compaction']]);
  assert.equal(compactCalls.length, 1);
  const [start, end, receivedAgent, receivedSignal] = compactCalls[0];
  assert.equal(start, 20);
  assert.equal(end, 30);
  assert.equal(receivedAgent, agent);
  assert.equal(receivedSignal, signal);
  assert.deepEqual(result, { kind: 'success', text: 'Compacted 1 history items (~77 tokens).' });
});

test('the wired command rejects arguments and reports a missing compaction backend', async () => {
  const { ctx, commands } = createApplyContext({
    services: {
      agentPresets: { serviceFor: () => undefined },
      compaction: undefined,
    },
  });
  apply(ctx, Config);
  const agent = { session: sessionWithPlanHistory() };
  const signal = new AbortController().signal;

  assert.deepEqual(
    await commands[0].handler({ rawInput: ' --force', agent, signal }),
    { kind: 'error', text: USAGE },
  );
  assert.deepEqual(
    await commands[0].handler({ rawInput: '', agent, signal }),
    { kind: 'error', text: MESSAGES.backendUnavailable },
  );
});

test('the registered section reads the live Config switches through apply()', () => {
  const { ctx, sections } = createApplyContext();
  apply(ctx, Config);
  const section = sections[0];
  const agent = { session: sessionWithPlanHistory() };

  assert.equal(section.text({ agent }), PLAN_EVIDENCE_GUIDANCE);

  Config.injectUnlimitedBudgetPrompt.setValue(false);
  try {
    const text = section.text({ agent });
    assert.equal(text.includes('Token budget: unlimited'), false);
    assert.equal(text, composePlanGuidance({ brainstorming: true, unlimitedBudget: false }));
  } finally {
    Config.injectUnlimitedBudgetPrompt.setValue(true);
  }
  assert.equal(section.text({ agent }), PLAN_EVIDENCE_GUIDANCE);

  const { ctx: emptyCtx, sections: emptySections } = createApplyContext({
    services: { planMode: undefined, sessionProjections: undefined },
  });
  apply(emptyCtx, Config);
  assert.equal(emptySections[0].text({ agent }), '', 'no plan-state source means an empty section');
});
