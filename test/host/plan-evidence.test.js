import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../../host/apply.js';
import {
  PLAN_BRAINSTORMING_GUIDANCE,
  PLAN_EVIDENCE_GUIDANCE,
  PLAN_EVIDENCE_ORDER_FALLBACK,
  PLAN_EVIDENCE_SECTION,
  PLAN_HANDOFF_GUIDANCE,
  PLAN_UNLIMITED_BUDGET_GUIDANCE,
  composePlanGuidance,
  readBrainstormingEnabled,
  readPlanModeActive,
  readUnlimitedBudgetEnabled,
  registerPlanEvidenceSection,
} from '../../host/plan-evidence.js';

const AGENT = { session: { id: 'session-1' } };

function planModeOf(state) {
  return {
    get(agent) {
      assert.equal(agent, AGENT);
      return state;
    },
  };
}

function createSystemPrompt(order = 500) {
  const sections = [];
  return {
    sections,
    getSectionOrder(name) {
      assert.equal(name, 'PLAN_POLICY');
      return order;
    },
    section(section) {
      sections.push(section);
      return () => {};
    },
  };
}

test('guidance covers budgeting, brainstorming, evidence, handoff, and anti-fabrication rules', () => {
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Token budget: unlimited/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Background:/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Evidence:/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Handoff:/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /self-contained/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /assumption/i);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Never present a guess as fact or invent/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /must not be re-investigated/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Re-check citations/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /one concise question per turn/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /materially change scope or approach/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /If the request is clear or the user delegates the choice, proceed/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /alternatives and tradeoffs only when they help the user decide/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /key reason for your recommendation/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Separate user requirements from your recommendations, assumptions, and unverified points/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /brief rationale, not step-by-step chain-of-thought/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /You are the Team Lead/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /`spawn_teammate`/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /at least 2 exploration teammates in parallel/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /one distinct, concrete scope/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /concise findings cited as path:line-range/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Do not investigate their scopes yourself/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /collect all results and resolve conflicts/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /1 separate planning teammate/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /candidate plan from the consolidated evidence/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Verify the evidence and the draft yourself/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /unavailable or fails, say so in the plan and continue alone/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /never invent teammate work/);
  assert.ok(PLAN_EVIDENCE_GUIDANCE.length > 400, 'guidance must carry substantial handoff instructions');
  assert.ok(PLAN_EVIDENCE_GUIDANCE.length < 2000, 'guidance must stay compact');
});

test('guidance is English-only and leaves native plan:policy rules to the native section', () => {
  for (const text of [PLAN_UNLIMITED_BUDGET_GUIDANCE, PLAN_BRAINSTORMING_GUIDANCE, PLAN_HANDOFF_GUIDANCE]) {
    assert.equal(/[　-〿㐀-鿿＀-￯]/.test(text), false, 'model-facing guidance must be English');
  }
  assert.equal(PLAN_EVIDENCE_GUIDANCE.includes('native review flow'), false);
  assert.equal(PLAN_EVIDENCE_GUIDANCE.includes('does not authorize execution'), false);
  assert.equal(PLAN_EVIDENCE_GUIDANCE.includes('exit_plan_mode'), false);
});

test('the unlimited-budget reminder is a short neutral directive that does not cut the work', () => {
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /^Token budget: unlimited\./);
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /Never cut investigation, tool calls, or needed questions to save tokens/);
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /keep the final plan concise/);
  for (const persona of ['DeepSeek', 'wealthy', 'stress-testing', 'spend freely']) {
    assert.equal(PLAN_UNLIMITED_BUDGET_GUIDANCE.includes(persona), false, `${persona} must not be injected`);
  }
  assert.ok(PLAN_UNLIMITED_BUDGET_GUIDANCE.length < 160, 'the budget reminder must stay short');
});

test('the full guidance is exactly the default composition of its parts', () => {
  assert.equal(PLAN_EVIDENCE_GUIDANCE, composePlanGuidance());
  assert.equal(
    PLAN_EVIDENCE_GUIDANCE,
    `${PLAN_UNLIMITED_BUDGET_GUIDANCE}\n\n${PLAN_BRAINSTORMING_GUIDANCE}\n\n${PLAN_HANDOFF_GUIDANCE}`,
  );
  assert.match(PLAN_BRAINSTORMING_GUIDANCE, /one concise question per turn/);
  assert.match(PLAN_BRAINSTORMING_GUIDANCE, /alternatives and tradeoffs/);
  assert.match(PLAN_BRAINSTORMING_GUIDANCE, /spawn_teammate/);
  assert.equal(PLAN_BRAINSTORMING_GUIDANCE.includes('Background:'), false);
  assert.equal(PLAN_BRAINSTORMING_GUIDANCE.includes('Handoff:'), false);
  assert.match(PLAN_HANDOFF_GUIDANCE, /Background:/);
  assert.match(PLAN_HANDOFF_GUIDANCE, /Evidence:/);
  assert.match(PLAN_HANDOFF_GUIDANCE, /Handoff:/);
  assert.match(PLAN_HANDOFF_GUIDANCE, /invent/);
  assert.equal(PLAN_HANDOFF_GUIDANCE.includes('one concise question'), false);
  assert.equal(PLAN_HANDOFF_GUIDANCE.includes('spawn_teammate'), false);
  assert.equal(PLAN_UNLIMITED_BUDGET_GUIDANCE.includes('Evidence:'), false);
});

test('the fully enabled composition is the shared module constant', () => {
  assert.equal(composePlanGuidance({ brainstorming: true, unlimitedBudget: true }), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(composePlanGuidance({ brainstorming: true }), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(composePlanGuidance({ unlimitedBudget: true }), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(composePlanGuidance({ brainstorming: true, unlimitedBudget: true }), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(sectionText(() => planModeOf({ active: true })), PLAN_EVIDENCE_GUIDANCE);
  assert.notEqual(composePlanGuidance({ brainstorming: false }), PLAN_EVIDENCE_GUIDANCE);
  assert.notEqual(composePlanGuidance({ unlimitedBudget: false }), PLAN_EVIDENCE_GUIDANCE);
});

function switches(brainstorming, unlimitedBudget) {
  return {
    injectBrainstormingPrompt: { get: () => brainstorming },
    injectUnlimitedBudgetPrompt: { get: () => unlimitedBudget },
  };
}

function sectionText(getPlanMode, config) {
  const systemPrompt = createSystemPrompt();
  registerPlanEvidenceSection({ systemPrompt, getPlanMode, getConfig: () => config });
  return systemPrompt.sections[0].text({ agent: AGENT });
}

function scopedAgent(state) {
  const session = { id: 'session-scoped' };
  return {
    session,
    ctx: {
      get(name) {
        if (name !== 'planMode') return undefined;
        return {
          get(agent) {
            assert.equal(agent.session, session);
            return state;
          },
        };
      },
    },
  };
}

function projectionsOf(view) {
  return {
    snapshot(session, keys) {
      assert.equal(session, AGENT.session);
      assert.deepEqual([...keys], ['plan']);
      return { values: { plan: view } };
    },
  };
}

test('readPlanModeActive prefers the agent-scoped planMode over the host instance', () => {
  const host = { get: () => ({ active: false }) };
  assert.equal(readPlanModeActive(scopedAgent({ active: true }), () => host), true);
  // The scoped instance is authoritative: its inactive state wins over an
  // active host-plane read.
  assert.equal(readPlanModeActive(scopedAgent({ active: false }), () => ({ get: () => ({ active: true }) })), false);
});

test('readPlanModeActive honors a pending selection over the logged state', () => {
  assert.equal(readPlanModeActive(scopedAgent({ active: false, pending: true })), true);
  assert.equal(readPlanModeActive(scopedAgent({ active: true, pending: false })), false);
});

test('readPlanModeActive coerces a non-boolean pending value to false', () => {
  assert.equal(readPlanModeActive(scopedAgent({ active: false, pending: 'yes' })), false);
  assert.equal(readPlanModeActive(AGENT, () => ({ get: () => ({ active: false, pending: 1 }) })), false);
  assert.equal(readPlanModeActive(AGENT, undefined, () => projectionsOf({ active: false, pending: 'yes' })), false);
});

test('readPlanModeActive falls back to the host planMode without a scoped service', () => {
  assert.equal(readPlanModeActive(AGENT, () => ({ get: () => ({ active: true }) })), true);
  assert.equal(readPlanModeActive(AGENT, () => ({ get: () => ({ active: false }) })), false);
  assert.equal(readPlanModeActive(AGENT, () => undefined), false);
});

test('readPlanModeActive falls back to the plan projection view', () => {
  assert.equal(
    readPlanModeActive(AGENT, () => { throw new Error('host plan mode is unavailable'); }, () => projectionsOf({ active: true })),
    true,
  );
  assert.equal(readPlanModeActive(AGENT, undefined, () => projectionsOf({ active: false, pending: true })), true);
  assert.equal(readPlanModeActive(AGENT, undefined, () => projectionsOf({ active: false, pending: false })), false);
  assert.equal(readPlanModeActive(AGENT, undefined, () => projectionsOf(undefined)), false);
  assert.equal(readPlanModeActive(AGENT, undefined, () => ({ snapshot: () => ({ values: {} }) })), false);
});

test('readPlanModeActive degrades to inactive when every source is missing or throws', () => {
  assert.equal(readPlanModeActive(undefined, undefined, undefined), false);
  assert.equal(readPlanModeActive(null, undefined, undefined), false);
  assert.equal(readPlanModeActive(AGENT, () => { throw new Error('unavailable'); }, () => { throw new Error('unavailable'); }), false);
  assert.equal(readPlanModeActive(AGENT, () => ({ get: () => { throw new Error('unavailable'); } })), false);
  const brokenCtx = { session: { id: 's' }, ctx: { get: () => { throw new Error('no scoped services'); } } };
  assert.equal(readPlanModeActive(brokenCtx, undefined, undefined), false);
});

test('composePlanGuidance omits each disabled part and always keeps the handoff', () => {
  assert.equal(
    composePlanGuidance({ brainstorming: false }),
    `${PLAN_UNLIMITED_BUDGET_GUIDANCE}\n\n${PLAN_HANDOFF_GUIDANCE}`,
  );
  assert.equal(
    composePlanGuidance({ unlimitedBudget: false }),
    `${PLAN_BRAINSTORMING_GUIDANCE}\n\n${PLAN_HANDOFF_GUIDANCE}`,
  );
  assert.equal(composePlanGuidance({ brainstorming: false, unlimitedBudget: false }), PLAN_HANDOFF_GUIDANCE);
  assert.equal(composePlanGuidance(), PLAN_EVIDENCE_GUIDANCE);
});

test('turning each switch off keeps the remaining guidance and the plan-mode gate', () => {
  const active = () => planModeOf({ active: true });
  assert.equal(
    sectionText(active, switches(false, true)),
    `${PLAN_UNLIMITED_BUDGET_GUIDANCE}\n\n${PLAN_HANDOFF_GUIDANCE}`,
  );
  assert.equal(
    sectionText(active, switches(true, false)),
    `${PLAN_BRAINSTORMING_GUIDANCE}\n\n${PLAN_HANDOFF_GUIDANCE}`,
  );
  assert.equal(sectionText(active, switches(false, false)), PLAN_HANDOFF_GUIDANCE);
  assert.equal(sectionText(() => planModeOf({ active: false }), switches(false, false)), '');
  assert.equal(sectionText(() => planModeOf({ active: true, pending: false }), switches(false, false)), '');
  assert.equal(sectionText(() => planModeOf({ active: false, pending: true }), switches(false, false)), PLAN_HANDOFF_GUIDANCE);
});

test('reads the brainstorming switch from live or plain config values', () => {
  assert.equal(readBrainstormingEnabled(undefined), true);
  assert.equal(readBrainstormingEnabled(null), true);
  assert.equal(readBrainstormingEnabled({}), true);
  assert.equal(readBrainstormingEnabled({ injectBrainstormingPrompt: true }), true);
  assert.equal(readBrainstormingEnabled({ injectBrainstormingPrompt: false }), false);
  assert.equal(readBrainstormingEnabled({ injectBrainstormingPrompt: { get: () => true } }), true);
  assert.equal(readBrainstormingEnabled({ injectBrainstormingPrompt: { get: () => false } }), false);
  assert.equal(readBrainstormingEnabled({ injectBrainstormingPrompt: { get: () => undefined } }), true);
  assert.equal(readBrainstormingEnabled({
    injectBrainstormingPrompt: {
      get() {
        throw new Error('the live config is unavailable');
      },
    },
  }), true);
  assert.equal(readBrainstormingEnabled({
    get injectBrainstormingPrompt() {
      throw new Error('the live config is unavailable');
    },
  }), true);
});

test('reads the unlimited-budget switch from live or plain config values', () => {
  assert.equal(readUnlimitedBudgetEnabled(undefined), true);
  assert.equal(readUnlimitedBudgetEnabled(null), true);
  assert.equal(readUnlimitedBudgetEnabled({}), true);
  assert.equal(readUnlimitedBudgetEnabled({ injectUnlimitedBudgetPrompt: true }), true);
  assert.equal(readUnlimitedBudgetEnabled({ injectUnlimitedBudgetPrompt: false }), false);
  assert.equal(readUnlimitedBudgetEnabled({ injectUnlimitedBudgetPrompt: { get: () => true } }), true);
  assert.equal(readUnlimitedBudgetEnabled({ injectUnlimitedBudgetPrompt: { get: () => false } }), false);
  assert.equal(readUnlimitedBudgetEnabled({ injectUnlimitedBudgetPrompt: { get: () => undefined } }), true);
  assert.equal(readUnlimitedBudgetEnabled({
    injectUnlimitedBudgetPrompt: {
      get() {
        throw new Error('the live config is unavailable');
      },
    },
  }), true);
  assert.equal(readUnlimitedBudgetEnabled({
    get injectUnlimitedBudgetPrompt() {
      throw new Error('the live config is unavailable');
    },
  }), true);
});

test('active plan mode renders the guidance and inactive plan mode renders nothing', () => {
  assert.equal(sectionText(() => planModeOf({ active: true })), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(sectionText(() => planModeOf({ active: false })), '');
});

test('a pending selection wins over the logged state, matching plan:policy', () => {
  assert.equal(sectionText(() => planModeOf({ active: false, pending: true })), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(sectionText(() => planModeOf({ active: true, pending: false })), '');
});

test('missing services, agents, or state degrade to empty text', () => {
  assert.equal(sectionText(undefined), '');
  assert.equal(sectionText(() => undefined), '');
  assert.equal(sectionText(() => ({ get: () => undefined })), '');
  assert.equal(sectionText(() => ({
    get() {
      throw new Error('plan projection is unavailable');
    },
  })), '');

  const systemPrompt = createSystemPrompt();
  registerPlanEvidenceSection({ systemPrompt, getPlanMode: () => planModeOf({ active: true }) });
  const [section] = systemPrompt.sections;
  assert.equal(section.text({}), '');
  assert.equal(section.text(), '');
  assert.equal(section.text({ agent: null }), '');
});

test('registers great-plan:plan-evidence right after the native plan policy', () => {
  const systemPrompt = createSystemPrompt();
  const planMode = planModeOf({ active: true });
  const dispose = registerPlanEvidenceSection({ systemPrompt, getPlanMode: () => planMode });

  assert.equal(typeof dispose, 'function');
  assert.equal(systemPrompt.sections.length, 1);
  const [section] = systemPrompt.sections;
  assert.equal(section.name, PLAN_EVIDENCE_SECTION);
  assert.equal(section.name, 'great-plan:plan-evidence');
  assert.equal(section.order, 501);
  assert.equal(typeof section.text, 'function');
  assert.equal(section.text({ agent: AGENT }), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(section.text({}), '');
  assert.equal(section.text(), '');
});

test('an unreadable plan-mode read degrades the section to empty text', () => {
  const systemPrompt = createSystemPrompt();
  registerPlanEvidenceSection({
    systemPrompt,
    getPlanMode: () => {
      throw new Error('plan mode service is unavailable');
    },
  });

  assert.equal(systemPrompt.sections[0].text({ agent: AGENT }), '');
});

test('the registered section reads agent-scoped plan state when the host read fails', () => {
  // Regression: the section used to render empty because the host-plane
  // planMode cannot see preset-scoped plan state.
  const systemPrompt = createSystemPrompt();
  registerPlanEvidenceSection({
    systemPrompt,
    getPlanMode: () => {
      throw new Error('host plan mode cannot see preset state');
    },
  });

  const [section] = systemPrompt.sections;
  assert.equal(section.text({ agent: scopedAgent({ active: true }) }), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(section.text({ agent: scopedAgent({ active: false }) }), '');
});

test('the registered section falls back to the plan projection when every planMode read fails', () => {
  const systemPrompt = createSystemPrompt();
  registerPlanEvidenceSection({
    systemPrompt,
    getPlanMode: () => {
      throw new Error('host plan mode cannot see preset state');
    },
    getSessionProjections: () => projectionsOf({ active: true }),
  });

  const [section] = systemPrompt.sections;
  assert.equal(section.text({ agent: AGENT }), PLAN_EVIDENCE_GUIDANCE);
  // An agent with a scoped inactive service stays empty even with an active projection.
  assert.equal(section.text({ agent: scopedAgent({ active: false }) }), '');
});

test('the registered section follows both live switches without re-registering', () => {
  const systemPrompt = createSystemPrompt();
  const planMode = planModeOf({ active: true });
  const config = {
    injectBrainstormingPrompt: { get: () => true },
    injectUnlimitedBudgetPrompt: { get: () => true },
  };
  registerPlanEvidenceSection({ systemPrompt, getPlanMode: () => planMode, getConfig: () => config });

  const [section] = systemPrompt.sections;
  assert.equal(section.text({ agent: AGENT }), PLAN_EVIDENCE_GUIDANCE);

  config.injectBrainstormingPrompt = { get: () => false };
  assert.equal(section.text({ agent: AGENT }), composePlanGuidance({ brainstorming: false }));

  config.injectBrainstormingPrompt = { get: () => true };
  config.injectUnlimitedBudgetPrompt = { get: () => false };
  assert.equal(section.text({ agent: AGENT }), composePlanGuidance({ unlimitedBudget: false }));

  config.injectBrainstormingPrompt = { get: () => false };
  assert.equal(section.text({ agent: AGENT }), PLAN_HANDOFF_GUIDANCE);

  config.injectBrainstormingPrompt = { get: () => true };
  config.injectUnlimitedBudgetPrompt = { get: () => true };
  assert.equal(section.text({ agent: AGENT }), PLAN_EVIDENCE_GUIDANCE);
});

test('an unreadable config read degrades to the default guidance', () => {
  const systemPrompt = createSystemPrompt();
  registerPlanEvidenceSection({
    systemPrompt,
    getPlanMode: () => planModeOf({ active: true }),
    getConfig: () => {
      throw new Error('the plugin config is unavailable');
    },
  });

  assert.equal(systemPrompt.sections[0].text({ agent: AGENT }), PLAN_EVIDENCE_GUIDANCE);
});

test('derives the order from the native plan policy position', () => {
  const systemPrompt = createSystemPrompt(777);
  registerPlanEvidenceSection({ systemPrompt, getPlanMode: () => undefined });

  assert.equal(systemPrompt.sections[0].order, 778);
});

test('falls back to the static order when PLAN_POLICY is unresolved', () => {
  const systemPrompt = createSystemPrompt(Number.NaN);
  registerPlanEvidenceSection({ systemPrompt, getPlanMode: () => undefined });

  assert.equal(PLAN_EVIDENCE_ORDER_FALLBACK, 501);
  assert.equal(systemPrompt.sections[0].order, PLAN_EVIDENCE_ORDER_FALLBACK);
});

test('registration survives an unavailable central order table', () => {
  const systemPrompts = [
    {
      section(section) {
        this.registered = section;
        return () => {};
      },
    },
    {
      getSectionOrder() {
        throw new Error('the central order table is unavailable');
      },
      section(section) {
        this.registered = section;
        return () => {};
      },
    },
  ];

  for (const systemPrompt of systemPrompts) {
    registerPlanEvidenceSection({ systemPrompt, getPlanMode: () => undefined });
    assert.equal(systemPrompt.registered.order, PLAN_EVIDENCE_ORDER_FALLBACK);
  }
});

test('apply registers the compact command, the evidence section, and the settings policy', () => {
  const commands = [];
  const sections = [];
  const policies = [];
  const planMode = planModeOf({ active: true });
  const config = {
    injectBrainstormingPrompt: { get: () => false },
    injectUnlimitedBudgetPrompt: { get: () => false },
  };
  const ctx = {
    fiber: Symbol('great-plan fiber'),
    get(name) {
      return name === 'planMode' ? planMode : undefined;
    },
    inject(dependencies, callback) {
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
            getSectionOrder: () => 500,
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

  apply(ctx, config);

  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'great-plan-compact');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'great-plan:plan-evidence');
  assert.equal(sections[0].order, 501);
  assert.equal(sections[0].text({ agent: AGENT }), PLAN_HANDOFF_GUIDANCE);
  assert.deepEqual(policies, [{ presentation: { auto: false }, owner: ctx.fiber }]);
});

test('apply lets the evidence section fall back to the plan projection when planMode fails', () => {
  const sections = [];
  const ctx = {
    fiber: Symbol('great-plan fiber'),
    get(name) {
      if (name === 'planMode') throw new Error('host plan mode is unavailable');
      if (name === 'sessionProjections') return projectionsOf({ active: true });
      return undefined;
    },
    inject(dependencies, callback) {
      if (dependencies.includes('commands')) {
        callback({
          commands: {
            register() {
              return () => {};
            },
          },
        });
      }
      if (dependencies.includes('systemPrompt')) {
        callback({
          systemPrompt: {
            getSectionOrder: () => 500,
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
            configure() {
              return () => {};
            },
          },
        });
      }
    },
  };

  apply(ctx, {
    injectBrainstormingPrompt: { get: () => true },
    injectUnlimitedBudgetPrompt: { get: () => true },
  });

  assert.equal(sections.length, 1);
  assert.equal(sections[0].text({ agent: AGENT }), PLAN_EVIDENCE_GUIDANCE);
});
