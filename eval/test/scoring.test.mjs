/**
 * Offline tests for the scoring subsystem: plan extraction and arm markers,
 * path citations, clarification/delegation/quality statistics, aggregation,
 * and the exact statistics helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARM_MARKER_STRINGS,
  MARKER_BRAINSTORMING,
  MARKER_BUDGET,
  MARKER_HANDOFF,
  MARKER_TEAM_LEAD,
  armMarkers,
  checkArmIntegrity,
  expectedMarkers,
  extractPlan,
  planTextFromArgs,
  planTextFromDetail,
} from '../interactive-swe/score/plan.mjs';
import { extractPathRefs, resolvePathRefs } from '../interactive-swe/score/paths.mjs';
import { clarificationStats } from '../interactive-swe/score/clarify.mjs';
import { delegationStats } from '../interactive-swe/score/delegation.mjs';
import { assumptionStats, handoffStats, qualityStats } from '../interactive-swe/score/quality.mjs';
import { scoreRun, scoreTask } from '../interactive-swe/score/aggregate.mjs';
import { mcnemar } from '../interactive-swe/score/mcnemar.mjs';
import { bootstrapMeanCI, mulberry32, percentile } from '../interactive-swe/score/bootstrap.mjs';
import {
  DEFAULT_PLAN,
  SYSTEM_PROMPTS,
  makeTempDir,
  planModeEvent,
  toolCallEvent,
  writeRun,
  writeTask,
  writeText,
} from './fixtures/score/fixtures.mjs';

test('path extractor accepts path references and ranges', () => {
  const refs = extractPathRefs('See lib/host/plan-evidence.js:19-39 and b.mjs:3 and docs/README:2.');
  assert.equal(refs.length, 3);
  assert.deepEqual(
    refs.map((ref) => [ref.path, ref.startLine, ref.endLine]),
    [
      ['lib/host/plan-evidence.js', 19, 39],
      ['b.mjs', 3, null],
      ['docs/README', 2, null],
    ],
  );
});

test('path extractor ignores URLs, times, fenced code, and host:port pairs', () => {
  assert.deepEqual(extractPathRefs('https://example.com/x.js:12 and http://localhost:8080/a.js:3'), []);
  assert.deepEqual(extractPathRefs('The meeting is at 12:30, not a citation.'), []);
  assert.deepEqual(extractPathRefs('```js\nconst x = f.js:3;\n```\n'), []);
  assert.deepEqual(extractPathRefs('www.example.com:8080'), []);
});

test('path resolution classifies resolved, out-of-bounds, phantom, unsafe, and no-root', (t) => {
  const root = makeTempDir(t, 'paths');
  writeText(path.join(root, 'src/a.js'), 'one\ntwo\nthree\nfour\nfive\n');
  writeText(path.join(root, 'docs/README'), 'readme one\nreadme two\n');
  const text =
    '`src/a.js:2` `src/a.js:4-5` `src/b.js:99` `src/a.js:9` `../escape.js:1` `docs/README:2`';
  const refs = extractPathRefs(text);
  const { refs: resolved, stats } = resolvePathRefs({
    refs,
    root,
    toolCalls: [{ name: 'read_file', argsRaw: JSON.stringify({ path: 'src/a.js' }) }],
    textLength: 1000,
  });
  assert.equal(stats.total, 6);
  assert.equal(stats.resolved, 3);
  assert.equal(stats.phantom, 1);
  assert.equal(stats.outOfBounds, 1);
  assert.equal(stats.unsafe, 1);
  assert.equal(stats.noRoot, 0);
  assert.equal(stats.corroborated, 3);
  assert.equal(stats.resolvedCorroborated, 2);
  assert.equal(stats.density, 6);
  assert.equal(stats.resolutionRate, 0.5);
  const byPath = new Map(resolved.map((ref) => [ref.raw, ref]));
  assert.equal(byPath.get('src/a.js:2').status, 'resolved');
  assert.equal(byPath.get('src/a.js:4-5').status, 'resolved');
  assert.equal(byPath.get('src/b.js:99').status, 'phantom');
  assert.equal(byPath.get('src/a.js:9').status, 'out-of-bounds');
  assert.equal(byPath.get('../escape.js:1').status, 'unsafe');
  assert.equal(byPath.get('docs/README:2').status, 'resolved');
  assert.equal(byPath.get('src/a.js:2').corroborated, true);
});

test('basename-only refs resolve uniquely and ambiguous names stay ambiguous', (t) => {
  const root = makeTempDir(t, 'paths-basename');
  writeText(path.join(root, 'src/a.js'), 'one\ntwo\n');
  writeText(path.join(root, 'lib/b.js'), 'one\n');
  writeText(path.join(root, 'one/dup.py'), 'one\n');
  writeText(path.join(root, 'two/dup.py'), 'one\n');
  const text = '`a.js:2` `b.js:1` `dup.py:1` `missing.py:1`';
  const { refs, stats } = resolvePathRefs({ refs: extractPathRefs(text), root });
  assert.equal(stats.resolved, 2);
  assert.equal(stats.basenameResolved, 2);
  assert.equal(stats.ambiguous, 1);
  assert.equal(stats.phantom, 1);
  const byRaw = new Map(refs.map((ref) => [ref.raw, ref]));
  assert.equal(byRaw.get('a.js:2').status, 'resolved');
  assert.equal(byRaw.get('a.js:2').resolution, 'basename');
  assert.equal(byRaw.get('b.js:1').status, 'resolved');
  assert.equal(byRaw.get('dup.py:1').status, 'ambiguous');
  assert.equal(byRaw.get('missing.py:1').status, 'phantom');
});

test('path resolution rejects absolute refs and symlink escapes', (t) => {
  const root = makeTempDir(t, 'paths-safe');
  const outside = makeTempDir(t, 'paths-outside');
  writeText(path.join(outside, 'secret.js'), 'secret\n');
  writeText(path.join(root, 'inside.js'), 'inside\n');
  try {
    fs.symlinkSync(path.join(outside, 'secret.js'), path.join(root, 'link.js'));
  } catch {
    // eslint-disable-next-line no-console
    console.warn('symlink unavailable on this filesystem; skipping symlink assertion');
  }
  const { refs, stats } = resolvePathRefs({
    refs: [
      { path: '/etc/passwd', startLine: 1, endLine: null },
      { path: 'link.js', startLine: 1, endLine: null },
      { path: 'inside.js', startLine: 1, endLine: null },
    ],
    root,
  });
  assert.equal(refs[0].status, 'unsafe');
  if (fs.existsSync(path.join(root, 'link.js'))) {
    assert.equal(refs[1].status, 'unsafe');
    assert.equal(refs[1].reason, 'symlink-escape');
  }
  assert.equal(refs[2].status, 'resolved');
  assert.equal(stats.unsafe >= 1, true);
});

test('path resolution without a worktree marks every ref no-root', () => {
  const refs = extractPathRefs('src/a.js:2');
  const { refs: resolved, stats } = resolvePathRefs({ refs, root: null });
  assert.equal(stats.noRoot, 1);
  assert.equal(stats.resolved, 0);
  assert.equal(resolved[0].status, 'no-root');
});

test('plan text prefers the review detail and cross-checks exit_plan_mode args', () => {
  const session = {
    toolCalls: [{ name: 'exit_plan_mode', args: { plan: 'PLAN FROM ARGS' }, argsRaw: null }],
  };
  const matching = extractPlan({ planReview: { detail: { plan: 'PLAN FROM ARGS' } }, session });
  assert.equal(matching.text, 'PLAN FROM ARGS');
  assert.equal(matching.source, 'plan-review');
  assert.equal(matching.submitted, true);
  assert.equal(matching.crossCheck.matches, true);
  assert.equal(matching.crossCheck.argsText, true);

  const mismatched = extractPlan({ planReview: { detail: { plan: 'PLAN FROM DETAIL' } }, session });
  assert.equal(mismatched.text, 'PLAN FROM DETAIL');
  assert.equal(mismatched.crossCheck.matches, false);

  const fileFallback = extractPlan({ planText: 'FROM PLAN FILE' });
  assert.equal(fileFallback.source, 'plan-file');
  assert.equal(fileFallback.submitted, false);

  const argsFallback = extractPlan({ session });
  assert.equal(argsFallback.source, 'exit-plan-mode-args');
  assert.equal(argsFallback.text, 'PLAN FROM ARGS');
});

test('plan text falls back to the wire plan-review request', () => {
  const wire = [
    { dir: 'out', kind: 'response', payload: { detail: { plan: 'WRONG' } } },
    {
      dir: 'in',
      kind: 'request',
      method: 'user-question/ask',
      payload: { requestId: 'r1', question: 'Q?', options: [{ label: 'Approve' }], detail: { plan: 'WIRE PLAN' } },
    },
  ];
  const plan = extractPlan({ wire });
  assert.equal(plan.text, 'WIRE PLAN');
  assert.equal(plan.source, 'wire');
  assert.equal(plan.review.requestId, 'r1');
  assert.equal(plan.review.question, 'Q?');
});

test('plan review detail shapes are accepted defensively', () => {
  assert.equal(planTextFromDetail('plain'), 'plain');
  assert.equal(planTextFromDetail({ plan: 'a' }), 'a');
  assert.equal(planTextFromDetail({ plan: { text: 'b' } }), 'b');
  assert.equal(planTextFromDetail({ content: [{ type: 'text', text: 'c' }] }), 'c');
  assert.equal(planTextFromDetail(null), '');
  assert.equal(planTextFromArgs({ plan_text: 'raw' }), 'raw');
  assert.equal(planTextFromArgs('{"plan":"json"}'), 'json');
});

test('arm markers use the exact plugin guidance strings', () => {
  assert.equal(ARM_MARKER_STRINGS.budget, MARKER_BUDGET);
  assert.equal(ARM_MARKER_STRINGS.brainstorming, MARKER_BRAINSTORMING);
  assert.equal(ARM_MARKER_STRINGS.teamLead, MARKER_TEAM_LEAD);
  assert.equal(ARM_MARKER_STRINGS.handoff, MARKER_HANDOFF);
  const full = armMarkers(SYSTEM_PROMPTS.full);
  assert.deepEqual(full, { budget: true, brainstorming: true, teamLead: true, handoff: true });
  const evidence = armMarkers(SYSTEM_PROMPTS.evidence);
  assert.deepEqual(evidence, { budget: true, brainstorming: false, teamLead: false, handoff: true });
  assert.deepEqual(armMarkers(SYSTEM_PROMPTS.native), {
    budget: false,
    brainstorming: false,
    teamLead: false,
    handoff: false,
  });
});

test('expected markers differ per arm and unknown arms are rejected', () => {
  assert.deepEqual(expectedMarkers('native'), {
    budget: false,
    brainstorming: false,
    teamLead: false,
    handoff: false,
  });
  assert.deepEqual(expectedMarkers('evidence'), {
    budget: true,
    brainstorming: false,
    teamLead: false,
    handoff: true,
  });
  assert.deepEqual(expectedMarkers('full'), {
    budget: true,
    brainstorming: true,
    teamLead: true,
    handoff: true,
  });
  assert.throws(() => expectedMarkers('mystery'), /unknown arm/);
});

test('arm integrity reports missing and unexpected markers', () => {
  assert.equal(checkArmIntegrity('full', SYSTEM_PROMPTS.full).ok, true);
  assert.equal(checkArmIntegrity('evidence', SYSTEM_PROMPTS.evidence).ok, true);
  assert.equal(checkArmIntegrity('native', SYSTEM_PROMPTS.native).ok, true);
  const evidenceOnFull = checkArmIntegrity('evidence', SYSTEM_PROMPTS.full);
  assert.equal(evidenceOnFull.ok, false);
  assert.deepEqual(evidenceOnFull.unexpected.sort(), ['brainstorming', 'teamLead']);
  const fullOnEvidence = checkArmIntegrity('full', SYSTEM_PROMPTS.evidence);
  assert.equal(fullOnEvidence.ok, false);
  assert.deepEqual(fullOnEvidence.missing.sort(), ['brainstorming', 'teamLead']);
});

test('clarification stats combine question rows and tool calls', () => {
  const session = {
    toolCalls: [
      { name: 'ask_user_question', args: { questions: [{ id: 'q1' }] } },
      { name: 'ask_user_question', args: { questions: [{ id: 'q1' }, { id: 'q2' }] } },
      { name: 'read_file', args: {} },
    ],
  };
  const questions = [
    {
      requestId: 'r1',
      questions: [{ id: 'q1' }],
      decision: 'answer',
      answers: [{ id: 'q1', selected: ['A'] }],
      capHit: false,
    },
    {
      requestId: 'r2',
      questions: [{ id: 'q1' }, { id: 'q2' }],
      decision: 'cancel',
      answers: [],
      capHit: true,
    },
  ];
  const stats = clarificationStats({ session, questions });
  assert.equal(stats.askCalls, 2);
  assert.equal(stats.askCount, 2);
  assert.equal(stats.questionRows, 2);
  assert.equal(stats.totalQuestions, 3);
  assert.deepEqual(stats.distribution, { '1': 1, '2': 1 });
  assert.equal(stats.oneQuestionCalls, 1);
  assert.equal(stats.oneQuestionRatio, 0.5);
  assert.equal(stats.maxQuestions, 2);
  assert.equal(stats.decisionCounts.answer, 1);
  assert.equal(stats.decisionCounts.cancel, 1);
  assert.equal(stats.answeredQuestions, 1);
  assert.equal(stats.capHits, 1);
  assert.equal(stats.taskWithAsk, true);

  const toolOnly = clarificationStats({ session: { toolCalls: session.toolCalls.slice(0, 1) }, questions: [] });
  assert.equal(toolOnly.askCount, 1);
  assert.equal(toolOnly.totalQuestions, 1);

  const empty = clarificationStats({});
  assert.equal(empty.askCalls, 0);
  assert.equal(empty.oneQuestionRatio, null);
  assert.equal(empty.taskWithAsk, false);
});

test('clarification stats exclude the plan-review exchange', () => {
  const stats = clarificationStats({
    questions: [
      { requestId: 'r1', questions: [{ id: 'plan-review', intent: { kind: 'plan-review' } }], decision: 'cancel', answers: [] },
      { requestId: 'r2', questions: [{ id: 'q1' }], decision: 'answer', answers: [{ id: 'q1', selected: ['a'] }] },
    ],
    session: { toolCalls: [] },
  });
  assert.equal(stats.planReviewRows, 1);
  assert.equal(stats.planReviewCancelled, 1);
  assert.equal(stats.questionRows, 1);
  assert.equal(stats.askCalls, 0);
  assert.equal(stats.taskWithAsk, true);
  assert.equal(stats.cancelledCalls, 0);
  assert.equal(stats.answeredCalls, 1);
  assert.deepEqual(stats.distribution, { '1': 1 });
  const reviewOnly = clarificationStats({
    questions: [{ requestId: 'r3', questions: [{ id: 'plan-review' }], decision: 'cancel', answers: [] }],
    session: { toolCalls: [] },
  });
  assert.equal(reviewOnly.taskWithAsk, false);
  assert.equal(reviewOnly.askCount, 0);
  assert.deepEqual(reviewOnly.distribution, {});
});

test('delegation stats recover names, parallel groups, and the planning teammate', () => {
  const session = {
    toolCalls: [
      { name: 'spawn_teammate', args: { name: 'explore-a', prompt: 'Investigate the parser' }, turn: 1, step: 3 },
      { name: 'spawn_teammate', args: { name: 'explore-b', prompt: 'Investigate the writer' }, turn: 1, step: 3 },
      { name: 'spawn_teammate', args: { name: 'planner', prompt: 'Draft a candidate plan' }, turn: 2, step: 1 },
      { name: 'read_file', args: {} },
    ],
    teamMembers: [{ id: 'm1' }],
    teamTasks: [{ id: 't1' }, { id: 't2' }],
  };
  const stats = delegationStats({ session });
  assert.equal(stats.spawnCalls, 3);
  assert.equal(stats.uniqueNameCount, 3);
  assert.deepEqual(stats.uniqueNames, ['explore-a', 'explore-b', 'planner']);
  assert.equal(stats.parallelGroups, 1);
  assert.equal(stats.maxParallel, 2);
  assert.equal(stats.callsInParallel, 2);
  assert.equal(stats.planningTeammates, 1);
  assert.deepEqual(stats.planningCandidates, ['planner']);
  assert.equal(stats.teamMembers, 1);
  assert.equal(stats.teamTasks, 2);
  assert.equal(stats.teamEvents, 3);

  assert.equal(delegationStats({}).spawnCalls, 0);
  assert.equal(delegationStats({}).anyDelegation, false);
});

test('quality stats detect handoff structure and assumption markers', () => {
  const handoff = handoffStats(DEFAULT_PLAN);
  assert.equal(handoff.hasBackground, true);
  assert.equal(handoff.hasEvidence, true);
  assert.equal(handoff.hasHandoff, true);
  assert.equal(handoff.hasSettled, true);
  assert.equal(handoff.citationCount, 2);
  assert.equal(handoff.score, 1);

  const assumptions = assumptionStats(DEFAULT_PLAN);
  assert.equal(assumptions.hasAssumptions, true);
  assert.equal(assumptions.hasOpenQuestions, true);
  assert.equal(assumptions.hasUnverified, true);
  assert.equal(assumptions.count >= 3, true);

  const plain = assumptionStats('Just do it.');
  assert.equal(plain.hasAssumptions, false);
  assert.equal(plain.count, 0);

  const combined = qualityStats(DEFAULT_PLAN);
  assert.equal(combined.handoff.hasHandoff, true);
  assert.equal(combined.assumptions.hasAssumptions, true);
});

test('McNemar exact two-sided p-values match known values', () => {
  assert.equal(mcnemar(0, 0).p, 1);
  assert.equal(mcnemar(1, 0).p, 1);
  assert.equal(mcnemar(2, 0).p, 0.5);
  assert.equal(mcnemar(3, 1).p, 0.625);
  assert.equal(mcnemar(10, 2).p, 0.03857421875);
  assert.equal(mcnemar(5, 5).p, 1);
  assert.equal(mcnemar(2, 7).p, mcnemar(7, 2).p);
  const large = mcnemar(600, 400);
  assert.equal(large.p > 0 && large.p < 0.01, true);
  const veryLarge = mcnemar(800, 600);
  assert.equal(veryLarge.p >= 0 && veryLarge.p <= 1, true);
  assert.throws(() => mcnemar(-1, 0), TypeError);
  assert.throws(() => mcnemar(1.5, 0), TypeError);
});

test('bootstrap interval is deterministic for a fixed seed', () => {
  const values = [1, 2, 3, 4];
  const first = bootstrapMeanCI(values, { seed: 7, iterations: 200 });
  const second = bootstrapMeanCI(values, { seed: 7, iterations: 200 });
  assert.deepEqual(first, second);
  assert.equal(first.mean, 2.5);
  assert.equal(first.n, 4);
  assert.equal(first.iterations, 200);
  assert.equal(first.low <= first.mean && first.mean <= first.high, true);

  const otherSeed = bootstrapMeanCI(values, { seed: 8, iterations: 200 });
  assert.equal(otherSeed.mean, 2.5);

  const empty = bootstrapMeanCI([]);
  assert.equal(empty.mean, null);
  assert.equal(empty.n, 0);

  const single = bootstrapMeanCI([4], { seed: 1 });
  assert.equal(single.low, 4);
  assert.equal(single.high, 4);

  const noIterations = bootstrapMeanCI(values, { seed: 1, iterations: 0 });
  assert.equal(noIterations.low, 2.5);
  assert.equal(noIterations.high, 2.5);

  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
  const rngA = mulberry32(42);
  const rngB = mulberry32(42);
  assert.equal(rngA(), rngB());
});

test('scoreTask aggregates plan, citations, clarify, delegation, and quality', (t) => {
  const root = makeTempDir(t, 'aggregate');
  const worktree = path.join(root, 'worktree');
  writeText(path.join(worktree, 'src/a.js'), 'one\ntwo\nthree\nfour\nfive\n');
  const runDir = writeRun(root, {
    runId: 'run-evidence',
    arm: 'evidence',
    tasks: [
      {
        instanceId: 'task-1',
        arm: 'evidence',
        worktree,
        plan: DEFAULT_PLAN,
        askCalls: [{ questions: [{ id: 'q1', question: 'Retry?' }], turn: 1, step: 2 }],
        questions: [
          {
            requestId: 'r1',
            questions: [{ id: 'q1', question: 'Retry?' }],
            decision: 'answer',
            answers: [{ id: 'q1', selected: ['Yes'] }],
            capHit: false,
          },
        ],
        spawnCalls: [{ args: { name: 'planner', prompt: 'Draft a candidate plan' }, turn: 1, step: 1 }],
        extraEvents: [toolCallEvent(0, 'read_file', { path: 'src/a.js' })],
      },
      {
        instanceId: 'task-2',
        arm: 'evidence',
        plan: 'Short plan without structured sections.',
        omit: ['plan-review.json', 'wire.ndjson'],
      },
    ],
  });
  const taskOne = scoreTask(path.join(runDir, 'tasks', 'task-1'));
  assert.equal(taskOne.instanceId, 'task-1');
  assert.equal(taskOne.arm, 'evidence');
  assert.equal(taskOne.status, 'ok');
  assert.equal(taskOne.plan.present, true);
  assert.equal(taskOne.plan.source, 'plan-review');
  assert.equal(taskOne.plan.submitted, true);
  assert.equal(taskOne.plan.crossCheck.matches, true);
  assert.equal(taskOne.plan.integrity.ok, true);
  assert.equal(taskOne.markersSource, 'system-prompt');
  assert.deepEqual(taskOne.markers, { budget: true, brainstorming: false, teamLead: false, handoff: true });
  assert.equal(taskOne.citations.total, 2);
  assert.equal(taskOne.citations.resolved, 1);
  assert.equal(taskOne.citations.phantom, 1);
  assert.equal(taskOne.citations.corroborated, 1);
  assert.equal(taskOne.clarify.askCount, 1);
  assert.equal(taskOne.delegation.spawnCalls, 1);
  assert.equal(taskOne.delegation.planningTeammates, 1);
  assert.equal(taskOne.quality.handoff.hasHandoff, true);
  assert.equal(taskOne.execution.resolved, null);
  assert.deepEqual(taskOne.errors, []);

  const taskTwo = scoreTask(path.join(runDir, 'tasks', 'task-2'));
  assert.equal(taskTwo.plan.source, 'plan-file');
  assert.equal(taskTwo.citations.total, 0);
  assert.equal(taskTwo.citations.resolutionRate, null);
  assert.equal(taskTwo.warnings.includes('missing plan-review.json'), true);

  const scored = scoreRun(runDir);
  assert.equal(scored.manifest.arm, 'evidence');
  assert.deepEqual(scored.tasks.map((task) => task.instanceId), ['task-1', 'task-2']);
  assert.equal(scored.tasks[0].usage.inputTokens, 100);
});

test('scoreTask falls back to the plan-time citation snapshot when the worktree is gone', (t) => {
  const root = makeTempDir(t, 'snapshot');
  const taskRoot = path.join(root, 'run', 'tasks');
  const taskDir = writeTask(taskRoot, 'task-1', {
    worktree: path.join(root, 'removed-worktree'),
    citations: {
      refs: [{ raw: 'a.py:1', path: 'a.py', startLine: 1, endLine: null, resolved: true, status: 'resolved' }],
      stats: {
        total: 1,
        unique: 1,
        resolved: 1,
        outOfBounds: 0,
        phantom: 0,
        unsafe: 0,
        noRoot: 0,
        ambiguous: 0,
        basenameResolved: 0,
        corroborated: 1,
        resolvedCorroborated: 1,
        resolutionRate: 1,
        corroborationRate: 1,
        density: 1,
      },
    },
  });
  const metrics = scoreTask(taskDir);
  assert.equal(metrics.citations.source, 'snapshot');
  assert.equal(metrics.citations.total, 1);
  assert.equal(metrics.citations.resolved, 1);
  assert.equal(metrics.citations.noRoot, 0);
});

test('scoreTask tolerates missing and malformed artifacts', (t) => {
  const root = makeTempDir(t, 'aggregate-bad');
  const runDir = writeRun(root, { runId: 'run-bad', arm: 'full', tasks: [] });
  const brokenDir = path.join(runDir, 'tasks', 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  const broken = scoreTask(brokenDir);
  assert.equal(broken.status, 'scoring_error');
  assert.equal(broken.instanceId, 'broken');
  assert.equal(broken.errors.includes('missing meta.json'), true);
  assert.equal(broken.errors.includes('missing events.jsonl'), true);
  assert.equal(broken.errors.includes('missing plan text'), true);

  const malformedDir = path.join(runDir, 'tasks', 'malformed');
  fs.mkdirSync(malformedDir, { recursive: true });
  fs.writeFileSync(path.join(malformedDir, 'meta.json'), '{not json');
  fs.writeFileSync(path.join(malformedDir, 'events.jsonl'), 'not json\n');
  const malformed = scoreTask(malformedDir);
  assert.equal(malformed.errors.includes('invalid meta.json'), true);
  assert.equal(malformed.errors.some((error) => error.startsWith('invalid events.jsonl')), true);

  assert.equal(scoreTask(path.join(root, 'nope')).status, 'scoring_error');
  assert.equal(scoreRun(path.join(root, 'missing-run')).manifest, null);
  assert.deepEqual(scoreRun(path.join(root, 'missing-run')).tasks, []);
});

test('scoreTask flags arm-marker mismatches in the injected system prompt', (t) => {
  const root = makeTempDir(t, 'integrity');
  const runDir = writeRun(root, { runId: 'run-mismatch', arm: 'evidence', tasks: [] });
  writeTask(path.join(runDir, 'tasks'), 'mismatch', {
    arm: 'evidence',
    systemText: SYSTEM_PROMPTS.full,
  });
  writeTask(path.join(runDir, 'tasks'), 'unverified', {
    arm: 'full',
    systemText: '',
  });
  const mismatch = scoreTask(path.join(runDir, 'tasks', 'mismatch'));
  assert.equal(mismatch.plan.integrity.ok, false);
  assert.deepEqual(mismatch.plan.integrity.unexpected.sort(), ['brainstorming', 'teamLead']);
  const unverified = scoreTask(path.join(runDir, 'tasks', 'unverified'));
  assert.equal(unverified.plan.integrity.ok, null);
  assert.equal(unverified.plan.integrity.reason, 'missing-system-prompt');
});

test('session order extraction tolerates unknown events', () => {
  const session = { toolCalls: [], planModes: [{ seq: 1, active: true }] };
  assert.equal(planModeEvent(1, true).type, 'plan/mode');
  assert.deepEqual(delegationStats({ session }).uniqueNames, []);
});
