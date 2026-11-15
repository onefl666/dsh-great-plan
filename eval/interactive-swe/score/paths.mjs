/**
 * Citation extraction and safe resolution.
 *
 * Plans cite evidence as `path:line` or `path:12-30`. This module extracts
 * those references, resolves them against the task worktree without allowing a
 * path escape, checks the cited line range against the real file, and records
 * whether the same path appears in a tool-call argument (corroboration). No
 * model is involved and every result is deterministic for a given filesystem.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLAN_MODE_TOOL } from '../session/events.mjs';

/**
 * Path reference pattern.
 *
 * The lookbehind avoids matching a suffix of a URL or of an absolute/Windows
 * path (the whole reference must start at a token boundary). A path token must
 * either contain a dot in its final segment or contain a slash, which keeps
 * times (`12:30`) and bare numbers out while accepting `a.js:3` and
 * `docs/README:4`.
 */
const PATH_REF_PATTERN = String.raw`(?<![A-Za-z0-9_./:@~+\\-])((?:[A-Za-z0-9_.@~+-]+\/)*[A-Za-z0-9_.@~+-]+\.[A-Za-z][A-Za-z0-9]{0,9}|(?:[A-Za-z0-9_.@~+-]+\/)+[A-Za-z0-9_.@~+-]+):(\d{1,6})(?:-(\d{1,6}))?`;

/** Characters that make a path ref suspicious before resolution is even tried. */
const IP_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Remove fenced code blocks before extraction.
 *
 * Plans frequently paste snippets whose `file.js:3` fragments are not
 * citations; blanking fenced blocks preserves line structure while dropping
 * those false positives.
 *
 * @param {string} text
 * @returns {string}
 */
function stripFencedCode(text) {
  return text.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, (block) => block.replace(/[^\n]/g, ' '));
}

/**
 * Extract every `path:line` / `path:12-30` reference from a text.
 *
 * @param {unknown} text plan or assistant text
 * @returns {Array<object>} refs with `{ raw, path, startLine, endLine, index }`
 */
export function extractPathRefs(text) {
  if (typeof text !== 'string' || text === '') return [];
  const stripped = stripFencedCode(text);
  const pattern = new RegExp(PATH_REF_PATTERN, 'g');
  const refs = [];
  for (const match of stripped.matchAll(pattern)) {
    const refPath = match[1];
    if (refPath.startsWith('www.')) continue;
    if (IP_LIKE.test(refPath)) continue;
    const startLine = Number(match[2]);
    const endLine = match[3] === undefined ? null : Number(match[3]);
    refs.push({
      raw: match[0],
      path: refPath,
      startLine,
      endLine,
      index: match.index ?? 0,
    });
  }
  return refs;
}

/** Build one searchable string from wire tool-call arguments. */
function toolArgumentHaystack(toolCalls) {
  const parts = [];
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (call === null || typeof call !== 'object') continue;
    // The plan-submission call embeds the plan itself, so it can never
    // corroborate a citation: every cited path appears in its arguments.
    if (call.name === PLAN_MODE_TOOL) continue;
    if (typeof call.argsRaw === 'string') parts.push(call.argsRaw);
    if (typeof call.args === 'string') parts.push(call.args);
    else if (call.args !== null && typeof call.args === 'object') {
      try {
        parts.push(JSON.stringify(call.args));
      } catch {
        // circular argument objects are ignored
      }
    }
  }
  return parts.join('\n');
}

/** Resolve `root` to an absolute real path when it exists. */
function realRootOf(root) {
  try {
    return fs.realpathSync(root);
  } catch {
    return null;
  }
}

/** True when `target` is strictly inside `root`. */
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Count the lines of a file body (`''` has zero lines). */
function countLines(content) {
  if (content === '') return 0;
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
}

/**
 * Resolve one extracted reference against a worktree root.
 *
 * @param {object} ref extracted reference (or `{ raw }` string form via `normalizeRef`)
 * @param {object} context
 * @param {string|null} context.root worktree root
 * @param {string|null} context.realRoot realpath of the root
 * @param {string} context.haystack concatenated tool-call argument text
 * @returns {object} resolved reference
 */
function resolveOneRef(ref, { root, realRoot, haystack, basenameIndex }) {
  const refPath = typeof ref.path === 'string' ? ref.path : '';
  const corroborated = refPath !== '' && haystack.includes(refPath);
  const base = {
    raw: ref.raw ?? `${ref.path}:${ref.startLine}${ref.endLine === null || ref.endLine === undefined ? '' : `-${ref.endLine}`}`,
    path: ref.path,
    startLine: ref.startLine,
    endLine: ref.endLine ?? null,
    exists: false,
    inBounds: false,
    resolved: false,
    corroborated,
    status: 'phantom',
    resolution: null,
    resolvedPath: null,
  };
  if (root === null || root === undefined || root === '') return { ...base, status: 'no-root' };

  if (refPath === '' || refPath.includes('\0')) return { ...base, status: 'unsafe', reason: 'invalid-path' };
  if (path.isAbsolute(refPath) || /^[A-Za-z]:[\\/]/.test(refPath)) {
    return { ...base, status: 'unsafe', reason: 'absolute' };
  }
  const normalizedRelative = path.normalize(refPath);
  if (normalizedRelative === '..' || normalizedRelative.startsWith(`..${path.sep}`)) {
    return { ...base, status: 'unsafe', reason: 'escape' };
  }
  let absolute = path.resolve(root, normalizedRelative);
  if (!isInside(path.resolve(root), absolute)) {
    return { ...base, status: 'unsafe', reason: 'escape' };
  }

  let stats = null;
  let targetRelative = normalizedRelative;
  let resolution = 'path';
  try {
    stats = fs.statSync(absolute);
  } catch {
    // A plan often cites `models.py:388` after first citing
    // `requests/models.py:388`; resolve a basename-only ref only when exactly
    // one file in the worktree has that basename. Multiple matches are
    // ambiguous, not phantom.
    if (!refPath.includes('/') && basenameIndex !== null) {
      const candidates = basenameIndex.get(refPath) ?? [];
      if (candidates.length === 0) return { ...base, status: 'phantom', reason: 'missing' };
      if (candidates.length > 1) {
        return { ...base, status: 'ambiguous', exists: true, candidates: [...candidates].sort() };
      }
      targetRelative = candidates[0];
      resolution = 'basename';
      absolute = path.resolve(root, targetRelative);
      try {
        stats = fs.statSync(absolute);
      } catch {
        return { ...base, status: 'phantom', reason: 'missing' };
      }
    } else {
      return { ...base, status: 'phantom', reason: 'missing' };
    }
  }
  if (!stats.isFile()) return { ...base, status: 'phantom', reason: 'not-a-file' };
  if (realRoot !== null) {
    try {
      const realTarget = fs.realpathSync(absolute);
      if (!isInside(realRoot, realTarget)) return { ...base, status: 'unsafe', reason: 'symlink-escape' };
    } catch {
      return { ...base, status: 'phantom', reason: 'missing' };
    }
  }

  let content;
  try {
    content = fs.readFileSync(absolute, 'utf8');
  } catch {
    return { ...base, status: 'phantom', reason: 'unreadable' };
  }
  const lineCount = countLines(content);
  const startLine = Number.isInteger(ref.startLine) ? ref.startLine : 0;
  const endLine = ref.endLine === null || ref.endLine === undefined ? null : Number(ref.endLine);
  const startOk = startLine >= 1 && startLine <= lineCount;
  const endOk = endLine === null || (Number.isInteger(endLine) && endLine >= startLine && endLine <= lineCount);
  const inBounds = startOk && endOk;
  return {
    ...base,
    exists: true,
    inBounds,
    resolved: inBounds,
    corroborated,
    status: inBounds ? 'resolved' : 'out-of-bounds',
    lineCount,
    resolution,
    resolvedPath: resolution === 'basename' ? targetRelative : null,
  };
}

/** Build a basename -> relative paths index, skipping metadata/package trees. */
function buildBasenameIndex(root) {
  const index = new Map();
  const walk = (dir, relative) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const childAbsolute = path.join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = fs.statSync(childAbsolute).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (isDirectory) {
        walk(childAbsolute, childRelative);
      } else {
        if (!index.has(entry.name)) index.set(entry.name, []);
        index.get(entry.name).push(childRelative);
      }
    }
  };
  walk(root, '');
  return index;
}

/**
 * Resolve a list of references against a worktree and summarize the result.
 *
 * @param {object} [input]
 * @param {Array<object|string>} [input.refs] refs from `extractPathRefs` (strings accepted)
 * @param {string|null} [input.root] task worktree root (`meta.worktree`)
 * @param {Array<object>} [input.toolCalls] sessionFacts tool calls for corroboration
 * @param {number} [input.textLength] plan length, used for citation density
 * @returns {{ refs: object[], stats: object }}
 */
export function resolvePathRefs({ refs = [], root = null, toolCalls = [], textLength = 0 } = {}) {
  const normalizedRoot = typeof root === 'string' && root !== '' ? path.resolve(root) : null;
  let realRoot = normalizedRoot === null ? null : realRootOf(normalizedRoot);
  if (normalizedRoot !== null && realRoot === null) realRoot = null;
  const rootUsable = normalizedRoot !== null && fs.existsSync(normalizedRoot);
  const haystack = toolArgumentHaystack(toolCalls);
  const needsBasename = rootUsable && (Array.isArray(refs) ? refs : []).some((ref) => {
    const value = typeof ref === 'string' ? normalizeRefString(ref) : ref;
    return value !== null && typeof value === 'object'
      && typeof value.path === 'string' && value.path !== '' && !value.path.includes('/');
  });
  const basenameIndex = needsBasename ? buildBasenameIndex(normalizedRoot) : null;
  const resolvedRefs = [];
  for (const rawRef of Array.isArray(refs) ? refs : []) {
    const ref = typeof rawRef === 'string' ? normalizeRefString(rawRef) : rawRef;
    if (ref === null || typeof ref !== 'object') continue;
    if (!rootUsable) {
      resolvedRefs.push({
        raw: ref.raw ?? '',
        path: ref.path ?? '',
        startLine: ref.startLine ?? 0,
        endLine: ref.endLine ?? null,
        exists: false,
        inBounds: false,
        resolved: false,
        corroborated: false,
        status: 'no-root',
      });
      continue;
    }
    resolvedRefs.push(resolveOneRef(ref, { root: normalizedRoot, realRoot, haystack, basenameIndex }));
  }

  const count = (status) => resolvedRefs.filter((ref) => ref.status === status).length;
  const total = resolvedRefs.length;
  const resolved = count('resolved');
  const outOfBounds = count('out-of-bounds');
  const phantom = count('phantom');
  const unsafe = count('unsafe');
  const noRoot = count('no-root');
  const ambiguous = count('ambiguous');
  const basenameResolved = resolvedRefs.filter((ref) => ref.resolution === 'basename').length;
  const corroborated = resolvedRefs.filter((ref) => ref.corroborated).length;
  const resolvedCorroborated = resolvedRefs.filter((ref) => ref.resolved && ref.corroborated).length;
  const uniqueKeys = new Set(resolvedRefs.map((ref) => `${ref.path}:${ref.startLine}-${ref.endLine ?? ''}`));
  const round = (value) => Math.round(value * 10000) / 10000;

  const stats = {
    total,
    unique: uniqueKeys.size,
    resolved,
    outOfBounds,
    phantom,
    unsafe,
    noRoot,
    ambiguous,
    basenameResolved,
    corroborated,
    resolvedCorroborated,
    resolutionRate: total === 0 ? null : round(resolved / total),
    corroborationRate: total === 0 ? null : round(corroborated / total),
    resolvedCorroborationRate: resolved === 0 ? null : round(resolvedCorroborated / resolved),
    outOfBoundsRate: total === 0 ? null : round(outOfBounds / total),
    phantomRate: total === 0 ? null : round(phantom / total),
    ambiguousRate: total === 0 ? null : round(ambiguous / total),
    density: typeof textLength === 'number' && textLength > 0 ? Math.round((total / (textLength / 1000)) * 100) / 100 : null,
    byStatus: {
      resolved,
      'out-of-bounds': outOfBounds,
      phantom,
      unsafe,
      ambiguous,
      'no-root': noRoot,
    },
  };

  return { refs: resolvedRefs, stats };
}

/** Parse a raw `path:line` string into the extracted-ref shape. */
function normalizeRefString(raw) {
  const match = /^(.*):(\d{1,6})(?:-(\d{1,6}))?$/.exec(String(raw));
  if (match === null) return { raw: String(raw), path: String(raw), startLine: 1, endLine: null };
  return {
    raw: String(raw),
    path: match[1],
    startLine: Number(match[2]),
    endLine: match[3] === undefined ? null : Number(match[3]),
    index: 0,
  };
}
