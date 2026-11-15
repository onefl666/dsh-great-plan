/**
 * Build and render the evaluation report.
 *
 * `buildReport(scoredRuns, { seed })` consumes `scoreRun` results and produces
 * one deterministic JSON object: per-arm summaries, paired deltas against the
 * baseline arm (with exact McNemar p-values and seeded bootstrap intervals),
 * calibration checks (arm markers, plan submission, clarification), an explicit
 * resolveRate that reports `blocked`/`gated` instead of fabricating a number,
 * and a validation section that names every missing or malformed run artifact.
 * `renderMarkdown` and `renderCsv` are pure string renderers over that object.
 */
import { ARMS } from './plan.mjs';
import { expectedMarkers } from './plan.mjs';
import { bootstrapMeanCI } from './bootstrap.mjs';
import { mcnemar } from './mcnemar.mjs';

/** Binary paired outcomes compared against the baseline arm. */
const BINARY_FLAGS = [
  { key: 'planPresent', get: (row) => row.planPresent },
  { key: 'planSubmitted', get: (row) => row.planSubmitted },
  { key: 'markerIntegrityOk', get: (row) => row.markerIntegrity },
  { key: 'handoffPresent', get: (row) => row.handoffPresent },
  { key: 'assumptionsMarked', get: (row) => row.hasAssumptions },
  { key: 'resolved', get: (row) => row.resolved },
];

/** Continuous paired metrics compared against the baseline arm. */
const CONTINUOUS_METRICS = [
  { key: 'planChars', get: (row) => row.planChars },
  { key: 'citationDensity', get: (row) => row.citationDensity },
  { key: 'citationResolutionRate', get: (row) => row.citationResolutionRate },
  { key: 'askCalls', get: (row) => row.askCalls },
  { key: 'spawnCalls', get: (row) => row.spawnCalls },
];

/** Round to a fixed number of decimals. */
function round(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Finite numbers only. */
function numbers(values) {
  return (Array.isArray(values) ? values : []).filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
}

/** Mean of a numeric array, or `null`. */
function mean(values) {
  const clean = numbers(values);
  if (clean.length === 0) return null;
  let total = 0;
  for (const value of clean) total += value;
  return total / clean.length;
}

/** Median of a numeric array, or `null`. */
function median(values) {
  const clean = numbers(values).sort((left, right) => left - right);
  if (clean.length === 0) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 === 0 ? (clean[middle - 1] + clean[middle]) / 2 : clean[middle];
}

/** `numerator / denominator`, or `null` when the denominator is zero. */
function rate(numerator, denominator) {
  if (typeof denominator !== 'number' || denominator === 0) return null;
  return round(numerator / denominator);
}

/** Count occurrences of each key. */
function tally(values) {
  const counts = {};
  for (const value of values) {
    const key = typeof value === 'string' && value !== '' ? value : 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Sum a numeric field across rows. */
function sumField(rows, get) {
  let total = 0;
  for (const row of rows) {
    const value = get(row);
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
}

/** Stable order for arm names: canonical arms first, then alphabetical. */
function sortArms(arms) {
  const extras = arms.filter((arm) => !ARMS.includes(arm)).sort();
  return [...ARMS.filter((arm) => arms.includes(arm)), ...extras];
}

/** Stable seed for one arm's bootstrap interval. */
function armSeed(seed, arm) {
  const rank = ARMS.indexOf(arm);
  const offset = rank === -1 ? 10000 : (rank + 1) * 7919;
  return (seed + offset) >>> 0;
}

/** Read a numeric metric defensively. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Flatten one task metrics object into a report row. */
function flattenTask(arm, run, task) {
  const plan = task?.plan !== null && typeof task?.plan === 'object' ? task.plan : {};
  const citations = task?.citations !== null && typeof task?.citations === 'object' ? task.citations : {};
  const clarify = task?.clarify !== null && typeof task?.clarify === 'object' ? task.clarify : {};
  const delegation = task?.delegation !== null && typeof task?.delegation === 'object' ? task.delegation : {};
  const quality = task?.quality !== null && typeof task?.quality === 'object' ? task.quality : {};
  const execution = task?.execution !== null && typeof task?.execution === 'object' ? task.execution : {};
  const markers = task?.markers !== null && typeof task?.markers === 'object' ? task.markers : {};
  const handoff = quality.handoff !== null && typeof quality.handoff === 'object' ? quality.handoff : {};
  const assumptions = quality.assumptions !== null && typeof quality.assumptions === 'object' ? quality.assumptions : {};
  return {
    arm,
    runId: run.runId,
    runMode: run.runMode,
    instanceId:
      typeof task?.instanceId === 'string' && task.instanceId !== '' ? task.instanceId : `unknown-${run.index}`,
    status: typeof task?.status === 'string' ? task.status : 'unknown',
    planPresent: plan.present === true,
    planSource: typeof plan.source === 'string' ? plan.source : 'none',
    planChars: num(plan.chars),
    planSubmitted: plan.submitted === true,
    markerIntegrity: typeof plan.integrity?.ok === 'boolean' ? plan.integrity.ok : null,
    markers: {
      budget: markers.budget === true,
      brainstorming: markers.brainstorming === true,
      teamLead: markers.teamLead === true,
      handoff: markers.handoff === true,
    },
    markersSource: typeof task?.markersSource === 'string' ? task.markersSource : 'none',
    citationTotal: num(citations.total),
    citationResolved: num(citations.resolved),
    citationOutOfBounds: num(citations.outOfBounds),
    citationPhantom: num(citations.phantom),
    citationUnsafe: num(citations.unsafe),
    citationNoRoot: num(citations.noRoot),
    citationAmbiguous: num(citations.ambiguous),
    citationCorroborated: num(citations.corroborated),
    citationDensity: typeof citations.density === 'number' && Number.isFinite(citations.density) ? citations.density : null,
    usage: task?.usage !== null && typeof task?.usage === 'object' ? task.usage : null,
    turns: num(task?.turns),
    toolCalls: num(task?.toolCalls),
    durationMs: num(task?.durationMs),
    citationResolutionRate:
      typeof citations.resolutionRate === 'number' && Number.isFinite(citations.resolutionRate)
        ? citations.resolutionRate
        : null,
    citationCorroborationRate:
      typeof citations.corroborationRate === 'number' && Number.isFinite(citations.corroborationRate)
        ? citations.corroborationRate
        : null,
    askCalls: num(clarify.askCount ?? clarify.askCalls),
    oneQuestionRatio:
      typeof clarify.oneQuestionRatio === 'number' && Number.isFinite(clarify.oneQuestionRatio)
        ? clarify.oneQuestionRatio
        : null,
    capHits: num(clarify.capHits),
    spawnCalls: num(delegation.spawnCalls),
    planningTeammates: num(delegation.planningTeammates),
    parallelGroups: num(delegation.parallelGroups),
    handoffPresent: handoff.hasHandoff === true,
    handoffScore:
      typeof handoff.score === 'number' && Number.isFinite(handoff.score) ? handoff.score : null,
    assumptionsCount: num(assumptions.count),
    hasAssumptions: assumptions.hasAssumptions === true,
    resolved: typeof execution.resolved === 'boolean' ? execution.resolved : null,
    errorCount: Array.isArray(task?.errors) ? task.errors.length : 0,
    errors: Array.isArray(task?.errors) ? task.errors : [],
    warnings: Array.isArray(task?.warnings) ? task.warnings : [],
  };
}

/** Summarize one arm from its task rows. */
function summarizeArm(arm, rows, runs, seed) {
  const taskCount = rows.length;
  const planPresent = rows.filter((row) => row.planPresent).length;
  const planSubmitted = rows.filter((row) => row.planSubmitted).length;
  const verified = rows.filter((row) => row.markerIntegrity !== null);
  const matched = verified.filter((row) => row.markerIntegrity === true).length;
  const citationTotals = {
    refs: sumField(rows, (row) => row.citationTotal),
    resolved: sumField(rows, (row) => row.citationResolved),
    outOfBounds: sumField(rows, (row) => row.citationOutOfBounds),
    phantom: sumField(rows, (row) => row.citationPhantom),
    unsafe: sumField(rows, (row) => row.citationUnsafe),
    noRoot: sumField(rows, (row) => row.citationNoRoot),
    ambiguous: sumField(rows, (row) => row.citationAmbiguous),
    corroborated: sumField(rows, (row) => row.citationCorroborated),
  };
  const bootstrapSeed = armSeed(seed, arm);
  const densityValues = rows.map((row) => row.citationDensity);
  const charValues = rows.map((row) => row.planChars);
  return {
    arm,
    runs: runs.map((run) => ({ runId: run.runId, runMode: run.runMode, taskCount: run.tasks.length })),
    tasks: taskCount,
    statuses: tally(rows.map((row) => row.status)),
    plans: {
      present: planPresent,
      submitted: planSubmitted,
      submissionRate: rate(planSubmitted, taskCount),
    },
    planChars: {
      mean: round(mean(charValues)),
      median: round(median(charValues)),
      ci: bootstrapMeanCI(charValues, { seed: bootstrapSeed, iterations: 500 }),
    },
    markers: {
      budget: rows.filter((row) => row.markers.budget).length,
      brainstorming: rows.filter((row) => row.markers.brainstorming).length,
      teamLead: rows.filter((row) => row.markers.teamLead).length,
      handoff: rows.filter((row) => row.markers.handoff).length,
    },
    markerSources: tally(rows.map((row) => row.markersSource)),
    markerIntegrity: {
      verified: verified.length,
      matched,
      rate: rate(matched, verified.length),
      unverified: taskCount - verified.length,
    },
    citations: {
      ...citationTotals,
      resolutionRate: rate(citationTotals.resolved, citationTotals.refs),
      corroborationRate: rate(citationTotals.corroborated, citationTotals.refs),
      densityMean: round(mean(densityValues)),
      densityCi: bootstrapMeanCI(numbers(densityValues), { seed: bootstrapSeed ^ 0x5f5f, iterations: 500 }),
      ambiguousRate: rate(citationTotals.ambiguous, citationTotals.refs),
      resolutionRateMean: round(mean(rows.map((row) => row.citationResolutionRate))),
      corroborationRateMean: round(mean(rows.map((row) => row.citationCorroborationRate))),
    },
    clarify: {
      tasksWithAsk: rows.filter((row) => row.askCalls > 0).length,
      askRate: rate(rows.filter((row) => row.askCalls > 0).length, taskCount),
      askCalls: sumField(rows, (row) => row.askCalls),
      avgAskPerTask: round(mean(rows.map((row) => row.askCalls))),
      oneQuestionRatioMean: round(mean(rows.map((row) => row.oneQuestionRatio))),
      capHits: sumField(rows, (row) => row.capHits),
      capHitRate: rate(rows.filter((row) => row.capHits > 0).length, taskCount),
    },
    delegation: {
      tasksWithSpawn: rows.filter((row) => row.spawnCalls > 0).length,
      spawnRate: rate(rows.filter((row) => row.spawnCalls > 0).length, taskCount),
      spawnCalls: sumField(rows, (row) => row.spawnCalls),
      avgSpawnPerTask: round(mean(rows.map((row) => row.spawnCalls))),
      planningTeammates: sumField(rows, (row) => row.planningTeammates),
      tasksWithPlanningTeammate: rows.filter((row) => row.planningTeammates > 0).length,
      parallelGroups: sumField(rows, (row) => row.parallelGroups),
    },
    quality: {
      handoffRate: rate(rows.filter((row) => row.handoffPresent).length, taskCount),
      handoffScoreMean: round(mean(rows.map((row) => row.handoffScore))),
      assumptionsRate: rate(rows.filter((row) => row.hasAssumptions).length, taskCount),
      assumptionsMean: round(mean(rows.map((row) => row.assumptionsCount))),
    },
    usage: {
      inputTokens: sumField(rows, (row) => row.usage?.inputTokens),
      outputTokens: sumField(rows, (row) => row.usage?.outputTokens),
      cacheReadTokens: sumField(rows, (row) => row.usage?.cacheReadTokens),
      cacheWriteTokens: sumField(rows, (row) => row.usage?.cacheWriteTokens),
    },
    efficiency: {
      turnsMean: round(mean(rows.map((row) => row.turns))),
      toolCallsMean: round(mean(rows.map((row) => row.toolCalls))),
      durationMsMean: round(mean(rows.map((row) => row.durationMs))),
    },
    errors: sumField(rows, (row) => row.errorCount),
  };
}

/** Calibration checks tied to the arm's expected marker configuration. */
function buildCalibration(perArm, rowsByArm) {
  return {
    markerIntegrity: perArm.map((entry) => ({
      arm: entry.arm,
      verified: entry.markerIntegrity.verified,
      matched: entry.markerIntegrity.matched,
      rate: entry.markerIntegrity.rate,
      unverified: entry.markerIntegrity.unverified,
    })),
    markerExpectations: perArm.map((entry) => {
      let expected = null;
      try {
        expected = expectedMarkers(entry.arm);
      } catch {
        expected = null;
      }
      const rows = rowsByArm.get(entry.arm) ?? [];
      if (expected === null) {
        return { arm: entry.arm, expected: null, matchedTasks: 0, rate: null, status: 'unknown-arm' };
      }
      const matchedRows = rows.filter((row) =>
        Object.keys(expected).every((key) => row.markers[key] === expected[key]),
      ).length;
      return {
        arm: entry.arm,
        expected,
        observed: entry.markers,
        matchedTasks: matchedRows,
        rate: rate(matchedRows, rows.length),
        status: rows.length === 0 ? 'no-tasks' : 'computed',
      };
    }),
    submission: perArm.map((entry) => ({
      arm: entry.arm,
      present: entry.plans.present,
      submitted: entry.plans.submitted,
      rate: entry.plans.submissionRate,
    })),
    clarification: perArm.map((entry) => ({
      arm: entry.arm,
      tasksWithAsk: entry.clarify.tasksWithAsk,
      askRate: entry.clarify.askRate,
      oneQuestionRatioMean: entry.clarify.oneQuestionRatioMean,
      capHits: entry.clarify.capHits,
      capHitRate: entry.clarify.capHitRate,
    })),
  };
}

/** Paired deltas of one arm against the baseline arm. */
function buildPairedDeltas(baseline, arm, baselineRows, armRows) {
  const baselineById = new Map(baselineRows.map((row) => [row.instanceId, row]));
  const armById = new Map(armRows.map((row) => [row.instanceId, row]));
  const sharedIds = [...baselineById.keys()].filter((id) => armById.has(id)).sort();
  const missingFromArm = [...baselineById.keys()].filter((id) => !armById.has(id)).sort();
  const missingFromBaseline = [...armById.keys()].filter((id) => !baselineById.has(id)).sort();
  const entry = {
    baseline,
    arm,
    pairedCount: sharedIds.length,
    status: sharedIds.length === 0 ? 'blocked' : 'computed',
    reason: sharedIds.length === 0 ? 'no overlapping task ids between the two arms' : null,
    missingFromArm,
    missingFromBaseline,
    binary: {},
    continuous: {},
  };
  if (sharedIds.length === 0) return entry;

  for (const flag of BINARY_FLAGS) {
    let eligible = 0;
    let baselinePass = 0;
    let armPass = 0;
    let onlyArm = 0;
    let onlyBaseline = 0;
    for (const id of sharedIds) {
      const baseValue = flag.get(baselineById.get(id));
      const armValue = flag.get(armById.get(id));
      if (typeof baseValue !== 'boolean' || typeof armValue !== 'boolean') continue;
      eligible += 1;
      if (baseValue) baselinePass += 1;
      if (armValue) armPass += 1;
      if (armValue && !baseValue) onlyArm += 1;
      if (!armValue && baseValue) onlyBaseline += 1;
    }
    entry.binary[flag.key] = {
      n: eligible,
      baselineRate: rate(baselinePass, eligible),
      armRate: rate(armPass, eligible),
      delta: eligible === 0 ? null : round(armPass / eligible - baselinePass / eligible),
      b: onlyArm,
      c: onlyBaseline,
      p: eligible === 0 ? null : mcnemar(onlyArm, onlyBaseline).p,
    };
  }

  for (const metric of CONTINUOUS_METRICS) {
    const deltas = [];
    for (const id of sharedIds) {
      const baseValue = metric.get(baselineById.get(id));
      const armValue = metric.get(armById.get(id));
      if (typeof baseValue !== 'number' || !Number.isFinite(baseValue)) continue;
      if (typeof armValue !== 'number' || !Number.isFinite(armValue)) continue;
      deltas.push(armValue - baseValue);
    }
    entry.continuous[metric.key] = {
      n: deltas.length,
      meanDelta: round(mean(deltas)),
    };
  }
  return entry;
}

/** Resolve rate semantics: blocked/gated instead of a fabricated number. */
function computeResolveRates(runs) {
  const entries = runs.map((run) => {
    const base = {
      runId: run.runId,
      arm: run.arm,
      runMode: run.runMode,
      numerator: 0,
      denominator: run.tasks.length,
      value: null,
      missing: run.tasks.length,
      reason: null,
    };
    if (run.manifest === null) {
      return { ...base, status: 'blocked', reason: 'missing manifest.json' };
    }
    if (run.runMode !== 'execute') {
      return {
        ...base,
        status: 'gated',
        reason: `runMode '${run.runMode ?? 'unknown'}' records no executed patch or test result; resolveRate requires runMode 'execute'`,
      };
    }
    const known = run.tasks.filter((task) => typeof task?.execution?.resolved === 'boolean');
    if (known.length === 0) {
      return {
        ...base,
        status: 'blocked',
        reason:
          'no resolved/testsPassed field in meta.json; run the SWE-bench evaluation on predictions.jsonl and merge its outcome',
      };
    }
    const resolved = known.filter((task) => task.execution.resolved === true).length;
    const status = known.length === run.tasks.length ? 'ok' : 'partial';
    return {
      ...base,
      status,
      numerator: resolved,
      value: run.tasks.length === 0 ? null : round(resolved / run.tasks.length),
      known: known.length,
      missing: run.tasks.length - known.length,
      reason: status === 'partial' ? `${run.tasks.length - known.length} task(s) have no recorded resolution` : null,
    };
  });
  const statuses = tally(entries.map((entry) => entry.status));
  const usable = entries.filter((entry) => (entry.status === 'ok' || entry.status === 'partial') && entry.denominator > 0);
  const numerator = usable.reduce((sum, entry) => sum + entry.numerator, 0);
  const denominator = usable.reduce((sum, entry) => sum + entry.denominator, 0);
  const status =
    (statuses.ok ?? 0) > 0
      ? 'ok'
      : (statuses.partial ?? 0) > 0
        ? 'partial'
        : (statuses.gated ?? 0) > 0
          ? 'gated'
          : 'blocked';
  return {
    status,
    value: denominator > 0 ? round(numerator / denominator) : null,
    numerator,
    denominator,
    statuses,
    runs: entries,
  };
}

/** Validation block: explicit missing/invalid inputs. */
function computeValidation(runs, armOrder, rowsByArm) {
  const missingManifests = runs
    .filter((run) => run.manifest === null)
    .map((run) => ({ index: run.index, runId: run.runId, arm: run.arm }));
  const knownArms = new Set(runs.map((run) => run.arm));
  const missingArms = ARMS.filter((arm) => !knownArms.has(arm));
  const unknownArms = [...knownArms].filter((arm) => !ARMS.includes(arm));
  const duplicates = [];
  for (const [arm, rows] of rowsByArm) {
    const counts = new Map();
    for (const row of rows) counts.set(row.instanceId, (counts.get(row.instanceId) ?? 0) + 1);
    for (const [instanceId, count] of counts) {
      if (count > 1) duplicates.push({ arm, instanceId, count });
    }
  }
  duplicates.sort((left, right) => `${left.arm}:${left.instanceId}`.localeCompare(`${right.arm}:${right.instanceId}`));
  const taskErrors = [];
  const taskWarnings = [];
  for (const [arm, rows] of rowsByArm) {
    for (const row of rows) {
      if (row.errors.length > 0) taskErrors.push({ arm, instanceId: row.instanceId, errors: row.errors });
      if (row.warnings.length > 0) taskWarnings.push({ arm, instanceId: row.instanceId, warnings: row.warnings });
    }
  }
  const baseline = armOrder.includes('native') ? 'native' : armOrder[0] ?? null;
  const baselineIds = baseline === null ? new Set() : new Set((rowsByArm.get(baseline) ?? []).map((row) => row.instanceId));
  const unpairedTasks = {};
  for (const [arm, rows] of rowsByArm) {
    if (arm === baseline) continue;
    const unmatched = rows.filter((row) => !baselineIds.has(row.instanceId)).map((row) => row.instanceId);
    if (unmatched.length > 0) unpairedTasks[arm] = unmatched.sort();
  }
  const ok =
    missingManifests.length === 0 &&
    missingArms.length === 0 &&
    unknownArms.length === 0 &&
    duplicates.length === 0 &&
    taskErrors.length === 0;
  return {
    ok,
    runCount: runs.length,
    taskCount: [...rowsByArm.values()].reduce((sum, rows) => sum + rows.length, 0),
    baseline,
    missingManifests,
    missingArms,
    unknownArms,
    duplicateInstanceIds: duplicates,
    taskErrors,
    taskWarnings,
    unpairedTasks,
    warnings: [...missingArms.map((arm) => `missing arm: ${arm}`), ...unknownArms.map((arm) => `unknown arm: ${arm}`)],
  };
}

/**
 * Build a report from `scoreRun` results.
 *
 * @param {object[]} scoredRuns results of `scoreRun(runDir)`
 * @param {object} [options]
 * @param {number} [options.seed=12345] bootstrap seed
 * @param {string} [options.now] report timestamp override (tests pass a fixed value)
 * @returns {object} report JSON
 */
export function buildReport(scoredRuns, { seed = 12345, now } = {}) {
  const deterministicSeed = Number.isInteger(seed) ? seed >>> 0 : 12345;
  const runList = Array.isArray(scoredRuns) ? scoredRuns : [];
  const runs = runList.map((scored, index) => {
    const manifest = scored?.manifest !== null && typeof scored?.manifest === 'object' ? scored.manifest : null;
    const tasks = Array.isArray(scored?.tasks) ? scored.tasks : [];
    const firstArm = tasks.find((task) => typeof task?.arm === 'string')?.arm;
    const arm =
      manifest !== null && typeof manifest.arm === 'string'
        ? manifest.arm
        : typeof firstArm === 'string'
          ? firstArm
          : 'unknown';
    return {
      index,
      runId: manifest !== null && manifest.runId !== undefined ? manifest.runId : null,
      arm,
      runMode: manifest !== null && typeof manifest.runMode === 'string' ? manifest.runMode : null,
      issueMode: manifest !== null && typeof manifest.issueMode === 'string' ? manifest.issueMode : null,
      manifest,
      tasks,
    };
  });

  const rowsByArm = new Map();
  for (const run of runs) {
    const rows = rowsByArm.get(run.arm) ?? [];
    for (const task of run.tasks) rows.push(flattenTask(run.arm, run, task));
    rowsByArm.set(run.arm, rows);
  }
  const armOrder = sortArms([...rowsByArm.keys()]);
  const perArm = armOrder.map((arm) => summarizeArm(arm, rowsByArm.get(arm) ?? [], runs.filter((run) => run.arm === arm), deterministicSeed));

  const baseline = armOrder.includes('native') ? 'native' : armOrder[0] ?? null;
  const paired = [];
  if (baseline !== null) {
    for (const arm of armOrder) {
      if (arm === baseline) continue;
      paired.push(buildPairedDeltas(baseline, arm, rowsByArm.get(baseline) ?? [], rowsByArm.get(arm) ?? []));
    }
  }

  const tasks = [];
  for (const arm of armOrder) {
    for (const row of rowsByArm.get(arm) ?? []) {
      tasks.push({
        arm: row.arm,
        runId: row.runId,
        runMode: row.runMode,
        instanceId: row.instanceId,
        status: row.status,
        planPresent: row.planPresent,
        planSource: row.planSource,
        planChars: row.planChars,
        planSubmitted: row.planSubmitted,
        markerIntegrity: row.markerIntegrity,
        citationTotal: row.citationTotal,
        citationResolved: row.citationResolved,
        citationOutOfBounds: row.citationOutOfBounds,
        citationPhantom: row.citationPhantom,
        citationAmbiguous: row.citationAmbiguous,
        citationCorroborated: row.citationCorroborated,
        citationDensity: row.citationDensity,
        citationResolutionRate: row.citationResolutionRate,
        citationCorroborationRate: row.citationCorroborationRate,
        askCalls: row.askCalls,
        oneQuestionRatio: row.oneQuestionRatio,
        capHits: row.capHits,
        spawnCalls: row.spawnCalls,
        planningTeammates: row.planningTeammates,
        parallelGroups: row.parallelGroups,
        handoffPresent: row.handoffPresent,
        handoffScore: row.handoffScore,
        assumptionsCount: row.assumptionsCount,
        usage: row.usage,
        turns: row.turns,
        toolCalls: row.toolCalls,
        durationMs: row.durationMs,
        resolved: row.resolved,
        errorCount: row.errorCount,
      });
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: typeof now === 'string' ? now : new Date().toISOString(),
    seed: deterministicSeed,
    armOrder,
    runs: runs.map((run) => ({
      index: run.index,
      runId: run.runId,
      arm: run.arm,
      runMode: run.runMode,
      issueMode: run.issueMode,
      taskCount: run.tasks.length,
    })),
    perArm: Object.fromEntries(perArm.map((entry) => [entry.arm, entry])),
    paired,
    calibration: buildCalibration(perArm, rowsByArm),
    resolveRate: computeResolveRates(runs),
    validation: computeValidation(runs, armOrder, rowsByArm),
    tasks,
  };
  return report;
}

/** Format a number for Markdown. */
function fmt(value, digits = 4) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return String(Number(value.toFixed(digits)));
}

/**
 * Render a report as Markdown.
 *
 * @param {object} report report from `buildReport`
 * @returns {string}
 */
export function renderMarkdown(report) {
  if (report === null || typeof report !== 'object') return '# Interactive SWE evaluation report\n\nNo report data.\n';
  const lines = [];
  lines.push('# Interactive SWE evaluation report');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt ?? 'unknown'}`);
  lines.push(`- Bootstrap seed: ${report.seed}`);
  lines.push(`- Runs: ${report.validation?.runCount ?? 0}`);
  lines.push(`- Tasks (arm-task rows): ${report.tasks?.length ?? 0}`);
  lines.push('');

  const validation = report.validation ?? {};
  lines.push('## Validation');
  lines.push('');
  lines.push(`- Status: ${validation.ok ? 'OK' : 'INCOMPLETE'}`);
  if (Array.isArray(validation.missingArms) && validation.missingArms.length > 0) {
    lines.push(`- Missing arms: ${validation.missingArms.join(', ')}`);
  }
  if (Array.isArray(validation.unknownArms) && validation.unknownArms.length > 0) {
    lines.push(`- Unknown arms: ${validation.unknownArms.join(', ')}`);
  }
  if (Array.isArray(validation.missingManifests) && validation.missingManifests.length > 0) {
    lines.push(`- Missing manifests: ${validation.missingManifests.length}`);
  }
  if (Array.isArray(validation.duplicateInstanceIds) && validation.duplicateInstanceIds.length > 0) {
    lines.push(`- Duplicate task ids: ${validation.duplicateInstanceIds.length}`);
  }
  if (Array.isArray(validation.taskErrors) && validation.taskErrors.length > 0) {
    lines.push(`- Tasks with artifact errors: ${validation.taskErrors.length}`);
    for (const entry of validation.taskErrors.slice(0, 10)) {
      lines.push(`  - ${entry.arm}/${entry.instanceId}: ${entry.errors.join('; ')}`);
    }
  }
  lines.push('');

  const resolveRate = report.resolveRate ?? { status: 'blocked', runs: [] };
  lines.push('## Resolve rate');
  lines.push('');
  lines.push(`- Overall status: **${resolveRate.status}** (${resolveRate.value === null ? 'no value' : fmt(resolveRate.value)})`);
  for (const entry of Array.isArray(resolveRate.runs) ? resolveRate.runs : []) {
    lines.push(
      `- ${entry.arm}${entry.runId === null ? '' : ` / ${entry.runId}`} (${entry.runMode ?? 'unknown'}): **${entry.status}** ` +
        `${entry.value === null ? '' : fmt(entry.value)}${entry.reason === null ? '' : ` — ${entry.reason}`}`,
    );
  }
  lines.push('');

  lines.push('## Per-arm summary');
  lines.push('');
  lines.push(
    '| Arm | Tasks | Plans | Submitted | Marker ok | Cite resolved | Cite corroborated | Ask rate | 1Q ratio | Spawn rate | Handoff | Assumptions |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const arm of report.armOrder ?? []) {
    const entry = report.perArm[arm];
    if (!entry) continue;
    lines.push(
      `| ${arm} | ${entry.tasks} | ${entry.plans.present} | ${fmt(entry.plans.submissionRate)} | ` +
        `${entry.markerIntegrity.matched}/${entry.markerIntegrity.verified} | ` +
        `${fmt(entry.citations.resolutionRate)} | ${fmt(entry.citations.corroborationRate)} | ` +
        `${fmt(entry.clarify.askRate)} | ${fmt(entry.clarify.oneQuestionRatioMean)} | ` +
        `${fmt(entry.delegation.spawnRate)} | ${fmt(entry.quality.handoffRate)} | ${fmt(entry.quality.assumptionsRate)} |`,
    );
  }
  lines.push('');

  lines.push('## Citations and efficiency');
  lines.push('');
  lines.push('| Arm | Refs | Resolved | Ambiguous | Phantom | Refs/task | Plan chars | Spawn/task | In tokens | Out tokens | Turns | Min/task |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const arm of report.armOrder ?? []) {
    const entry = report.perArm[arm];
    if (!entry) continue;
    const tasks = entry.tasks === 0 ? 1 : entry.tasks;
    const minutes = typeof entry.efficiency?.durationMsMean === 'number'
      ? Math.round((entry.efficiency.durationMsMean / 60000) * 10) / 10
      : null;
    lines.push(
      `| ${arm} | ${entry.citations.refs} | ${entry.citations.resolved} | ${entry.citations.ambiguous ?? 0} | ` +
        `${entry.citations.phantom} | ${fmt(entry.citations.refs / tasks)} | ${fmt(entry.planChars.mean)} | ` +
        `${fmt(entry.delegation.spawnCalls / tasks)} | ${entry.usage.inputTokens} | ${entry.usage.outputTokens} | ` +
        `${fmt(entry.efficiency?.turnsMean)} | ${minutes === null ? '—' : minutes} |`,
    );
  }
  lines.push('');

  lines.push('## Paired deltas');
  lines.push('');
  if (!Array.isArray(report.paired) || report.paired.length === 0) {
    lines.push('No paired comparison available (a baseline arm is missing or there is only one arm).');
  } else {
    for (const pair of report.paired) {
      lines.push(`### ${pair.arm} vs ${pair.baseline}`);
      lines.push('');
      if (pair.status !== 'computed') {
        lines.push(`- **${pair.status}**: ${pair.reason}`);
        lines.push('');
        continue;
      }
      lines.push(`- Paired tasks: ${pair.pairedCount}`);
      if (pair.missingFromArm.length > 0) lines.push(`- Missing from ${pair.arm}: ${pair.missingFromArm.join(', ')}`);
      if (pair.missingFromBaseline.length > 0) {
        lines.push(`- Missing from ${pair.baseline}: ${pair.missingFromBaseline.join(', ')}`);
      }
      lines.push('');
      lines.push('| Outcome | n | baseline | arm | delta | b | c | McNemar p |');
      lines.push('|---|---|---|---|---|---|---|---|');
      for (const [key, value] of Object.entries(pair.binary)) {
        lines.push(
          `| ${key} | ${value.n} | ${fmt(value.baselineRate)} | ${fmt(value.armRate)} | ${fmt(value.delta)} | ` +
            `${value.b} | ${value.c} | ${fmt(value.p)} |`,
        );
      }
      lines.push('');
      lines.push('| Metric | n | mean delta |');
      lines.push('|---|---|---|');
      for (const [key, value] of Object.entries(pair.continuous)) {
        lines.push(`| ${key} | ${value.n} | ${fmt(value.meanDelta)} |`);
      }
      lines.push('');
    }
  }

  lines.push('## Calibration');
  lines.push('');
  lines.push('| Arm | Expected markers | Matched tasks | Rate | Status |');
  lines.push('|---|---|---|---|---|');
  for (const entry of report.calibration?.markerExpectations ?? []) {
    const expected = entry.expected
      ? Object.entries(entry.expected)
          .filter(([, value]) => value)
          .map(([key]) => key)
          .join(', ') || 'none'
      : 'unknown';
    lines.push(
      `| ${entry.arm} | ${expected} | ${entry.matchedTasks} | ${fmt(entry.rate)} | ${entry.status} |`,
    );
  }
  lines.push('');

  lines.push('## Clarification');
  lines.push('');
  lines.push('| Arm | Tasks with ask | Ask rate | Mean 1Q ratio | Cap hits | Cap hit rate |');
  lines.push('|---|---|---|---|---|---|');
  for (const entry of report.calibration?.clarification ?? []) {
    lines.push(
      `| ${entry.arm} | ${entry.tasksWithAsk} | ${fmt(entry.askRate)} | ${fmt(entry.oneQuestionRatioMean)} | ` +
        `${entry.capHits} | ${fmt(entry.capHitRate)} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** Quote a CSV field when needed. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** CSV columns for one task row. */
const CSV_COLUMNS = [
  'arm',
  'runId',
  'runMode',
  'instanceId',
  'status',
  'planPresent',
  'planSource',
  'planChars',
  'planSubmitted',
  'markerIntegrity',
  'citationTotal',
  'citationResolved',
  'citationOutOfBounds',
  'citationPhantom',
  'citationCorroborated',
  'citationDensity',
  'citationResolutionRate',
  'citationCorroborationRate',
  'askCalls',
  'oneQuestionRatio',
  'capHits',
  'spawnCalls',
  'planningTeammates',
  'parallelGroups',
  'handoffPresent',
  'handoffScore',
  'assumptionsCount',
  'resolved',
  'errorCount',
];

/**
 * Render the task-level table as CSV.
 *
 * @param {object} report report from `buildReport`
 * @returns {string}
 */
export function renderCsv(report) {
  const rows = Array.isArray(report?.tasks) ? [...report.tasks] : [];
  const armOrder = Array.isArray(report?.armOrder) ? report.armOrder : [];
  const rank = (arm) => {
    const index = armOrder.indexOf(arm);
    return index === -1 ? armOrder.length : index;
  };
  rows.sort((left, right) => {
    const byArm = rank(left.arm) - rank(right.arm);
    if (byArm !== 0) return byArm;
    return String(left.instanceId).localeCompare(String(right.instanceId));
  });
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}
