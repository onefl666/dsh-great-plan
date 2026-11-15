/**
 * Seeded, deterministic bootstrap confidence intervals.
 *
 * Resampling uses mulberry32 over an explicit seed, so the same input and seed
 * always produce byte-identical bounds. This keeps report artifacts
 * reproducible without any external RNG dependency.
 */

/**
 * mulberry32 PRNG.
 *
 * @param {number} seed 32-bit unsigned seed
 * @returns {() => number} values in [0, 1)
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Linear-interpolated percentile of an ascending array.
 *
 * @param {number[]} sorted ascending values
 * @param {number} probability 0..1
 * @returns {number}
 */
export function percentile(sorted, probability) {
  if (!Array.isArray(sorted) || sorted.length === 0) return NaN;
  const clamped = Math.min(1, Math.max(0, probability));
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * clamped;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/** Mean of a numeric array (NaN for an empty array). */
function mean(values) {
  if (values.length === 0) return NaN;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Percentile bootstrap CI for a mean.
 *
 * @param {number[]} values sample
 * @param {object} [options]
 * @param {number} [options.seed=12345] PRNG seed
 * @param {number} [options.iterations=1000] resample count
 * @param {number} [options.confidence=0.95] two-sided confidence level
 * @returns {{ mean: number|null, low: number|null, high: number|null, n: number, iterations: number, seed: number, confidence: number }}
 */
export function bootstrapMeanCI(values, { seed = 12345, iterations = 1000, confidence = 0.95 } = {}) {
  const clean = (Array.isArray(values) ? values : []).filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
  const options = {
    seed: Number.isInteger(seed) ? seed >>> 0 : 12345,
    iterations: Number.isInteger(iterations) && iterations > 0 ? Math.min(iterations, 100000) : 0,
    confidence: typeof confidence === 'number' && confidence > 0 && confidence < 1 ? confidence : 0.95,
  };
  if (clean.length === 0) {
    return { mean: null, low: null, high: null, n: 0, iterations: 0, seed: options.seed, confidence: options.confidence };
  }
  const observedMean = mean(clean);
  if (clean.length === 1 || options.iterations === 0) {
    return {
      mean: observedMean,
      low: observedMean,
      high: observedMean,
      n: clean.length,
      iterations: 0,
      seed: options.seed,
      confidence: options.confidence,
    };
  }
  const rng = mulberry32(options.seed);
  const resampled = new Array(options.iterations);
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < clean.length; index += 1) {
      total += clean[Math.floor(rng() * clean.length)];
    }
    resampled[iteration] = total / clean.length;
  }
  resampled.sort((left, right) => left - right);
  const alpha = (1 - options.confidence) / 2;
  return {
    mean: observedMean,
    low: percentile(resampled, alpha),
    high: percentile(resampled, 1 - alpha),
    n: clean.length,
    iterations: options.iterations,
    seed: options.seed,
    confidence: options.confidence,
  };
}
