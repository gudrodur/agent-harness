// Presence beacons: which agent sessions recently took a turn, and where.
//
// One JSON file `{beacons: [...]}` keyed by (session id, cwd), so two sessions
// sharing one working directory stay visible as two beacons. A UserPromptSubmit
// hook refreshes one entry per session on every turn. A row is fresh for
// PRESENCE_STALE_MS; past that it is parked (idle) only with proof that its
// host process still exists, up to PRESENCE_IDLE_MAX_MS, or, for a row written
// before host identities with no pid, while its window runs an agent (the
// reader checks that). A row whose host is gone reads as absent and the next
// write deletes it. Advisory only: every write is best-effort and every reader
// treats a missing file as "nobody here".
//
// Store root: AGENT_SWITCHBOARD_DIR (default
// `${XDG_STATE_HOME:-$HOME/.local/state}/agent-switchboard`). Presence lives
// at $AGENT_SWITCHBOARD_DIR/presence.json unless AGENT_SWITCHBOARD_PRESENCE_FILE
// overrides it. The mailbox keeps its own overrides (AGENT_SWITCHBOARD_MAILBOX_DIR
// / AGENT_MAILBOX_DIR); see lib/agent-mailbox.mjs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withRetriedStore } from './store.mjs';

export const switchboardDir = () =>
  process.env.AGENT_SWITCHBOARD_DIR ??
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'agent-switchboard');

export const PRESENCE_FILE =
  process.env.AGENT_SWITCHBOARD_PRESENCE_FILE ?? path.join(switchboardDir(), 'presence.json');

// A beacon outlives a single tool call but not a parked afternoon: 20 minutes.
// The mailbox prune imports this; do not restate the number.
export const PRESENCE_STALE_MS = 20 * 60 * 1000;

// An idle seat keeps its beacon past the TTL so it stays addressable: the
// writer prunes only a beacon whose host is gone or that is older than this.
export const PRESENCE_IDLE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const readPresenceFile = (file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && Array.isArray(parsed.beacons) ? parsed : { beacons: [] };
  } catch {
    return { beacons: [] };
  }
};

// ---- Process identity ------------------------------------------------------
//
// A pid alone proves nothing: the kernel reuses numbers, and a pid recorded for
// "the server that drains this session" says nothing about the process that
// hosts the session. A row therefore carries a host identity, (boot id, pid,
// start time), written by the process that knows its host. The start time is
// field 22 of /proc/<pid>/stat and the boot id is the kernel's random boot
// uuid, so the triple names one process on one boot and nothing else.

export const AGENT_COMM_NAMES = ['claude', 'pi', 'opencode'];

// AGENT_MAILBOX_PROC_DIR replaces /proc (tests only).
export const defaultProcDir = () => process.env.AGENT_MAILBOX_PROC_DIR ?? '/proc';

// Three-way read: a pid that is gone is evidence ("gone"); a /proc that cannot
// be read or parsed is not ("unreadable").
const readStat = (pid, procDir) => {
  let text;
  try {
    text = fs.readFileSync(path.join(procDir, String(pid), 'stat'), 'utf8');
  } catch (e) {
    return { status: e?.code === 'ENOENT' || e?.code === 'ESRCH' ? 'gone' : 'unreadable' };
  }
  // The command name sits in parentheses and may hold spaces or ')', so the
  // fields are read after the LAST ')'.
  const close = text.lastIndexOf(')');
  const open = text.indexOf('(');
  const fields = close < 0 ? [] : text.slice(close + 2).trim().split(' ');
  const ppid = Number(fields[1]);
  const start = Number(fields[19]);
  if (open < 0 || !Number.isInteger(ppid) || !Number.isSafeInteger(start)) return { status: 'unreadable' };
  return { status: 'ok', ppid, comm: text.slice(open + 1, close), start };
};

// {ppid, comm, start} for a live pid, else null.
export const procStat = (pid, { procDir = defaultProcDir() } = {}) => {
  const r = readStat(pid, procDir);
  return r.status === 'ok' ? { ppid: r.ppid, comm: r.comm, start: r.start } : null;
};

export const currentBootId = ({ procDir = defaultProcDir() } = {}) => {
  try {
    return fs.readFileSync(path.join(procDir, 'sys', 'kernel', 'random', 'boot_id'), 'utf8').trim() || null;
  } catch {
    return null;
  }
};

// {bootId, pid, start} for a live pid, else null.
export const procIdentity = (pid, { procDir = defaultProcDir() } = {}) => {
  const st = procStat(pid, { procDir });
  const bootId = currentBootId({ procDir });
  return st && bootId ? { bootId, pid: Number(pid), start: st.start } : null;
};

// One probe per read: the boot id and every pid's stat are read once, however
// many rows name them.
export const createProbe = ({ procDir = defaultProcDir() } = {}) => {
  let boot;
  const stats = new Map();
  return {
    procDir,
    bootId: () => (boot === undefined ? (boot = currentBootId({ procDir })) : boot),
    stat: (pid) => {
      if (!stats.has(pid)) stats.set(pid, readStat(pid, procDir));
      return stats.get(pid);
    },
  };
};

const argvOf = (pid, procDir) => {
  try {
    return fs.readFileSync(path.join(procDir, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
};

// The interactive host of a process: the first ancestor (the process itself
// included) whose command name is an agent and that is not a server. A
// server's argv carries `serve`; one whose argv cannot be read is skipped
// too, since taking a server for a host is the mistake this identity exists
// to prevent. Null when no ancestor qualifies: no host is better than a wrong one.
// `accept({pid, comm, start})` may refuse the first qualifying ancestor; the
// walk then ends with no host rather than climbing to a process further up,
// which would be some other session's.
export const findHostAncestor = ({ from = process.pid, procDir = defaultProcDir(), names = AGENT_COMM_NAMES, accept = () => true } = {}) => {
  let pid = Number(from);
  for (let hops = 0; Number.isInteger(pid) && pid > 1 && hops < 64; hops += 1) {
    const st = procStat(pid, { procDir });
    if (!st) return null;
    if (names.includes(st.comm)) {
      const argv = argvOf(pid, procDir);
      if (argv && !argv.includes('serve')) return accept({ pid, comm: st.comm, start: st.start }) ? { pid, start: st.start } : null;
    }
    pid = st.ppid;
  }
  return null;
};

// Claude Code's per-process session records: <pid>.json holds the session the
// process runs (the seam lib/claude-session.sh reads).
export const claudeSessionsDir = () =>
  process.env.CLAUDE_SESSIONS_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude'), 'sessions');

const claudeRecordSession = (pid) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(claudeSessionsDir(), `${pid}.json`), 'utf8')).sessionId ?? null;
  } catch {
    return null;
  }
};

// A beacon may carry the pid of a writer from before host identities existed
// (the opencode plugin passed the server's pid). EPERM means the process exists
// under another user. No pid keeps the TTL rule alone.
export const pidAlive = (pid) => {
  if (pid == null) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
};

const hasHost = (b) => b.hostPid != null && b.hostStart != null && b.bootId != null;

// Is this recorded process still the one that was recorded? 'yes' | 'no' |
// 'unknown' (a /proc or boot id that cannot be read is not an answer).
const processVerdict = (b, pid, start, probe) => {
  const boot = probe.bootId();
  if (boot == null) return 'unknown';
  if (boot !== b.bootId) return 'no';
  const st = probe.stat(pid);
  if (st.status === 'unreadable') return 'unknown';
  return st.status === 'ok' && st.start === Number(start) ? 'yes' : 'no';
};

// The liveness model. Pure: the clock and /proc come in as arguments.
//   state    fresh | idle-live | legacy-idle | stale | dead
//   verified the host identity matched a live process (never true by TTL alone)
//   unknown  the identity could not be checked (unreadable /proc or boot id);
//            the row then falls back to the TTL rule and is never deleted
//   legacy   'pid' | 'null' for a row written before host identities
//   consumer whether mail queued for it is drained without typing
// `superseded` is not decided here: it compares rows (see supersede).
export const classifyBeacon = (b, { now = Date.now(), probe = createProbe() } = {}) => {
  const tick = Date.parse(b.lastTick);
  const age = now - tick;
  const out = (state, extra = {}) => ({ state, verified: false, unknown: false, legacy: null, consumer: false, ...extra });
  if (!Number.isFinite(tick) || age >= PRESENCE_IDLE_MAX_MS) return out('dead');
  const fresh = age < PRESENCE_STALE_MS;
  // Mail is drained out of band only when the row names a writer that is
  // still the one recorded; a restarted server leaves the host live and the
  // consumer gone. An idle seat has no composer loop of its own, so it counts
  // as drained only through such a writer.
  const consumerOf = (state) => {
    if (b.mailbox !== true) return false;
    let writerOk = true;
    if (b.writerStart != null && b.writerPid != null) writerOk = processVerdict(b, b.writerPid, b.writerStart, probe) !== 'no';
    return state === 'fresh' ? writerOk : writerOk && b.writerStart != null;
  };

  if (hasHost(b)) {
    const v = processVerdict(b, b.hostPid, b.hostStart, probe);
    if (v === 'no') return out('dead');
    if (v === 'unknown') {
      const state = fresh ? 'fresh' : 'legacy-idle';
      return out(state, { unknown: true, consumer: consumerOf(state) });
    }
    const state = fresh ? 'fresh' : 'idle-live';
    return out(state, { verified: true, consumer: consumerOf(state) });
  }
  // A modern writer with no host bound, or whose host moved to another
  // session: the TTL only, which is honest. This comes before the legacy pid:
  // a row an old writer left a server pid on keeps that column after a modern
  // writer takes it over, and the stale pid must not outvote the identity.
  if (b.bootId != null || b.writerPid != null || b.hostPid != null) {
    const state = fresh ? 'fresh' : 'stale';
    return out(state, { consumer: fresh && consumerOf(state) });
  }
  if (b.pid != null) {
    if (!pidAlive(b.pid)) return out('dead', { legacy: 'pid' });
    const state = fresh ? 'fresh' : 'stale';
    return out(state, { legacy: 'pid', consumer: fresh && consumerOf(state) });
  }
  // Written before identities and with no pid (a Claude Code hook): fresh by
  // the TTL, parked past it only while its window runs an agent, which the
  // reader checks (it owns the window list).
  const state = fresh ? 'fresh' : 'legacy-idle';
  return out(state, { legacy: 'null', consumer: fresh && consumerOf(state) });
};

const SEAT_STATES = new Set(['fresh', 'idle-live', 'legacy-idle']);
const outranks = (a, b) => (a.verified !== b.verified ? a.verified === true : String(a.lastTick) > String(b.lastTick));

// Two sessions in one window cannot both be its occupant: the verified one
// wins, else the newest tick. Two verified rows stay apart, because two
// different live hosts recorded for one window contradict each other and no
// guess is made. Rows of one session never displace each other. Takes rows
// carrying `state` and `verified`; returns them with the losers marked
// state 'superseded' (`base` keeps the state they had).
export const supersede = (rows) => {
  const groups = new Map();
  for (const r of rows) {
    if (!SEAT_STATES.has(r.state) || r.windowId == null || r.sessionId == null || r.sessionId === '') continue;
    const win = Number(r.windowId);
    if (!groups.has(win)) groups.set(win, new Map());
    const bySession = groups.get(win);
    const best = bySession.get(r.sessionId);
    if (!best || outranks(r, best)) bySession.set(r.sessionId, r);
  }
  const beaten = new Set();
  for (const [win, bySession] of groups) {
    for (const r of bySession.values()) {
      for (const o of bySession.values()) {
        if (o !== r && !(r.verified && o.verified) && outranks(o, r)) beaten.add(`${win}\0${r.sessionId}`);
      }
    }
  }
  return rows.map((r) => (
    r.windowId != null && SEAT_STATES.has(r.state) && beaten.has(`${Number(r.windowId)}\0${r.sessionId}`)
      ? { ...r, state: 'superseded', base: r.state }
      : r
  ));
};

// Every row with its verdict, supersession applied.
export const classifyBeacons = (beacons, { now = Date.now(), probe = createProbe() } = {}) =>
  supersede(beacons.map((b) => ({ ...b, ...classifyBeacon(b, { now, probe }) })));

export const isLiveBeacon = (b, now = Date.now(), probe) => classifyBeacon(b, { now, probe }).state === 'fresh';

// Past the TTL with a host that still exists, or parked in a window that may
// still run an agent (the reader decides that part): parked, not gone.
export const isIdleBeacon = (b, now = Date.now(), probe) => {
  const { state } = classifyBeacon(b, { now, probe });
  return state === 'idle-live' || state === 'legacy-idle';
};

const prunePresence = (beacons, now) => {
  const probe = createProbe();
  return beacons.filter((b) => isLiveBeacon(b, now, probe));
};
// What a writer keeps on disk: everything that is not provably gone.
const retainPresence = (beacons, now) => {
  const probe = createProbe();
  return beacons.filter((b) => classifyBeacon(b, { now, probe }).state !== 'dead');
};

// The identity a write records. A recorder names its host: 'auto' walks the
// ancestors of `hostFrom` for the interactive agent that runs THIS session
// (a claude process only when its session record names `sessionId`); an object
// {pid, start?} names it; null or nothing records none. 'auto' is opt-in:
// a recorder that does not own an interactive host (a nested agent, a plain
// script) must not borrow the nearest agent ancestor, which belongs to another
// session. AGENT_SWITCHBOARD_HOST_PROBE=off stops an 'auto' that starts from
// this process (tests); an explicit `hostFrom` is not affected. Nothing is
// recorded that could not be read, nor with no boot id to pin it to.
const hostProbeOff = () => process.env.AGENT_SWITCHBOARD_HOST_PROBE === 'off';
const resolveIdentity = ({ host, hostProof, writer, bootId, hostFrom, sessionId, procDir = defaultProcDir() }) => {
  const startOf = (pid, given) => (given != null ? Number(given) : (readStat(pid, procDir).start ?? null));
  const named = (p) => {
    if (!p || !Number.isInteger(Number(p.pid))) return null;
    const start = startOf(Number(p.pid), p.start);
    return start != null && Number.isFinite(start) ? { pid: Number(p.pid), start } : null;
  };
  let h = host ?? null;
  if (h === 'auto') {
    h = hostProbeOff() && hostFrom == null ? null : findHostAncestor({
      from: hostFrom ?? process.pid,
      procDir,
      accept: ({ pid, comm }) => comm !== 'claude' || sessionId == null || claudeRecordSession(pid) === sessionId,
    });
  }
  const hostId = named(h);
  const writerId = named(writer);
  const boot = bootId ?? currentBootId({ procDir });
  if (boot == null || (!hostId && !writerId)) return { bootId: null, host: null, writer: null };
  return {
    bootId: boot,
    host: hostId ? { ...hostId, proof: hostProof ?? h.proof ?? 'self' } : null,
    writer: writerId,
  };
};

// File backend stays while an explicit {file} override points at JSON, or
// while the legacy AGENT_SWITCHBOARD_PRESENCE_FILE env is set without an
// explicit AGENT_SWITCHBOARD_DB (which wins). Otherwise the beacon lives in
// the SQLite store; the first open imports the legacy file once and leaves
// it in place.
const legacyPresenceEnv = () =>
  process.env.AGENT_MAILBOX_PRESENCE_FILE ?? process.env.AGENT_SWITCHBOARD_PRESENCE_FILE ?? null;
const usePresenceDb = (file) =>
  file === undefined && (process.env.AGENT_SWITCHBOARD_DB != null || legacyPresenceEnv() == null);
const resolvePresenceFile = (file) => file ?? legacyPresenceEnv() ?? PRESENCE_FILE;

// Call-time source: a temp HOME in tests never reads the live file.
const withPresenceDb = (fn) =>
  withRetriedStore(() => ({ presenceFile: legacyPresenceEnv() ?? path.join(switchboardDir(), 'presence.json') }), fn);

export const presenceRowToBeacon = (r) => ({
  sessionId: r.session_id,
  cwd: r.cwd,
  ...(r.home_cwd != null ? { homeCwd: r.home_cwd } : {}),
  branch: r.branch,
  repo: r.repo,
  ...(r.mailbox != null ? { mailbox: !!r.mailbox } : {}),
  ...(r.mailbox_only ? { mailboxOnly: true } : {}),
  ...(r.window_id != null ? { windowId: r.window_id } : {}),
  ...(r.pid != null ? { pid: r.pid } : {}),
  ...(r.boot_id != null ? { bootId: r.boot_id } : {}),
  ...(r.host_pid != null ? { hostPid: r.host_pid } : {}),
  ...(r.host_start != null ? { hostStart: r.host_start } : {}),
  ...(r.host_proof != null ? { hostProof: r.host_proof } : {}),
  ...(r.writer_pid != null ? { writerPid: r.writer_pid } : {}),
  ...(r.writer_start != null ? { writerStart: r.writer_start } : {}),
  ...(r.last_work_tick != null ? { lastWorkTick: r.last_work_tick } : {}),
  lastWorkCwd: r.last_work_cwd ?? null,
  firstTick: r.first_tick,
  lastTick: r.last_tick,
});

// Delete a row only while it is still the row that was judged dead: a writer
// that revived it since (a new tick or another host) keeps it. Returns the
// number of rows deleted.
export const deleteBeaconIfUnchanged = (store, b) =>
  store.run(
    `DELETE FROM presence_beacons
      WHERE session_id = ? AND cwd = ? AND last_tick = ? AND pid IS ?
        AND boot_id IS ? AND host_pid IS ? AND host_start IS ? AND writer_pid IS ? AND writer_start IS ?`,
    b.sessionId, b.cwd, b.lastTick, b.pid ?? null,
    b.bootId ?? null, b.hostPid ?? null, b.hostStart ?? null, b.writerPid ?? null, b.writerStart ?? null,
  ).changes ?? 0;

const beaconKey = (b) => `${b.sessionId ?? 'anon'}:${b.cwd}`;

// Refresh this session's presence (call from a UserPromptSubmit hook). Returns
// the OTHER live beacons.
//
// Identity arguments (see resolveIdentity): `host` is the process that hosts
// the session, `writer` the one that drains its mailbox (the host itself when
// omitted), `hostProof` how the host was found (`self` | `argv` | `created`).
// `pid` is the older single-pid argument: it is still stored and still read,
// but only to classify rows written that way. A process hosts one session at a
// time, so recording a host clears it, and the window it gave, from every row
// of another session that held it.
export const recordPresence = ({
  file = undefined,
  cwd = process.cwd(),
  homeCwd = null,
  branch = null,
  repo = null,
  sessionId = null,
  mailbox = null,
  mailboxOnly = null,
  windowId = null,
  pid = null,
  host = undefined,
  hostProof = null,
  hostFrom = undefined,
  writer = null,
  bootId = null,
  work = false,
  now = Date.now(),
} = {}) => {
  const ident = resolveIdentity({ host, hostProof, writer, bootId, hostFrom, sessionId });
  if (usePresenceDb(file)) {
    return withPresenceDb((store) => {
      const iso = new Date(now).toISOString();
      const sid = sessionId ?? 'anon';
      const kept = [];
      store.transaction(() => {
        // Read before the prune: the row that last worked may be the one it deletes.
        const inherited = store.get(
          'SELECT last_work_cwd FROM presence_beacons WHERE session_id = ? AND last_work_cwd IS NOT NULL LIMIT 1',
          sid,
        )?.last_work_cwd ?? null;
        store.run('DELETE FROM presence_beacons WHERE last_tick < ?', new Date(now - PRESENCE_IDLE_MAX_MS).toISOString());
        const me = store.get('SELECT * FROM presence_beacons WHERE session_id = ? AND cwd = ?', sid, cwd);
        const idParams = [
          ident.bootId, ident.host?.pid ?? null, ident.host?.start ?? null, ident.host?.proof ?? null,
          ident.writer?.pid ?? null, ident.writer?.start ?? null,
        ];
        if (me) {
          store.run(
            `UPDATE presence_beacons SET last_tick = ?, branch = ?, cwd = ?,
              home_cwd = COALESCE(?, home_cwd), mailbox = COALESCE(?, mailbox), mailbox_only = COALESCE(?, mailbox_only),
              window_id = COALESCE(?, window_id),
              pid = COALESCE(?, pid), last_work_tick = COALESCE(?, last_work_tick),
              boot_id = COALESCE(?, boot_id), host_pid = COALESCE(?, host_pid), host_start = COALESCE(?, host_start),
              host_proof = COALESCE(?, host_proof), writer_pid = COALESCE(?, writer_pid), writer_start = COALESCE(?, writer_start)
             WHERE session_id = ? AND cwd = ?`,
            iso, branch, cwd,
            homeCwd, mailbox == null ? null : mailbox ? 1 : 0, mailboxOnly == null ? null : mailboxOnly ? 1 : 0,
            windowId == null ? null : Number(windowId),
            pid == null ? null : Number(pid), work ? iso : null,
            ...idParams,
            sid, me.cwd,
          );
        } else {
          store.run(
            `INSERT INTO presence_beacons
               (session_id, cwd, home_cwd, branch, repo, mailbox, mailbox_only, window_id, pid, last_work_tick, last_work_cwd, first_tick, last_tick,
                boot_id, host_pid, host_start, host_proof, writer_pid, writer_start)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            sid, cwd, homeCwd, branch, repo,
            mailbox == null ? null : mailbox ? 1 : 0, mailboxOnly == null ? null : mailboxOnly ? 1 : 0, windowId == null ? null : Number(windowId),
            pid == null ? null : Number(pid), work ? iso : null, work ? cwd : inherited,
            iso, iso,
            ...idParams,
          );
        }
        // One host, one session: whoever held this host before no longer does.
        if (ident.host) {
          store.run(
            `UPDATE presence_beacons SET host_pid = NULL, host_start = NULL, host_proof = NULL, window_id = NULL
              WHERE session_id != ? AND boot_id = ? AND host_pid = ? AND host_start = ?`,
            sid, ident.bootId, ident.host.pid, ident.host.start,
          );
        }
        // Work moves the session's latest work tree on every row it owns.
        if (work) store.run('UPDATE presence_beacons SET last_work_cwd = ? WHERE session_id = ?', cwd, sid);
        // A beacon that is provably gone is deleted here, not only hidden, so
        // the next reader does not have to probe it again. Judged and deleted
        // inside this transaction, which holds the write lock, and each delete
        // still names what was judged. An unreadable /proc proves nothing and
        // deletes nothing.
        const probe = createProbe();
        for (const b of store.all('SELECT * FROM presence_beacons').map(presenceRowToBeacon)) {
          const verdict = classifyBeacon(b, { now, probe });
          if (verdict.state === 'dead') deleteBeaconIfUnchanged(store, b);
          else if (verdict.state === 'fresh') kept.push(b);
        }
      });
      const mineKey = beaconKey({ sessionId, cwd });
      return kept.filter((b) => beaconKey(b) !== mineKey);
    });
  }
  file = resolvePresenceFile(file);
  const raw = readPresenceFile(file).beacons;
  const kept = retainPresence(raw, now);
  // Read from the unpruned list: the beacon that last worked may be pruned now.
  const inherited = raw.find((b) => (b.sessionId ?? 'anon') === (sessionId ?? 'anon') && b.lastWorkCwd)?.lastWorkCwd ?? null;
  const iso = new Date(now).toISOString();
  const mineKey = beaconKey({ sessionId, cwd });
  const me = kept.find((b) => beaconKey(b) === mineKey);
  const identFields = {
    ...(ident.bootId != null ? { bootId: ident.bootId } : {}),
    ...(ident.host ? { hostPid: ident.host.pid, hostStart: ident.host.start, hostProof: ident.host.proof } : {}),
    ...(ident.writer ? { writerPid: ident.writer.pid, writerStart: ident.writer.start } : {}),
  };
  if (me) {
    me.lastTick = iso;
    me.branch = branch;
    me.cwd = cwd;
    if (homeCwd !== null) me.homeCwd = homeCwd;
    // Optional consumer flag (the mailbox prompt hook sets true). Merge-only:
    // an omitted argument must never clear an existing true, since callers
    // that do not know about the flag run every turn.
    if (mailbox !== null) me.mailbox = mailbox;
    // Poller with no composer to type into: same merge-only rule.
    if (mailboxOnly !== null) me.mailboxOnly = mailboxOnly;
    // Kitty window id (the mailbox hook sets it from KITTY_WINDOW_ID) so a
    // window id resolves to the session living in that window, not to
    // whoever shares its cwd. Same merge-only rule: never clear once set.
    if (windowId !== null) me.windowId = windowId;
    if (pid !== null) me.pid = pid;
    Object.assign(me, identFields);
    if (work) me.lastWorkTick = iso;
    if (me.lastWorkCwd == null && inherited !== null) me.lastWorkCwd = inherited;
  } else {
    kept.push({ sessionId, cwd, ...(homeCwd ? { homeCwd } : {}), branch, repo, ...(mailbox !== null ? { mailbox } : {}), ...(mailboxOnly ? { mailboxOnly: true } : {}), ...(windowId !== null ? { windowId } : {}), ...(pid !== null ? { pid } : {}), ...identFields, ...(work ? { lastWorkTick: iso } : {}), ...(work ? { lastWorkCwd: cwd } : inherited !== null ? { lastWorkCwd: inherited } : {}), firstTick: iso, lastTick: iso });
  }
  // One host, one session (see above).
  if (ident.host) {
    for (const b of kept) {
      if ((b.sessionId ?? 'anon') === (sessionId ?? 'anon')) continue;
      if (b.bootId === ident.bootId && b.hostPid === ident.host.pid && b.hostStart === ident.host.start) {
        delete b.hostPid;
        delete b.hostStart;
        delete b.hostProof;
        delete b.windowId;
      }
    }
  }
  // Work moves the session's latest work tree on every beacon it owns.
  if (work) for (const b of kept) if ((b.sessionId ?? 'anon') === (sessionId ?? 'anon')) b.lastWorkCwd = cwd;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ beacons: kept }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort — presence is advisory.
  }
  return prunePresence(kept, now).filter((b) => beaconKey(b) !== mineKey);
};

// Drop this session's beacons on clean session end. Keyed on sessionId when
// known — removes ALL of that session's beacons. Without a sessionId only
// anon beacons matching cwd are dropped, so a co-located sibling's beacon is
// never clobbered.
export const releasePresence = ({ file = undefined, sessionId = null, cwd = null } = {}) => {
  if (usePresenceDb(file)) {
    return withPresenceDb((store) => {
      if (sessionId) store.run('DELETE FROM presence_beacons WHERE session_id = ?', sessionId);
      else if (cwd) store.run("DELETE FROM presence_beacons WHERE session_id = 'anon' AND cwd = ?", cwd);
    });
  }
  file = resolvePresenceFile(file);
  const data = readPresenceFile(file);
  const kept = data.beacons.filter((b) =>
    sessionId ? b.sessionId !== sessionId : !(b.sessionId == null && cwd && b.cwd === cwd),
  );
  if (kept.length === data.beacons.length) return;
  try {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ beacons: kept }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort — presence is advisory.
  }
};

// Every live beacon (no exclusion), raw rows including the `mailbox`
export const readAllPresence = ({ file = undefined, now = Date.now() } = {}) => {
  if (usePresenceDb(file)) {
    return withPresenceDb((store) =>
      prunePresence(store.all('SELECT * FROM presence_beacons').map(presenceRowToBeacon), now),
    );
  }
  return prunePresence(readPresenceFile(resolvePresenceFile(file)).beacons, now);
};
