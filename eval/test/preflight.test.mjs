import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_DSH_CLI,
  EXPECTED_CONFIG_FIELDS,
  parseDumpText,
  parseSchemaRows,
  preflight,
  schemaFindings,
} from '../interactive-swe/profile/preflight.mjs';
import {
  ARM_NAMES,
  BASE_DISABLED_ROWS,
  BASE_INSERTED_ROWS,
  PLUGIN_PACKAGE,
  SCHEMASTERY_PACKAGE,
  SCHEMASTERY_SPEC,
  armPatchPath,
  basePatchPath,
  provision,
} from '../interactive-swe/profile/provision.mjs';

/** Create a temp directory removed after the test. */
function tempDir(t, prefix = 'gp-preflight-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Build one realistic `--dump-config-schema` document. */
function schemaDocument({
  status = 'schema',
  fields = {},
  diagnostics = [],
  complete = true,
  extraConfigProperties = {},
  includeRow = true,
} = {}) {
  const properties = {};
  for (const name of EXPECTED_CONFIG_FIELDS) {
    const field = fields[name] ?? { default: true, volatile: true };
    properties[name] = {
      type: 'boolean',
      default: field.default,
      ...(field.volatile === false ? {} : { 'x-cordis': { volatile: true } }),
    };
  }
  const entries = [
    { path: '/3', id: 'agent-team', name: '@deepseek-ai/dsh-experimental-agent-team', status: 'schema' },
    { path: '/4', id: 'web', name: '@deepseek-ai/dsh-web', status: 'absent' },
  ];
  if (includeRow) {
    entries.push({
      path: '/9',
      id: 'great-plan',
      name: PLUGIN_PACKAGE,
      status,
      configRef: '#/$defs/config0',
    });
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Cordis configuration for profile eval',
    type: 'array',
    $defs: {
      config0: {
        type: 'object',
        properties: { ...properties, ...extraConfigProperties },
        required: [],
      },
    },
    'x-cordis': {
      profile: 'eval',
      complete,
      entries,
      diagnostics,
    },
  };
}

/** Build the exact real-world wrapped shape (anyOf inside a $defs.configN). */
function realSchemaDocument() {
  const field = () => ({
    default: true,
    'x-cordis': { volatile: true },
    anyOf: [{ type: 'boolean' }, { type: 'null' }],
  });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Cordis configuration for profile eval',
    type: 'array',
    $defs: {
      config77: {
        default: {},
        anyOf: [{
          type: ['object', 'null'],
          properties: {
            injectBrainstormingPrompt: field(),
            injectUnlimitedBudgetPrompt: field(),
            includeOriginalUserInstructions: field(),
            includeMinimalRuntimeContext: field(),
          },
        }],
      },
    },
    'x-cordis': {
      profile: 'eval',
      complete: true,
      diagnostics: [],
      entries: [{
        path: '/111',
        id: 'great-plan',
        name: PLUGIN_PACKAGE,
        status: 'schema',
        configRef: '#/$defs/config77',
      }],
    },
  };
}

/**
 * Seed an installed peer package. `location: 'profile'` matches what
 * `dsh plugin add` does (pnpm installs inside `profiles/eval`); `'home'` is the
 * legacy home-root fallback.
 */
function seedPeer(home, version = '3.18.5', location = 'profile') {
  const base = location === 'home'
    ? path.join(home, 'node_modules', '@deepseek-ai', 'schemastery')
    : path.join(home, 'profiles', 'eval', 'node_modules', '@deepseek-ai', 'schemastery');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), `${JSON.stringify({ name: SCHEMASTERY_PACKAGE, version })}\n`);
  return path.join(base, 'package.json');
}

/** Build a composed `--dump-config` YAML dump for one arm. */
function dumpForArm(arm, { breakEvidence = false } = {}) {
  const lines = ['# == @deepseek-ai/dsh-base'];
  lines.push('');
  for (const id of BASE_INSERTED_ROWS) {
    lines.push(`- id: ${id}`, '  name: demo-row', '');
  }
  for (const id of BASE_DISABLED_ROWS) {
    lines.push(`- id: ${id}`, '  disabled: true', '');
  }
  if (arm === 'native') {
    lines.push('- id: great-plan', '  disabled: true', '');
  } else {
    lines.push('- id: great-plan', '  config:');
    for (const [key, value] of Object.entries(schemaArms()[arm])) {
      if (breakEvidence && arm === 'evidence' && key === 'injectUnlimitedBudgetPrompt') continue;
      lines.push(`    ${key}: ${value}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** Expected arm configs, written out independently of the production constants. */
function schemaArms() {
  return {
    evidence: {
      injectBrainstormingPrompt: false,
      injectUnlimitedBudgetPrompt: true,
      includeOriginalUserInstructions: true,
      includeMinimalRuntimeContext: true,
    },
    full: {
      injectBrainstormingPrompt: true,
      injectUnlimitedBudgetPrompt: true,
      includeOriginalUserInstructions: true,
      includeMinimalRuntimeContext: true,
    },
  };
}

/** Create an executable fake CLI file. */
function fakeCli(t) {
  const file = path.join(tempDir(t), 'dsh');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

/** Create a temp plugin checkout with a readable package.json. */
function tempWorkspace(t) {
  const dir = path.join(tempDir(t), 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"@onefl666/dsh-great-plan","version":"0.6.0"}\n');
  return dir;
}

/** Provision a real eval home in a temp cache root. */
function provisionedHome(t, { copyCredentials = true, installPeer = true } = {}) {
  const workspace = tempWorkspace(t);
  const root = tempDir(t);
  if (copyCredentials) fs.writeFileSync(path.join(root, '.credentials.yaml'), 'deepseek:\n  apiKey: test\n');
  const result = provision({ workspace, cacheRoot: path.join(root, 'cache'), homeDir: root, copyCredentials });
  if (installPeer) {
    for (const home of result.homes) seedPeer(home.home);
  }
  return { workspace, root, result };
}

/** Fake exec: matches specs in order and records every call. */
function createFakeExec(routes) {
  const calls = [];
  const exec = async (spec) => {
    calls.push(spec);
    for (const route of routes) {
      if (route.match(spec)) return route.respond(spec, calls);
    }
    return { code: 0, stdout: '', stderr: '', durationMs: 1 };
  };
  return { exec, calls };
}

/** Standard machine route set for a healthy preflight run. */
function healthyRoutes({ schema = schemaDocument(), armDumps = {}, gitStatus = '', gitFail = false, schemaFail = false } = {}) {
  return [
    {
      match: (spec) => spec.command === 'git' && spec.args.join(' ') === '-C ' + spec.args[1] + ' rev-parse HEAD',
      respond: () => (gitFail ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' } : { code: 0, stdout: 'abc123def456\n', stderr: '' }),
    },
    {
      match: (spec) => spec.command === 'git' && spec.args.at(-1) === '--porcelain',
      respond: () => ({ code: 0, stdout: gitStatus, stderr: '' }),
    },
    {
      match: (spec) => spec.command === 'docker',
      respond: () => ({ code: 0, stdout: 'Docker version 27.0.0, build test\n', stderr: '' }),
    },
    {
      match: (spec) => spec.args?.includes('--dump-config-schema'),
      respond: () => (schemaFail
        ? { code: 1, stdout: '', stderr: 'dsh: failed to load profile' }
        : { code: 0, stdout: JSON.stringify(schema, null, 2), stderr: '' }),
    },
    {
      match: (spec) => spec.args?.includes('--dump-config'),
      respond: (spec) => {
        const arm = ARM_NAMES.find((name) => spec.args.some((arg) => arg.endsWith(`/${name}.yml`)));
        if (arm === undefined) return { code: 1, stdout: '', stderr: 'unknown arm' };
        return { code: 0, stdout: armDumps[arm] ?? dumpForArm(arm), stderr: '' };
      },
    },
  ];
}

test('EXPECTED_CONFIG_FIELDS is the frozen four-field inventory', () => {
  assert.deepEqual(EXPECTED_CONFIG_FIELDS, [
    'injectBrainstormingPrompt',
    'injectUnlimitedBudgetPrompt',
    'includeOriginalUserInstructions',
    'includeMinimalRuntimeContext',
  ]);
  assert.equal(Object.isFrozen(EXPECTED_CONFIG_FIELDS), true);
  assert.equal(DEFAULT_DSH_CLI, '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
});

test('parseSchemaRows finds entry rows recursively and tolerates surrounding noise', () => {
  const document = schemaDocument();
  const parsed = parseSchemaRows(JSON.stringify(document));
  assert.equal(parsed.length, 3);
  assert.equal(parsed.find((row) => row.id === 'great-plan').status, 'schema');
  const noisy = `dsh: warning: unrelated line\n${JSON.stringify(document)}\n`;
  assert.equal(parseSchemaRows(noisy).length, 3);
  const grouped = { 'x-cordis': { entries: [{ path: '/0', group: true }, { path: '/0/config', id: 'nested', name: 'x', status: 'absent' }] } };
  assert.deepEqual(parseSchemaRows(JSON.stringify(grouped)).map((row) => row.id), ['nested']);
});

test('parseSchemaRows never throws on malformed stdout', () => {
  assert.deepEqual(parseSchemaRows(''), []);
  assert.deepEqual(parseSchemaRows(undefined), []);
  assert.deepEqual(parseSchemaRows('not json at all'), []);
  assert.deepEqual(parseSchemaRows('{"broken": '), []);
});

test('schemaFindings resolves the great-plan row, config fields and diagnostics', () => {
  const diagnostics = [{ level: 'warning', path: '/9', message: 'lazy schema limitation' }];
  const findings = schemaFindings(JSON.stringify(schemaDocument({ diagnostics })));
  assert.equal(findings.raw, false);
  assert.equal(findings.complete, true);
  assert.equal(findings.row.id, 'great-plan');
  assert.equal(findings.row.status, 'schema');
  assert.equal(findings.row.configRef, '#/$defs/config0');
  assert.deepEqual(findings.fields.map((field) => field.name), [...EXPECTED_CONFIG_FIELDS]);
  for (const field of findings.fields) {
    assert.equal(field.present, true);
    assert.equal(field.default, true);
    assert.equal(field.volatile, true);
  }
  assert.deepEqual(findings.diagnostics, [{ level: 'warning', path: '/9', message: 'lazy schema limitation' }]);
});

test('schemaFindings tolerates a missing row and unexpected extra fields', () => {
  const missing = schemaFindings(JSON.stringify(schemaDocument({ includeRow: false })));
  assert.equal(missing.row, null);
  assert.deepEqual(missing.fields, []);
  const extra = schemaFindings(JSON.stringify(schemaDocument({ extraConfigProperties: { extraSwitch: { type: 'boolean', default: false } } })));
  assert.equal(extra.fields.length, 5);
});

test('schemaFindings falls back to raw text for truncated output', () => {
  const raw = [
    'dsh: warning: output truncated',
    '"entries": [',
    '  { "path": "/9", "id": "great-plan", "name": "@onefl666/dsh-great-plan", "status": "schema", "configRef": "#/$defs/config0" }',
    ']',
    '"injectBrainstormingPrompt": { "type": "boolean", "default": true, "x-cordis": { "volatile": true } }',
    '"injectUnlimitedBudgetPrompt": { "type": "boolean", "default": true, "x-cordis": { "volatile": true } }',
    '"includeOriginalUserInstructions": { "type": "boolean", "default": true, "x-cordis": { "volatile": true } }',
    '"includeMinimalRuntimeContext": { "type": "boolean", "default": true, "x-cordis": { "volatile": true } }',
  ].join('\n');
  const findings = schemaFindings(raw);
  assert.equal(findings.raw, true);
  assert.equal(findings.row.status, 'schema');
  assert.deepEqual(findings.fields.map((field) => field.name), [...EXPECTED_CONFIG_FIELDS]);
  for (const field of findings.fields) {
    assert.equal(field.present, true);
    assert.equal(field.default, true);
    assert.equal(field.volatile, true);
  }
  assert.equal(schemaFindings('nothing here').row, null);
});

test('parseDumpText finds a row with config and disabled state', () => {
  const dump = [
    '# == @deepseek-ai/dsh-base',
    '',
    '- id: agent-team',
    '  name: demo',
    '',
    '- id: great-plan',
    '  name: "@onefl666/dsh-great-plan"',
    '  config:',
    '    injectBrainstormingPrompt: false',
    '    injectUnlimitedBudgetPrompt: true',
    '    includeOriginalUserInstructions: true',
    '    includeMinimalRuntimeContext: true',
    '    nested:',
    '      ignored: 1',
    '',
    '- id: web',
    '  disabled: true',
    '',
  ].join('\n');
  const greatPlan = parseDumpText(dump, 'great-plan');
  assert.deepEqual(greatPlan, {
    found: true,
    disabled: false,
    config: {
      injectBrainstormingPrompt: false,
      injectUnlimitedBudgetPrompt: true,
      includeOriginalUserInstructions: true,
      includeMinimalRuntimeContext: true,
    },
  });
  assert.deepEqual(parseDumpText(dump, 'web'), { found: true, disabled: true, config: null });
  assert.deepEqual(parseDumpText(dump, 'great-plan'), { found: true, disabled: false, config: { ...greatPlan.config } });
  assert.deepEqual(parseDumpText(dump, 'missing'), { found: false, disabled: false, config: null });
});

test('parseDumpText tolerates expressions, quotes and malformed input', () => {
  const dump = [
    '- id: "great-plan"',
    '  disabled: !!js "(process.env.X === \'1\')"',
    '  config: {}',
    '- id: plain',
    '  disabled: false',
    '- id: quoted',
    "  name: 'demo'",
  ].join('\n');
  const expressionRow = parseDumpText(dump, 'great-plan');
  assert.equal(expressionRow.found, true);
  assert.equal(expressionRow.disabled, null);
  assert.deepEqual(expressionRow.config, {});
  assert.deepEqual(parseDumpText(dump, 'plain'), { found: true, disabled: false, config: null });
  assert.equal(parseDumpText('', 'great-plan').found, false);
  assert.equal(parseDumpText('not: [a dump', 'great-plan').found, false);
  assert.throws(() => parseDumpText(dump, ''), /requires a row id/);
});

test('preflight passes a healthy machine and checks the real invocations', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const datasetFile = path.join(root, 'tasks.jsonl');
  fs.writeFileSync(datasetFile, '{"instance_id":"demo"}\n');
  const { exec, calls } = createFakeExec(healthyRoutes());

  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli, PATH: process.env.PATH },
    exec,
    compose: true,
    checkProfile: true,
    datasetFile,
    diskFreeBytes: 10 * 1024 ** 3,
    model: { provider: 'p', model: 'm' },
    simulator: 'http:sim',
  });

  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.ok, true);
  assert.equal(report.facts.node.major, Number(process.versions.node.split('.')[0]));
  assert.equal(report.facts.node.zstd, true);
  assert.equal(report.facts.cli.executable, true);
  assert.equal(report.facts.workspace.head, 'abc123def456');
  assert.equal(report.facts.workspace.dirty, false);
  assert.equal(report.facts.workspace.packageName, PLUGIN_PACKAGE);
  assert.equal(report.facts.workspace.version, '0.6.0');
  assert.equal(report.facts.dataset.present, true);
  assert.equal(report.facts.homes.length, 1);
  assert.equal(report.facts.homes[0].profilePresent, true);
  assert.equal(report.facts.homes[0].pluginLinkOk, true);
  assert.equal(report.facts.homes[0].credentials.mode, 0o600);
  assert.equal(report.facts.homes[0].schemastery.present, true);
  assert.equal(report.facts.homes[0].schemastery.version, '3.18.5');
  assert.equal(
    report.facts.homes[0].schemastery.path,
    path.join(result.homes[0].profileDir, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'),
  );
  assert.equal(report.facts.peerDependencies[SCHEMASTERY_PACKAGE].presentInAllHomes, true);
  assert.equal(report.facts.schema.ok, true);
  assert.equal(report.facts.schema.row.status, 'schema');
  assert.equal(report.facts.compose.enabled, true);
  assert.equal(report.facts.compose.ok, true);
  for (const arm of ARM_NAMES) assert.equal(report.facts.compose.arms[arm].ok, true, `arm ${arm}`);
  assert.equal(report.facts.docker.present, true);
  assert.equal(report.facts.model.configured, true);
  assert.equal(report.facts.simulator.kind, 'http');

  const schemaCall = calls.find((spec) => spec.args?.includes('--dump-config-schema'));
  assert.ok(schemaCall);
  assert.equal(schemaCall.command, cli);
  assert.deepEqual(schemaCall.args, ['--profile', 'eval', '--dump-config-schema']);
  assert.equal(schemaCall.env.DSH_HOME, result.homes[0].home);

  const composeCalls = calls.filter((spec) => spec.args?.includes('--dump-config'));
  assert.equal(composeCalls.length, 3);
  for (let index = 0; index < ARM_NAMES.length; index += 1) {
    const call = composeCalls[index];
    const arm = ARM_NAMES[index];
    assert.deepEqual(call.args, [
      '--profile', 'eval',
      '--patch', basePatchPath(),
      '--patch', armPatchPath(arm),
      '--dump-config',
    ]);
    assert.equal(call.env.DSH_HOME, result.homes[0].home);
  }
});

test('preflight refuses the native arm when great-plan is not disabled', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const { exec } = createFakeExec(healthyRoutes({
    armDumps: {
      native: dumpForArm('native').replace('- id: great-plan\n  disabled: true\n', '- id: great-plan\n  disabled: false\n'),
    },
  }));
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec,
    compose: true,
    datasetFile: path.join(root, 'absent.jsonl'),
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, false);
  assert.match(report.blockers.join('\n'), /arm native: .*disable/);
});

test('preflight refuses an evidence arm that does not restate all four fields', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const { exec } = createFakeExec(healthyRoutes({
    armDumps: { evidence: dumpForArm('evidence', { breakEvidence: true }) },
  }));
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec,
    compose: true,
    datasetFile: path.join(root, 'absent.jsonl'),
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, false);
  assert.match(report.blockers.join('\n'), /arm evidence: .*injectUnlimitedBudgetPrompt/);
});

test('preflight blocks when the base patch rows are not applied', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const { exec } = createFakeExec(healthyRoutes({
    armDumps: { full: dumpForArm('full').replace('- id: web\n  disabled: true\n', '- id: web\n  disabled: false\n') },
  }));
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec,
    compose: true,
    datasetFile: path.join(root, 'absent.jsonl'),
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, false);
  assert.match(report.blockers.join('\n'), /arm full: .*row web is not disabled/);
});

test('preflight blocks on a bad schema row, defaults, or diagnostics', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const datasetFile = path.join(root, 'tasks.jsonl');
  fs.writeFileSync(datasetFile, '{}\n');
  const baseOptions = {
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    checkProfile: true,
    datasetFile,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  };

  const badStatus = await preflight({
    ...baseOptions,
    exec: createFakeExec(healthyRoutes({ schema: schemaDocument({ status: 'error' }) })).exec,
  });
  assert.match(badStatus.blockers.join('\n'), /status is "error"/);

  const badDefault = await preflight({
    ...baseOptions,
    exec: createFakeExec(healthyRoutes({
      schema: schemaDocument({ fields: { injectBrainstormingPrompt: { default: false, volatile: true } } }),
    })).exec,
  });
  assert.match(badDefault.blockers.join('\n'), /injectBrainstormingPrompt default is false/);

  const notVolatile = await preflight({
    ...baseOptions,
    exec: createFakeExec(healthyRoutes({
      schema: schemaDocument({ fields: { includeMinimalRuntimeContext: { default: true, volatile: false } } }),
    })).exec,
  });
  assert.match(notVolatile.blockers.join('\n'), /includeMinimalRuntimeContext is not marked volatile/);

  const rowDiagnostic = await preflight({
    ...baseOptions,
    exec: createFakeExec(healthyRoutes({
      schema: schemaDocument({ diagnostics: [{ level: 'error', path: '/9', message: 'Config is not a native Schemastery schema' }] }),
    })).exec,
  });
  assert.match(rowDiagnostic.blockers.join('\n'), /schema diagnostic: Config is not a native Schemastery schema/);

  const schemasteryDiagnostic = await preflight({
    ...baseOptions,
    exec: createFakeExec(healthyRoutes({
      schema: schemaDocument({ diagnostics: [{ level: 'error', path: '/3', message: "Cannot find package '@deepseek-ai/schemastery'" }] }),
    })).exec,
  });
  assert.match(schemasteryDiagnostic.blockers.join('\n'), /Cannot find package/);

  const unrelated = await preflight({
    ...baseOptions,
    exec: createFakeExec(healthyRoutes({
      schema: schemaDocument({ diagnostics: [{ level: 'error', path: '/3', message: 'stock bundle row failed' }] }),
    })).exec,
  });
  assert.equal(unrelated.ok, true);
  assert.match(unrelated.warnings.join('\n'), /unrelated schema diagnostic/);
});

test('preflight blocks when the CLI or git checkout is unavailable', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const missingCli = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: path.join(root, 'no-such-dsh') },
    exec: createFakeExec(healthyRoutes()).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
  });
  assert.match(missingCli.blockers.join('\n'), /dsh CLI not found/);

  const cli = fakeCli(t);
  const gitFail = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes({ gitFail: true })).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
  });
  assert.match(gitFail.blockers.join('\n'), /not a readable git checkout/);
});

test('preflight blocks without provisioned eval homes', async (t) => {
  const workspace = tempWorkspace(t);
  const emptyCache = path.join(tempDir(t), 'empty-cache');
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: emptyCache,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes()).exec,
    checkProfile: true,
    datasetFile: path.join(tempDir(t), 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
  });
  assert.equal(report.ok, false);
  assert.match(report.blockers.join('\n'), /no eval homes/);
  assert.match(report.blockers.join('\n'), /cannot run live profile checks/);
  assert.deepEqual(report.facts.homes, []);
});

test('preflight skips live checks by default and records the skip', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const { exec, calls } = createFakeExec(healthyRoutes());
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, true);
  assert.equal(report.facts.schema.skipped, true);
  assert.equal(report.facts.compose.enabled, false);
  assert.match(report.warnings.join('\n'), /profile schema check skipped/);
  assert.equal(calls.some((spec) => spec.args?.includes('--dump-config') || spec.args?.includes('--dump-config-schema')), false);
});

test('preflight blocks execute mode without docker but only warns in plan mode', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const routes = [
    ...healthyRoutes().filter((route) => !(route.match({ command: 'docker', args: ['--version'] }))),
    { match: (spec) => spec.command === 'docker', respond: () => ({ code: 1, stdout: '', stderr: 'docker: command not found' }) },
  ];
  const baseOptions = {
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(routes).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  };
  const plan = await preflight(baseOptions);
  assert.equal(plan.ok, true);
  assert.match(plan.warnings.join('\n'), /docker is unavailable/);

  const execute = await preflight({ ...baseOptions, runMode: 'execute' });
  assert.equal(execute.ok, false);
  assert.match(execute.blockers.join('\n'), /execute mode requires docker/);
});

test('preflight handles docker failing to spawn', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const routes = [
    ...healthyRoutes().filter((route) => !(route.match({ command: 'docker', args: ['--version'] }))),
    { match: (spec) => spec.command === 'docker', respond: () => { throw new Error('spawn docker ENOENT'); } },
  ];
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(routes).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    diskFreeBytes: 10 * 1024 ** 3,
  });
  assert.equal(report.facts.docker.present, false);
  assert.match(report.warnings.join('\n'), /spawn docker ENOENT/);
});

test('preflight blocks hidden issue mode without a live simulator', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes()).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    issueMode: 'hidden',
    simulator: 'none',
    model: 'p/m',
  });
  assert.equal(report.ok, false);
  assert.match(report.blockers.join('\n'), /hidden issue mode requires a live simulator/);
});

test('preflight warns about missing credentials, dataset and model configuration', async (t) => {
  const { workspace, root, result } = provisionedHome(t, { copyCredentials: false });
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes()).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
  });
  assert.equal(report.ok, true);
  const warnings = report.warnings.join('\n');
  assert.match(warnings, /no credentials were copied/);
  assert.match(warnings, /dataset missing/);
  assert.match(warnings, /no model configured/);
  assert.match(warnings, /no simulator configured/);
});

test('preflight flags dirty workspaces and over-permissive credentials', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  fs.chmodSync(path.join(result.homes[0].home, '.credentials.yaml'), 0o644);
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes({ gitStatus: ' M lib/index.js\n' })).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.facts.workspace.dirty, true);
  assert.match(report.warnings.join('\n'), /uncommitted changes/);
  assert.match(report.warnings.join('\n'), /mode 0o644/);
});

test('preflight enforces disk-space thresholds', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const baseOptions = {
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes()).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    model: 'p/m',
    simulator: 'fixture',
  };
  const blocked = await preflight({ ...baseOptions, diskFreeBytes: 100 * 1024 ** 2 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.blockers.join('\n'), /free under the cache root/);

  const warned = await preflight({ ...baseOptions, diskFreeBytes: 2 * 1024 ** 3 });
  assert.equal(warned.ok, true);
  assert.match(warned.warnings.join('\n'), /low disk space/);

  const fine = await preflight({ ...baseOptions, diskFreeBytes: 20 * 1024 ** 3 });
  assert.equal(fine.ok, true);
  assert.doesNotMatch(fine.warnings.join('\n'), /disk space/);
});

test('preflight blocks when the schema dump fails to run', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes({ schemaFail: true })).exec,
    checkProfile: true,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, false);
  assert.match(report.blockers.join('\n'), /profile schema dump failed/);
  assert.equal(report.facts.schema.ok, false);
});

test('preflight reports missing patch files alongside enabled compose checks', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes()).exec,
    compose: true,
    basePatchPath: path.join(root, 'missing-base.yml'),
    armPatchPaths: Object.fromEntries(ARM_NAMES.map((arm) => [arm, armPatchPath(arm)])),
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, false);
  assert.match(report.blockers.join('\n'), /patch file missing/);
});

test('preflight compares arm config values exactly', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const wrongFull = dumpForArm('full').replace('injectBrainstormingPrompt: true', 'injectBrainstormingPrompt: false');
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes({ armDumps: { full: wrongFull } })).exec,
    compose: true,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, false);
  assert.match(report.blockers.join('\n'), /arm full: .*config\.injectBrainstormingPrompt is false \(expected true\)/);
});

test('schemaFindings unwraps the real anyOf/$defs.configN projection', () => {
  const document = realSchemaDocument();
  assert.equal(parseSchemaRows(JSON.stringify(document))[0].configRef, '#/$defs/config77');
  const findings = schemaFindings(JSON.stringify(document));
  assert.equal(findings.raw, false);
  assert.equal(findings.row.status, 'schema');
  assert.deepEqual(findings.fields.map((field) => field.name), [...EXPECTED_CONFIG_FIELDS]);
  for (const field of findings.fields) {
    assert.equal(field.present, true);
    assert.equal(field.default, true);
    assert.equal(field.volatile, true);
  }
});

test('preflight reports schema ok with all four fields for the real wrapped shape', async (t) => {
  const { workspace, root, result } = provisionedHome(t);
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes({ schema: realSchemaDocument() })).exec,
    checkProfile: true,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.deepEqual(report.blockers, []);
  assert.equal(report.ok, true);
  assert.equal(report.facts.schema.ok, true);
  assert.equal(report.facts.schema.fields.length, 4);
  assert.equal(report.facts.schema.fields.every((field) => field.default === true && field.volatile === true), true);
});

test('preflight blocks when the schemastery peer is not installed', async (t) => {
  const { workspace, root, result } = provisionedHome(t, { installPeer: false });
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes()).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, false);
  assert.match(
    report.blockers.join('\n'),
    /missing peer dependency @deepseek-ai\/schemastery \(run provision --install-peers\)/,
  );
  assert.equal(report.facts.homes[0].schemastery.present, false);
  assert.equal(report.facts.peerDependencies[SCHEMASTERY_PACKAGE].presentInAllHomes, false);
});

test('preflight warns when the installed schemastery version is unexpected', async (t) => {
  const { workspace, root, result } = provisionedHome(t, { installPeer: false });
  for (const home of result.homes) seedPeer(home.home, '3.17.0');
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes()).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, true);
  assert.match(report.warnings.join('\n'), /schemastery@3\.17\.0 \(expected ~3\.18\.5\)/);
  assert.equal(report.facts.peerDependencies[SCHEMASTERY_PACKAGE].spec, SCHEMASTERY_SPEC);
});

test('preflight accepts the legacy home-root schemastery location as a fallback', async (t) => {
  const { workspace, root, result } = provisionedHome(t, { installPeer: false });
  const peerPath = seedPeer(result.homes[0].home, '3.18.5', 'home');
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes()).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, true);
  assert.equal(report.facts.homes[0].schemastery.present, true);
  assert.equal(report.facts.homes[0].schemastery.path, peerPath);
  assert.equal(report.facts.peerDependencies[SCHEMASTERY_PACKAGE].presentInAllHomes, true);
});

test('preflight prefers the profile-directory schemastery over the home-root copy', async (t) => {
  const { workspace, root, result } = provisionedHome(t, { installPeer: false });
  const home = result.homes[0].home;
  const profilePeerPath = path.join(
    result.homes[0].profileDir,
    'node_modules',
    '@deepseek-ai',
    'schemastery',
    'package.json',
  );
  seedPeer(home, '3.17.0', 'home');
  seedPeer(home, '3.18.5', 'profile');
  const cli = fakeCli(t);
  const report = await preflight({
    workspace,
    cacheRoot: result.cacheRoot,
    env: { DSH_CLI: cli },
    exec: createFakeExec(healthyRoutes()).exec,
    datasetFile: path.join(root, 'absent.jsonl'),
    checkDocker: false,
    diskFreeBytes: 10 * 1024 ** 3,
    model: 'p/m',
    simulator: 'fixture',
  });
  assert.equal(report.ok, true);
  assert.equal(report.facts.homes[0].schemastery.path, profilePeerPath);
  assert.equal(report.facts.homes[0].schemastery.version, '3.18.5');
  assert.deepEqual(report.facts.homes[0].schemastery.searchedPaths, [
    profilePeerPath,
    path.join(home, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'),
  ]);
});
