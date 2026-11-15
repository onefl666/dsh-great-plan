/** Current time as an ISO string. */
export function nowIso() {
  return new Date().toISOString();
}

/** Sleep for a number of milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
