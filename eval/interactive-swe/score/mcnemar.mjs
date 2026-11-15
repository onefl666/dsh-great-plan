/**
 * Exact McNemar test for paired binary outcomes.
 *
 * `b` is the number of pairs where the treatment passes and the baseline fails;
 * `c` is the reverse. Under the null hypothesis `b` and `c` are equally likely,
 * so the exact two-sided p-value is `2 * P(X <= min(b, c))` with
 * `X ~ Binomial(b + c, 0.5)`, capped at 1. Small samples are evaluated with a
 * stable binomial-pmf recurrence (the dyadic probabilities of small samples are
 * represented exactly); very large samples are evaluated in log space so
 * `2 ** n` never has to be represented.
 *
 * @see https://en.wikipedia.org/wiki/McNemar%27s_test
 */

/** Lanczos log-gamma approximation, used only for very large samples. */
function logGamma(value) {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let x = value;
  let y = value;
  let total = x + 5.5;
  total -= (x + 0.5) * Math.log(total);
  let series = 1.000000000190015;
  for (const coefficient of coefficients) {
    y += 1;
    series += coefficient / y;
  }
  return -total + Math.log((2.5066282746310005 * series) / x);
}

/** log(C(n, k)) */
function logBinomial(n, k) {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Lower-tail probability P(X <= m) for X ~ Binomial(n, 0.5), n small. */
function lowerTailExact(n, m) {
  let pmf = 2 ** -n;
  let total = pmf;
  for (let k = 1; k <= m; k += 1) {
    pmf *= (n - k + 1) / k;
    total += pmf;
  }
  return Math.min(1, total);
}

/** Log-space lower-tail probability for large n. */
function lowerTailLog(n, m) {
  const logTwo = Math.log(2);
  let total = 0;
  for (let k = 0; k <= m; k += 1) {
    total += Math.exp(logBinomial(n, k) - n * logTwo);
  }
  return Math.min(1, total);
}

/**
 * Exact two-sided McNemar p-value.
 *
 * @param {number} b pairs where the treatment passes and the baseline fails
 * @param {number} c pairs where the treatment fails and the baseline passes
 * @returns {{ b: number, c: number, p: number }} exact two-sided p
 * @throws {TypeError} when b or c is not a non-negative integer
 */
export function mcnemar(b, c) {
  if (!Number.isInteger(b) || b < 0) throw new TypeError(`b must be a non-negative integer: ${String(b)}`);
  if (!Number.isInteger(c) || c < 0) throw new TypeError(`c must be a non-negative integer: ${String(c)}`);
  const n = b + c;
  if (n === 0) return { b, c, p: 1 };
  const m = Math.min(b, c);
  const tail = n <= 1000 ? lowerTailExact(n, m) : lowerTailLog(n, m);
  return { b, c, p: Math.min(1, 2 * tail) };
}
