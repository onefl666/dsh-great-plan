/**
 * Offline stand-in for the DSH-supplied `@deepseek-ai/dsh-compaction` package.
 *
 * `lib/host/apply.js` imports only `toolPairingBalancedAfter` from this package,
 * lazily, when the `/great-plan-compact` handler runs. `host-entry.test.js` maps
 * that bare specifier here so the real command handler can be exercised offline.
 *
 * Only seq 30 is balanced, matching the smoke's history:
 * system(10), user(20), tool-result(30), pending plan review(50), so the
 * selected compaction range is [20, 30].
 */
export function toolPairingBalancedAfter(_session, seq) {
  return seq === 30;
}
