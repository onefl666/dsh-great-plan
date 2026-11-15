import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { listDir } from '../util/fsutil.mjs';
import { runCommand } from '../util/proc.mjs';
import { nowIso } from '../util/time.mjs';
import {
  ARM_CONFIGS,
  ARM_NAMES,
  BASE_DISABLED_ROWS,
  BASE_INSERTED_ROWS,
  PLUGIN_PACKAGE,
  PROFILE_NAME,
  SCHEMASTERY_PACKAGE,
  SCHEMASTERY_SPEC,
  armPatchPath,
  basePatchPath,
  defaultCacheRoot,
} from './provision.mjs';

/**
 * Preflight for the interactive-swe evaluation harness.
 *
 * Everything here is read-only with respect to the real `~/.dsh`: it inspects
 * the eval homes under the cache root and the checked-out workspace, and it
 * shells out only through the injected `exec` (default `runCommand`). The live
 * profile checks (`--dump-config-schema`, `--dump-config --patch ...`) are opt-in
 * through `checkProfile` / `compose` so offline callers and tests never spawn
 * `dsh`. No model is ever called.
 *
 * @module profile/preflight
 */

/** The four volatile Config fields the Great Plan bundle must expose. */
export const EXPECTED_CONFIG_FIELDS = Object.freeze([
  'injectBrainstormingPrompt',
  'injectUnlimitedBudgetPrompt',
  'includeOriginalUserInstructions',
  'includeMinimalRuntimeContext',
]);

/** Environment variable that overrides the installed CLI path. */
export const CLI_ENV = 'DSH_CLI';

/** Default installed CLI on this host (Desktop app bundle). */
export const DEFAULT_DSH_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';

/** Minimum Node major version required by the harness (zstd session logs, `node:test`). */
export const REQUIRED_NODE_MAJOR = 24;

/** Below this free disk space preflight warns. */
export const DISK_WARN_BYTES = 5 * 1024 ** 3;

/** Below this free disk space preflight blocks. */
export const DISK_BLOCK_BYTES = 1024 ** 3;

const ENTRY_ID = 'great-plan';
const PROFILE_SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.dirname(PROFILE_SOURCE_DIR);

/**
 * Parse a JSON document tolerantly: exact JSON first, then the first balanced
 * object embedded in surrounding noise. Returns `null` instead of throwing.
 *
 * @param {string} text Raw stdout.
 * @returns {unknown|null} Parsed document or `null`.
 */
function tryParseJsonDocument(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to the balanced-object extraction below.
  }
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Whether a node looks like one `x-cordis.entries` row.
 *
 * @param {unknown} value Candidate node.
 * @returns {boolean} True for an entry row.
 */
function isEntryRow(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.status !== 'string') return false;
  if (typeof value.id === 'string') return true;
  return typeof value.name === 'string' && typeof value.path === 'string';
}

/**
 * Whether a parsed JSON node is a `--dump-config-schema` document rather than
 * an arbitrary object picked out of polluted output.
 *
 * @param {unknown} value Candidate document.
 * @returns {boolean} True for a schema document.
 */
function isSchemaDocument(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.hasOwn(value, 'x-cordis') || Object.hasOwn(value, '$defs') || Object.hasOwn(value, '$schema');
}

/**
 * Recursively find composed-entry rows in a `--dump-config-schema` document.
 * Tolerant: unknown additions, nested groups, and non-entry objects are skipped.
 *
 * @param {string} stdout Raw schema-dump stdout.
 * @returns {Array<Record<string, unknown>>} Entry rows in document order.
 */
export function parseSchemaRows(stdout) {
  const document = tryParseJsonDocument(stdout);
  if (document === null) return [];
  const rows = [];
  const seen = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (isEntryRow(value) && !seen.has(value)) {
      seen.add(value);
      rows.push(value);
    }
    for (const key of Object.keys(value)) visit(value[key]);
  };
  visit(document);
  return rows;
}

/**
 * Resolve a local JSON Pointer (`#/...`) relative to the schema document root.
 * `#/$defs/config77` therefore resolves against the root, not a nested node.
 *
 * @param {Record<string, unknown>} document Schema document.
 * @param {unknown} ref Local JSON Pointer.
 * @returns {Record<string, unknown>|null} Referenced schema or `null`.
 */
function resolveSchemaRef(document, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = document;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(segment)) return null;
      node = node[Number(segment)];
    } else {
      node = node[segment];
    }
    if (node === undefined) return null;
  }
  return node !== null && typeof node === 'object' ? node : null;
}

/** Schema keywords that wrap an object schema without changing its fields. */
const SCHEMA_BRANCH_KEYS = Object.freeze([
  'anyOf',
  'allOf',
  'oneOf',
  'then',
  'else',
  'items',
  'prefixItems',
  'additionalProperties',
  'inner',
]);

/**
 * Flatten a schema node and every nested branch/item node.
 *
 * Schemastery wraps projected object schemas in `anyOf` branches, e.g.
 * `$defs.config77 = { default: {}, anyOf: [{ type: ['object','null'],
 * properties: { ...four fields } }] }`, so properties are not always on the
 * definition node itself.
 *
 * @param {unknown} node Schema node.
 * @param {Set<object>} [seen] Cycle guard.
 * @returns {Array<Record<string, unknown>>} Flattened object nodes.
 */
function flattenSchemaNodes(node, seen = new Set()) {
  const nodes = [];
  if (node === null || typeof node !== 'object' || seen.has(node)) return nodes;
  seen.add(node);
  nodes.push(node);
  for (const key of SCHEMA_BRANCH_KEYS) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) nodes.push(...flattenSchemaNodes(item, seen));
    } else if (child !== null && typeof child === 'object') {
      nodes.push(...flattenSchemaNodes(child, seen));
    }
  }
  return nodes;
}

/**
 * Flatten a Schemastery-projected object schema into field facts. Properties
 * may live on the definition or inside an `anyOf` branch; a field's `default`
 * and `x-cordis.volatile` may likewise be on its own node or a nested branch.
 *
 * @param {Record<string, unknown>|null} definition Config schema definition.
 * @returns {Array<{ name: string, present: boolean, type: string|null, default: unknown, required: boolean, volatile: boolean }>}
 */
function fieldsFromDefinition(definition) {
  const properties = new Map();
  const required = new Set();
  for (const node of flattenSchemaNodes(definition)) {
    if (Array.isArray(node.required)) {
      for (const name of node.required) if (typeof name === 'string') required.add(name);
    }
    const nodeProperties = node.properties;
    if (nodeProperties === null || typeof nodeProperties !== 'object' || Array.isArray(nodeProperties)) continue;
    for (const [name, property] of Object.entries(nodeProperties)) {
      if (!properties.has(name)) properties.set(name, []);
      properties.get(name).push(property);
    }
  }
  return [...properties.entries()].map(([name, schemas]) => {
    let type = null;
    let defaultValue;
    let hasDefault = false;
    let volatile = false;
    for (const schema of schemas) {
      for (const node of flattenSchemaNodes(schema)) {
        if (type === null && typeof node.type === 'string') type = node.type;
        if (!hasDefault && Object.hasOwn(node, 'default')) {
          defaultValue = node.default;
          hasDefault = true;
        }
        const native = node['x-cordis'];
        if (native !== null && typeof native === 'object' && native.volatile === true) volatile = true;
      }
    }
    return {
      name,
      present: true,
      type,
      default: hasDefault ? defaultValue : undefined,
      required: required.has(name),
      volatile,
    };
  });
}

/**
 * Normalize `x-cordis.diagnostics` to plain records.
 *
 * @param {Record<string, unknown>} document Schema document.
 * @returns {Array<{ level: string, path: string|null, message: string }>}
 */
function diagnosticsOf(document) {
  const container = document === null || typeof document !== 'object' ? undefined : document['x-cordis'];
  const raw = container && typeof container === 'object' ? container.diagnostics : undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      level: typeof item.level === 'string' ? item.level : 'error',
      path: typeof item.path === 'string' ? item.path : null,
      message: typeof item.message === 'string' ? item.message : String(item.message ?? ''),
    }));
}

/**
 * Find the row for a loader id (or, failing that, by plugin name substring).
 *
 * @param {Array<Record<string, unknown>>} rows Parsed entry rows.
 * @param {string} id Loader row id.
 * @returns {Record<string, unknown>|null}
 */
function findRow(rows, id) {
  const byId = rows.find((row) => row.id === id);
  if (byId !== undefined) return byId;
  const byName = rows.find((row) => typeof row.name === 'string' && row.name.includes(id));
  return byName ?? null;
}

/**
 * Heuristic text fallback for a truncated or polluted schema dump: find the
 * `great-plan` row block and the four field snippets by regex. Never throws.
 *
 * @param {string} text Raw text.
 * @returns {{ row: object|null, fields: object[], diagnostics: object[], complete: boolean, raw: true }}
 */
function rawSchemaFindings(text) {
  const source = typeof text === 'string' ? text : '';
  const idIndex = source.search(/"id"\s*:\s*"great-plan"/);
  if (idIndex === -1) {
    return { row: null, fields: [], diagnostics: [], complete: false, raw: true };
  }
  const window = source.slice(Math.max(0, idIndex - 1200), Math.min(source.length, idIndex + 1200));
  const statusMatch = window.match(/"status"\s*:\s*"([^"]+)"/);
  const nameMatch = window.match(/"name"\s*:\s*"([^"]+)"/);
  const configRefMatch = window.match(/"configRef"\s*:\s*"(#[^"]+)"/);
  const row = {
    id: ENTRY_ID,
    status: statusMatch === null ? 'unknown' : statusMatch[1],
    raw: true,
  };
  if (nameMatch !== null) row.name = nameMatch[1];
  if (configRefMatch !== null) row.configRef = configRefMatch[1];
  const fields = EXPECTED_CONFIG_FIELDS.map((name) => {
    const at = source.indexOf(`"${name}"`);
    if (at === -1) return { name, present: false, type: null, default: undefined, required: false, volatile: false };
    const slice = source.slice(at, at + 400);
    const defaultMatch = slice.match(/"default"\s*:\s*(true|false)/);
    return {
      name,
      present: true,
      type: null,
      default: defaultMatch === null ? undefined : defaultMatch[1] === 'true',
      required: false,
      volatile: /"volatile"\s*:\s*true/.test(slice),
    };
  });
  const diagnostics = [];
  const diagnosticPattern = /"level"\s*:\s*"(error|warning)"[^}]*?"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match = diagnosticPattern.exec(source);
  while (match !== null) {
    diagnostics.push({ level: match[1], path: null, message: match[2].replace(/\\"/g, '"') });
    match = diagnosticPattern.exec(source);
  }
  return {
    row,
    fields,
    diagnostics,
    complete: /"complete"\s*:\s*true/.test(source),
    raw: true,
  };
}

/**
 * Tolerant findings from a real (or simulated) `--dump-config-schema` dump:
 * the `great-plan` row, its projected Config fields, and composition
 * diagnostics. A structured JSON parse is preferred; truncated or polluted
 * output falls back to regex extraction over the raw text.
 *
 * @param {string} stdout Raw stdout.
 * @returns {{
 *   row: object|null,
 *   fields: object[],
 *   diagnostics: Array<{ level: string, path: string|null, message: string }>,
 *   complete: boolean,
 *   raw: boolean,
 * }}
 */
export function schemaFindings(stdout) {
  const document = tryParseJsonDocument(stdout);
  if (document !== null && isSchemaDocument(document)) {
    const rows = parseSchemaRows(stdout);
    const row = findRow(rows, ENTRY_ID);
    const definition = resolveSchemaRef(document, row?.configRef);
    const container = document === null || typeof document !== 'object' ? undefined : document['x-cordis'];
    return {
      row,
      fields: fieldsFromDefinition(definition),
      diagnostics: diagnosticsOf(document),
      complete: Boolean(container && typeof container === 'object' && container.complete === true),
      raw: false,
    };
  }
  return rawSchemaFindings(stdout);
}

/**
 * Parse one YAML scalar produced by the profile dump (quoted strings, booleans,
 * nulls, numbers, block tags). Unrecognized expressions stay strings.
 *
 * @param {string} raw Raw scalar text.
 * @returns {unknown}
 */
function parseYamlScalar(raw) {
  if (typeof raw !== 'string') return raw;
  const value = raw.trim();
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^'(.*)'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  if (/^"(.*)"$/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  const tag = /^!!\w+\s+(.*)$/.exec(value);
  if (tag !== null) return tag[1];
  return value;
}

/**
 * Split the composed dump into row blocks and parse the fields the harness
 * checks: `id`, `disabled`, and the top-level keys of `config`.
 *
 * @param {string} text Raw `--dump-config` stdout.
 * @returns {Map<string, { id: string, disabled: boolean|null, config: object|null }>}
 */
function indexDumpRows(text) {
  const rows = new Map();
  if (typeof text !== 'string' || text.trim() === '') return rows;
  const blocks = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    if (/^-\s+\S/.test(line)) {
      if (current !== null) blocks.push(current);
      current = [line.replace(/^-\s+/, '')];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) blocks.push(current);

  for (const block of blocks) {
    const top = new Map();
    let configIndent = null;
    let configLines = null;
    for (const line of block) {
      const match = /^(\s*)([^\s:#][^:]*):\s*(.*)$/.exec(line);
      if (match === null) continue;
      const indent = match[1].length;
      const key = match[2].trim();
      if (configIndent !== null && indent > configIndent) {
        configLines.push(line);
        continue;
      }
      configIndent = null;
      if (key === 'config' && match[3].trim() === '') {
        configIndent = indent;
        configLines = [];
        top.set('config', { block: configLines });
        continue;
      }
      top.set(key, match[3].trim());
    }
    const rawId = top.get('id');
    if (typeof rawId !== 'string') continue;
    const id = String(parseYamlScalar(rawId));
    if (id === '') continue;
    const rawDisabled = top.get('disabled');
    let disabled = false;
    if (typeof rawDisabled === 'string') {
      if (rawDisabled.startsWith('!!')) disabled = null;
      else disabled = parseYamlScalar(rawDisabled) === true;
    }
    let config = null;
    const rawConfig = top.get('config');
    if (rawConfig !== undefined && typeof rawConfig === 'object') {
      config = {};
      if (Array.isArray(rawConfig.block) && rawConfig.block.length > 0) {
        let baseIndent = null;
        for (let index = 0; index < rawConfig.block.length; index += 1) {
          const match = /^(\s*)([^\s:#][^:]*):\s*(.*)$/.exec(rawConfig.block[index]);
          if (match === null) continue;
          const indent = match[1].length;
          if (baseIndent === null) baseIndent = indent;
          if (indent !== baseIndent) continue;
          // `key:` followed by a deeper line is a nested container, not a scalar.
          const nested = rawConfig.block
            .slice(index + 1)
            .some((candidate) => candidate.trim() !== '' && /^\s+/.test(candidate) && candidate.match(/^\s*/)[0].length > indent);
          if (match[3].trim() === '' && nested) continue;
          config[match[2].trim()] = parseYamlScalar(match[3]);
        }
      }
    } else if (typeof rawConfig === 'string' && rawConfig.trim() === '{}') {
      config = {};
    }
    rows.set(id, { id, disabled, config });
  }
  return rows;
}

/**
 * Find one row in a composed `--dump-config` YAML dump. Line-based and
 * tolerant: comments, layer headers, group rows, nested lists, and `!!js`
 * expressions do not break it; unknown input yields `found: false`.
 *
 * @param {string} text Raw `--dump-config` stdout.
 * @param {string} id Loader row id to find.
 * @returns {{ found: boolean, disabled: boolean|null, config: Record<string, unknown>|null }}
 */
export function parseDumpText(text, id) {
  if (typeof id !== 'string' || id === '') throw new Error('parseDumpText requires a row id');
  const row = indexDumpRows(text).get(id);
  if (row === undefined) return { found: false, disabled: false, config: null };
  return { found: true, disabled: row.disabled, config: row.config };
}

/**
 * Normalize one `runCommand`-shaped exec result, catching spawn failures.
 *
 * @param {(spec: object) => Promise<object>} exec Injected exec.
 * @param {object} spec `runCommand` arguments.
 * @returns {Promise<{ ok: boolean, code: number|null, stdout: string, stderr: string, durationMs: number|null }>}
 */
async function execResult(exec, spec) {
  try {
    const result = await exec(spec);
    const code = result === null || result === undefined ? null : result.code;
    return {
      ok: code === 0,
      code: typeof code === 'number' ? code : null,
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : '',
      durationMs: typeof result?.durationMs === 'number' ? result.durationMs : null,
    };
  } catch (error) {
    return {
      ok: false,
      code: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: null,
    };
  }
}

/**
 * Build the child environment for a CLI dump: the caller's environment plus the
 * eval home as `DSH_HOME`.
 *
 * @param {NodeJS.ProcessEnv|undefined} env Full environment from the caller (defaults to `process.env`).
 * @param {string} dshHome Eval home to expose as `DSH_HOME`.
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv(env, dshHome) {
  return { ...(env === undefined ? process.env : env), DSH_HOME: dshHome };
}

/**
 * Trim long child stderr to one actionable line for a blocker message.
 *
 * @param {string} text Child stderr.
 * @returns {string}
 */
function stderrTail(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return 'no stderr';
  return lines.slice(-3).join(' | ');
}

/**
 * Free bytes on the filesystem holding `target`, walking up to the nearest
 * existing ancestor. Returns `null` when the platform or filesystem cannot
 * report it.
 *
 * @param {string} target Path to inspect.
 * @returns {number|null}
 */
function freeDiskBytes(target) {
  const statfsSync = fs.statfsSync;
  if (typeof statfsSync !== 'function') return null;
  let candidate = path.resolve(target);
  for (;;) {
    try {
      const stats = statfsSync(candidate);
      const available = Number(stats.bavail);
      const size = Number(stats.bsize);
      if (!Number.isFinite(available) || !Number.isFinite(size)) return null;
      return available * size;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

/**
 * Sort discovered home names deterministically: `dsh-home` first, then numeric
 * worker order.
 *
 * @param {string} left Home name.
 * @param {string} right Home name.
 * @returns {number}
 */
function compareHomeNames(left, right) {
  const rank = (name) => {
    if (name === 'dsh-home') return -1;
    const match = /^dsh-home-w(\d+)$/.exec(name);
    return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
  };
  const delta = rank(left) - rank(right);
  return delta !== 0 ? delta : left.localeCompare(right);
}

/**
 * Read a JSON file, returning `null` for a missing/invalid file.
 *
 * @param {string} file Path.
 * @returns {unknown|null}
 */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run the live `--dump-config-schema` check against one eval home.
 *
 * @param {object} options
 * @param {(spec: object) => Promise<object>} options.exec Injected exec.
 * @param {string} options.cliPath CLI path.
 * @param {string} options.dshHome Eval home (DSH_HOME).
 * @param {string} options.cwd Child working directory.
 * @param {NodeJS.ProcessEnv|undefined} options.env Caller environment.
 * @param {number} options.timeoutMs Child timeout.
 * @returns {Promise<{ blockers: string[], warnings: string[], facts: object }>}
 */
async function checkProfileSchema({ exec, cliPath, dshHome, cwd, env, timeoutMs }) {
  const args = ['--profile', PROFILE_NAME, '--dump-config-schema'];
  const result = await execResult(exec, {
    command: cliPath,
    args,
    cwd,
    env: childEnv(env, dshHome),
    timeoutMs,
  });
  const facts = {
    enabled: true,
    ok: false,
    invocation: { command: cliPath, args, dshHome },
    exitCode: result.code,
    durationMs: result.durationMs,
    row: null,
    fields: [],
    diagnostics: { total: 0, errors: 0, warnings: 0 },
    complete: false,
  };
  const blockers = [];
  const warnings = [];
  if (!result.ok) {
    blockers.push(`profile schema dump failed (exit ${result.code ?? 'spawn-error'}): ${stderrTail(result.stderr)}`);
    return { blockers, warnings, facts };
  }
  const findings = schemaFindings(result.stdout);
  facts.row = findings.row === null ? null : {
    id: findings.row.id ?? ENTRY_ID,
    path: findings.row.path ?? null,
    status: findings.row.status ?? null,
    configRef: findings.row.configRef ?? null,
  };
  facts.fields = findings.fields;
  facts.complete = findings.complete;
  facts.rawFallback = findings.raw;
  facts.diagnostics = {
    total: findings.diagnostics.length,
    errors: findings.diagnostics.filter((item) => item.level === 'error').length,
    warnings: findings.diagnostics.filter((item) => item.level === 'warning').length,
  };

  if (findings.row === null) {
    blockers.push('schema dump has no great-plan row');
    return { blockers, warnings, facts };
  }
  if (findings.row.status !== 'schema') {
    blockers.push(`great-plan row status is ${JSON.stringify(findings.row.status)} (expected "schema")`);
  }
  const present = new Set(findings.fields.filter((field) => field.present !== false).map((field) => field.name));
  const missing = EXPECTED_CONFIG_FIELDS.filter((name) => !present.has(name));
  if (missing.length > 0) blockers.push(`great-plan Config is missing fields: ${missing.join(', ')}`);
  for (const name of EXPECTED_CONFIG_FIELDS) {
    const field = findings.fields.find((item) => item.name === name);
    if (field === undefined) continue;
    if (field.default !== true) blockers.push(`great-plan Config.${name} default is ${String(field.default)} (expected true)`);
    if (field.volatile !== true) blockers.push(`great-plan Config.${name} is not marked volatile`);
  }
  const unexpected = findings.fields.map((field) => field.name).filter((name) => !EXPECTED_CONFIG_FIELDS.includes(name));
  if (unexpected.length > 0) warnings.push(`great-plan Config has unexpected fields: ${unexpected.join(', ')}`);

  const rowPrefix = typeof findings.row.path === 'string' ? findings.row.path : '';
  for (const diagnostic of findings.diagnostics) {
    const location = diagnostic.path ?? '';
    const touchesRow = rowPrefix !== '' && (location === rowPrefix || location.startsWith(`${rowPrefix}/`));
    const mentionsPlugin = /great-plan/.test(diagnostic.message);
    const mentionsSchemastery = /schemastery/.test(diagnostic.message);
    if (diagnostic.level === 'error' && (touchesRow || mentionsPlugin || mentionsSchemastery)) {
      blockers.push(`schema diagnostic: ${diagnostic.message}`);
    } else if (diagnostic.level === 'error') {
      warnings.push(`unrelated schema diagnostic: ${diagnostic.message}`);
    }
  }
  if (!findings.complete) warnings.push('schema dump reports x-cordis.complete=false');
  if (findings.raw) warnings.push('schema dump needed the raw-text fallback (output was not valid JSON)');
  facts.ok = blockers.length === 0;
  return { blockers, warnings, facts };
}

/**
 * Run the three-arm composed `--dump-config` checks (base patch + arm patch).
 *
 * @param {object} options
 * @param {(spec: object) => Promise<object>} options.exec Injected exec.
 * @param {string} options.cliPath CLI path.
 * @param {string} options.dshHome Eval home (DSH_HOME).
 * @param {string} options.cwd Child working directory.
 * @param {NodeJS.ProcessEnv|undefined} options.env Caller environment.
 * @param {number} options.timeoutMs Child timeout.
 * @param {string} options.basePatch Base patch path.
 * @param {Record<string, string>} options.armPatches Arm patch paths.
 * @returns {Promise<{ blockers: string[], warnings: string[], facts: object }>}
 */
async function checkCompose({ exec, cliPath, dshHome, cwd, env, timeoutMs, basePatch, armPatches }) {
  const blockers = [];
  const warnings = [];
  const arms = {};
  for (const arm of ARM_NAMES) {
    const args = ['--profile', PROFILE_NAME, '--patch', basePatch, '--patch', armPatches[arm], '--dump-config'];
    const armFacts = {
      ok: false,
      invocation: { command: cliPath, args, dshHome },
      errors: [],
      exitCode: null,
    };
    const result = await execResult(exec, {
      command: cliPath,
      args,
      cwd,
      env: childEnv(env, dshHome),
      timeoutMs,
    });
    armFacts.exitCode = result.code;
    if (!result.ok) {
      armFacts.errors.push(`compose dump failed (exit ${result.code ?? 'spawn-error'}): ${stderrTail(result.stderr)}`);
    } else {
      const rows = indexDumpRows(result.stdout);
      for (const id of BASE_INSERTED_ROWS) {
        if (!rows.has(id)) armFacts.errors.push(`base row ${id} is missing`);
      }
      for (const id of BASE_DISABLED_ROWS) {
        const row = rows.get(id);
        if (row === undefined) armFacts.errors.push(`base row ${id} is missing`);
        else if (row.disabled !== true) armFacts.errors.push(`base row ${id} is not disabled`);
      }
      const row = rows.get(ENTRY_ID);
      if (row === undefined) {
        armFacts.errors.push('great-plan row is missing');
      } else if (arm === 'native') {
        if (row.disabled !== true) armFacts.errors.push('native arm does not disable the great-plan row');
        if (row.config !== null) armFacts.errors.push('native arm must not write great-plan config');
      } else {
        const expected = ARM_CONFIGS[arm];
        if (row.disabled === true) armFacts.errors.push(`${arm} arm disables the great-plan row`);
        if (row.config === null) {
          armFacts.errors.push(`${arm} arm does not restate the four Config fields`);
        } else {
          const missing = Object.keys(expected).filter((key) => !Object.hasOwn(row.config, key));
          if (missing.length > 0) armFacts.errors.push(`${arm} arm does not restate: ${missing.join(', ')}`);
          for (const [key, value] of Object.entries(expected)) {
            if (Object.hasOwn(row.config, key) && row.config[key] !== value) {
              armFacts.errors.push(`${arm} arm config.${key} is ${String(row.config[key])} (expected ${String(value)})`);
            }
          }
          const extra = Object.keys(row.config).filter((key) => !Object.hasOwn(expected, key));
          if (extra.length > 0) armFacts.errors.push(`${arm} arm config has unexpected keys: ${extra.join(', ')}`);
        }
      }
    }
    armFacts.ok = armFacts.errors.length === 0;
    if (!armFacts.ok) blockers.push(`arm ${arm}: ${armFacts.errors.join('; ')}`);
    arms[arm] = armFacts;
  }
  return {
    blockers,
    warnings,
    facts: { enabled: true, ok: blockers.length === 0, arms },
  };
}

/**
 * Normalize the optional model description.
 *
 * @param {unknown} value Caller-supplied model.
 * @param {NodeJS.ProcessEnv} env Environment.
 * @returns {{ configured: boolean, source: string|null, value: unknown }}
 */
function normalizeModel(value, env) {
  if (value !== undefined && value !== null && value !== '') {
    return { configured: true, source: 'option', value };
  }
  for (const key of ['GREAT_PLAN_EVAL_MODEL', 'DSH_EVAL_MODEL']) {
    if (typeof env[key] === 'string' && env[key].trim() !== '') {
      return { configured: true, source: key, value: env[key] };
    }
  }
  return { configured: false, source: null, value: null };
}

/**
 * Normalize the optional simulator description to `{ kind, model }`.
 *
 * @param {unknown} value Caller-supplied simulator.
 * @param {NodeJS.ProcessEnv} env Environment.
 * @returns {{ configured: boolean, source: string|null, kind: string|null, model: string|null }}
 */
function normalizeSimulator(value, env) {
  let raw = value;
  let source = value === undefined || value === null ? null : 'option';
  if (raw === undefined || raw === null || raw === '') {
    raw = null;
    source = null;
    for (const key of ['GREAT_PLAN_EVAL_SIMULATOR', 'DSH_EVAL_SIMULATOR']) {
      if (typeof env[key] === 'string' && env[key].trim() !== '') {
        raw = env[key];
        source = key;
        break;
      }
    }
  }
  if (raw === null) return { configured: false, source: null, kind: null, model: null };
  if (typeof raw === 'object') {
    return {
      configured: true,
      source,
      kind: typeof raw.kind === 'string' ? raw.kind : 'http',
      model: typeof raw.model === 'string' ? raw.model : null,
    };
  }
  const text = String(raw).trim();
  if (text === '') return { configured: false, source: null, kind: null, model: null };
  if (text === 'none' || text === 'fixture' || text === 'live') return { configured: true, source, kind: text, model: null };
  const [kind, model] = text.split(':', 2);
  return { configured: true, source, kind: kind === '' ? 'http' : kind, model: model ?? null };
}

/**
 * Preflight the harness: environment, workspace, eval homes, and (optionally)
 * the live profile composition. Every external command goes through the
 * injected `exec`; a spawn failure becomes a blocker rather than a throw.
 *
 * @param {object} [options]
 * @param {string} [options.workspace] Plugin checkout under test (defaults to cwd).
 * @param {string} [options.cacheRoot] Eval cache root (defaults to {@link defaultCacheRoot}).
 * @param {NodeJS.ProcessEnv} [options.env] Full environment for child processes.
 * @param {(spec: object) => Promise<object>} [options.exec] Injected `runCommand`.
 * @param {boolean} [options.compose] Also run the three-arm `--dump-config` checks.
 * @param {boolean} [options.checkProfile] Run the live `--dump-config-schema` check.
 * @param {string} [options.cliPath] CLI path override (else `$DSH_CLI`, else the Desktop path).
 * @param {string} [options.datasetFile] Dataset override (else `<harness>/dataset/tasks.jsonl`).
 * @param {string} [options.basePatchPath] Base patch override (else the committed file).
 * @param {Record<string, string>} [options.armPatchPaths] Arm patch overrides.
 * @param {unknown} [options.model] Configured model (provider/model or object).
 * @param {unknown} [options.simulator] Simulator (`none`/`fixture`/`live`/`http:model` or object).
 * @param {string} [options.runMode] `plan` or `execute` (gates Docker severity).
 * @param {string} [options.issueMode] `hidden` or `full` (gates the simulator blocker).
 * @param {number} [options.timeoutMs] Child timeout for CLI/git checks.
 * @param {number} [options.diskFreeBytes] Disk-free override for deterministic tests.
 * @param {boolean} [options.checkDocker] Set false to skip the Docker probe.
 * @returns {Promise<{ ok: boolean, blockers: string[], warnings: string[], facts: object }>}
 */
export async function preflight(options = {}) {
  const env = options.env ?? process.env;
  const exec = options.exec ?? runCommand;
  const blockers = [];
  const warnings = [];
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
  const facts = { checkedAt: nowIso() };

  // ── Node runtime ──────────────────────────────────────────────────────────
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  const zstd = typeof zlib.zstdDecompressSync === 'function';
  facts.node = { version: nodeVersion, major: nodeMajor, zstd };
  if (!Number.isFinite(nodeMajor) || nodeMajor < REQUIRED_NODE_MAJOR) {
    blockers.push(`Node >= ${REQUIRED_NODE_MAJOR} required (found v${nodeVersion})`);
  }
  if (!zstd) blockers.push('zlib.zstdDecompressSync is unavailable; session logs cannot be decoded');

  // ── Workspace checkout ────────────────────────────────────────────────────
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const workspaceStat = fs.statSync(workspace, { throwIfNoEntry: false });
  const workspacePresent = workspaceStat !== undefined && workspaceStat.isDirectory();
  const workspaceFacts = {
    root: workspace,
    present: workspacePresent,
    head: null,
    dirty: null,
    packageName: null,
    version: null,
  };
  facts.workspace = workspaceFacts;
  let pluginVersion = null;
  if (!workspacePresent) {
    blockers.push(`workspace is not a directory: ${workspace}`);
  } else {
    const manifest = readJsonFile(path.join(workspace, 'package.json'));
    if (manifest === null || typeof manifest !== 'object') {
      blockers.push(`workspace has no readable package.json: ${path.join(workspace, 'package.json')}`);
    } else {
      workspaceFacts.packageName = typeof manifest.name === 'string' ? manifest.name : null;
      workspaceFacts.version = typeof manifest.version === 'string' ? manifest.version : null;
      pluginVersion = workspaceFacts.version;
      if (workspaceFacts.packageName !== PLUGIN_PACKAGE) {
        blockers.push(`workspace package is ${JSON.stringify(workspaceFacts.packageName)} (expected ${JSON.stringify(PLUGIN_PACKAGE)})`);
      }
      if (pluginVersion === null) blockers.push('workspace package.json has no version');
    }
    const headResult = await execResult(exec, {
      command: 'git',
      args: ['-C', workspace, 'rev-parse', 'HEAD'],
      timeoutMs: 30000,
      env,
    });
    if (!headResult.ok) {
      blockers.push(`workspace is not a readable git checkout (rev-parse HEAD failed): ${stderrTail(headResult.stderr)}`);
    } else {
      workspaceFacts.head = headResult.stdout.trim();
    }
    const statusResult = await execResult(exec, {
      command: 'git',
      args: ['-C', workspace, 'status', '--porcelain'],
      timeoutMs: 30000,
      env,
    });
    if (!statusResult.ok) {
      blockers.push(`workspace git status failed: ${stderrTail(statusResult.stderr)}`);
    } else {
      workspaceFacts.dirty = statusResult.stdout.trim() !== '';
      if (workspaceFacts.dirty) warnings.push('workspace has uncommitted changes; the manifest will record dirty=true');
    }
  }

  // ── CLI ──────────────────────────────────────────────────────────────────
  const cliPath = options.cliPath ?? (typeof env[CLI_ENV] === 'string' && env[CLI_ENV] !== '' ? env[CLI_ENV] : DEFAULT_DSH_CLI);
  const cliStat = fs.statSync(cliPath, { throwIfNoEntry: false });
  let cliExecutable = false;
  if (cliStat !== undefined && cliStat.isFile()) {
    try {
      fs.accessSync(cliPath, fs.constants.X_OK);
      cliExecutable = true;
    } catch {
      cliExecutable = false;
    }
  }
  facts.cli = { path: cliPath, exists: cliStat !== undefined && cliStat.isFile(), executable: cliExecutable };
  if (!facts.cli.exists) blockers.push(`dsh CLI not found: ${cliPath} (set ${CLI_ENV})`);
  else if (!cliExecutable) blockers.push(`dsh CLI is not executable: ${cliPath}`);

  // ── Dataset ──────────────────────────────────────────────────────────────
  const datasetFile = options.datasetFile ?? path.join(HARNESS_ROOT, 'dataset', 'tasks.jsonl');
  const datasetStat = fs.statSync(datasetFile, { throwIfNoEntry: false });
  const datasetPresent = datasetStat !== undefined && datasetStat.isFile();
  facts.dataset = { path: datasetFile, present: datasetPresent };
  if (!datasetPresent) warnings.push(`dataset missing: ${datasetFile} (run fetch-dataset / normalize before run)`);

  // ── Eval homes under the cache root ──────────────────────────────────────
  const cacheRoot = options.cacheRoot === undefined ? defaultCacheRoot(env) : path.resolve(options.cacheRoot);
  facts.cacheRoot = cacheRoot;
  const homesRoot = path.join(cacheRoot, 'homes');
  const homeNames = listDir(homesRoot)
    .filter((name) => !name.startsWith('.'))
    .sort(compareHomeNames);
  let workspaceReal = null;
  try {
    workspaceReal = fs.realpathSync(workspace);
  } catch {
    workspaceReal = null;
  }
  const homes = [];
  for (const name of homeNames) {
    const home = path.join(homesRoot, name);
    let homeIsDir = false;
    try {
      homeIsDir = fs.statSync(home).isDirectory();
    } catch {
      homeIsDir = false;
    }
    if (!homeIsDir) continue;
    const profileDir = path.join(home, 'profiles', PROFILE_NAME);
    const profileManifest = readJsonFile(path.join(profileDir, 'package.json'));
    const profilePresent = profileManifest !== null && typeof profileManifest === 'object';
    let bundles = [];
    let dependency = null;
    if (profilePresent) {
      const dsh = profileManifest.dsh;
      const profile = dsh !== null && typeof dsh === 'object' ? dsh.profile : undefined;
      const rawBundles = profile !== null && typeof profile === 'object' ? profile.bundles : undefined;
      bundles = Array.isArray(rawBundles) ? rawBundles.filter((item) => typeof item === 'string') : [];
      const dependencies = profileManifest.dependencies;
      if (dependencies !== null && typeof dependencies === 'object') {
        dependency = typeof dependencies[PLUGIN_PACKAGE] === 'string' ? dependencies[PLUGIN_PACKAGE] : null;
      }
    }
    const linkPath = path.join(home, 'node_modules', ...PLUGIN_PACKAGE.split('/'));
    let linkTarget = null;
    let linkOk = false;
    try {
      const linkStat = fs.lstatSync(linkPath);
      if (linkStat.isSymbolicLink()) {
        linkTarget = fs.realpathSync(linkPath);
        linkOk = workspaceReal !== null && linkTarget === workspaceReal;
      } else if (linkStat.isDirectory()) {
        linkTarget = path.join(home, 'node_modules', ...PLUGIN_PACKAGE.split('/'));
        linkOk = workspaceReal !== null && fs.realpathSync(linkTarget) === workspaceReal;
      }
    } catch {
      linkOk = false;
    }
    // `dsh plugin add` installs into the profile directory (pnpm runs there), so
    // that copy is authoritative; the home-root location is only a compatibility
    // fallback for manually seeded homes.
    const schemasterySearchedPaths = [
      path.join(profileDir, 'node_modules', ...SCHEMASTERY_PACKAGE.split('/'), 'package.json'),
      path.join(home, 'node_modules', ...SCHEMASTERY_PACKAGE.split('/'), 'package.json'),
    ];
    const schemastery = {
      package: SCHEMASTERY_PACKAGE,
      spec: SCHEMASTERY_SPEC,
      path: schemasterySearchedPaths[0],
      searchedPaths: schemasterySearchedPaths,
      present: false,
      version: null,
    };
    for (const candidate of schemasterySearchedPaths) {
      const candidateManifest = readJsonFile(candidate);
      if (candidateManifest === null || typeof candidateManifest !== 'object') continue;
      if (candidateManifest.name !== SCHEMASTERY_PACKAGE) continue;
      schemastery.path = candidate;
      schemastery.present = true;
      schemastery.version = typeof candidateManifest.version === 'string' ? candidateManifest.version : null;
      break;
    }
    const credentialsPath = path.join(home, '.credentials.yaml');
    const credentialsStat = fs.statSync(credentialsPath, { throwIfNoEntry: false });
    const credentials = {
      path: credentialsPath,
      present: credentialsStat !== undefined && credentialsStat.isFile(),
      mode: credentialsStat === undefined ? null : credentialsStat.mode & 0o777,
    };
    const homeFacts = {
      name,
      home,
      profileDir,
      profilePresent,
      bundles,
      dependency,
      pluginLink: linkPath,
      pluginLinkTarget: linkTarget,
      pluginLinkOk: linkOk,
      credentials,
      schemastery,
    };
    homes.push(homeFacts);
    if (!profilePresent) {
      blockers.push(`eval home ${name} has no readable profiles/${PROFILE_NAME}/package.json (re-run provision)`);
    } else {
      const missingBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', PLUGIN_PACKAGE]
        .filter((bundle) => !bundles.includes(bundle));
      if (missingBundles.length > 0) {
        blockers.push(`eval home ${name} is missing bundles: ${missingBundles.join(', ')}`);
      }
      if (dependency === null || !dependency.startsWith('link:')) {
        blockers.push(`eval home ${name} does not link ${PLUGIN_PACKAGE} from the workspace`);
      }
    }
    if (!linkOk) {
      blockers.push(`eval home ${name} plugin link is missing or points elsewhere: ${linkPath}`);
    }
    if (!schemastery.present) {
      blockers.push(
        `eval home ${name} is missing peer dependency ${SCHEMASTERY_PACKAGE} (run provision --install-peers)`,
      );
    } else if (schemastery.version !== null && !schemastery.version.startsWith('3.18.')) {
      warnings.push(
        `eval home ${name} has ${SCHEMASTERY_PACKAGE}@${schemastery.version} (expected ${SCHEMASTERY_SPEC})`,
      );
    }
    if (credentials.present && (credentials.mode & 0o077) !== 0) {
      warnings.push(`credentials file ${credentialsPath} has mode 0o${credentials.mode.toString(8)} (expected 0o600)`);
    }
  }
  facts.homes = homes;
  facts.peerDependencies = {
    [SCHEMASTERY_PACKAGE]: {
      spec: SCHEMASTERY_SPEC,
      presentInAllHomes: homes.length > 0 && homes.every((home) => home.schemastery.present),
    },
  };
  if (homes.length === 0) {
    blockers.push(`no eval homes under ${homesRoot} (run provision --workers N)`);
  }
  const credentialsInHomes = homes.filter((home) => home.credentials.present);
  facts.credentials = {
    present: credentialsInHomes.length > 0,
    homes: credentialsInHomes.map((home) => home.name),
  };
  if (credentialsInHomes.length === 0 && homes.length > 0) {
    warnings.push('no credentials were copied into the eval homes (provision --copy-credentials); model-backed runs will fail');
  }

  // ── Disk space ───────────────────────────────────────────────────────────
  const freeBytes = typeof options.diskFreeBytes === 'number' ? options.diskFreeBytes : freeDiskBytes(cacheRoot);
  facts.disk = { freeBytes };
  if (freeBytes !== null) {
    if (freeBytes < DISK_BLOCK_BYTES) {
      blockers.push(`only ${Math.round(freeBytes / 1024 ** 2)} MiB free under the cache root (need >= 1 GiB)`);
    } else if (freeBytes < DISK_WARN_BYTES) {
      warnings.push(`low disk space under the cache root: ${Math.round(freeBytes / 1024 ** 2)} MiB free`);
    }
  }

  // ── Model / simulator configuration ──────────────────────────────────────
  const model = normalizeModel(options.model, env);
  const simulator = normalizeSimulator(options.simulator, env);
  facts.model = model;
  facts.simulator = simulator;
  if (!model.configured) warnings.push('no model configured; live runs need --model provider/model');
  if (!simulator.configured) warnings.push('no simulator configured; hidden issue mode needs a live simulator');
  if (options.issueMode === 'hidden' && simulator.kind === 'none') {
    blockers.push('hidden issue mode requires a live simulator; simulator is "none"');
  }
  if (simulator.kind === 'http' && simulator.model === null && !model.configured) {
    warnings.push('HTTP simulator has no model configured');
  }

  // ── Docker (only mandatory for execute mode) ─────────────────────────────
  const runMode = options.runMode ?? 'plan';
  if (options.checkDocker === false) {
    facts.docker = { checked: false, present: false, version: null };
  } else {
    const dockerResult = await execResult(exec, { command: 'docker', args: ['--version'], timeoutMs: 15000, env });
    const present = dockerResult.ok;
    facts.docker = {
      checked: true,
      present,
      version: present ? dockerResult.stdout.trim() || dockerResult.stderr.trim() || null : null,
    };
    if (!present) {
      const message = `docker is unavailable: ${stderrTail(dockerResult.stderr)}`;
      if (runMode === 'execute') blockers.push(`${message} (execute mode requires docker)`);
      else warnings.push(message);
    }
  }

  // ── Live profile checks (opt-in, never a model call) ─────────────────────
  const checkProfile = options.checkProfile === true;
  const compose = options.compose === true;
  const firstHome = homes.find((home) => home.profilePresent) ?? homes[0] ?? null;
  const basePatch = options.basePatchPath ?? basePatchPath();
  const armPatches = {};
  for (const arm of ARM_NAMES) {
    armPatches[arm] = options.armPatchPaths?.[arm] ?? armPatchPath(arm);
  }

  if ((checkProfile || compose) && firstHome === null) {
    blockers.push('cannot run live profile checks without a provisioned eval home');
    facts.schema = { enabled: false };
    facts.compose = { enabled: false };
  } else if (checkProfile || compose) {
    const common = {
      exec,
      cliPath,
      dshHome: firstHome.home,
      cwd: workspace,
      env,
      timeoutMs,
    };
    if (checkProfile) {
      const schema = await checkProfileSchema(common);
      blockers.push(...schema.blockers);
      warnings.push(...schema.warnings);
      facts.schema = schema.facts;
    } else {
      facts.schema = { enabled: false, skipped: true };
      warnings.push('profile schema check skipped (checkProfile=false)');
    }
    if (compose) {
      const composed = await checkCompose({ ...common, basePatch, armPatches });
      blockers.push(...composed.blockers);
      warnings.push(...composed.warnings);
      facts.compose = composed.facts;
    } else {
      facts.compose = { enabled: false };
    }
  } else {
    facts.schema = { enabled: false, skipped: true };
    facts.compose = { enabled: false };
    warnings.push('profile schema check skipped (checkProfile=false)');
  }

  // ── Patch files (only meaningful with the live checks) ───────────────────
  const patchFiles = [
    { role: 'base', path: basePatch },
    ...ARM_NAMES.map((arm) => ({ role: `arm:${arm}`, path: armPatches[arm] })),
  ];
  facts.patches = patchFiles.map(({ role, path: file }) => ({
    role,
    path: file,
    present: fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true,
  }));
  if (compose) {
    for (const patch of facts.patches) {
      if (!patch.present) blockers.push(`patch file missing: ${patch.path}`);
    }
  }

  facts.pluginVersion = pluginVersion;
  facts.runMode = runMode;
  facts.checkProfile = checkProfile;
  facts.composeEnabled = compose;

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    facts,
  };
}
