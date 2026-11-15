/**
 * One evaluation task end to end, and the batch driver around it.
 *
 * `runTask` prepares a git workspace, drives one SDK plan-mode session, applies
 * the review policy (cancel in plan mode, approve in execute mode), snapshots
 * the plan and citations at the review before answering, captures the patch in
 * execute mode, and writes the artifacts described in CONTRACTS.md.
 * `runBatch` iterates tasks deterministically with per-worker scratch homes,
 * writes and refreshes `manifest.json`, and skips already-`ok` tasks on resume.
 *
 * Driver, worktree, simulator, process executor, and spawn are injectable so
 * the whole path can run offline (see `dryRun`).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureDir, atomicWriteFile, readJsonIfExists } from '../util/fsutil.mjs';
import { appendJsonl } from '../util/jsonl.mjs';
import { sha256Hex } from '../util/hash.mjs';
import { nowIso } from '../util/time.mjs';
import { assertSafeId, newSessionId } from '../util/ids.mjs';
import { runCommand } from '../util/proc.mjs';
import { extractSession, advertisedToolNames } from '../session/events.mjs';
import { findSessionLog } from '../session/locate.mjs';
import { readSessionLog } from '../session/zstd-log.mjs';
import { buildPlanInput } from './prompts.mjs';
import { runSdkSession, isPlanReviewQuestion, planReviewApproveLabel } from './sdk-driver.mjs';
import * as defaultWorktree from './worktree.mjs';
import { createRecorder } from './transcript.mjs';
import { createSimulator } from '../simulator/user-sim.mjs';
import { createFakeDriver, createFakeSimulator } from '../fixtures/fake-driver.mjs';

/** Default DSH app CLI used to spawn the SDK stdio profile. */
export const DEFAULT_DSH_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
/** Default maximum number of simulator-answered question batches per task. */
export const DEFAULT_ANSWERS_CAP = 3;
/** Default wall-clock task deadline. */
export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
/** Default quiet period after terminal activity. */
export const DEFAULT_IDLE_SETTLE_MS = 8000;
/** The task status taxonomy from CONTRACTS.md. */
export const STATUSES = [
  'ok',
  'timeout',
  'plan_missing',
  'simulator_error',
  'init_error',
  'provider_error',
  'protocol_error',
  'spawn_error',
  'internal',
];

const ZERO_USAGE = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function tail(text, limit = 400) {
  const value = String(text ?? '').trim();
  return value.length <= limit ? value : `…${value.slice(-limit)}`;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
      .join('');
  }
  return '';
}

function normalizeModel(model) {
  return {
    provider: typeof model?.provider === 'string' ? model.provider : null,
    model: typeof model?.model === 'string' ? model.model : null,
    reasoningEffort: typeof model?.reasoningEffort === 'string' && model.reasoningEffort !== '' ? model.reasoningEffort : null,
    maxTokens: Number.isSafeInteger(model?.maxTokens) && model.maxTokens > 0 ? model.maxTokens : null,
  };
}

function modelNameOf(model) {
  if (model.provider === null && model.model === null) return 'unknown';
  if (model.provider === null) return model.model;
  if (model.model === null) return model.provider;
  return `${model.provider}/${model.model}`;
}

function normalizePolicy(policy, runMode) {
  const review =
    policy?.review === 'approve' || policy?.review === 'cancel'
      ? policy.review
      : runMode === 'execute'
        ? 'approve'
        : 'cancel';
  return {
    review,
    answersCap: Number.isInteger(policy?.answersCap) && policy.answersCap >= 0 ? policy.answersCap : DEFAULT_ANSWERS_CAP,
    taskTimeoutMs:
      Number.isFinite(policy?.taskTimeoutMs) && policy.taskTimeoutMs > 0 ? policy.taskTimeoutMs : DEFAULT_TASK_TIMEOUT_MS,
    idleSettleMs:
      Number.isFinite(policy?.idleSettleMs) && policy.idleSettleMs >= 0 ? policy.idleSettleMs : DEFAULT_IDLE_SETTLE_MS,
    approvals: policy?.approvals === true,
  };
}

function resolveHomeDir(home) {
  if (typeof home === 'string' && home.trim() !== '') return path.resolve(home);
  if (home !== null && typeof home === 'object' && typeof home.home === 'string' && home.home.trim() !== '') {
    return path.resolve(home.home);
  }
  return null;
}

/** Refuse to point a child at the real user profile. */
function assertSafeEvalHome(homeDir) {
  const realDshHome = path.resolve(os.homedir(), '.dsh');
  if (homeDir === realDshHome || homeDir.startsWith(`${realDshHome}${path.sep}`)) {
    throw new Error(`refusing to run against the real DSH home: ${homeDir}`);
  }
  return homeDir;
}

function selectIssueText(task, issueMode) {
  const primary = issueMode === 'full' ? task?.original_issue : task?.problem_statement;
  const fallback = issueMode === 'full' ? task?.problem_statement : task?.original_issue;
  const text = typeof primary === 'string' && primary.trim() !== '' ? primary : typeof fallback === 'string' ? fallback : '';
  return text.trim() === '' ? '(the task has no issue text)' : text;
}

function normalizePatchPaths(patches) {
  if (!Array.isArray(patches)) return [];
  return patches
    .map((patch) => (typeof patch === 'string' ? patch : patch?.path))
    .filter((value) => typeof value === 'string' && value !== '');
}

function normalizePatchDescriptors(patches) {
  if (!Array.isArray(patches)) return [];
  return patches.map((patch) =>
    typeof patch === 'string'
      ? { path: patch, sha256: null }
      : { path: typeof patch?.path === 'string' ? patch.path : null, sha256: typeof patch?.sha256 === 'string' ? patch.sha256 : null },
  );
}

function buildDriverArgs(patches) {
  return ['--profile', 'eval', ...normalizePatchPaths(patches).flatMap((file) => ['--patch', file])];
}

function firstOptionLabel(question) {
  if (!Array.isArray(question?.options) || question.options.length === 0) return '';
  const first = question.options[0];
  const label = typeof first === 'string' ? first : first?.label;
  return typeof label === 'string' ? label : '';
}

function planReviewText(question) {
  const detail = textOf(question?.detail);
  if (detail.trim() !== '') return detail;
  return typeof question?.question === 'string' ? question.question : '';
}

/** Extract the last exit_plan_mode argument as a fallback plan source. */
function planFromSessionFacts(facts) {
  const calls = Array.isArray(facts?.toolCalls) ? facts.toolCalls : [];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call?.name !== 'exit_plan_mode') continue;
    const args = call.args;
    if (args !== null && typeof args === 'object' && typeof args.plan === 'string' && args.plan.trim() !== '') return args.plan;
  }
  return '';
}

function countTurns(facts) {
  const ends = Array.isArray(facts?.turnEnds) ? facts.turnEnds.length : 0;
  if (ends > 0) return ends;
  let max = 0;
  const items = [...(facts?.toolCalls ?? []), ...(facts?.assistantMessages ?? [])];
  for (const item of items) {
    if (typeof item?.turn === 'number' && Number.isFinite(item.turn)) max = Math.max(max, item.turn);
  }
  return max;
}

function turnEndHadError(facts) {
  return (facts?.turnEnds ?? []).some((entry) => entry?.reason?.kind === 'error');
}

// ---------------------------------------------------------------------------
// Citations: snapshot at review time, before the worktree can disappear.
// ---------------------------------------------------------------------------

const PATH_EXTENSIONS =
  'js|mjs|cjs|jsx|ts|tsx|py|md|json|jsonl|yml|yaml|toml|txt|sh|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|html|css|scss|sass|less|vue|svelte|xml|sql|proto|lua|pl|gradle|lock|cfg|ini|conf';
const PATH_REF_PATTERN = new RegExp(
  `(?<![\\w:/.-])((?:[\\w.@+-]+/)*(?:[\\w.@+-]+\\.(?:${PATH_EXTENSIONS})))(?::(\\d+)(?:-(\\d+))?)?`,
  'gi',
);

/**
 * Extract `path:line` / `path:12-30` references from plan markdown.
 *
 * @param {string} planText the plan markdown
 * @returns {{raw: string, path: string, line: number|null, endLine: number|null}[]} deduplicated refs
 */
export function extractLocalPathRefs(planText) {
  if (typeof planText !== 'string' || planText === '') return [];
  const refs = [];
  const seen = new Set();
  for (const match of planText.matchAll(PATH_REF_PATTERN)) {
    const index = match.index ?? 0;
    if (planText.slice(Math.max(0, index - 8), index).includes('://')) continue;
    const filePath = match[1];
    const line = match[2] === undefined ? null : Number(match[2]);
    const endLine = match[3] === undefined ? null : Number(match[3]);
    const raw = `${filePath}${line === null ? '' : `:${line}${endLine === null ? '' : `-${endLine}`}`}`;
    if (seen.has(raw)) continue;
    seen.add(raw);
    refs.push({ raw, path: filePath, line, endLine });
  }
  return refs;
}

function toolArgumentText(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : [])
    .map((call) => `${call?.name ?? ''} ${call?.argsRaw ?? ''} ${call?.args === undefined ? '' : JSON.stringify(call.args)}`)
    .join('\n');
}

function resolveLocalPathRefs({ refs, root, toolCalls }) {
  const rootPath = path.resolve(root);
  const argumentText = toolArgumentText(toolCalls);
  const resolved = refs.map((ref) => {
    const entry = {
      raw: ref.raw,
      path: ref.path,
      line: ref.line ?? null,
      endLine: ref.endLine ?? null,
      resolved: false,
      inBounds: null,
      phantom: false,
      corroborated: ref.path !== '' && argumentText.includes(ref.path),
    };
    const target = path.resolve(rootPath, ref.path);
    if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) {
      entry.phantom = true;
      return entry;
    }
    let content;
    try {
      content = fs.readFileSync(target, 'utf8');
    } catch {
      entry.phantom = true;
      return entry;
    }
    if (entry.line === null) {
      entry.resolved = true;
      return entry;
    }
    const lineCount = content === '' ? 1 : content.split('\n').length;
    const endLine = entry.endLine === null ? entry.line : entry.endLine;
    entry.inBounds = entry.line >= 1 && endLine >= entry.line && endLine <= lineCount;
    entry.resolved = entry.inBounds;
    if (!entry.inBounds) entry.outOfBounds = true;
    return entry;
  });
  const count = (predicate) => resolved.filter(predicate).length;
  const planLines = Math.max(1, String(refs.length));
  return {
    refs: resolved,
    stats: {
      total: resolved.length,
      resolved: count((entry) => entry.resolved === true),
      outOfBounds: count((entry) => entry.outOfBounds === true),
      phantom: count((entry) => entry.phantom === true),
      corroborated: count((entry) => entry.corroborated === true),
      density: Number((resolved.length / planLines).toFixed(4)),
    },
  };
}

let pathScorerPromise = null;

function loadPathScorer() {
  if (pathScorerPromise === null) {
    pathScorerPromise = import(new URL('../score/paths.mjs', import.meta.url)).catch(() => null);
  }
  return pathScorerPromise;
}

/** Build `citations.json` content, preferring the scoring module when present. */
async function buildCitations({ planText, root, toolCalls }) {
  const scorer = await loadPathScorer();
  if (scorer !== null && typeof scorer.resolvePathRefs === 'function') {
    try {
      const refs =
        typeof scorer.extractPathRefs === 'function' ? scorer.extractPathRefs(planText) : extractLocalPathRefs(planText);
      const result = scorer.resolvePathRefs({ refs, root, toolCalls, textLength: planText.length });
      if (result !== null && typeof result === 'object' && Array.isArray(result.refs) && result.stats !== undefined) {
        return { refs: result.refs, stats: result.stats };
      }
    } catch {
      // fall through to the local resolver
    }
  }
  return resolveLocalPathRefs({ refs: extractLocalPathRefs(planText), root, toolCalls });
}

// ---------------------------------------------------------------------------
// Question policy: review snapshots and simulator-mediated clarifications.
// ---------------------------------------------------------------------------

function normalizeSimulatorAnswers(rawAnswers, questions) {
  const expected = questions.map((question) => String(question.id));
  const expectedSet = new Set(expected);
  const byId = new Map();
  for (const answer of Array.isArray(rawAnswers) ? rawAnswers : []) {
    if (answer === null || typeof answer !== 'object' || typeof answer.id !== 'string') continue;
    byId.set(answer.id, answer);
  }
  const answers = [];
  for (const id of expected) {
    const answer = byId.get(id);
    if (answer === undefined) throw new Error(`simulator did not answer question id: ${id}`);
    if (!Array.isArray(answer.selected) || !answer.selected.every((label) => typeof label === 'string')) {
      throw new Error(`simulator answer ${id} requires a selected string array`);
    }
    if (answer.custom !== undefined && typeof answer.custom !== 'string') {
      throw new Error(`simulator answer ${id} custom must be a string`);
    }
    answers.push({
      id,
      selected: [...answer.selected],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    });
  }
  for (const id of byId.keys()) {
    if (!expectedSet.has(id)) throw new Error(`simulator answered an unknown question id: ${id}`);
  }
  return answers;
}

function createQuestionPolicy({ task, runMode, policy, simulator, taskDir, worktreeDir, state, getToolCalls }) {
  async function handleReview(review, questions, request) {
    const planText = planReviewText(review);
    const action = runMode === 'execute' ? 'approve' : 'cancel';
    const citations = await buildCitations({ planText, root: worktreeDir, toolCalls: getToolCalls() });
    const snapshot = {
      requestId: typeof request.requestId === 'string' ? request.requestId : null,
      question: typeof review.question === 'string' ? review.question : null,
      options: Array.isArray(review.options) ? review.options : null,
      detail: planText,
      action,
      answeredAt: nowIso(),
    };
    atomicWriteFile(path.join(taskDir, 'plan.md'), planText);
    atomicWriteFile(path.join(taskDir, 'citations.json'), `${JSON.stringify(citations, null, 2)}\n`);
    atomicWriteFile(path.join(taskDir, 'plan-review.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
    state.reviewAction = action;
    state.reviewSnapshot = snapshot;
    if (action === 'cancel') return { cancelled: true, decision: 'cancel' };
    const approveLabel = planReviewApproveLabel(review);
    const answers = [{ id: String(review.id), selected: [approveLabel] }];
    for (const other of questions) {
      if (other === review) continue;
      const label = firstOptionLabel(other);
      answers.push(
        label === ''
          ? { id: String(other.id), selected: [], custom: 'No answer provided.' }
          : { id: String(other.id), selected: [label] },
      );
    }
    return { answers, decision: 'approve' };
  }

  async function handleAsk(questions) {
    state.askCount += 1;
    if (simulator?.kind === 'none') return { cancelled: true, decision: 'cancel' };
    if (state.askCount > policy.answersCap) {
      state.capHits += 1;
      return { cancelled: true, capHit: true, decision: 'cancel' };
    }
    let result;
    try {
      result = await simulator.answer({ task, questions, history: state.history });
    } catch (error) {
      state.errors.push({ kind: 'simulator', message: messageOf(error) });
      throw new Error(`simulator failed: ${messageOf(error)}`);
    }
    if (result !== null && typeof result === 'object' && result.cancelled === true) {
      return { cancelled: true, decision: 'cancel' };
    }
    const answers = normalizeSimulatorAnswers(result?.answers, questions);
    if (result?.usage !== null && typeof result?.usage === 'object') {
      state.simulatorUsage.inputTokens += Number.isFinite(result.usage.inputTokens) ? result.usage.inputTokens : 0;
      state.simulatorUsage.outputTokens += Number.isFinite(result.usage.outputTokens) ? result.usage.outputTokens : 0;
    }
    state.simulatorCalls += 1;
    state.history.push({ questions, answers });
    return { answers, capHit: result?.capHit === true };
  }

  return async function questionPolicy(request) {
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    const review = questions.find((question) => isPlanReviewQuestion(question));
    if (review !== undefined) {
      try {
        return await handleReview(review, questions, request ?? {});
      } catch (error) {
        state.errors.push({ kind: 'review-snapshot', message: messageOf(error) });
        throw error;
      }
    }
    return handleAsk(questions);
  };
}

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

function emptyMeta({ task, arm, issueMode, runMode, sessionId, startedAt }) {
  return {
    schemaVersion: 1,
    instanceId: task?.instance_id ?? null,
    arm,
    issueMode,
    runMode,
    status: 'internal',
    failureKind: 'unknown',
    sessionId,
    baseCommit: task?.base_commit ?? null,
    worktree: null,
    startedAt,
    finishedAt: nowIso(),
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
    usage: ZERO_USAGE(),
    reviewAction: 'none',
    askCount: 0,
    capHits: 0,
    simulator: { kind: 'none' },
    gitDiffSha256: null,
  };
}

function writeMeta(taskDir, meta) {
  atomicWriteFile(path.join(taskDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

function normalizeUsage(usage) {
  return {
    inputTokens: Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0,
    outputTokens: Number.isFinite(usage?.outputTokens) ? usage.outputTokens : 0,
    cacheReadTokens: Number.isFinite(usage?.cacheReadTokens) ? usage.cacheReadTokens : 0,
    cacheWriteTokens: Number.isFinite(usage?.cacheWriteTokens) ? usage.cacheWriteTokens : 0,
  };
}

function classifyRun({ driverResult, simulatorState, planText, reviewSnapshot, facts }) {
  const errors = Array.isArray(driverResult?.errors) ? driverResult.errors : [];
  if (driverResult?.timedOut === true) return { status: 'timeout', failureKind: 'timeout' };
  const spawnError = errors.find((error) => error?.kind === 'spawn');
  if (spawnError) return { status: 'spawn_error', failureKind: 'spawn' };
  const initError = errors.find((error) => error?.kind === 'rpc' && error.method === 'initialize');
  if (initError) return { status: 'init_error', failureKind: 'initialize' };
  const snapshotError = simulatorState.errors.find((error) => error.kind === 'review-snapshot');
  if (snapshotError) return { status: 'internal', failureKind: 'review-snapshot' };
  const simulatorError =
    simulatorState.errors.find((error) => error.kind === 'simulator') ??
    errors.find((error) => error?.kind === 'question-policy');
  if (simulatorError) {
    return { status: 'simulator_error', failureKind: simulatorError.kind === 'simulator' ? 'simulator' : 'question-policy' };
  }
  const malformed = errors.find((error) =>
    ['malformed', 'unsupported-request', 'input', 'stdin'].includes(error?.kind),
  );
  if (malformed) return { status: 'protocol_error', failureKind: malformed.kind };
  const rpcError = errors.find((error) => error?.kind === 'rpc');
  if (rpcError) return { status: 'protocol_error', failureKind: `rpc:${rpcError.method ?? 'unknown'}` };
  const finishReason = driverResult?.completion?.finishReason;
  if (finishReason === 'error' || finishReason === 'aborted') {
    return { status: 'provider_error', failureKind: `finish:${finishReason}` };
  }
  if (turnEndHadError(facts)) return { status: 'provider_error', failureKind: 'turn-error' };
  if (reviewSnapshot === null || typeof planText !== 'string' || planText.trim() === '') {
    return { status: 'plan_missing', failureKind: 'no-plan-review' };
  }
  const processError = errors.find((error) => error?.kind === 'process-exit' || error?.kind === 'driver');
  if (processError) return { status: 'protocol_error', failureKind: processError.kind };
  if (driverResult === null || driverResult === undefined) return { status: 'internal', failureKind: 'driver-missing' };
  return { status: 'ok', failureKind: null };
}

/**
 * Run one task and write its artifacts.
 *
 * @param {object} options
 * @param {object} options.task normalized task row
 * @param {string} options.runDir run directory
 * @param {'native'|'evidence'|'full'} [options.arm]
 * @param {'hidden'|'full'} [options.issueMode]
 * @param {'plan'|'execute'} [options.runMode]
 * @param {string|object} options.home scratch DSH home (string or provision record)
 * @param {object[]} [options.patches] arm patch descriptors (`{path, sha256}`)
 * @param {object} [options.model] model route
 * @param {object} [options.simulator] `createSimulator` instance
 * @param {Function} [options.driver] injectable driver (defaults to `runSdkSession`)
 * @param {object} [options.worktree] injectable worktree module
 * @param {object} [options.policy] policy overrides
 * @param {boolean} [options.dryRun] use the fake driver and a synthetic workspace
 * @param {string} [options.worktreeDir] reuse a prepared directory instead of git
 * @param {string} [options.cacheRoot] mirror/worktree cache root
 * @param {Function} [options.exec] injectable `runCommand`
 * @param {Function} [options.spawnImpl] injectable `spawn`
 * @param {string} [options.dshCli] app CLI path
 * @param {string} [options.sessionId] fixed SDK session id (tests)
 * @returns {Promise<object>} the written `meta.json`
 */
export async function runTask(options = {}) {
  const task = options.task;
  if (task === null || typeof task !== 'object') throw new TypeError('runTask requires a task');
  if (typeof task.instance_id !== 'string' || task.instance_id === '') {
    throw new TypeError('task.instance_id is required');
  }
  assertSafeId(task.instance_id);
  if (typeof options.runDir !== 'string' || options.runDir.trim() === '') {
    throw new TypeError('runTask requires runDir');
  }
  const runDir = path.resolve(options.runDir);
  ensureDir(runDir);
  const taskDir = path.join(runDir, 'tasks', task.instance_id);
  ensureDir(taskDir);
  const startedAt = nowIso();
  const arm = options.arm ?? 'native';
  const issueMode = options.issueMode ?? 'hidden';
  const runMode = options.runMode ?? 'plan';
  const sessionId = options.sessionId ?? newSessionId();
  const dryRun = options.dryRun === true;
  const simulator = options.simulator ?? (dryRun ? createFakeSimulator() : createSimulator({ kind: 'none' }));
  try {
    return await executeTask({
      options,
      task,
      runDir,
      taskDir,
      startedAt,
      arm,
      issueMode,
      runMode,
      sessionId,
      dryRun,
      simulator,
    });
  } catch (error) {
    const meta = emptyMeta({ task, arm, issueMode, runMode, sessionId, startedAt });
    meta.failureKind = 'internal';
    meta.error = messageOf(error);
    meta.durationMs = Math.max(0, Date.parse(meta.finishedAt) - Date.parse(startedAt));
    writeMeta(taskDir, meta);
    return meta;
  }
}

async function executeTask({ options, task, runDir, taskDir, startedAt, arm, issueMode, runMode, sessionId, dryRun, simulator }) {
  const model = normalizeModel(options.model);
  const policy = normalizePolicy(options.policy, runMode);
  const homeDir =
    resolveHomeDir(options.home) ?? (dryRun ? path.join(runDir, '.dryrun', 'homes', 'w0') : null);
  if (homeDir === null) throw new Error('runTask requires a scratch DSH home');
  assertSafeEvalHome(homeDir);
  ensureDir(homeDir);
  const cacheRoot = options.cacheRoot ?? defaultWorktree.defaultCacheRoot();
  const exec = options.exec ?? runCommand;
  const worktreeApi = options.worktree ?? defaultWorktree;
  const driver =
    options.driver ??
    (dryRun ? createFakeDriver({ tasks: [task], answers: options.dryRunAnswers ?? {} }) : runSdkSession);
  const recorder = createRecorder(taskDir);
  const state = { events: [] };
  const simulatorState = {
    askCount: 0,
    capHits: 0,
    simulatorCalls: 0,
    simulatorUsage: { inputTokens: 0, outputTokens: 0 },
    history: [],
    errors: [],
    reviewAction: 'none',
    reviewSnapshot: null,
  };
  const warnings = [];
  let worktreeDir = null;
  let worktreeKind = null;
  let shouldRemove = false;
  let driverResult = null;
  let diff = null;
  let gitDiffSha256 = null;

  try {
    // Workspace.
    if (typeof options.worktreeDir === 'string' && options.worktreeDir.trim() !== '') {
      worktreeDir = path.resolve(options.worktreeDir);
      if (!fs.existsSync(worktreeDir)) throw new Error(`provided worktreeDir does not exist: ${worktreeDir}`);
      worktreeKind = 'provided';
    } else if (dryRun) {
      worktreeDir = path.join(runDir, '.dryrun', 'worktrees', task.instance_id);
      ensureDir(worktreeDir);
      const readme = path.join(worktreeDir, 'README.md');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme, '# Dry-run workspace\n\nThe synthetic task worktree used by offline selftests.\n');
      }
      // Initialize a local git repository so execute-mode diff capture runs the
      // real code path without any network, model, or remote repository.
      try {
        await exec({ command: 'git', args: ['init', '--quiet', worktreeDir], timeoutMs: 60000 });
      } catch (error) {
        warnings.push(`dry-run git init failed: ${messageOf(error)}`);
      }
      worktreeKind = 'dry-run';
    } else {
      const dir = defaultWorktree.worktreePath({
        repo: task.repo,
        cacheRoot,
        worker: path.basename(homeDir) || 'w0',
        instanceId: task.instance_id,
      });
      if (fs.existsSync(dir)) {
        await worktreeApi.removeWorktree?.({ repo: task.repo, cacheRoot, dir, exec });
        if (fs.existsSync(dir)) throw new Error(`stale worktree directory could not be removed: ${dir}`);
      }
      const added = await worktreeApi.addWorktree({
        repo: task.repo,
        cacheRoot,
        baseCommit: task.base_commit,
        dir,
        exec,
      });
      if (added === null || typeof added !== 'object' || typeof added.dir !== 'string') {
        throw new Error('worktree.addWorktree returned no directory');
      }
      worktreeDir = added.dir;
      worktreeKind = added.kind ?? 'worktree';
      for (const warning of added.warnings ?? []) warnings.push(warning);
      shouldRemove = true;
    }

    // Wire + event streaming.
    function onFrame(frame) {
      try {
        recorder.wire(frame.kind, frame);
      } catch (error) {
        warnings.push(`wire transcript write failed: ${messageOf(error)}`);
      }
      if (frame.kind === 'notification' && frame.method === 'session.event') {
        const sessionEvent = frame.payload?.event;
        if (sessionEvent !== null && typeof sessionEvent === 'object') state.events.push(sessionEvent);
      }
    }

    const questionPolicy = createQuestionPolicy({
      task,
      runMode,
      policy,
      simulator,
      taskDir,
      worktreeDir,
      state: simulatorState,
      getToolCalls: () => extractSession(state.events).toolCalls,
    });

    const issueText = selectIssueText(task, issueMode);
    const inputText = buildPlanInput(issueText);
    const command = options.dshCli ?? process.env.DSH_CLI ?? DEFAULT_DSH_CLI;
    const args = buildDriverArgs(options.patches);
    const childEnv = { ...process.env, DSH_HOME: homeDir };

    try {
      driverResult = await driver({
        command,
        args,
        cwd: worktreeDir,
        env: childEnv,
        model,
        sessionId,
        inputText,
        questionPolicy,
        timeoutMs: policy.taskTimeoutMs,
        idleSettleMs: policy.idleSettleMs,
        spawnImpl: options.spawnImpl,
        onFrame,
        dryRun,
        task,
        arm,
        issueMode,
        runMode,
        askUserQuestion: options.askUserQuestion,
        fakeAskCount: options.fakeAskCount,
        omitTools: options.omitTools,
      });
    } catch (error) {
      warnings.push(`driver failed: ${messageOf(error)}`);
      driverResult = {
        frames: [],
        questions: [],
        response: null,
        completion: null,
        exitCode: null,
        stderrTail: '',
        startedAt,
        endedAt: nowIso(),
        timedOut: false,
        errors: [{ kind: 'driver', message: messageOf(error) }],
        warnings: [],
      };
    }
    if (driverResult === null || typeof driverResult !== 'object') driverResult = { errors: [{ kind: 'driver', message: 'driver returned no result' }] };
    for (const row of Array.isArray(driverResult.questions) ? driverResult.questions : []) {
      recorder.question(row);
    }

    // Durable events: streamed frames first, then the persisted session log.
    if (state.events.length === 0 && !dryRun) {
      try {
        const logFile = findSessionLog(homeDir, sessionId);
        if (logFile !== null) {
          const decoded = readSessionLog(logFile);
          state.events = Array.isArray(decoded.events) ? decoded.events : [];
        }
      } catch (error) {
        warnings.push(`session log fallback failed: ${messageOf(error)}`);
      }
    }
    for (const sessionEvent of state.events) recorder.event(sessionEvent);

    const facts = extractSession(state.events);
    const planText = simulatorState.reviewSnapshot?.detail ?? planFromSessionFacts(facts);
    const usage = normalizeUsage(facts.usage);
    const statusInfo = classifyRun({
      driverResult,
      simulatorState,
      planText,
      reviewSnapshot: simulatorState.reviewSnapshot,
      facts,
    });
    const requiredTools = ['ask_user_question', 'exit_plan_mode', 'spawn_teammate'];
    const rosterTools = advertisedToolNames(facts);
    const toolRoster = {
      checked: Array.isArray(rosterTools),
      ok: null,
      missing: [],
      tools: Array.isArray(rosterTools) ? rosterTools : null,
    };
    if (toolRoster.checked) {
      toolRoster.missing = requiredTools.filter((name) => !rosterTools.includes(name));
      toolRoster.ok = toolRoster.missing.length === 0;
      if (!toolRoster.ok) {
        warnings.push(`tool roster is missing: ${toolRoster.missing.join(', ')}`);
        if (statusInfo.status === 'ok') {
          statusInfo.status = 'protocol_error';
          statusInfo.failureKind = 'tool-roster';
        }
      }
    }

    // Execute-mode patch capture happens before the worktree is removed.
    if (runMode === 'execute' && worktreeDir !== null) {
      try {
        const captured = await worktreeApi.captureDiff({ dir: worktreeDir, exec });
        diff = typeof captured?.diff === 'string' ? captured.diff : '';
        if (captured?.ok === false) warnings.push(`git diff failed: ${tail(captured.stderr)}`);
      } catch (error) {
        warnings.push(`git diff failed: ${messageOf(error)}`);
        diff = '';
      }
      gitDiffSha256 = sha256Hex(diff ?? '');
    }

    // Artifacts.
    atomicWriteFile(path.join(taskDir, 'plan.md'), planText);
    if (!fs.existsSync(path.join(taskDir, 'plan-review.json'))) {
      atomicWriteFile(
        path.join(taskDir, 'plan-review.json'),
        `${JSON.stringify({ requestId: null, question: null, options: null, detail: planText, action: 'none', answeredAt: null }, null, 2)}\n`,
      );
    }
    if (!fs.existsSync(path.join(taskDir, 'citations.json'))) {
      const citations = await buildCitations({ planText, root: worktreeDir, toolCalls: facts.toolCalls });
      atomicWriteFile(path.join(taskDir, 'citations.json'), `${JSON.stringify(citations, null, 2)}\n`);
    }
    if (runMode === 'execute') {
      atomicWriteFile(path.join(taskDir, 'diff.patch'), diff ?? '');
      appendJsonl(path.join(runDir, 'predictions.jsonl'), {
        instance_id: task.instance_id,
        model_name_or_path: modelNameOf(model),
        model_patch: diff ?? '',
      });
    }

    const finishedAt = nowIso();
    const meta = {
      schemaVersion: 1,
      instanceId: task.instance_id,
      arm,
      issueMode,
      runMode,
      status: statusInfo.status,
      failureKind: statusInfo.failureKind,
      sessionId,
      baseCommit: typeof task.base_commit === 'string' ? task.base_commit : null,
      worktree: worktreeDir,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      turns: countTurns(facts),
      toolCalls: Array.isArray(facts.toolCalls) ? facts.toolCalls.length : 0,
      usage,
      reviewAction: simulatorState.reviewAction,
      askCount: simulatorState.askCount,
      capHits: simulatorState.capHits,
      toolRoster,
      simulator: {
        kind: typeof simulator?.kind === 'string' ? simulator.kind : 'none',
        ...(simulatorState.simulatorCalls > 0
          ? { usage: { ...simulatorState.simulatorUsage, calls: simulatorState.simulatorCalls } }
          : {}),
      },
      gitDiffSha256,
      ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
      ...(worktreeKind === null ? {} : { worktreeKind }),
    };
    writeMeta(taskDir, meta);
    recorder.flush();
    return meta;
  } finally {
    // Worktrees are retained by default so post-run citation scoring can
    // resolve `meta.worktree`; `removeWorktree: true` opts into cleanup.
    if (shouldRemove && worktreeDir !== null && options.removeWorktree === true) {
      try {
        await worktreeApi.removeWorktree?.({ repo: task.repo, cacheRoot, dir: worktreeDir, exec });
      } catch {
        // workspace cleanup must not fail the task
      }
    }
  }
}

// ---------------------------------------------------------------------------
// runBatch
// ---------------------------------------------------------------------------

function taskDirFor(runDir, task) {
  return path.join(runDir, 'tasks', String(task?.instance_id ?? ''));
}

function summarizeTasks(runDir, tasks) {
  const counts = { total: tasks.length, ok: 0, failed: 0, byStatus: {} };
  const usage = ZERO_USAGE();
  for (const task of tasks) {
    const meta = readJsonIfExists(path.join(taskDirFor(runDir, task), 'meta.json'));
    if (meta === null || typeof meta !== 'object') continue;
    const status = typeof meta.status === 'string' ? meta.status : 'internal';
    counts.byStatus[status] = (counts.byStatus[status] ?? 0) + 1;
    const taskUsage = normalizeUsage(meta.usage);
    usage.inputTokens += taskUsage.inputTokens;
    usage.outputTokens += taskUsage.outputTokens;
    usage.cacheReadTokens += taskUsage.cacheReadTokens;
    usage.cacheWriteTokens += taskUsage.cacheWriteTokens;
  }
  counts.ok = counts.byStatus.ok ?? 0;
  counts.failed = counts.total - counts.ok;
  return { counts, usage };
}

function deriveRunId({ arm, issueMode, runMode, seed, startedAt }) {
  const stamp = String(startedAt).replace(/[^0-9]/g, '').slice(0, 14);
  return `${arm}-${issueMode}-${runMode}-${seed === null || seed === undefined ? 'noseed' : seed}-${stamp}`;
}

/**
 * Run a batch of tasks and write `manifest.json`.
 *
 * The input order is the deterministic iteration order; `offset`/`limit` slice
 * it. Concurrency never exceeds the number of scratch homes (for live runs)
 * because a home is single-writer. `resume` skips tasks whose `meta.json`
 * status is already `ok`.
 *
 * @param {object} options
 * @param {object[]} options.tasks tasks to run
 * @param {string} options.runId run identity
 * @param {string} options.runDir run directory
 * @param {(object[]|undefined)} options.homes per-worker provision records
 * @param {object} [options.deps] injected implementations and environment facts
 * @returns {Promise<object>} the final manifest
 */
export async function runBatch(options = {}) {
  if (typeof options.runDir !== 'string' || options.runDir.trim() === '') {
    throw new TypeError('runBatch requires runDir');
  }
  const runDir = path.resolve(options.runDir);
  ensureDir(runDir);
  const allTasks = Array.isArray(options.tasks) ? options.tasks : [];
  const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0;
  const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : null;
  const selected = limit === null ? allTasks.slice(offset) : allTasks.slice(offset, offset + limit);
  const deps = options.deps ?? {};
  const dryRun = options.dryRun === true || deps.dryRun === true;
  const arm = options.arm ?? 'native';
  const issueMode = options.issueMode ?? 'hidden';
  const runMode = options.runMode ?? 'plan';
  const homes = Array.isArray(options.homes) ? options.homes : [];
  if (!dryRun && selected.length > 0 && homes.length === 0) {
    throw new Error('runBatch requires at least one scratch home for a live run');
  }
  const requestedConcurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : 1;
  const concurrency = Math.max(
    1,
    Math.min(requestedConcurrency, homes.length > 0 ? homes.length : requestedConcurrency, Math.max(1, selected.length)),
  );
  const model = normalizeModel(options.model);
  const policy = normalizePolicy(options.policy, runMode);
  const cacheRoot = options.cacheRoot ?? deps.cacheRoot ?? defaultWorktree.defaultCacheRoot();
  const simulator = options.simulator ?? (dryRun ? createFakeSimulator() : createSimulator({ kind: 'none' }));
  const driver =
    options.driver ??
    deps.driver ??
    (dryRun ? createFakeDriver({ tasks: selected, answers: deps.fakeAnswers ?? {} }) : undefined);
  const worktreeApi = options.worktree ?? deps.worktree;
  const exec = deps.exec ?? runCommand;
  const spawnImpl = deps.spawnImpl;
  const dshCli = options.dshCli ?? deps.dshCli ?? process.env.DSH_CLI ?? DEFAULT_DSH_CLI;
  const seed = options.seed ?? null;
  const resume = options.resume === true;
  const previous = resume ? readJsonIfExists(path.join(runDir, 'manifest.json')) : null;
  const startedAt = typeof previous?.startedAt === 'string' ? previous.startedAt : nowIso();
  const manifest = {
    schemaVersion: 1,
    runId: options.runId ?? previous?.runId ?? deriveRunId({ arm, issueMode, runMode, seed, startedAt }),
    arm,
    issueMode,
    runMode,
    model,
    workspace: deps.workspace ?? options.workspace ?? { root: process.cwd(), pluginHead: null, pluginDirty: false },
    env: {
      node: process.version,
      dshCli,
      dshHome: resolveHomeDir(homes[0]) ?? null,
      appVersion: deps.appVersion ?? null,
      platform: process.platform,
      cpus: typeof os.cpus === 'function' ? os.cpus().length : 0,
    },
    patches: normalizePatchDescriptors(options.patches),
    sample: {
      tasksFile: deps.tasksFile ?? options.tasksFile ?? null,
      sha256: deps.tasksSha256 ?? options.tasksSha256 ?? null,
      ids: selected.map((task) => task?.instance_id),
      count: selected.length,
    },
    policy,
    simulator: {
      kind: typeof simulator?.kind === 'string' ? simulator.kind : 'none',
      model: typeof simulator?.model === 'string' ? simulator.model : null,
    },
    seed,
    startedAt,
    finishedAt: null,
    counts: { total: selected.length, ok: 0, failed: selected.length, byStatus: {} },
    usage: ZERO_USAGE(),
    stopReason: null,
  };
  const manifestFile = path.join(runDir, 'manifest.json');

  function writeManifest() {
    const summary = summarizeTasks(runDir, selected);
    manifest.counts = summary.counts;
    manifest.usage = summary.usage;
    atomicWriteFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  writeManifest();
  if (selected.length === 0) {
    manifest.finishedAt = nowIso();
    writeManifest();
    return manifest;
  }

  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= selected.length) return;
      const task = selected[index];
      const home = homes.length > 0 ? homes[index % homes.length] : { name: 'dry-run', home: path.join(runDir, 'dry-run-home') };
      if (resume) {
        const previousMeta = readJsonIfExists(path.join(taskDirFor(runDir, task), 'meta.json'));
        if (previousMeta?.status === 'ok') continue;
      }
      try {
        await runTask({
          task,
          arm,
          issueMode,
          runMode,
          runDir,
          home,
          patches: options.patches,
          model,
          simulator,
          driver,
          worktree: worktreeApi,
          policy,
          dryRun,
          cacheRoot,
          exec,
          spawnImpl,
          dshCli,
          askUserQuestion: deps.askUserQuestion,
          fakeAskCount: deps.fakeAskCount,
          dryRunAnswers: deps.fakeAnswers,
        });
      } catch (error) {
        deps.onError?.(error, task);
      }
      writeManifest();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  manifest.finishedAt = nowIso();
  writeManifest();
  return manifest;
}
