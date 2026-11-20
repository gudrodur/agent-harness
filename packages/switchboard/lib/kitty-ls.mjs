// The one `kitty @ ls` call. Every reader of the window list (the window
// resolver, the typing proof, agent-send's idle checks, and the shell scripts
// through lib/kitty-ls.sh and the CLI below) goes through `kittyList`.
//
// A full `ls` makes kitty walk /proc for every window it holds, so with many
// pollers on one kitty the requests queue on its socket and kitty stops
// answering at all. Three things bound that load, shared by every process of
// one user against one kitty instance:
//
//   cache    the last answer, `{startedAt, finishedAt, data}`, reused for
//            AGENT_KITTY_LS_TTL_MS (default 2000) by a read that allows it.
//            A `fresh` read only takes an answer whose call started after
//            the read was asked for. "Gone" is never served from the cache.
//   lock     an O_EXCL file holding `{pid, at}`: at most one full `ls` in
//            flight, and at most one narrow `ls` per window id (a fan-out to
//            many windows reads them side by side, not in one queue). A
//            holder that died, or one older than the timeout plus 2 s, is
//            moved aside to `.stale.<pid>`; a waiter still without an answer
//            after the timeout plus 1 s makes its own read, unlocked: a slow
//            kitty delays a read, it never fails it.
//   breaker  an `ls` that timed out opens it for 5 s, doubling per repeated
//            timeout, with +/-20% jitter, never past 60 s. While it is open no `ls`
//            is sent and the answer is `overloaded` with the time it closes:
//            a timed-out request is still processed by kitty, so only not
//            asking lowers its load. A success deletes it.
//
// Reads are narrow when the caller names a window (`match: 'id:N'`): kitty
// filters before it walks /proc, so the walk covers one window. kitty numbers
// tabs and windows in one space, so the result is always filtered again here
// against `.tabs[].windows[]`; a kitty that rejects `--match` gets the full
// read, filtered the same way, for the rest of the process.
//
// Every result has the `env` field of each window removed: no caller reads it
// and the cache must not keep it.
//
// The state lives in AGENT_KITTY_LS_DIR (default
// $XDG_RUNTIME_DIR/agent-switchboard/kitty-ls), keyed by the resolved kitty
// binary and the kitty instance (--to, else KITTY_LISTEN_ON with the socket's
// inode and change time, or with KITTY_PID for a socket that has no path,
// else the tty's KITTY_PID), so a restarted kitty never sees an older instance's windows or
// its breaker.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextDelay, sleepSync } from './backoff.mjs';

const KITTY_LS_TIMEOUT_MS = 5000;
const envNum = (name, dflt, { min = 0 } = {}) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min ? v : dflt;
};
// AGENT_KITTY_LS_TIMEOUT_MS shortens the bound (test seam: a hanging stub).
const timeoutMs = () => {
  const v = Number(process.env.AGENT_KITTY_LS_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : KITTY_LS_TIMEOUT_MS;
};
const ttlMs = () => envNum('AGENT_KITTY_LS_TTL_MS', 2000);
const breakerBaseMs = () => envNum('AGENT_KITTY_LS_BREAKER_BASE_MS', 5000, { min: 1 });
const breakerCapMs = () => envNum('AGENT_KITTY_LS_BREAKER_CAP_MS', 60_000, { min: 1 });
const LOCK_POLL_MS = 25;

export const kittyBin = () => process.env.AGENT_MAILBOX_KITTY ?? 'kitty';

export const stateDir = () => {
  if (process.env.AGENT_KITTY_LS_DIR) return process.env.AGENT_KITTY_LS_DIR;
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, 'agent-switchboard', 'kitty-ls');
  return path.join(os.tmpdir(), `agent-switchboard-${process.getuid?.() ?? 'user'}`, 'kitty-ls');
};

// The binary as the exec would find it, so two names for one stub share a key
// and two stubs never do.
const resolveBin = (bin) => {
  if (bin.includes('/')) return path.resolve(bin);
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return bin;
};

// A restarted kitty listens on the same path, so the path alone would hand it
// the dead instance's breaker. A socket kitty binds again is a new file: its
// inode and change time together tell it from the old one (the inode alone
// does not, a filesystem may hand the freed number straight back). An
// abstract or TCP socket has no file, and the kitty pid tells the instances
// apart instead.
const instanceOf = (to) => {
  if (to) return `to:${to}`;
  const listen = process.env.KITTY_LISTEN_ON;
  if (listen) {
    const sock = /^unix:([^@].*)$/.exec(listen)?.[1];
    if (sock) {
      try {
        const st = fs.statSync(sock, { bigint: true });
        return `listen:${listen}:ino:${st.ino}:ctime:${st.ctimeNs}`;
      } catch { /* unlinked: the path alone */ }
      return `listen:${listen}`;
    }
    return `listen:${listen}:pid:${process.env.KITTY_PID ?? ''}`;
  }
  return `tty:${process.env.KITTY_PID ?? ''}`;
};

export const cacheKey = ({ to = null, bin = kittyBin() } = {}) =>
  crypto.createHash('sha256').update(`${resolveBin(bin)}\0${instanceOf(to)}`).digest('hex').slice(0, 24);

// The files of one key, or null when the directory cannot be used (then every
// read goes straight to kitty, as before this module kept state).
const filesFor = (key) => {
  const dir = stateDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch { return null; }
  const base = path.join(dir, key);
  return {
    full: `${base}.json`,
    narrow: (id) => `${base}.w${id}.json`,
    lock: `${base}.lock`,
    narrowLock: (id) => `${base}.w${id}.lock`,
    breaker: `${base}.breaker.json`,
  };
};

// kitty's created_at is nanoseconds since the epoch, past 2^53: a plain
// JSON.parse rounds it, and a window-identity record written from kitty's own
// output (pid plus created_at) would no longer match. An integer a double
// cannot hold is kept as its exact text, which JSON.stringify writes back
// unchanged. Nothing in node reads created_at as a number.
const keepExact = (key, value, ctx) => (
  typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(ctx?.source ?? '') && typeof JSON.rawJSON === 'function'
    ? JSON.rawJSON(ctx.source)
    : value
);
const parseExact = (text) => JSON.parse(text, keepExact);
const readJson = (p) => { try { return parseExact(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const writeAtomic = (p, obj) => {
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
};
const unlinkQuiet = (p) => { try { fs.unlinkSync(p); } catch { /* gone */ } };

// --- the shape of an answer ---------------------------------------------------

const stripEnv = (ls) => ls.map((osw) => ({
  ...osw,
  tabs: (osw?.tabs ?? []).map((tab) => ({
    ...tab,
    windows: (tab?.windows ?? []).map((w) => {
      if (w == null || typeof w !== 'object') return w;
      const { env: _env, ...rest } = w;
      return rest;
    }),
  })),
}));

// Only the window with this id, under its own tab and OS window; empty tabs and
// OS windows are dropped, so `[]` means the window is not there.
const filterId = (ls, id) => ls
  .map((osw) => ({ ...osw, tabs: (osw.tabs ?? []).map((tab) => ({ ...tab, windows: (tab.windows ?? []).filter((w) => w?.id === id) })).filter((tab) => tab.windows.length > 0) }))
  .filter((osw) => osw.tabs.length > 0);

const parseId = (match) => {
  const m = /^id:(\d+)$/.exec(String(match ?? ''));
  return m ? Number(m[1]) : null;
};

// Every window of the list, flattened.
export const flattenWindows = (ls) => (ls ?? []).flatMap((t) => (t.tabs ?? []).flatMap((tab) => tab.windows ?? []));

// --- the real call --------------------------------------------------------------

const OPTION_REJECTED = /unknown option|unrecognized option|no such option|not a valid|invalid match|unknown field/i;
const NO_MATCH = /No matching windows/i;
const firstLine = (s) => String(s ?? '').trim().split('\n').find((l) => l.trim() !== '')?.trim() ?? '';

// Set when this kitty rejected `ls --match`: later reads in this process go
// full and are filtered here.
let matchRejected = false;

const callKitty = (bin, args, timeout) => {
  const r = spawnSync(bin, args, { encoding: 'utf-8', timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') return { kind: 'timeout' };
    if (r.error.code === 'ENOENT') return { kind: 'no-kitty', detail: `${bin} not found` };
    return { kind: 'unreachable', detail: r.error.message };
  }
  if (r.status !== 0) {
    const said = `${r.stderr ?? ''}\n${r.stdout ?? ''}`;
    return { kind: 'failed', said, detail: firstLine(r.stderr) || firstLine(r.stdout) || (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`) };
  }
  let parsed;
  try { parsed = parseExact(r.stdout); } catch { parsed = undefined; }
  // Anything but an array (an error object, text) is not an answer to `ls`.
  if (!Array.isArray(parsed)) return { kind: 'bad-output', detail: `not a JSON array: ${firstLine(r.stdout).slice(0, 120) || '<empty>'}` };
  return { kind: 'ok', data: parsed };
};

// --- breaker ---------------------------------------------------------------------

const openBreaker = (files, now = Date.now()) => {
  if (!files) return null;
  const b = readJson(files.breaker);
  return b && Number(b.until) > now ? b : null;
};
const tripBreaker = (files, reason) => {
  const now = Date.now();
  const cap = breakerCapMs();
  const prev = files ? readJson(files.breaker) : null;
  const failures = prev && Number.isFinite(Number(prev.failures)) && now - Number(prev.until) <= cap ? Number(prev.failures) + 1 : 1;
  const until = now + nextDelay(failures - 1, { baseMs: breakerBaseMs(), capMs: cap });
  const b = { openedAt: now, until, failures, reason };
  if (files) writeAtomic(files.breaker, b);
  return b;
};

// --- lock --------------------------------------------------------------------------

const tryLock = (lock) => {
  const me = { pid: process.pid, at: Date.now() };
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) {
    if (e.code === 'EEXIST') return null;
    return { ...me, unlocked: true }; // cannot lock here at all: go without one
  }
  try { fs.writeSync(fd, JSON.stringify(me)); } finally { fs.closeSync(fd); }
  return me;
};
const unlock = (lock, me) => {
  if (!me || me.unlocked) return;
  const cur = readJson(lock);
  if (cur && cur.pid === me.pid && cur.at === me.at) unlinkQuiet(lock);
};
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
// Move a dead or overdue holder's lock aside. Whoever wins the rename may take
// the lock next; a rename that moved a lock other than the one judged orphaned
// (it was retaken in between) is put back.
const breakOrphan = (lock, timeout) => {
  let st;
  try { st = fs.statSync(lock); } catch { return true; }
  const held = readJson(lock);
  const at = Number.isFinite(Number(held?.at)) ? Number(held.at) : st.mtimeMs;
  const dead = Number.isInteger(held?.pid) && held.pid !== process.pid && !pidAlive(held.pid);
  if (!dead && Date.now() - at <= timeout + 2000) return false;
  const stale = `${lock}.stale.${process.pid}`;
  try { fs.renameSync(lock, stale); } catch { return true; }
  const moved = readJson(stale);
  if (held && moved && (moved.pid !== held.pid || moved.at !== held.at)) {
    try { fs.linkSync(stale, lock); } catch { /* a new holder already */ }
  }
  unlinkQuiet(stale);
  return true;
};

// --- cache -------------------------------------------------------------------------

const usable = (entry, { fresh, requestedAt, ttl, now }) =>
  entry && Array.isArray(entry.data) && Number.isFinite(entry.startedAt)
  && now - entry.startedAt < ttl
  && (!fresh || entry.startedAt >= requestedAt);

const fromCache = (files, { id, fresh, requestedAt, ttl }) => {
  if (!files || ttl <= 0) return null;
  const now = Date.now();
  const full = readJson(files.full);
  if (usable(full, { fresh, requestedAt, ttl, now })) {
    if (id == null) return full.data;
    const hit = filterId(full.data, id);
    if (hit.length > 0) return hit;
  }
  if (id == null) return null;
  const narrow = readJson(files.narrow(id));
  if (usable(narrow, { fresh, requestedAt, ttl, now }) && narrow.data.length > 0) return narrow.data;
  return null;
};

// --- the read ----------------------------------------------------------------------

const DOWN = new Set(['timeout', 'overloaded', 'unreachable', 'bad-output']);
// The latest read's outcome in this process: null before any read.
let last = null;

const overloaded = (b) => ({
  ok: false, reason: 'overloaded', retryAt: Number(b.until), openedAt: Number(b.openedAt),
  detail: `an ls timed out at ${new Date(Number(b.openedAt)).toISOString()}`,
});

const realRead = (files, { bin, to, id, match, timeout }) => {
  const narrowArgs = id != null ? (matchRejected ? [] : ['--match', `id:${id}`]) : match ? ['--match', match] : [];
  const args = ['@', ...(to ? ['--to', to] : []), 'ls', ...narrowArgs];
  const startedAt = Date.now();
  const r = callKitty(bin, args, timeout);
  if (r.kind === 'failed' && narrowArgs.length > 0 && NO_MATCH.test(r.said)) {
    // The window is gone: no cached answer may still show it.
    if (files) { unlinkQuiet(files.breaker); unlinkQuiet(files.full); }
    if (files && id != null) unlinkQuiet(files.narrow(id));
    return { ok: true, data: [] };
  }
  if (r.kind === 'failed' && narrowArgs.length > 0 && OPTION_REJECTED.test(r.said)) {
    matchRejected = true;
    return realRead(files, { bin, to, id, match: null, timeout });
  }
  if (r.kind === 'ok') {
    const finishedAt = Date.now();
    let data = stripEnv(r.data);
    if (files) {
      unlinkQuiet(files.breaker);
      if (narrowArgs.length === 0) writeAtomic(files.full, { startedAt, finishedAt, data });
    }
    if (id != null) {
      data = filterId(data, id);
      if (files && narrowArgs.length > 0) {
        if (data.length > 0) writeAtomic(files.narrow(id), { startedAt, finishedAt, data });
        else unlinkQuiet(files.narrow(id));
      }
    }
    return { ok: true, data };
  }
  if (r.kind === 'timeout') {
    const b = tripBreaker(files, `an ls timed out after ${timeout} ms`);
    return { ...overloaded(b), reason: 'timeout' };
  }
  if (r.kind === 'failed') return { ok: false, reason: 'unreachable', detail: r.detail };
  return { ok: false, reason: r.kind, detail: r.detail };
};

const remember = (r) => { last = r; return r; };

// { ok: true, data } or { ok: false, reason, retryAt?, detail? }, with reason
// one of overloaded (the breaker is open), timeout (this read opened it),
// unreachable, no-kitty, bad-output.
// `data: []` from a narrow read means the window is gone.
export const kittyList = ({ match = null, fresh = false, to = null, maxAgeMs } = {}) => {
  const requestedAt = Date.now();
  const timeout = timeoutMs();
  const ttl = maxAgeMs ?? ttlMs();
  const bin = kittyBin();
  const id = parseId(match);
  const files = filesFor(cacheKey({ to, bin }));
  const deadline = requestedAt + timeout + 1000;
  const opts = { bin, to, id, match, timeout };
  const lockFor = () => (files && id != null && !matchRejected ? files.narrowLock(id) : files?.lock);
  for (;;) {
    const hit = fromCache(files, { id, fresh, requestedAt, ttl });
    if (hit) return remember({ ok: true, data: hit, cached: true });
    const b = openBreaker(files);
    if (b) return remember(overloaded(b));
    if (!files) return remember(realRead(null, opts));
    const lock = lockFor();
    const me = tryLock(lock);
    if (me) {
      try {
        const again = fromCache(files, { id, fresh, requestedAt, ttl });
        if (again) return remember({ ok: true, data: again, cached: true });
        const b2 = openBreaker(files);
        if (b2) return remember(overloaded(b2));
        return remember(realRead(files, opts));
      } finally { unlock(lock, me); }
    }
    if (breakOrphan(lock, timeout)) continue;
    // The holder is alive and kitty is slow: ask it ourselves rather than
    // fail a send that only had to wait.
    if (Date.now() >= deadline) return remember(realRead(files, opts));
    sleepSync(nextDelay(0, { baseMs: LOCK_POLL_MS, capMs: LOCK_POLL_MS, jitter: 0.4 }));
  }
};

// Is kitty remote control up? Any fresh cached answer says so; otherwise one
// narrow read (this window, or the active one). Any answer from kitty counts,
// "no such window" and output that is not a list included: the caller asked
// whether kitty answers, not what it holds.
export const kittyProbe = ({ to = null } = {}) => {
  const files = filesFor(cacheKey({ to }));
  const ttl = ttlMs();
  if (files && ttl > 0) {
    const full = readJson(files.full);
    if (usable(full, { fresh: false, requestedAt: 0, ttl, now: Date.now() })) return remember({ ok: true, data: full.data, cached: true });
  }
  const own = /^\d+$/.test(process.env.KITTY_WINDOW_ID ?? '') ? `id:${process.env.KITTY_WINDOW_ID}` : 'recent:0';
  const r = kittyList({ match: own, to });
  if (!r.ok && r.reason === 'bad-output') return remember({ ok: true, data: [] });
  return r;
};

// The parsed list, or null when remote control did not answer.
export const kittyLs = (opts = {}) => {
  const r = kittyList(opts);
  return r.ok ? r.data : null;
};

// True after a read that failed for a reason other than a missing binary (a
// mailbox-only setup has no remote control to wait for), and while the
// breaker is open. The latest read wins: a kitty that recovered is up.
export const kittyKnownDown = () => {
  if (last && DOWN.has(last.reason)) return true;
  if (last?.ok) return false;
  const files = filesFor(cacheKey());
  return openBreaker(files) != null;
};

const iso = (ms) => new Date(ms).toISOString();
export const overloadMessage = (r) =>
  `kitty remote control is overloaded (${r.detail ?? 'an ls timed out'}); backing off until ${iso(r.retryAt)}, not asking again before then`;

// One line for a refusal or a hint, naming why kitty did not answer.
export const kittyDownMessage = (r = last) => {
  if (!r || r.ok) return 'kitty remote control answered';
  if (r.reason === 'overloaded' || r.reason === 'timeout') return overloadMessage(r);
  if (r.reason === 'no-kitty') return `kitty is not installed here (${r.detail})`;
  return `kitty remote control is not answering (${r.reason}${r.detail ? `: ${r.detail}` : ''})`;
};

// CLI, run by lib/kitty-ls.sh: `kitty-ls.mjs [--match id:N] [--fresh]
// [--probe] [--to S]`. Exit 0 with the JSON on stdout (`[]` from a narrow
// read: the window is gone) and nothing on stderr; 2 when kitty did not
// answer; 75 while the breaker is open. A failure prints its message, then
// `reason=`, `retry_in_ms=` and `detail=` lines, on stderr and on stdout:
// lib/kitty-ls.sh reads stdout alone, so a node warning on stderr never
// lands in what it parses.
if (process.argv[1] != null && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? null : null);
  const known = new Set(['--match', '--fresh', '--probe', '--to']);
  const bad = argv.filter((a, i) => a.startsWith('--') && !known.has(a) && !['--match', '--to'].includes(argv[i - 1]));
  if (bad.length > 0) {
    process.stderr.write('usage: kitty-ls.mjs [--match id:N] [--fresh] [--probe] [--to S]\n');
    process.exit(64);
  }
  const to = opt('--to');
  const r = argv.includes('--probe') ? kittyProbe({ to }) : kittyList({ match: opt('--match'), fresh: argv.includes('--fresh'), to });
  if (r.ok) {
    process.stdout.write(`${JSON.stringify(r.data)}\n`);
    process.exit(0);
  }
  const retryIn = Number.isFinite(r.retryAt) ? Math.max(0, r.retryAt - Date.now()) : 0;
  const report = `${kittyDownMessage(r)}\nreason=${r.reason}\nretry_in_ms=${retryIn}\ndetail=${String(r.detail ?? '').replace(/\n/g, ' ')}\n`;
  process.stderr.write(report);
  process.stdout.write(report);
  process.exit(r.reason === 'overloaded' || r.reason === 'timeout' ? 75 : 2);
}
