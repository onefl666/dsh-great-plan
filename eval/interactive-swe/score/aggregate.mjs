/**
 * Aggregate one task directory or one whole run into scriptable metrics.
 *
 * A `<runDir>` follows the layout in `eval/interactive-swe/CONTRACTS.md`:
 * `manifest.json` plus `tasks/<instance_id>/` artifact directories. Every read
 * is defensive: a missing or malformed artifact is reported in `errors` /
 * `warnings` instead of failing the whole run, so one broken task cannot hide
 * the rest of the evaluation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../util/jsonl.mjs';
import { listDir, readJsonIfExists } from '../util/fsutil.mjs';
import { sha256Hex } from '../util/hash.mjs';
import { extractSession, systemPromptText } from '../session/events.mjs';
import { armMarkers, checkArmIntegrity, extractPlan } from './plan.mjs';
import { ARMS } from './plan.mjs';
import { extractPathRefs, resolvePathRefs } from './paths.mjs';
import { clarificationStats } from './clarify.mjs';
import { delegationStats } from './delegation.mjs';
import { qualityStats } from './quality.mjs';

/** Re-export the recognized arm names for report consumers. */
export { ARMS };

/** Artifact file names inside a task directory. */
export const TASK_ARTIFACTS = {
  meta: 'meta.json',
  plan: 'plan.md',
  planReview: 'plan-review.json',
  citations: 'citations.json',
  wire: 'wire.ndjson',
  questions: 'questions.ndjson',
  events: 'events.jsonl',
  diff: 'diff.patch',
};

/** Read a UTF-8 text file, returning `null` when it does not exist. */
function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Read a JSON artifact and record whether it was missing or malformed. */
function readJsonArtifact(file, name, errors) {
  if (!fs.existsSync(file)) return null;
  const value = readJsonIfExists(file, null);
  if (value === null) errors.push(`invalid ${name}`);
  return value;
}

/** Read a JSONL artifact, turning a parse failure into an error entry. */
function readJsonlArtifact(file, name, errors) {
  if (!fs.existsSync(file)) return [];
  try {
    const rows = readJsonl(file);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    errors.push(`invalid ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** Read the boolean resolution outcome from any supported meta field. */
function readResolved(meta) {
  if (meta === null || typeof meta !== 'object') return null;
  const candidates = [meta.resolved, meta.testsPassed, meta.execution?.resolved, meta.result?.resolved];
  for (const value of candidates) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

/** Usage object with all four counters present. */
function normalizeUsage(usage) {
  const source = usage !== null && typeof usage === 'object' ? usage : {};
  const read = (key) => (typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : 0);
  return {
    inputTokens: read('inputTokens'),
    outputTokens: read('outputTokens'),
    cacheReadTokens: read('cacheReadTokens'),
    cacheWriteTokens: read('cacheWriteTokens'),
  };
}

/** The metrics object reported for a task directory that could not be read. */
function failedMetrics(instanceId, errors) {
  return {
    instanceId,
    arm: null,
    runMode: null,
    issueMode: null,
    status: 'scoring_error',
    plan: {
      present: false,
      source: 'none',
      chars: 0,
      submitted: false,
      review: null,
      crossCheck: null,
      integrity: { arm: null, ok: null, reason: 'scoring-error' },
    },
    markers: { budget: false, brainstorming: false, teamLead: false, handoff: false },
    markersSource: 'none',
    citations: {
      total: 0,
      unique: 0,
      resolved: 0,
      outOfBounds: 0,
      phantom: 0,
      unsafe: 0,
      noRoot: 0,
      corroborated: 0,
      resolvedCorroborated: 0,
      resolutionRate: null,
      corroborationRate: null,
      resolvedCorroborationRate: null,
      outOfBoundsRate: null,
      phantomRate: null,
      density: null,
      byStatus: { resolved: 0, 'out-of-bounds': 0, phantom: 0, unsafe: 0, 'no-root': 0 },
      refs: [],
      snapshot: { present: false, refs: null, stats: null },
    },
    clarify: clarificationStats({}),
    delegation: delegationStats({}),
    quality: qualityStats(''),
    execution: {
      runMode: null,
      status: 'scoring_error',
      diffPresent: false,
      diffSha256: null,
      diffShaMatches: null,
      resolved: null,
    },
    usage: normalizeUsage(null),
    turns: null,
    toolCalls: null,
    reviewAction: null,
    durationMs: null,
    artifacts: {
      meta: false,
      plan: false,
      planReview: false,
      citations: false,
      wire: false,
      questions: false,
      events: false,
      diff: false,
    },
    errors: [...errors],
    warnings: [],
    scoringError: errors[0] ?? 'scoring failed',
  };
}

/**
 * Read every known artifact from a task directory.
 *
 * @param {string} taskDir
 * @returns {object} raw artifacts and a `present`/`errors` report
 */
export function readTaskArtifacts(taskDir) {
  const errors = [];
  const present = {};
  const file = (key) => path.join(taskDir, TASK_ARTIFACTS[key]);
  for (const key of Object.keys(TASK_ARTIFACTS)) present[key] = fs.existsSync(file(key));
  const artifacts = {
    present,
    errors,
    meta: readJsonArtifact(file('meta'), 'meta.json', errors),
    planText: readTextIfExists(file('plan')) ?? '',
    planReview: readJsonArtifact(file('planReview'), 'plan-review.json', errors),
    citations: readJsonArtifact(file('citations'), 'citations.json', errors),
    wire: readJsonlArtifact(file('wire'), 'wire.ndjson', errors),
    questions: readJsonlArtifact(file('questions'), 'questions.ndjson', errors),
    events: readJsonlArtifact(file('events'), 'events.jsonl', errors),
    diff: readTextIfExists(file('diff')),
  };
  return artifacts;
}

/**
 * Score one task from an already-read artifact set.
 *
 * @param {string} taskDir task directory (for the id fallback)
 * @param {object} artifacts result of `readTaskArtifacts`
 * @returns {object} task metrics
 */
function metricsFromArtifacts(taskDir, artifacts) {
  const errors = [...artifacts.errors];
  const warnings = [];
  const meta = artifacts.meta !== null && typeof artifacts.meta === 'object' ? artifacts.meta : null;
  const instanceId =
    meta !== null && typeof meta.instanceId === 'string' && meta.instanceId !== ''
      ? meta.instanceId
      : path.basename(path.resolve(taskDir));
  const arm = meta !== null && typeof meta.arm === 'string' ? meta.arm : null;
  const runMode = meta !== null && typeof meta.runMode === 'string' ? meta.runMode : null;
  const issueMode = meta !== null && typeof meta.issueMode === 'string' ? meta.issueMode : null;
  const status =
    meta === null ? 'scoring_error' : typeof meta.status === 'string' ? meta.status : 'unknown';

  const session = extractSession(Array.isArray(artifacts.events) ? artifacts.events : []);
  const systemText = systemPromptText(session);
  const plan = extractPlan({
    wire: artifacts.wire,
    session,
    planReview: artifacts.planReview,
    planText: artifacts.planText,
  });

  let markers = armMarkers('');
  let markersSource = 'none';
  let integrity;
  if (arm === null || !ARMS.includes(arm)) {
    integrity = {
      arm,
      ok: null,
      reason: arm === null ? 'missing-arm' : 'unknown-arm',
      markers: armMarkers(systemText),
      expected: null,
      missing: [],
      unexpected: [],
      source: systemText.trim() === '' ? 'none' : 'system-prompt',
    };
    markers = armMarkers(systemText);
    markersSource = systemText.trim() === '' ? 'none' : 'system-prompt';
  } else if (systemText.trim() === '') {
    markers = armMarkers(plan.text);
    markersSource = plan.text === '' ? 'none' : 'plan-text';
    integrity = {
      arm,
      ok: null,
      reason: 'missing-system-prompt',
      markers,
      expected: null,
      missing: [],
      unexpected: [],
      source: 'none',
    };
  } else {
    const checked = checkArmIntegrity(arm, systemText);
    integrity = { ...checked, source: 'system-prompt' };
    markers = checked.markers;
    markersSource = 'system-prompt';
  }

  const root = meta !== null && typeof meta.worktree === 'string' && meta.worktree !== '' ? meta.worktree : null;
  const refs = extractPathRefs(plan.text);
  const resolution = resolvePathRefs({
    refs,
    root,
    toolCalls: session.toolCalls,
    textLength: plan.text.length,
  });

  const citationsSnapshot = artifacts.citations;
  // The plan-time snapshot is immutable. Prefer it when the worktree has been
  // removed or reused by a later arm/run, so a report never turns valid
  // citations into no-root just because scoring happens after the run.
  const snapshotStats = citationsSnapshot !== null && typeof citationsSnapshot === 'object' ? citationsSnapshot.stats : null;
  const snapshotRefs = citationsSnapshot !== null && typeof citationsSnapshot === 'object' ? citationsSnapshot.refs : null;
  const rootUsable = root !== null && fs.existsSync(root);
  const useSnapshot = (!rootUsable || resolution.stats.noRoot === resolution.stats.total)
    && snapshotStats !== null && typeof snapshotStats === 'object'
    && Number.isFinite(snapshotStats.total) && snapshotStats.total > 0
    && Array.isArray(snapshotRefs);
  const citationResult = useSnapshot ? { refs: snapshotRefs, stats: snapshotStats } : resolution;
  const citations = {
    ...citationResult.stats,
    refs: citationResult.refs,
    source: useSnapshot ? 'snapshot' : 'recomputed',
    snapshot:
      citationsSnapshot !== null && typeof citationsSnapshot === 'object'
        ? {
            present: true,
            refs: Array.isArray(citationsSnapshot.refs) ? citationsSnapshot.refs.length : null,
            stats: citationsSnapshot.stats ?? null,
          }
        : { present: false, refs: null, stats: null },
  };

  const clarify = clarificationStats({ session, questions: artifacts.questions });
  const delegation = delegationStats({ session });
  const quality = qualityStats(plan.text);
  const diffPresent = typeof artifacts.diff === 'string' && artifacts.diff !== '';
  const expectedDiffSha = meta !== null && typeof meta.gitDiffSha256 === 'string' ? meta.gitDiffSha256 : null;
  const diffSha256 = diffPresent ? sha256Hex(artifacts.diff) : null;
  const execution = {
    runMode,
    status,
    diffPresent,
    diffSha256,
    diffShaMatches: diffSha256 !== null && expectedDiffSha !== null ? diffSha256 === expectedDiffSha : null,
    resolved: readResolved(meta),
  };

  if (!artifacts.present.meta) errors.push('missing meta.json');
  if (!artifacts.present.events) errors.push('missing events.jsonl');
  if (plan.text === '') errors.push('missing plan text');
  if (!artifacts.present.planReview) warnings.push('missing plan-review.json');
  if (!artifacts.present.citations) warnings.push('missing citations.json');
  if (runMode === 'execute' && !diffPresent) warnings.push('missing diff.patch');

  const metaUsage = meta !== null && typeof meta.usage === 'object' ? meta.usage : null;
  return {
    instanceId,
    arm,
    runMode,
    issueMode,
    status,
    plan: {
      present: plan.text !== '',
      source: plan.source,
      chars: plan.chars,
      submitted: plan.submitted,
      review: plan.review,
      crossCheck: plan.crossCheck,
      integrity,
      exitPlanCallCount: plan.exitPlanCallCount,
    },
    markers,
    markersSource,
    citations,
    clarify,
    delegation,
    quality,
    execution,
    usage: normalizeUsage(metaUsage ?? (artifacts.present.events ? session.usage : null)),
    turns: meta !== null && typeof meta.turns === 'number' ? meta.turns : null,
    toolCalls:
      meta !== null && typeof meta.toolCalls === 'number' ? meta.toolCalls : session.toolCalls.length,
    reviewAction: meta !== null && typeof meta.reviewAction === 'string' ? meta.reviewAction : null,
    durationMs: meta !== null && typeof meta.durationMs === 'number' ? meta.durationMs : null,
    artifacts: { ...artifacts.present },
    errors,
    warnings,
    scoringError: null,
  };
}

/**
 * Score one task directory into a metrics object.
 *
 * Never throws for missing or malformed artifacts: the failure is reported in
 * `errors` and `scoringError`, which the report surfaces as validation output.
 *
 * @param {string} taskDir task directory under `<runDir>/tasks/`
 * @returns {object} task metrics
 */
export function scoreTask(taskDir) {
  if (typeof taskDir !== 'string' || taskDir === '') {
    return failedMetrics('unknown', ['task directory is not a string']);
  }
  const resolved = path.resolve(taskDir);
  const instanceId = path.basename(resolved);
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return failedMetrics(instanceId, ['task directory not found']);
    }
    return metricsFromArtifacts(resolved, readTaskArtifacts(resolved));
  } catch (error) {
    return failedMetrics(instanceId, [`scoring failed: ${error instanceof Error ? error.message : String(error)}`]);
  }
}

/**
 * Score every task directory in a run.
 *
 * Task directories are visited in lexical order so a report is reproducible.
 * A missing run directory yields `{ manifest: null, tasks: [] }`.
 *
 * @param {string} runDir run directory per CONTRACTS
 * @returns {{ manifest: object|null, tasks: object[] }}
 */
export function scoreRun(runDir) {
  if (typeof runDir !== 'string' || runDir === '') return { manifest: null, tasks: [] };
  const resolved = path.resolve(runDir);
  const manifestPath = path.join(resolved, 'manifest.json');
  const manifest = readJsonIfExists(manifestPath, null);
  const taskRoot = path.join(resolved, 'tasks');
  const entries = listDir(taskRoot)
    .filter((name) => !name.startsWith('.'))
    .sort();
  const tasks = [];
  for (const name of entries) {
    const taskDir = path.join(taskRoot, name);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(taskDir).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (isDirectory) tasks.push(scoreTask(taskDir));
  }
  tasks.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  return { manifest: manifest !== null && typeof manifest === 'object' ? manifest : null, tasks };
}
