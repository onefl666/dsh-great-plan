/**
 * Delegation statistics.
 *
 * The plugin's guidance asks the planner to spawn at least two parallel
 * exploration teammates and one separate planning teammate. This module counts
 * `spawn_teammate` calls, recovers teammate names from the call arguments,
 * groups calls that share a `(turn, step)` (same model step), and applies a
 * keyword heuristic for the planning teammate. It reads only recorded facts;
 * no model or network is involved.
 */
import { SPAWN_TOOL } from '../session/events.mjs';

/** Keywords that identify a planning/drafting teammate in its name or prompt. */
export const PLANNING_HINTS = /\b(plan|planning|planner|draft|candidate|synthesis|synthesi[sz]e|consolidat\w*)\b/i;

/** Round to four decimals for stable report output. */
function round(value) {
  return Math.round(value * 10000) / 10000;
}

/** Read the first string field among a list of candidate argument names. */
function pickString(args, keys) {
  if (args === null || typeof args !== 'object') return null;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** The teammate name carried by spawn arguments, when present. */
function teammateName(args) {
  const direct = pickString(args, ['name', 'agentName', 'teammate', 'teammateName', 'memberName', 'id']);
  if (direct !== null) return direct;
  if (args !== null && typeof args === 'object' && args.agent !== null && typeof args.agent === 'object') {
    return pickString(args.agent, ['name', 'id']);
  }
  return null;
}

/** The free text that describes what a spawned teammate was asked to do. */
function teammateBrief(args) {
  if (args === null || typeof args !== 'object') return '';
  const parts = [];
  for (const key of ['prompt', 'instructions', 'task', 'description', 'scope', 'goal', 'role', 'title']) {
    if (typeof args[key] === 'string') parts.push(args[key]);
  }
  return parts.join(' ');
}

/**
 * Compute delegation metrics for one task.
 *
 * @param {object} [input]
 * @param {object|null} [input.session] sessionFacts
 * @returns {object} delegation stats
 */
export function delegationStats({ session = null } = {}) {
  const toolCalls =
    session !== null && typeof session === 'object' && Array.isArray(session.toolCalls) ? session.toolCalls : [];
  const spawnCalls = toolCalls.filter(
    (call) => call !== null && typeof call === 'object' && call.name === SPAWN_TOOL,
  );

  const names = [];
  const groups = new Map();
  const planningCandidates = [];
  let namedCalls = 0;
  let planningTeammates = 0;

  for (const call of spawnCalls) {
    const args = call.args !== null && typeof call.args === 'object' ? call.args : null;
    const name = teammateName(args);
    if (name !== null) {
      namedCalls += 1;
      if (!names.includes(name)) names.push(name);
    }
    const turn = call.turn ?? null;
    const step = call.step ?? null;
    const key = `${turn ?? '?'}:${step ?? '?'}`;
    const group = groups.get(key) ?? { turn, step, count: 0, names: [] };
    group.count += 1;
    if (name !== null) group.names.push(name);
    groups.set(key, group);

    const haystack = [name ?? '', teammateBrief(args)].join(' ');
    if (PLANNING_HINTS.test(haystack)) {
      planningTeammates += 1;
      planningCandidates.push(name);
    }
  }

  const groupList = [...groups.values()];
  const parallelGroups = groupList.filter((group) => group.count >= 2);
  const maxParallel = groupList.reduce((max, group) => Math.max(max, group.count), 0);
  const callsInParallel = parallelGroups.reduce((sum, group) => sum + group.count, 0);
  const teamMembers = session !== null && Array.isArray(session.teamMembers) ? session.teamMembers.length : 0;
  const teamTasks = session !== null && Array.isArray(session.teamTasks) ? session.teamTasks.length : 0;

  return {
    spawnCalls: spawnCalls.length,
    namedCalls,
    unnamedCalls: spawnCalls.length - namedCalls,
    uniqueNames: names,
    uniqueNameCount: names.length,
    groups: groupList,
    parallelGroups: parallelGroups.length,
    maxParallel,
    callsInParallel,
    parallelSpawnRatio: spawnCalls.length === 0 ? null : round(callsInParallel / spawnCalls.length),
    planningTeammates,
    planningCandidates,
    teamMembers,
    teamTasks,
    teamEvents: teamMembers + teamTasks,
    anyDelegation: spawnCalls.length > 0,
  };
}
