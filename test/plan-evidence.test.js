import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../host/apply.js';
import {
  PLAN_BRAINSTORMING_GUIDANCE,
  PLAN_EVIDENCE_GUIDANCE,
  PLAN_EVIDENCE_ORDER_FALLBACK,
  PLAN_EVIDENCE_SECTION,
  PLAN_HANDOFF_GUIDANCE,
  PLAN_UNLIMITED_BUDGET_GUIDANCE,
  composePlanGuidance,
  planEvidenceText,
  readBrainstormingEnabled,
  readUnlimitedBudgetEnabled,
  registerPlanEvidenceSection,
} from '../host/plan-evidence.js';

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
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Background/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Evidence chain/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Handoff/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /assumption/i);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /never invent/i);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /re-?investigat|repeat this investigation/i);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /one concise, open-ended question per turn/i);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /materially change/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /without needless questions/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /multiple plausible approaches/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /alternatives and tradeoffs/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /distinguish user-stated requirements/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /concise rationale summary, not private step-by-step chain-of-thought/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /native review flow/);
  assert.ok(PLAN_EVIDENCE_GUIDANCE.length > 400, 'guidance must carry substantial handoff instructions');
  assert.ok(PLAN_EVIDENCE_GUIDANCE.length < 3000, 'guidance must stay compact');
});

test('the unlimited-budget reminder asks for free spending without cutting the work', () => {
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /Token budget: unlimited/);
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /usage is unlimited/);
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /Do not skimp on tokens/);
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /spend freely/);
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /very wealthy/);
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /tool calls/);
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /necessary questions/);
  assert.match(PLAN_UNLIMITED_BUDGET_GUIDANCE, /keep the final plan concise/);
  assert.ok(PLAN_UNLIMITED_BUDGET_GUIDANCE.length < 400, 'the budget reminder must stay short');
});

test('the full guidance is exactly the default composition of its parts', () => {
  assert.equal(PLAN_EVIDENCE_GUIDANCE, composePlanGuidance());
  assert.equal(
    PLAN_EVIDENCE_GUIDANCE,
    `${PLAN_UNLIMITED_BUDGET_GUIDANCE}\n\n${PLAN_BRAINSTORMING_GUIDANCE}\n\n${PLAN_HANDOFF_GUIDANCE}`,
  );
  assert.match(PLAN_BRAINSTORMING_GUIDANCE, /one concise, open-ended question per turn/i);
  assert.match(PLAN_BRAINSTORMING_GUIDANCE, /alternatives and tradeoffs/);
  assert.match(PLAN_BRAINSTORMING_GUIDANCE, /native review flow/);
  assert.equal(PLAN_BRAINSTORMING_GUIDANCE.includes('Evidence chain'), false);
  assert.match(PLAN_HANDOFF_GUIDANCE, /Background/);
  assert.match(PLAN_HANDOFF_GUIDANCE, /Evidence chain/);
  assert.match(PLAN_HANDOFF_GUIDANCE, /Handoff/);
  assert.match(PLAN_HANDOFF_GUIDANCE, /never invent/i);
  assert.equal(PLAN_HANDOFF_GUIDANCE.includes('one concise, open-ended question'), false);
  assert.equal(PLAN_UNLIMITED_BUDGET_GUIDANCE.includes('Evidence chain'), false);
});

test('the fully enabled composition is the shared module constant', () => {
  assert.equal(composePlanGuidance({ brainstorming: true, unlimitedBudget: true }), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(composePlanGuidance({ brainstorming: true }), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(composePlanGuidance({ unlimitedBudget: true }), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(composePlanGuidance({ brainstorming: true, unlimitedBudget: true }), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(planEvidenceText(planModeOf({ active: true }), AGENT, true, true), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(planEvidenceText(planModeOf({ active: true, pending: true }), AGENT, true, true), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(sectionText(() => planModeOf({ active: true })), PLAN_EVIDENCE_GUIDANCE);
  assert.notEqual(composePlanGuidance({ brainstorming: false }), PLAN_EVIDENCE_GUIDANCE);
  assert.notEqual(composePlanGuidance({ unlimitedBudget: false }), PLAN_EVIDENCE_GUIDANCE);
});

function sectionText(getPlanMode) {
  const systemPrompt = createSystemPrompt();
  registerPlanEvidenceSection({ systemPrompt, getPlanMode });
  return systemPrompt.sections[0].text({ agent: AGENT });
}

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
  assert.equal(
    planEvidenceText(planModeOf({ active: true }), AGENT, false, true),
    `${PLAN_UNLIMITED_BUDGET_GUIDANCE}\n\n${PLAN_HANDOFF_GUIDANCE}`,
  );
  assert.equal(
    planEvidenceText(planModeOf({ active: true }), AGENT, true, false),
    `${PLAN_BRAINSTORMING_GUIDANCE}\n\n${PLAN_HANDOFF_GUIDANCE}`,
  );
  assert.equal(planEvidenceText(planModeOf({ active: true }), AGENT, false, false), PLAN_HANDOFF_GUIDANCE);
  assert.equal(planEvidenceText(planModeOf({ active: false }), AGENT, false, false), '');
  assert.equal(planEvidenceText(planModeOf({ active: true, pending: false }), AGENT, false, false), '');
  assert.equal(planEvidenceText(planModeOf({ active: false, pending: true }), AGENT, false, false), PLAN_HANDOFF_GUIDANCE);
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
  assert.equal(planEvidenceText(planModeOf({ active: true }), AGENT), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(planEvidenceText(planModeOf({ active: false }), AGENT), '');
});

test('a pending selection wins over the logged state, matching plan:policy', () => {
  assert.equal(planEvidenceText(planModeOf({ active: false, pending: true }), AGENT), PLAN_EVIDENCE_GUIDANCE);
  assert.equal(planEvidenceText(planModeOf({ active: true, pending: false }), AGENT), '');
});

test('missing services, agents, or state degrade to empty text', () => {
  assert.equal(planEvidenceText(undefined, AGENT), '');
  assert.equal(planEvidenceText(null, AGENT), '');
  assert.equal(planEvidenceText({}, AGENT), '');
  assert.equal(planEvidenceText({ get: () => ({ active: true }) }, undefined), '');
  assert.equal(planEvidenceText({ get: () => ({ active: true }) }, null), '');
  assert.equal(planEvidenceText({ get: () => undefined }, AGENT), '');
  assert.equal(planEvidenceText({
    get() {
      throw new Error('plan projection is unavailable');
    },
  }, AGENT), '');
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
