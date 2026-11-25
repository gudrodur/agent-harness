// Presence rows carry a verified host identity (boot id, pid, start time), so a
// reused pid, a reboot or a host that moved to another session reads as gone,
// and a parked seat stays addressable without a window scan. Each case runs
// against a fake /proc (tests/helpers/fake-proc.mjs).
//
// Run: node --test tests/presence-identity.test.mjs (or the full suite)

import './helpers/isolate-setup.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFakeProc } from './helpers/fake-proc.mjs';

const P = await import('../lib/presence.mjs');
const M = await import('../lib/agent-mailbox.mjs');
const { openStore } = await import('../lib/store.mjs');
const { claimRole } = await import('../lib/seat-roles.mjs');

const WIN = 501;
const MIN = 60_000;
let tmp, proc, dbPath;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-identity-'));
  dbPath = path.join(tmp, 'state.db');
  process.env.AGENT_SWITCHBOARD_DB = dbPath;
  proc = makeFakeProc({ bootId: 'boot-1' });
  process.env.AGENT_MAILBOX_PROC_DIR = proc.dir;
  // kitty shows two windows: 501 titled "seat-title" and 502.
  const ls = path.join(tmp, 'ls.json');
  fs.writeFileSync(ls, JSON.stringify([{ tabs: [{ title: 'tab', windows: [
    { id: 501, title: 'seat-title', pid: 1, cwd: '/r/x' },
    { id: 502, title: 'other', pid: 1, cwd: '/r/y' },
  ] }] }]));
  const kitty = path.join(tmp, 'kitty');
  fs.writeFileSync(kitty, `#!/usr/bin/env bash\n[ "$2" = "ls" ] && cat ${JSON.stringify(ls)}\nexit 0\n`, { mode: 0o755 });
  process.env.AGENT_MAILBOX_KITTY = kitty;
});
afterEach(() => {
  delete process.env.AGENT_SWITCHBOARD_DB;
  delete process.env.AGENT_MAILBOX_PROC_DIR;
  delete process.env.AGENT_MAILBOX_KITTY;
  proc.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const wins = [{ id: 501, title: 'seat-title', tabTitle: 'tab', pid: 1, cwd: '/r/x', foreground: [] }];
const key = (sid, cwd = '/r/x') => M.recipientKey({ cwd, sessionId: sid });
// A row written by a host with a proven identity (what the hooks record).
const seat = (sessionId, host, { minutes = 0, window = WIN, cwd = '/r/x', ...extra } = {}) =>
  P.recordPresence({
    sessionId, cwd, mailbox: true, windowId: window, now: Date.now() - minutes * MIN,
    ...(host ? { host: { pid: host.pid, start: host.start }, hostProof: 'self' } : { host: null }),
    ...extra,
  });
const rows = () => {
  const s = openStore(dbPath);
  try { return s.all('SELECT * FROM presence_beacons ORDER BY session_id'); } finally { s.close(); }
};
const sids = (list) => list.map((b) => b.sessionId).sort();

test('schema: the identity columns exist on a fresh store and are added to an old one', () => {
  const want = ['boot_id', 'host_pid', 'host_start', 'host_proof', 'writer_pid', 'writer_start'];
  const s = openStore(dbPath);
  const cols = s.all('PRAGMA table_info(presence_beacons)').map((c) => c.name);
  s.close();
  for (const c of want) assert.ok(cols.includes(c), `column ${c}`);
  const oldDb = path.join(tmp, 'old.db');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const old = new DatabaseSync(oldDb);
  old.exec(`CREATE TABLE presence_beacons (session_id TEXT NOT NULL, cwd TEXT NOT NULL, home_cwd TEXT, branch TEXT,
    repo TEXT, mailbox INTEGER, window_id INTEGER, pid INTEGER, first_tick TEXT NOT NULL, last_tick TEXT NOT NULL,
    PRIMARY KEY (session_id, cwd));`);
  old.close();
  const upgraded = openStore(oldDb);
  const after = upgraded.all('PRAGMA table_info(presence_beacons)').map((c) => c.name);
  upgraded.close();
  for (const c of want) assert.ok(after.includes(c), `upgraded column ${c}`);
});

test('procStat reads comm after the last ")" and start time from field 22', () => {
  proc.add(41, { comm: 'we ird) name', start: 4242, ppid: 7 });
  assert.deepEqual(P.procStat(41, { procDir: proc.dir }), { ppid: 7, comm: 'we ird) name', start: 4242 });
  assert.equal(P.procStat(9999, { procDir: proc.dir }), null);
});

test('case 1: a title resolves to the live seat when a dead row shares its window', () => {
  const h1 = proc.add(100, { start: 1000 });
  const h2 = proc.add(200, { start: 2000 });
  seat('s1', h1);
  proc.reuse(100, 5555); // s1's host pid now belongs to another process
  seat('s2', h2);
  const r = M.resolveRecipient('seat-title', { senderSessionId: 'sender', senderCwd: '/elsewhere' });
  assert.equal(r.sessionId, 's2');
});

test('case 2: two legacy fresh rows in one window, the newer tick wins', () => {
  seat('s1', null, { minutes: 1 });
  seat('s2', null, { minutes: 0 });
  const r = M.resolveRecipient('seat-title', { senderSessionId: 'sender', senderCwd: '/elsewhere' });
  assert.equal(r.sessionId, 's2');
});

test('case 3: a reused host pid reads as absent, is hidden from --who and deleted by the next write', () => {
  const h1 = proc.add(100, { start: 1000 });
  seat('s1', h1);
  assert.deepEqual(sids(M.readPresenceBeacons()), ['s1']);
  proc.reuse(100, 7);
  assert.deepEqual(sids(M.readPresenceBeacons()), []);
  assert.deepEqual(M.listSeats({ wins, agentWindows: new Set([WIN]) }), []);
  P.recordPresence({ sessionId: 'other', cwd: '/r/y', host: null });
  assert.deepEqual(rows().map((r) => r.session_id), ['other']);
});

test('case 4: a legacy bare pid gets the TTL only, never the 7-day idle', () => {
  seat('s1', null, { minutes: 60, pid: process.pid });
  proc.add(300, { comm: 'claude', window: WIN });
  assert.deepEqual(M.idleBeacons({ wins, agentWindows: new Set([WIN]) }), []);
  assert.deepEqual(sids(M.readPresenceBeacons()), []);
  assert.equal(M.readPresenceBeacons({ includeStale: true })[0].state, 'stale');
});

test('case 4b: an old writer that passes only pid still works while fresh', () => {
  seat('s1', null, { pid: process.pid });
  const [b] = M.readPresenceBeacons();
  assert.equal(b.sessionId, 's1');
  assert.equal(b.state, 'fresh');
  assert.equal(b.verified, false);
  assert.equal(b.pid, process.pid);
});

test('case 5: a legacy Claude Code row without a pid keeps the window rule (no regression)', () => {
  seat('s1', null, { minutes: 60 });
  proc.add(300, { comm: 'claude', window: WIN });
  const idle = M.idleBeacons({ wins });
  assert.deepEqual(sids(idle), ['s1']);
  assert.equal(M.listSeats({ wins })[0].idleMinutes, 60);
  // The window closed: parked no longer.
  assert.deepEqual(M.idleBeacons({ wins: [] }), []);
  // And it never counts for the fleet ladder.
  const s = openStore(dbPath);
  try {
    claimRole(s, { role: 'lead', sessionId: 's1', cwd: '/r/x', windowId: WIN });
    assert.equal(M.liveRoleHolder(s, 'lead', { sessionId: 'me', includeIdle: true }), null);
  } finally { s.close(); }
});

test('case 6: an idle-live seat inside the retention horizon is reached by key and by title', () => {
  const h = proc.add(100, { start: 1000 });
  seat('s1', h, { minutes: 53 });
  const byKey = M.resolveRecipient(key('s1'));
  assert.equal(byKey.sessionId, 's1');
  assert.equal(byKey.idleMinutes, 53);
  const byTitle = M.resolveRecipient('seat-title', { senderSessionId: 'sender', senderCwd: '/elsewhere' });
  assert.equal(byTitle.sessionId, 's1');
  assert.equal(byTitle.idleMinutes, 53);
  const seatRow = M.listSeats({ wins })[0];
  assert.equal(seatRow.idleMinutes, 53);
  assert.equal(seatRow.state, 'idle-live');
  assert.equal(seatRow.verified, true);
});

test('case 6b: a verified idle seat needs no agent in its window, a legacy one does', () => {
  const h = proc.add(100, { start: 1000, comm: 'bash' });
  seat('s1', h, { minutes: 53 });
  assert.deepEqual(sids(M.idleBeacons({ wins, agentWindows: new Set() })), ['s1']);
});

test('case 7: an unreadable /proc deletes nothing and never downgrades a fresh row', () => {
  const h1 = proc.add(100, { start: 1000 });
  const h2 = proc.add(200, { start: 2000 });
  seat('fresh', h1);
  seat('aged', h2, { minutes: 53, window: 502, cwd: '/r/y' });
  proc.destroy();
  const all = M.readPresenceBeacons({ includeStale: true });
  const by = Object.fromEntries(all.map((b) => [b.sessionId, b]));
  assert.equal(by.fresh.state, 'fresh');
  assert.equal(by.fresh.unknown, true);
  assert.equal(by.aged.state, 'legacy-idle');
  assert.equal(by.aged.unknown, true);
  assert.equal(by.aged.verified, false);
  P.recordPresence({ sessionId: 'writer', cwd: '/r/z', host: null });
  assert.deepEqual(rows().map((r) => r.session_id), ['aged', 'fresh', 'writer']);
});

test('case 8: a reboot (boot id differs) reads as dead and the next write deletes the row', () => {
  const h = proc.add(100, { start: 1000 });
  seat('s1', h, { minutes: 53 });
  proc.setBoot('boot-2');
  assert.equal(M.readPresenceBeacons({ includeStale: true })[0].state, 'dead');
  assert.deepEqual(M.idleBeacons({ wins }), []);
  assert.throws(() => M.resolveRecipient(key('s1')), /stale or gone/);
  P.recordPresence({ sessionId: 'writer', cwd: '/r/z', host: null });
  assert.deepEqual(rows().map((r) => r.session_id), ['writer']);
});

test('case 9: binding a host to a second session clears it, and its window, from the first', () => {
  const h = proc.add(100, { start: 1000 });
  seat('s1', h, { window: 501 });
  seat('s2', h, { window: 502, cwd: '/r/y' });
  const by = Object.fromEntries(M.readPresenceBeacons({ includeStale: true }).map((b) => [b.sessionId, b]));
  assert.equal(by.s2.hostPid, 100);
  assert.equal(by.s1.hostPid, undefined);
  assert.equal(by.s1.hostStart, undefined);
  assert.equal(by.s1.windowId, undefined);
  // s1 now carries no proof: past the TTL it is stale, not idle-live.
  assert.equal(P.classifyBeacon({ ...by.s1, lastTick: new Date(Date.now() - 60 * MIN).toISOString() }).state, 'stale');
});

test('case 9b: the same session in two directories never supersedes itself', () => {
  const h = proc.add(100, { start: 1000 });
  seat('s1', h, { cwd: '/r/x' });
  seat('s1', h, { cwd: '/r/x/.claude/worktrees/a' });
  const r = M.resolveRecipient('seat-title', { senderSessionId: 'sender', senderCwd: '/elsewhere' });
  assert.equal(r.sessionId, 's1');
});

test('two different verified hosts recorded for one window stay ambiguous', () => {
  const h1 = proc.add(100, { start: 1000 });
  const h2 = proc.add(200, { start: 2000 });
  seat('s1', h1);
  seat('s2', h2);
  assert.throws(() => M.resolveRecipient('seat-title', { senderSessionId: 'sender', senderCwd: '/elsewhere' }), /matches 2 live sessions/);
});

test('case 10: the fleet ladder counts only a verified idle-live holder', () => {
  const h = proc.add(100, { start: 1000 });
  const gone = proc.add(200, { start: 2000 });
  seat('verified', h, { minutes: 53 });
  seat('dead', gone, { minutes: 53, window: 502, cwd: '/r/y' });
  seat('legacy', null, { minutes: 53, window: 503, cwd: '/r/z' });
  proc.add(300, { comm: 'claude', window: 503 });
  proc.reuse(200, 9);
  const s = openStore(dbPath);
  try {
    for (const sid of ['verified', 'dead', 'legacy']) claimRole(s, { role: sid, sessionId: sid, cwd: '/r/x', windowId: WIN });
    const holder = (role, opts) => M.liveRoleHolder(s, role, { sessionId: 'me', ...opts });
    assert.equal(holder('verified'), null, 'idle is not live by default');
    assert.equal(holder('verified', { includeIdle: true })?.session_id, 'verified');
    assert.equal(holder('dead', { includeIdle: true }), null);
    assert.equal(holder('legacy', { includeIdle: true }), null);
  } finally { s.close(); }
});

test('a role resolves to an idle-live holder with the wake path, not a role queue', () => {
  const h = proc.add(100, { start: 1000 });
  seat('holder', h, { minutes: 53 });
  const s = openStore(dbPath);
  try { claimRole(s, { role: 'lead', sessionId: 'holder', cwd: '/r/x', windowId: WIN }); } finally { s.close(); }
  const r = M.resolveRecipient('role:lead');
  assert.equal(r.sessionId, 'holder');
  assert.equal(r.idleMinutes, 53);
  assert.equal(r.queuedForRole, undefined);
});

test('consumer: a restarted writer turns hasConsumer off while the host stays live', () => {
  const host = proc.add(100, { start: 1000 });
  const writer = proc.add(150, { start: 1500, comm: 'opencode', argv: ['opencode', 'serve'] });
  P.recordPresence({
    sessionId: 's1', cwd: '/r/x', mailbox: true, windowId: WIN, host: { pid: host.pid, start: host.start }, hostProof: 'argv',
    writer: { pid: writer.pid, start: writer.start },
  });
  assert.equal(M.resolveRecipient(key('s1')).hasConsumer, true);
  proc.reuse(150, 1501); // the server restarted
  const r = M.resolveRecipient(key('s1'));
  assert.equal(r.sessionId, 's1');
  assert.equal(r.hasConsumer, false);
});

test('auto host: the first agent ancestor that is not a server is recorded as the host', () => {
  proc.add(700, { comm: 'claude', start: 123, ppid: 1 });
  proc.add(800, { comm: 'sh', start: 5, ppid: 700 });
  proc.add(900, { comm: 'node', start: 6, ppid: 800 });
  sessionRecords({ 700: 's1' });
  P.recordPresence({ sessionId: 's1', cwd: '/r/x', host: 'auto', hostFrom: 900 });
  const [b] = M.readPresenceBeacons();
  assert.equal(b.hostPid, 700);
  assert.equal(b.hostStart, 123);
  assert.equal(b.hostProof, 'self');
  assert.equal(b.bootId, 'boot-1');
});

test('auto host: a server ancestor and a chain with no agent record no host', () => {
  proc.add(700, { comm: 'opencode', start: 123, ppid: 1, argv: ['opencode', 'serve', '--port', '1'] });
  proc.add(900, { comm: 'node', start: 6, ppid: 700 });
  P.recordPresence({ sessionId: 's1', cwd: '/r/x', host: 'auto', hostFrom: 900 });
  P.recordPresence({ sessionId: 's2', cwd: '/r/y', host: 'auto', hostFrom: 999 });
  for (const b of M.readPresenceBeacons()) {
    assert.equal(b.hostPid, undefined, b.sessionId);
    assert.equal(b.bootId, undefined, b.sessionId);
  }
});

test('file backend: identity fields round-trip, a reused pid is pruned, the host moves with the invariant', () => {
  const file = path.join(tmp, 'presence.json');
  const h1 = proc.add(100, { start: 1000 });
  const h2 = proc.add(200, { start: 2000 });
  P.recordPresence({ file, sessionId: 's1', cwd: '/r/x', windowId: 501, host: h1 });
  P.recordPresence({ file, sessionId: 's2', cwd: '/r/y', windowId: 502, host: h2 });
  const read = () => Object.fromEntries(P.readAllPresence({ file }).map((b) => [b.sessionId, b]));
  assert.deepEqual([read().s1.hostPid, read().s1.hostStart, read().s1.bootId, read().s1.hostProof], [100, 1000, 'boot-1', 'self']);
  P.recordPresence({ file, sessionId: 's3', cwd: '/r/z', windowId: 503, host: h1 });
  assert.equal(read().s1.hostPid, undefined);
  assert.equal(read().s1.windowId, undefined);
  assert.equal(read().s3.hostPid, 100);
  proc.reuse(200, 77);
  assert.equal(read().s2, undefined);
  P.recordPresence({ file, sessionId: 's4', cwd: '/r/w', host: null });
  assert.ok(!JSON.parse(fs.readFileSync(file, 'utf-8')).beacons.some((b) => b.sessionId === 's2'));
});

test('classifyBeacon follows the table for every evidence shape', () => {
  const h = proc.add(100, { start: 1000 });
  const probe = P.createProbe({ procDir: proc.dir });
  const at = (minutes) => new Date(Date.now() - minutes * MIN).toISOString();
  const base = { sessionId: 's', cwd: '/c', mailbox: true };
  const cls = (b) => P.classifyBeacon({ ...base, ...b }, { probe });
  const ident = { bootId: 'boot-1', hostPid: h.pid, hostStart: h.start };
  assert.equal(cls({ ...ident, lastTick: at(1) }).state, 'fresh');
  assert.equal(cls({ ...ident, lastTick: at(1) }).verified, true);
  assert.equal(cls({ ...ident, lastTick: at(60) }).state, 'idle-live');
  assert.equal(cls({ ...ident, lastTick: at(8 * 24 * 60) }).state, 'dead');
  assert.equal(cls({ ...ident, hostStart: 1, lastTick: at(1) }).state, 'dead');
  // A modern writer with no host bound gets the TTL only.
  assert.equal(cls({ bootId: 'boot-1', writerPid: 5, writerStart: 5, lastTick: at(1) }).state, 'fresh');
  assert.equal(cls({ bootId: 'boot-1', writerPid: 5, writerStart: 5, lastTick: at(60) }).state, 'stale');
  assert.equal(cls({ pid: process.pid, lastTick: at(60) }).state, 'stale');
  assert.equal(cls({ pid: process.pid, lastTick: at(60) }).legacy, 'pid');
  assert.equal(cls({ pid: spawnSync('true').pid, lastTick: at(1) }).state, 'dead');
  assert.equal(cls({ lastTick: at(60) }).state, 'legacy-idle');
  assert.equal(cls({ lastTick: at(1) }).state, 'fresh');
  assert.equal(cls({ lastTick: 'garbage' }).state, 'dead');
});

test('supersede keeps the verified row, then the newest tick, and never two verified hosts apart', () => {
  const t = (m) => new Date(Date.now() - m * MIN).toISOString();
  const r = (sessionId, windowId, minutes, verified) => ({ sessionId, windowId, lastTick: t(minutes), state: 'fresh', verified });
  const out = P.supersede([r('a', 1, 5, false), r('b', 1, 1, false), r('c', 1, 9, true), r('d', 2, 3, false), r('e', 3, 2, true), r('f', 3, 8, true)]);
  const state = Object.fromEntries(out.map((x) => [x.sessionId, x.state]));
  assert.deepEqual(state, { a: 'superseded', b: 'superseded', c: 'fresh', d: 'fresh', e: 'fresh', f: 'fresh' });
});

// ---- Review round 1 --------------------------------------------------------

// The probe switch is off for the whole suite; these cases are about what a
// recorder gets when nothing turns it off.
const withProbeOn = (fn) => {
  const saved = process.env.AGENT_SWITCHBOARD_HOST_PROBE;
  delete process.env.AGENT_SWITCHBOARD_HOST_PROBE;
  try { return fn(); } finally { if (saved === undefined) delete process.env.AGENT_SWITCHBOARD_HOST_PROBE; else process.env.AGENT_SWITCHBOARD_HOST_PROBE = saved; }
};
const sessionRecords = (records) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'claude-sessions-'));
  for (const [pid, sessionId] of Object.entries(records)) fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid: Number(pid), sessionId }));
  process.env.CLAUDE_SESSIONS_DIR = dir;
  return dir;
};
afterEach(() => { delete process.env.CLAUDE_SESSIONS_DIR; });

test('fix 1: a nested agent that names no host never takes the seat host (no flapping)', () => {
  proc.add(700, { comm: 'claude', start: 123, ppid: 1 });
  proc.add(900, { comm: 'codex', start: 9, ppid: 700 });
  sessionRecords({ 700: 'seat' });
  withProbeOn(() => {
    P.recordPresence({ sessionId: 'seat', cwd: '/r/x', windowId: 501, mailbox: true, host: 'auto', hostFrom: 700 });
    // A recorder started under the seat's claude process, naming no host.
    P.recordPresence({ sessionId: 'nested', cwd: '/r/y', mailbox: true, hostFrom: 900 });
    P.recordPresence({ sessionId: 'seat', cwd: '/r/x', windowId: 501, mailbox: true, host: 'auto', hostFrom: 700 });
    P.recordPresence({ sessionId: 'nested', cwd: '/r/y', mailbox: true, hostFrom: 900 });
  });
  const by = Object.fromEntries(M.readPresenceBeacons({ includeStale: true }).map((b) => [b.sessionId, b]));
  assert.equal(by.seat.hostPid, 700);
  assert.equal(by.seat.windowId, 501);
  assert.equal(by.nested.hostPid, undefined);
});

test('fix 1: an auto host must be a claude process whose session record names this session', () => {
  proc.add(700, { comm: 'claude', start: 123, ppid: 1 });
  proc.add(900, { comm: 'node', start: 9, ppid: 700 });
  sessionRecords({ 700: 'seat' });
  P.recordPresence({ sessionId: 'other', cwd: '/r/y', host: 'auto', hostFrom: 900 });
  P.recordPresence({ sessionId: 'seat', cwd: '/r/x', host: 'auto', hostFrom: 900 });
  const by = Object.fromEntries(M.readPresenceBeacons({ includeStale: true }).map((b) => [b.sessionId, b]));
  assert.equal(by.other.hostPid, undefined, 'a session the record does not name gets no host');
  assert.equal(by.seat.hostPid, 700);
  // No record at all proves nothing either.
  fs.rmSync(path.join(process.env.CLAUDE_SESSIONS_DIR, '700.json'));
  P.recordPresence({ sessionId: 'norec', cwd: '/r/z', host: 'auto', hostFrom: 900 });
  assert.equal(M.readPresenceBeacons({ includeStale: true }).find((b) => b.sessionId === 'norec').hostPid, undefined);
});

test('fix 2: a modern writer identity is judged before a leftover server pid', () => {
  const dead = spawnSync('true').pid;
  const w = proc.add(150, { start: 1500, comm: 'opencode', argv: ['opencode', 'serve'] });
  const at = new Date(Date.now() - MIN).toISOString();
  const probe = P.createProbe({ procDir: proc.dir });
  const row = { sessionId: 's', cwd: '/c', mailbox: true, pid: dead, bootId: 'boot-1', writerPid: w.pid, writerStart: w.start, lastTick: at };
  assert.equal(P.classifyBeacon(row, { probe }).state, 'fresh');
  assert.equal(P.classifyBeacon({ ...row, lastTick: new Date(Date.now() - 60 * MIN).toISOString() }, { probe }).state, 'stale');
  // Through the store: the old pid column survives an update (COALESCE), and the next write must not delete the row.
  const s = openStore(dbPath);
  s.run('INSERT INTO presence_beacons (session_id, cwd, pid, first_tick, last_tick) VALUES (?, ?, ?, ?, ?)', 'srv', '/r/x', dead, at, at);
  s.close();
  P.recordPresence({ sessionId: 'srv', cwd: '/r/x', mailbox: true, host: null, writer: w });
  P.recordPresence({ sessionId: 'other', cwd: '/r/y', host: null });
  assert.ok(rows().some((r) => r.session_id === 'srv'), 'the row with a writer identity is kept');
  assert.deepEqual(sids(M.readPresenceBeacons()).filter((x) => x === 'srv'), ['srv']);
});

test('fix 3: sending by mailbox key makes no kitty call, even with a legacy parked row present', () => {
  const log = path.join(tmp, 'kitty-calls.log');
  const kitty = path.join(tmp, 'kitty-logging');
  fs.writeFileSync(kitty, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n[ "$2" = "ls" ] && cat ${JSON.stringify(path.join(tmp, 'ls.json'))}\nexit 0\n`, { mode: 0o755 });
  process.env.AGENT_MAILBOX_KITTY = kitty;
  const h = proc.add(100, { start: 1000 });
  seat('verified', h, { minutes: 53 });
  seat('legacy', null, { minutes: 60, window: 502, cwd: '/r/y' });
  proc.add(300, { comm: 'claude', window: 502 });
  assert.equal(M.resolveRecipient(key('verified')).sessionId, 'verified');
  assert.equal(M.resolveRecipient(`/old/cwd__verified`.replace(/[^A-Za-z0-9._-]/g, '-')).sessionId, 'verified');
  assert.equal(fs.existsSync(log), false, 'no kitty call for a key that a verified row answers');
  // A legacy parked row is still reachable by its own key, and that one does need the window check.
  assert.equal(M.resolveRecipient(key('legacy', '/r/y')).sessionId, 'legacy');
  assert.equal(fs.existsSync(log), true);
});

test('fix 4: no code or doc names a mailbox-idle outcome nothing throws', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  for (const f of ['bin/agent-send.mjs', 'lib/agent-mailbox.mjs', 'lib/presence.mjs', 'docs/configuration.md']) {
    assert.ok(!/mailbox-idle/.test(fs.readFileSync(path.join(root, f), 'utf8')), `${f} still names mailbox-idle`);
  }
  assert.ok(/classifyBeacon/.test(fs.readFileSync(path.join(root, 'docs/configuration.md'), 'utf8')), 'configuration.md names classifyBeacon');
});

test('fix 5: a dead verdict deletes a row only while the row is still what was judged', () => {
  const h = proc.add(100, { start: 1000 });
  seat('s1', h, { minutes: 53 });
  const judged = M.readPresenceBeacons({ includeStale: true }).find((b) => b.sessionId === 's1');
  // A writer revives the row between the verdict and the delete.
  const h2 = proc.add(101, { start: 2000 });
  P.recordPresence({ sessionId: 's1', cwd: '/r/x', mailbox: true, windowId: WIN, host: { pid: h2.pid, start: h2.start } });
  const s = openStore(dbPath);
  try {
    assert.equal(P.deleteBeaconIfUnchanged(s, judged), 0);
    assert.deepEqual(s.all('SELECT session_id FROM presence_beacons').map((r) => r.session_id), ['s1']);
    const current = P.presenceRowToBeacon(s.get('SELECT * FROM presence_beacons WHERE session_id = ?', 's1'));
    assert.equal(P.deleteBeaconIfUnchanged(s, current), 1);
  } finally { s.close(); }
});
