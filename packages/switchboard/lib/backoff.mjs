// Waiting helpers shared by every poller in the package.
//
// sleepSync blocks the thread without spinning (the store's busy retry and the
// kitty-ls lock wait use it). nextDelay is the one backoff curve: attempt 0 is
// the base, each later attempt multiplies it by `factor` up to `capMs`, and the
// result is spread by +/- `jitter` so pollers that started together drift
// apart instead of asking in step. Pure: pass `rand` to pin the jitter.
export const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export const nextDelay = (attempt, { baseMs, capMs, factor = 2, jitter = 0.2, rand = Math.random } = {}) => {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const raw = Math.min(capMs, baseMs * factor ** n);
  const spread = 1 + jitter * (2 * rand() - 1);
  return Math.max(0, Math.round(raw * spread));
};
