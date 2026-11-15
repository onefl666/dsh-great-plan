/**
 * Plan quality heuristics.
 *
 * These checks are deliberately mechanical: headings and keyword markers only,
 * no model. They measure whether a plan carries a background/evidence/handoff
 * structure (the plugin's guidance asks for exactly that) and whether it marks
 * assumptions, open questions, and unverified points instead of presenting
 * guesses as facts.
 */
import { extractPathRefs } from './paths.mjs';

/** Section/keyword definitions for the handoff structure. */
const HANDOFF_MARKERS = {
  background: /\bbackground\b/i,
  evidence: /\bevidence\b/i,
  handoff: /\bhand\s?off\b/i,
  nextSteps: /\bnext steps?\b|\bwhat to do next\b|\bexecution steps?\b/i,
  settled: /\bsettled\b|\bmust not be re-investigated\b|\bdo not re-investigate\b/i,
  executor: /\bexecutor\b/i,
  verification: /\bverify first\b|\bto verify\b|\bverification\b/i,
};

/** Keyword definitions for assumption markers. */
const ASSUMPTION_MARKERS = [
  { kind: 'assume', pattern: /\bassum(?:e|ed|es|ption|ptions)\b/gi },
  { kind: 'unverified', pattern: /\bunverified\b|\bnot verified\b/gi },
  { kind: 'open-question', pattern: /\bopen questions?\b|\bopen issue\b/gi },
  { kind: 'unknown', pattern: /\bunknowns?\b|\bunknown yet\b/gi },
  { kind: 'todo', pattern: /\bTBD\b|\bto be determined\b/g },
  { kind: 'guess', pattern: /\bguess(?:ed|es)?\b|\bhypothes[ie]s\b/gi },
  { kind: 'verify-first', pattern: /\bverify first\b|\bto verify\b/gi },
];

/** Round to four decimals for stable report output. */
function round(value) {
  return Math.round(value * 10000) / 10000;
}

/** Headings from a Markdown body (ATX and bold-only lines). */
function markdownHeadings(text) {
  const headings = [];
  for (const line of text.split('\n')) {
    const atx = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (atx !== null) {
      headings.push(atx[1].trim());
      continue;
    }
    const bold = /^\s{0,3}\*\*([^*].*?)\*\*\s*:?\s*$/.exec(line);
    if (bold !== null) headings.push(bold[1].trim());
  }
  return headings;
}

/**
 * Handoff structure metrics for a plan.
 *
 * @param {unknown} text plan text
 * @returns {object} `{ hasBackground, hasEvidence, hasHandoff, hasNextSteps, ... }`
 */
export function handoffStats(text) {
  const body = typeof text === 'string' ? text : '';
  const headings = markdownHeadings(body);
  const headingText = headings.join('\n');
  const markers = {};
  for (const [key, pattern] of Object.entries(HANDOFF_MARKERS)) {
    markers[key] = pattern.test(body) || pattern.test(headingText);
  }
  const citationCount = extractPathRefs(body).length;
  const present = [markers.background, markers.evidence, markers.handoff].filter(Boolean).length;
  return {
    hasBackground: markers.background,
    hasEvidence: markers.evidence,
    hasHandoff: markers.handoff,
    hasNextSteps: markers.nextSteps,
    hasSettled: markers.settled,
    hasExecutor: markers.executor,
    hasVerification: markers.verification,
    headings,
    citationCount,
    sectionsPresent: present,
    score: round(present / 3),
  };
}

/**
 * Assumption / unverified-point metrics for a plan.
 *
 * @param {unknown} text plan text
 * @returns {object} `{ count, hasAssumptions, hasOpenQuestions, ... }`
 */
export function assumptionStats(text) {
  const body = typeof text === 'string' ? text : '';
  const headings = markdownHeadings(body);
  const matches = [];
  const byKind = {};
  for (const marker of ASSUMPTION_MARKERS) {
    const found = [...body.matchAll(marker.pattern)];
    if (found.length === 0) continue;
    byKind[marker.kind] = found.length;
    for (const match of found) {
      matches.push({
        kind: marker.kind,
        text: match[0],
        index: match.index ?? 0,
      });
    }
  }
  const assumptionHeading = headings.some((heading) => /\bassumptions?\b/i.test(heading));
  const openQuestionHeading = headings.some((heading) => /\bopen questions?\b/i.test(heading));
  const unverifiedHeading = headings.some((heading) => /\bunverified\b|\bunknown\b/i.test(heading));
  return {
    count: matches.length,
    byKind,
    markers: matches,
    headings,
    hasAssumptions: assumptionHeading || (byKind.assume ?? 0) > 0,
    hasOpenQuestions: openQuestionHeading || (byKind['open-question'] ?? 0) > 0,
    hasUnverified: unverifiedHeading || (byKind.unverified ?? 0) > 0,
    hasUnknowns: (byKind.unknown ?? 0) > 0 || unverifiedHeading,
    score: round(Math.min(1, matches.length / 3)),
  };
}

/**
 * Both quality families in one object, used by `scoreTask`.
 *
 * @param {unknown} text plan text
 * @returns {{ handoff: object, assumptions: object }}
 */
export function qualityStats(text) {
  return {
    handoff: handoffStats(text),
    assumptions: assumptionStats(text),
  };
}
