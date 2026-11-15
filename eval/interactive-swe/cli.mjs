#!/usr/bin/env node
/**
 * interactive-swe evaluation CLI.
 *
 * One entry point for the repository-only harness: dataset setup, scratch
 * profile provisioning, preflight, offline selftest/dry-run, the gated live
 * run, scoring, reporting, optional judge, and cache cleanup.
 *
 * Exit codes: 0 success, 1 runtime failure, 2 blocked (preflight/gating).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARM_NAMES,
  armPatchPath,
  basePatchPath,
  defaultCacheRoot,
  provision,
  ensurePeerDependencies,
  PEER_DEPENDENCIES,
} from './profile/provision.mjs';
import { DEFAULT_DSH_CLI, preflight } from './profile/preflight.mjs';
import { fetchDataset, refreshBatchIds } from './dataset/fetch-dataset.mjs';
import { normalizeParquet, readTasks } from './dataset/normalize.mjs';
import { normalizeTasks, selectTasks } from './tasks/schema.mjs';
import { createSimulator } from './simulator/user-sim.mjs';
import { runBatch } from './runner/runner.mjs';
import { warmRepositories } from './runner/warm.mjs';
import { scoreRun } from './score/aggregate.mjs';
import { buildReport, renderCsv, renderMarkdown } from './score/report.mjs';
import { judgeRun } from './judge/judge.mjs';
import { readJsonl } from './util/jsonl.mjs';
import { atomicWriteFile, ensureDir, readJsonIfExists } from './util/fsutil.mjs';
import { sha256Hex } from './util/hash.mjs';
import { nowIso } from './util/time.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BATCH_IDS_FILE = path.join(HERE, 'dataset', 'batch1_ids.txt');
const SAMPLE_TASKS_FILE = path.join(HERE, 'dataset', 'fixtures', 'tasks.sample.jsonl');
const CACHE_ROOT = defaultCacheRoot(process.env);
const DATASET_FILE = path.join(CACHE_ROOT, 'dataset', 'tasks.jsonl');
const RUNS_ROOT = path.join(CACHE_ROOT, 'runs');
const REPORTS_ROOT = path.join(CACHE_ROOT, 'reports');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_BLOCKED = 2;

function usage() {
  return `interactive-swe evaluation harness

Usage: node eval/interactive-swe/cli.mjs <command> [options]

Commands:
  provision       Create scratch eval DSH home(s) under the cache
  fetch-dataset   Download the pinned parquet and verify its sha256
  normalize       Convert the parquet into tasks.jsonl (uv + pyarrow)
  prepare         fetch-dataset + normalize
  preflight       Report environment blockers; --compose/--check-profile run live checks
  selftest        Offline fixture end-to-end: run artifacts -> score -> report
  dry-run         Same as selftest with a chosen fixture tasks file
  run             Gated live SDK run; requires --confirm-live
  warm-repos      Pre-clone the selected tasks' repository mirrors (optional)
  score           Score one run directory
  report          Build report.json/csv/md from scored runs
  judge           Optional LLM judge for one run (disabled by default)
  clean           Remove cache runs/reports/homes (never ~/.dsh)

Common options:
  --json                 machine-readable output
  --out <dir>            output directory
  --help                 this help

Run options:
  --arm <native|evidence|full>       default: full
  --issue-mode <hidden|full>         default: hidden
  --run-mode <plan|execute>          default: plan
  --ids-file <file>                  default: dataset/batch1_ids.txt
  --all                              use every normalized task
  --limit <n> --offset <n> --sample <n> --seed <n>
  --concurrency <n>                  default: 1 (each worker needs a home)
  --resume                           skip tasks whose meta.status is ok
  --confirm-live                     required for a real model run

Environment:
  GREAT_PLAN_EVAL_CACHE   cache root (default ~/.cache/great-plan-eval)
  DSH_CLI                 DSH app CLI (default /Applications/.../runtime/cli/bin/dsh)
  EVAL_PROVIDER, EVAL_MODEL, EVAL_REASONING_EFFORT, EVAL_MAX_TOKENS
  EVAL_SIMULATOR (none|fixture|http), EVAL_SIMULATOR_MODEL,
  EVAL_SIMULATOR_BASE_URL, EVAL_SIMULATOR_API_KEY, EVAL_ANSWER_CAP
  EVAL_JUDGE_BASE_URL, EVAL_JUDGE_API_KEY, EVAL_JUDGE_MODEL
`;
}

function fail(message, code = EXIT_FAIL) {
  process.stderr.write(`${message}\n`);
  return code;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      const error = new Error(`unexpected argument: ${arg}`);
      error.code = 'BAD_ARGS';
      throw error;
    }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    const key = equals === -1 ? body : body.slice(0, equals);
    if (equals !== -1) {
      options[key] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function flag(options, key) {
  return options[key] === true || options[key] === 'true' || options[key] === '1';
}

function integerOption(options, key, fallback = null) {
  if (options[key] === undefined || options[key] === true) return fallback;
  const value = Number(options[key]);
  if (!Number.isInteger(value)) {
    const error = new Error(`--${key} must be an integer`);
    error.code = 'BAD_ARGS';
    throw error;
  }
  return value;
}

function stamp() {
  return nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function cacheRelative(target) {
  const resolved = path.resolve(target);
  const cache = path.resolve(CACHE_ROOT);
  return resolved === cache || resolved.startsWith(`${cache}${path.sep}`);
}

function requireCachePath(target) {
  if (!cacheRelative(target)) {
    const error = new Error(`refusing to modify a path outside the eval cache: ${target}`);
    error.code = 'UNSAFE_PATH';
    throw error;
  }
  return path.resolve(target);
}

function readModel(env = process.env) {
  const provider = typeof env.EVAL_PROVIDER === 'string' ? env.EVAL_PROVIDER.trim() : '';
  const model = typeof env.EVAL_MODEL === 'string' ? env.EVAL_MODEL.trim() : '';
  if (provider === '' || model === '') return null;
  return {
    provider,
    model,
    ...(typeof env.EVAL_REASONING_EFFORT === 'string' && env.EVAL_REASONING_EFFORT !== ''
      ? { reasoningEffort: env.EVAL_REASONING_EFFORT }
      : {}),
    ...(Number.isSafeInteger(Number(env.EVAL_MAX_TOKENS)) && Number(env.EVAL_MAX_TOKENS) > 0
      ? { maxTokens: Number(env.EVAL_MAX_TOKENS) }
      : {}),
  };
}

function issueModeFor(options) {
  return typeof options['issue-mode'] === 'string' ? options['issue-mode'] : 'hidden';
}

function readSimulatorSpec(env = process.env) {
  const kind = typeof env.EVAL_SIMULATOR === 'string' && env.EVAL_SIMULATOR !== '' ? env.EVAL_SIMULATOR : 'none';
  return {
    kind,
    model: typeof env.EVAL_SIMULATOR_MODEL === 'string' && env.EVAL_SIMULATOR_MODEL !== '' ? env.EVAL_SIMULATOR_MODEL : null,
  };
}

function createLiveSimulator(env = process.env) {
  const spec = readSimulatorSpec(env);
  let fixture = null;
  if (spec.kind === 'fixture') {
    const file = env.EVAL_SIMULATOR_FIXTURE;
    if (typeof file !== 'string' || file === '') throw new Error('fixture simulator requires EVAL_SIMULATOR_FIXTURE');
    fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const cap = Number(env.EVAL_ANSWER_CAP ?? 3);
  return createSimulator({
    kind: spec.kind,
    model: spec.model,
    baseUrl: env.EVAL_SIMULATOR_BASE_URL ?? null,
    apiKey: env.EVAL_SIMULATOR_API_KEY ?? null,
    fixture,
    cap: Number.isInteger(cap) && cap >= 0 ? cap : 3,
  });
}

function readAppVersion() {
  const candidates = [
    path.join(path.dirname(process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'), '..', '..', '..', 'app.asar', 'dsh', 'package.json'),
  ];
  for (const candidate of candidates) {
    const parsed = readJsonIfExists(candidate, null);
    if (parsed !== null && typeof parsed.version === 'string') return parsed.version;
  }
  return null;
}

function loadTasksFrom(file) {
  const rows = readJsonl(file);
  const { tasks, errors } = normalizeTasks(rows);
  if (errors.length > 0) throw new Error(`invalid tasks in ${file}: ${errors.slice(0, 3).map((error) => error.message).join('; ')}`);
  if (tasks.length === 0) throw new Error(`no tasks in ${file}`);
  return tasks;
}

function selectedTasksFromCache(options) {
  const { tasks } = readTasks(CACHE_ROOT);
  const requested = flag(options, 'all') ? undefined : options['ids-file'] === undefined ? BATCH_IDS_FILE : path.resolve(String(options['ids-file']));
  const selected = selectTasks(tasks, {
    ...(requested === undefined ? {} : { idsFile: requested }),
    ...(options.limit === undefined ? {} : { limit: integerOption(options, 'limit') }),
    ...(options.offset === undefined ? {} : { offset: integerOption(options, 'offset') }),
    ...(options.sample === undefined ? {} : { sample: integerOption(options, 'sample') }),
    ...(options.seed === undefined ? {} : { seed: integerOption(options, 'seed') }),
  });
  return { tasks, selected };
}

function patchDescriptors(arm) {
  return [basePatchPath(), armPatchPath(arm)].map((file) => ({ path: file, sha256: sha256Hex(fs.readFileSync(file)) }));
}

function simulatorForOptions(options) {
  if (flag(options, 'dry-run')) return null;
  return createLiveSimulator(process.env);
}

function print(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function commandProvision(options) {
  const workers = integerOption(options, 'workers', 1);
  const result = provision({
    workspace: REPO_ROOT,
    cacheRoot: CACHE_ROOT,
    workers,
    copyCredentials: flag(options, 'copy-credentials'),
    force: flag(options, 'force'),
  });
  if (!flag(options, 'skip-peers')) {
    const peerPath = (home) => path.join(home.profileDir, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json');
    const alreadyInstalled = result.homes.every((home) => fs.existsSync(peerPath(home)));
    if (alreadyInstalled && !flag(options, 'force')) {
      result.peers = { ok: true, skipped: true, reason: 'peer already installed in every home' };
    } else {
      const cliPath = process.env.DSH_CLI || DEFAULT_DSH_CLI;
      const peers = await ensurePeerDependencies({
        homes: result.homes,
        cliPath,
        env: process.env,
      });
      result.peerDependencies = Object.keys(PEER_DEPENDENCIES);
      result.peers = peers;
      if (!peers.ok) {
        print(result, flag(options, 'json'));
        return fail(`provision: peer install failed; re-run with network access or inspect ${result.homes[0]?.home ?? 'the eval home'}`, EXIT_FAIL);
      }
    }
  }
  print(result, flag(options, 'json'));
  return EXIT_OK;
}

async function commandFetchDataset(options) {
  if (flag(options, 'refresh-ids')) {
    const text = await refreshBatchIds();
    process.stdout.write(text);
    if (!text.endsWith('\n')) process.stdout.write('\n');
  }
  const result = await fetchDataset({ cacheRoot: CACHE_ROOT });
  print(result, flag(options, 'json'));
  return EXIT_OK;
}

async function commandNormalize(options) {
  const download = await fetchDataset({ cacheRoot: CACHE_ROOT });
  const result = await normalizeParquet({
    parquetFile: download.path,
    cacheRoot: CACHE_ROOT,
    parquetSha256: download.sha256,
    expectedCount: integerOption(options, 'expected-count', 500),
    allowCountMismatch: flag(options, 'allow-count-mismatch'),
  });
  print({ count: result.tasks.length, meta: result.meta, tasksFile: result.tasksFile }, flag(options, 'json'));
  return EXIT_OK;
}

async function commandPrepare(options) {
  const download = await fetchDataset({ cacheRoot: CACHE_ROOT });
  const result = await normalizeParquet({
    parquetFile: download.path,
    cacheRoot: CACHE_ROOT,
    parquetSha256: download.sha256,
    expectedCount: integerOption(options, 'expected-count', 500),
    allowCountMismatch: flag(options, 'allow-count-mismatch'),
  });
  print({ download, count: result.tasks.length, meta: result.meta }, flag(options, 'json'));
  return EXIT_OK;
}

async function commandPreflight(options) {
  const result = await preflight({
    workspace: REPO_ROOT,
    cacheRoot: CACHE_ROOT,
    datasetFile: DATASET_FILE,
    model: readModel(),
    simulator: readSimulatorSpec(),
    runMode: typeof options['run-mode'] === 'string' ? options['run-mode'] : 'plan',
    issueMode: typeof options['issue-mode'] === 'string' ? options['issue-mode'] : undefined,
    checkProfile: flag(options, 'check-profile') || flag(options, 'compose'),
    compose: flag(options, 'compose'),
  });
  if (flag(options, 'json')) print(result, true);
  else {
    process.stdout.write(`preflight: ${result.ok ? 'ok' : 'blocked'}\n`);
    for (const blocker of result.blockers) process.stdout.write(`  BLOCKER ${blocker}\n`);
    for (const warning of result.warnings) process.stdout.write(`  warning ${warning}\n`);
    if (result.facts.schema?.enabled) process.stdout.write(`  schema: ${result.facts.schema.ok === false ? 'failed' : 'ok'}\n`);
    if (result.facts.compose?.enabled) process.stdout.write(`  compose: ${result.facts.compose.ok === false ? 'failed' : 'ok'}\n`);
  }
  return flag(options, 'strict') && !result.ok ? EXIT_BLOCKED : EXIT_OK;
}

async function runOfflineArm({ options, tasksFile, tasks, arm, runId, runDir }) {
  const issueMode = typeof options['issue-mode'] === 'string' ? options['issue-mode'] : 'hidden';
  const runMode = typeof options['run-mode'] === 'string' ? options['run-mode'] : 'plan';
  const manifest = await runBatch({
    tasks,
    runId,
    runDir,
    arm,
    issueMode,
    runMode,
    homes: [],
    patches: patchDescriptors(arm),
    model: null,
    policy: { answersCap: integerOption(options, 'answers-cap', 3) },
    seed: integerOption(options, 'seed', 42),
    dryRun: true,
    deps: {
      workspace: { root: REPO_ROOT, pluginHead: null, pluginDirty: false },
      appVersion: 'fixture',
      tasksFile,
      tasksSha256: sha256Hex(fs.readFileSync(tasksFile)),
      fakeAnswers: {},
    },
  });
  const scored = scoreRun(runDir);
  return { runDir, manifest, scored };
}

async function commandSelftest(options) {
  const stampText = stamp();
  const root = path.resolve(String(options.out ?? path.join(RUNS_ROOT, `selftest-${stampText}`)));
  const tasks = loadTasksFrom(SAMPLE_TASKS_FILE);
  const runs = [];
  for (const arm of ARM_NAMES) {
    runs.push(await runOfflineArm({
      options,
      tasksFile: SAMPLE_TASKS_FILE,
      tasks,
      arm,
      runId: `selftest-${stampText}-${arm}`,
      runDir: path.join(root, arm),
    }));
  }
  const report = buildReport(runs.map((run) => run.scored), {
    seed: integerOption(options, 'seed', 42),
    now: nowIso(),
  });
  ensureDir(root);
  atomicWriteFile(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  atomicWriteFile(path.join(root, 'report.md'), renderMarkdown(report));
  atomicWriteFile(path.join(root, 'report.csv'), renderCsv(report));
  for (const run of runs) {
    atomicWriteFile(path.join(run.runDir, 'scores.json'), `${JSON.stringify(run.scored, null, 2)}\n`);
  }
  const summary = {
    root,
    arms: runs.map((run) => ({ arm: run.scored.manifest?.arm ?? 'unknown', counts: run.manifest.counts })),
    validation: report.validation,
    report: path.join(root, 'report.json'),
  };
  print(summary, flag(options, 'json'));
  return report.validation.ok === false ? EXIT_FAIL : EXIT_OK;
}

async function commandDryRun(options) {
  const tasksFile = options.tasks === undefined ? SAMPLE_TASKS_FILE : path.resolve(String(options.tasks));
  const tasks = loadTasksFrom(tasksFile);
  const arm = typeof options.arm === 'string' ? options.arm : 'full';
  if (!ARM_NAMES.includes(arm)) return fail(`dry-run: unknown arm: ${arm}`, EXIT_FAIL);
  const stampText = stamp();
  const runId = typeof options['run-id'] === 'string' ? options['run-id'] : `dry-${stampText}`;
  const runDir = path.resolve(String(options.out ?? path.join(RUNS_ROOT, runId)));
  const run = await runOfflineArm({ options, tasksFile, tasks, arm, runId, runDir });
  const report = buildReport([run.scored], { seed: integerOption(options, 'seed', 42), now: nowIso() });
  atomicWriteFile(path.join(runDir, 'scores.json'), `${JSON.stringify(run.scored, null, 2)}\n`);
  atomicWriteFile(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  atomicWriteFile(path.join(runDir, 'report.md'), renderMarkdown(report));
  atomicWriteFile(path.join(runDir, 'report.csv'), renderCsv(report));
  print({ runDir, manifest: run.manifest.counts, report: path.join(runDir, 'report.json') }, flag(options, 'json'));
  return EXIT_OK;
}

async function commandRun(options) {
  if (!flag(options, 'confirm-live')) {
    return fail('run: refusing to start a live model run without --confirm-live', EXIT_BLOCKED);
  }
  const model = readModel();
  if (model === null) return fail('run: EVAL_PROVIDER and EVAL_MODEL are required', EXIT_BLOCKED);
  const simulatorSpec = readSimulatorSpec();
  if (issueModeFor(options) === 'hidden' && simulatorSpec.kind === 'none') {
    return fail('run: hidden issue mode requires EVAL_SIMULATOR=http (or fixture)', EXIT_BLOCKED);
  }
  if (simulatorSpec.kind === 'http') {
    if (!process.env.EVAL_SIMULATOR_BASE_URL || !process.env.EVAL_SIMULATOR_API_KEY) {
      return fail('run: http simulator requires EVAL_SIMULATOR_BASE_URL and EVAL_SIMULATOR_API_KEY', EXIT_BLOCKED);
    }
  }
  if (simulatorSpec.kind === 'fixture' && !process.env.EVAL_SIMULATOR_FIXTURE) {
    return fail('run: fixture simulator requires EVAL_SIMULATOR_FIXTURE', EXIT_BLOCKED);
  }
  const arm = typeof options.arm === 'string' ? options.arm : 'full';
  if (!ARM_NAMES.includes(arm)) return fail(`run: unknown arm: ${arm}`, EXIT_FAIL);
  const issueMode = typeof options['issue-mode'] === 'string' ? options['issue-mode'] : 'hidden';
  const runMode = typeof options['run-mode'] === 'string' ? options['run-mode'] : 'plan';
  const concurrency = integerOption(options, 'concurrency', 1);
  const check = await preflight({
    workspace: REPO_ROOT,
    cacheRoot: CACHE_ROOT,
    datasetFile: DATASET_FILE,
    model,
    simulator: readSimulatorSpec(),
    runMode,
    issueMode,
    checkProfile: true,
    compose: true,
  });
  if (!check.ok) {
    for (const blocker of check.blockers) process.stderr.write(`BLOCKER ${blocker}\n`);
    return fail('run: preflight is not green', EXIT_BLOCKED);
  }
  if (check.facts.homes.length < concurrency) {
    return fail(`run: concurrency ${concurrency} needs ${concurrency} provisioned homes (have ${check.facts.homes.length})`, EXIT_BLOCKED);
  }
  if (!check.facts.credentials.present && process.env.EVAL_ALLOW_ENV_CREDENTIALS !== '1' && !flag(options, 'allow-env-credentials')) {
    return fail('run: no credentials in the eval home (provision --copy-credentials) and EVAL_ALLOW_ENV_CREDENTIALS is not set', EXIT_BLOCKED);
  }
  const { tasks, selected } = selectedTasksFromCache(options);
  if (selected.length === 0) return fail('run: no tasks selected', EXIT_FAIL);
  const simulator = simulatorForOptions(options);
  const stampText = stamp();
  const runId = typeof options['run-id'] === 'string' ? options['run-id'] : `${arm}-${issueMode}-${runMode}-${stampText}`;
  const runDir = path.resolve(String(options.out ?? path.join(RUNS_ROOT, runId)));
  if (fs.existsSync(path.join(runDir, 'manifest.json')) && !flag(options, 'resume')) {
    return fail(`run: run directory already exists (use --resume): ${runDir}`, EXIT_FAIL);
  }
  const manifest = await runBatch({
    tasks: selected,
    runId,
    runDir,
    arm,
    issueMode,
    runMode,
    homes: check.facts.homes,
    patches: patchDescriptors(arm),
    model,
    simulator,
    policy: {
      answersCap: integerOption(options, 'answers-cap', 3),
      taskTimeoutMs: integerOption(options, 'task-timeout-ms', 30 * 60 * 1000),
      idleSettleMs: integerOption(options, 'idle-settle-ms', 8000),
    },
    seed: integerOption(options, 'seed', 42),
    concurrency,
    resume: flag(options, 'resume'),
    dshCli: check.facts.cli.path,
    deps: {
      workspace: {
        root: check.facts.workspace.root,
        pluginHead: check.facts.workspace.head,
        pluginDirty: check.facts.workspace.dirty,
      },
      tasksFile: DATASET_FILE,
      tasksSha256: sha256Hex(fs.readFileSync(DATASET_FILE)),
      appVersion: readAppVersion(),
      cacheRoot: CACHE_ROOT,
    },
  });
  print({ runDir, manifest: manifest.counts, manifestFile: path.join(runDir, 'manifest.json') }, flag(options, 'json'));
  if (runMode === 'execute') {
    process.stdout.write(`predictions: ${path.join(runDir, 'predictions.jsonl')}\n`);
  }
  return manifest.counts.failed === 0 ? EXIT_OK : EXIT_FAIL;
}

async function commandWarmRepos(options) {
  const { selected } = selectedTasksFromCache(options);
  const result = await warmRepositories({ tasks: selected, cacheRoot: CACHE_ROOT });
  print(result, flag(options, 'json'));
  return result.ok ? EXIT_OK : EXIT_FAIL;
}

async function commandScore(options) {
  if (typeof options.run !== 'string') return fail('score: --run <dir> is required', EXIT_FAIL);
  const runDir = path.resolve(options.run);
  const scored = scoreRun(runDir);
  const out = typeof options.out === 'string' ? path.resolve(options.out) : runDir;
  ensureDir(out);
  atomicWriteFile(path.join(out, 'scores.json'), `${JSON.stringify(scored, null, 2)}\n`);
  print({ runDir, tasks: scored.tasks.length, out: path.join(out, 'scores.json') }, flag(options, 'json'));
  return EXIT_OK;
}

async function commandReport(options) {
  const raw = options.runs ?? options.run;
  if (raw === undefined) return fail('report: --runs <dir[,dir]> is required', EXIT_FAIL);
  const runDirs = Array.isArray(raw) ? raw : String(raw).split(',').map((item) => item.trim()).filter(Boolean);
  const scored = runDirs.map((dir) => scoreRun(path.resolve(dir)));
  const report = buildReport(scored, { seed: integerOption(options, 'seed', 12345), now: nowIso() });
  const out = path.resolve(String(options.out ?? path.join(REPORTS_ROOT, `report-${stamp()}`)));
  ensureDir(out);
  atomicWriteFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  atomicWriteFile(path.join(out, 'report.md'), renderMarkdown(report));
  atomicWriteFile(path.join(out, 'report.csv'), renderCsv(report));
  print({ out, runs: runDirs.length, resolveRate: report.resolveRate }, flag(options, 'json'));
  return EXIT_OK;
}

async function commandJudge(options) {
  if (typeof options.run !== 'string') return fail('judge: --run <dir> is required', EXIT_FAIL);
  if (!flag(options, 'enable')) {
    print({ enabled: false, reason: 'judge is off by default; pass --enable' }, flag(options, 'json'));
    return EXIT_OK;
  }
  const env = process.env;
  const baseUrl = env.EVAL_JUDGE_BASE_URL;
  const apiKey = env.EVAL_JUDGE_API_KEY;
  const model = env.EVAL_JUDGE_MODEL;
  if (!baseUrl || !model) return fail('judge: EVAL_JUDGE_BASE_URL and EVAL_JUDGE_MODEL are required', EXIT_BLOCKED);
  const result = await judgeRun({ runDir: path.resolve(options.run), baseUrl, apiKey, model });
  print(result, flag(options, 'json'));
  return result.errors.length === 0 ? EXIT_OK : EXIT_FAIL;
}

async function commandClean(options) {
  const targets = [];
  const add = (dir, enabled) => {
    if (!enabled) return;
    const resolved = requireCachePath(dir);
    targets.push(resolved);
  };
  const all = flag(options, 'all');
  add(RUNS_ROOT, all || flag(options, 'runs'));
  add(REPORTS_ROOT, all || flag(options, 'reports'));
  add(path.join(CACHE_ROOT, 'homes'), all || flag(options, 'home'));
  add(path.join(CACHE_ROOT, 'repos'), all || flag(options, 'repos'));
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true });
  print({ removed: targets }, flag(options, 'json'));
  return EXIT_OK;
}

const COMMANDS = {
  provision: commandProvision,
  'fetch-dataset': commandFetchDataset,
  normalize: commandNormalize,
  prepare: commandPrepare,
  preflight: commandPreflight,
  selftest: commandSelftest,
  'dry-run': commandDryRun,
  run: commandRun,
  'warm-repos': commandWarmRepos,
  score: commandScore,
  report: commandReport,
  judge: commandJudge,
  clean: commandClean,
};

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage());
    return EXIT_OK;
  }
  const handler = COMMANDS[command];
  if (handler === undefined) return fail(`unknown command: ${command}\n\n${usage()}`, EXIT_FAIL);
  let options;
  try {
    options = parseArgs(rest);
  } catch (error) {
    return fail(error.message, EXIT_FAIL);
  }
  if (options.help === true) {
    process.stdout.write(usage());
    return EXIT_OK;
  }
  try {
    return await handler(options);
  } catch (error) {
    const code = error?.code === 'BAD_ARGS' || error?.code === 'UNSAFE_PATH' ? EXIT_FAIL : EXIT_FAIL;
    return fail(`${command}: ${error instanceof Error ? error.message : String(error)}`, code);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
