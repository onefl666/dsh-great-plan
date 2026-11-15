/**
 * Offline tests for the report builder and its Markdown/CSV renderers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scoreRun } from '../interactive-swe/score/aggregate.mjs';
import { buildReport, renderCsv, renderMarkdown } from '../interactive-swe/score/report.mjs';
import {
  DEFAULT_PLAN,
  SYSTEM_PROMPTS,
  makeTempDir,
  writeRun,
  writeTask,
} from './fixtures/score/fixtures.mjs';

const NOW = '2026-02-01T00:00:00.000Z';

/** Ask/spawn payload that exercises clarification and delegation metrics. */
const ASK_TASK = {
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
};

test('buildReport summarizes per-arm metrics, calibration, and paired deltas', (t) => {
  const root = makeTempDir(t, 'report');
  const nativeRun = writeRun(root, {
    runId: 'run-native',
    arm: 'native',
    tasks: [
      { instanceId: 'n1', arm: 'native', submitted: false, systemText: SYSTEM_PROMPTS.native },
      { instanceId: 'n2', arm: 'native', submitted: false, systemText: SYSTEM_PROMPTS.native },
    ],
  });
  const evidenceRun = writeRun(root, {
    runId: 'run-evidence',
    arm: 'evidence',
    tasks: [
      { instanceId: 'n1', arm: 'evidence', ...ASK_TASK },
      { instanceId: 'n2', arm: 'evidence' },
      { instanceId: 'e3', arm: 'evidence', plan: 'A short extra plan.' },
    ],
  });
  const fullRun = writeRun(root, {
    runId: 'run-full',
    arm: 'full',
    tasks: [
      { instanceId: 'n1', arm: 'full' },
      { instanceId: 'n2', arm: 'full' },
    ],
  });

  const scored = [scoreRun(nativeRun), scoreRun(evidenceRun), scoreRun(fullRun)];
  const report = buildReport(scored, { seed: 5, now: NOW });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAt, NOW);
  assert.equal(report.seed, 5);
  assert.deepEqual(report.armOrder, ['native', 'evidence', 'full']);
  assert.equal(report.perArm.native.tasks, 2);
  assert.equal(report.perArm.evidence.tasks, 3);
  assert.equal(report.perArm.full.tasks, 2);
  assert.equal(report.tasks.length, 7);

  assert.equal(report.perArm.evidence.plans.submitted, 3);
  assert.equal(report.perArm.native.markerIntegrity.rate, 1);
  assert.equal(report.perArm.evidence.markerIntegrity.matched, 3);
  assert.equal(report.perArm.evidence.clarify.tasksWithAsk, 1);
  assert.equal(report.perArm.evidence.delegation.spawnCalls, 1);
  assert.equal(report.perArm.evidence.quality.handoffRate, 0.6667);

  assert.deepEqual(
    report.calibration.markerExpectations.map((entry) => [entry.arm, entry.status, entry.rate]),
    [
      ['native', 'computed', 1],
      ['evidence', 'computed', 1],
      ['full', 'computed', 1],
    ],
  );
  assert.equal(report.validation.ok, true);
  assert.deepEqual(report.validation.missingArms, []);
  assert.equal(report.resolveRate.status, 'gated');

  const evidencePair = report.paired.find((pair) => pair.arm === 'evidence');
  assert.equal(evidencePair.status, 'computed');
  assert.equal(evidencePair.pairedCount, 2);
  assert.deepEqual(evidencePair.missingFromBaseline, ['e3']);
  const submitted = evidencePair.binary.planSubmitted;
  assert.equal(submitted.b, 2);
  assert.equal(submitted.c, 0);
  assert.equal(submitted.p, 0.5);
  assert.equal(submitted.baselineRate, 0);
  assert.equal(submitted.armRate, 1);
  assert.equal(evidencePair.continuous.planChars.n, 2);

  const markdown = renderMarkdown(report);
  assert.equal(markdown, renderMarkdown(report));
  assert.match(markdown, /## Per-arm summary/);
  assert.match(markdown, /## Paired deltas/);
  assert.match(markdown, /## Calibration/);
  assert.match(markdown, /resolve rate/i);
  assert.match(markdown, /gated/);
  assert.match(markdown, /missing from native: e3/i);

  const csv = renderCsv(report);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 1 + report.tasks.length);
  assert.match(lines[0], /^arm,runId,runMode,instanceId/);
  assert.match(csv, /evidence,run-evidence,plan,e3/);
});

test('report resolveRate is gated for plan mode and blocked without resolution data', (t) => {
  const root = makeTempDir(t, 'report-resolve');
  const planRun = writeRun(root, {
    runId: 'run-plan',
    arm: 'native',
    tasks: [{ instanceId: 'p1', arm: 'native', systemText: SYSTEM_PROMPTS.native }],
  });
  const planReport = buildReport([scoreRun(planRun)], { seed: 1, now: NOW });
  assert.equal(planReport.resolveRate.status, 'gated');
  assert.equal(planReport.resolveRate.value, null);
  assert.equal(planReport.resolveRate.runs[0].status, 'gated');
  assert.match(planReport.resolveRate.runs[0].reason, /requires runMode 'execute'/);
  assert.match(renderMarkdown(planReport), /gated/);

  const executeRun = writeRun(root, {
    runId: 'run-exec-blocked',
    arm: 'full',
    runMode: 'execute',
    tasks: [{ instanceId: 'x1', arm: 'full', runMode: 'execute', diff: 'diff --git a/x b/x\n' }],
  });
  const blockedReport = buildReport([scoreRun(executeRun)], { seed: 1, now: NOW });
  assert.equal(blockedReport.resolveRate.status, 'blocked');
  assert.equal(blockedReport.resolveRate.runs[0].status, 'blocked');
  assert.match(blockedReport.resolveRate.runs[0].reason, /predictions\.jsonl/);
  assert.match(renderMarkdown(blockedReport), /blocked/);
});

test('report resolveRate uses recorded resolutions and marks partial runs', (t) => {
  const root = makeTempDir(t, 'report-resolved');
  const resolvedRun = writeRun(root, {
    runId: 'run-exec-resolved',
    arm: 'full',
    runMode: 'execute',
    tasks: [
      { instanceId: 'r1', arm: 'full', runMode: 'execute', resolved: true, diff: 'diff --git a/r b/r\n' },
      { instanceId: 'r2', arm: 'full', runMode: 'execute', resolved: false, diff: 'diff --git a/r2 b/r2\n' },
    ],
  });
  const resolvedReport = buildReport([scoreRun(resolvedRun)], { seed: 1, now: NOW });
  assert.equal(resolvedReport.resolveRate.status, 'ok');
  assert.equal(resolvedReport.resolveRate.value, 0.5);
  assert.equal(resolvedReport.resolveRate.numerator, 1);
  assert.equal(resolvedReport.resolveRate.denominator, 2);

  const partialRoot = makeTempDir(t, 'report-partial');
  const partialRun = writeRun(partialRoot, {
    runId: 'run-exec-partial',
    arm: 'full',
    runMode: 'execute',
    tasks: [
      { instanceId: 'r1', arm: 'full', runMode: 'execute', resolved: true, diff: 'diff --git a/r b/r\n' },
      { instanceId: 'r2', arm: 'full', runMode: 'execute', diff: 'diff --git a/r2 b/r2\n' },
    ],
  });
  const partialReport = buildReport([scoreRun(partialRun)], { seed: 1, now: NOW });
  assert.equal(partialReport.resolveRate.status, 'partial');
  assert.equal(partialReport.resolveRate.runs[0].missing, 1);
  assert.match(partialReport.resolveRate.runs[0].reason, /no recorded resolution/);
});

test('report validation names missing arms and manifests', () => {
  const empty = buildReport([], { seed: 9, now: NOW });
  assert.deepEqual(empty.validation.missingArms, ['native', 'evidence', 'full']);
  assert.equal(empty.validation.ok, false);
  assert.equal(empty.perArm.native, undefined);
  assert.equal(empty.resolveRate.status, 'blocked');
  assert.ok(Array.isArray(empty.paired));
  assert.match(renderMarkdown(empty), /Missing arms: native, evidence, full/);

  const missingManifest = buildReport([{ manifest: null, tasks: [] }], { seed: 9, now: NOW });
  assert.equal(missingManifest.validation.missingManifests.length, 1);
  assert.equal(missingManifest.validation.ok, false);
});

test('report marks paired arms with no overlapping tasks as blocked', (t) => {
  const root = makeTempDir(t, 'report-unpaired');
  const nativeRun = writeRun(root, {
    runId: 'run-native-unpaired',
    arm: 'native',
    tasks: [{ instanceId: 'a', arm: 'native', systemText: SYSTEM_PROMPTS.native }],
  });
  const evidenceRun = writeRun(root, {
    runId: 'run-evidence-unpaired',
    arm: 'evidence',
    tasks: [{ instanceId: 'b', arm: 'evidence' }],
  });
  const report = buildReport([scoreRun(nativeRun), scoreRun(evidenceRun)], { seed: 1, now: NOW });
  assert.deepEqual(report.validation.missingArms, ['full']);
  assert.deepEqual(report.validation.unpairedTasks, { evidence: ['b'] });
  const pair = report.paired.find((entry) => entry.arm === 'evidence');
  assert.equal(pair.status, 'blocked');
  assert.equal(pair.pairedCount, 0);
  assert.match(renderMarkdown(report), /no overlapping task ids/);
});

test('report build is deterministic for a fixed seed and timestamp', (t) => {
  const root = makeTempDir(t, 'report-deterministic');
  const runDir = writeRun(root, {
    runId: 'run-det',
    arm: 'full',
    tasks: [
      { instanceId: 'd1', arm: 'full', plan: DEFAULT_PLAN },
      { instanceId: 'd2', arm: 'full', plan: 'A different plan.' },
    ],
  });
  const scored = [scoreRun(runDir)];
  const first = buildReport(scored, { seed: 123, now: NOW });
  const second = buildReport(scored, { seed: 123, now: NOW });
  assert.deepEqual(first, second);
  assert.equal(typeof first.perArm.full.planChars.ci.low, 'number');
});

test('renderCsv quotes fields containing commas', (t) => {
  const root = makeTempDir(t, 'report-csv');
  const runDir = writeRun(root, {
    runId: 'run-csv',
    arm: 'native',
    tasks: [{ instanceId: 'task,one', arm: 'native', systemText: SYSTEM_PROMPTS.native }],
  });
  const report = buildReport([scoreRun(runDir)], { seed: 1, now: NOW });
  const csv = renderCsv(report);
  assert.match(csv, /"task,one"/);
  assert.equal(csv.endsWith('\n'), true);
  assert.equal(renderMarkdown(null).includes('No report data'), true);
  assert.equal(renderCsv({}).trim().split('\n').length, 1);
});

test('report validation records task artifact errors', (t) => {
  const root = makeTempDir(t, 'report-errors');
  const runDir = writeRun(root, { runId: 'run-errors', arm: 'full', tasks: [] });
  const brokenDir = path.join(runDir, 'tasks', 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  writeTask(path.join(runDir, 'tasks'), 'ok-task', { arm: 'full', systemText: SYSTEM_PROMPTS.full });
  const report = buildReport([scoreRun(runDir)], { seed: 1, now: NOW });
  assert.equal(report.validation.ok, false);
  assert.equal(report.validation.taskErrors.length, 1);
  assert.equal(report.validation.taskErrors[0].instanceId, 'broken');
});
