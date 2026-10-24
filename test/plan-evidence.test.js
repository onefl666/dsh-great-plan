import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../index.js';
import {
  PLAN_EVIDENCE_GUIDANCE,
  PLAN_EVIDENCE_ORDER_FALLBACK,
  PLAN_EVIDENCE_SECTION,
  planEvidenceText,
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

test('guidance covers background, evidence chain, handoff, and anti-fabrication rules', () => {
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Background/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Evidence chain/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /Handoff/);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /assumption/i);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /never invent/i);
  assert.match(PLAN_EVIDENCE_GUIDANCE, /re-?investigat|repeat this investigation/i);
  assert.ok(PLAN_EVIDENCE_GUIDANCE.length > 400, 'guidance must carry substantial handoff instructions');
  assert.ok(PLAN_EVIDENCE_GUIDANCE.length < 2000, 'guidance must stay compact');
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

test('apply registers the compact command and the evidence prompt section', () => {
  const commands = [];
  const sections = [];
  const planMode = planModeOf({ active: true });
  const ctx = {
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
    },
  };

  apply(ctx);

  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'great-plan-compact');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'great-plan:plan-evidence');
  assert.equal(sections[0].order, 501);
  assert.equal(sections[0].text({ agent: AGENT }), PLAN_EVIDENCE_GUIDANCE);
});
