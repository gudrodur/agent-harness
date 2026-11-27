// A window claim belongs to the session that can prove it (#3476).
//
// Two shapes from the live store, 2026-11-27:
//   - a session that once held window 27 kept claiming it on every later tree
//     row for 7 days, because a writer with no window could not clear it
//     (`window_id = COALESCE(?, window_id)`), so one window matched several
//     live sessions;
//   - four rows written on 2026-11-23 (session id `t`, no host, no pid) were
//     the only claimants of window 28 and `--to 28` resolved to one of them,
//     because a legacy-idle row parked for a window that merely runs some
//     agent, whatever cwd the row names.
//
// The tests are fail-first: each one asserts the rule the live reading
// violated, not the shape of the old answer.
//
// Run: node --test tests/presence-window-claim.test.mjs

import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { recordPresence, readAllPresence, procStat, currentBootId } = await import('../lib/presence.mjs');
const { idleBeacons, recipientKey, resolveRecipient } = await import('../lib/agent-mailbox.mjs');

const freshDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-window-'));
  process.env.AGENT_SWITCHBOARD_DB = path.join(dir, 'state.db');
  return dir;
};
const find = (cwd) => readAllPresence().find((b) => b.cwd === cwd);
const twoHoursAgo = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

// ---- the writer: a known-none window clears a frozen one -------------------

test('store: a caller that knows the window is none clears the frozen one', () => {
  freshDb();
  recordPresence({ cwd: '/w/a', sessionId: 's1', windowId: 27, now: Date.now() - 60_000 });
  assert.equal(find('/w/a').windowId, 27);
  recordPresence({ cwd: '/w/a', sessionId: 's1', windowId: null, windowKnown: true });
  assert.equal(find('/w/a').windowId, undefined, 'the tick proved there is no window; the row must not keep 27');
});

test('store: an unmeasured window keeps what an earlier tick recorded', () => {
  freshDb();
  recordPresence({ cwd: '/w/a', sessionId: 's1', windowId: 27, now: Date.now() - 60_000 });
  recordPresence({ cwd: '/w/a', sessionId: 's1' });
  assert.equal(find('/w/a').windowId, 27, 'omitting the window is not a claim that there is none');
});

test('store: the cleared row is not a claimant, its sibling tree rows are untouched', () => {
  freshDb();
  recordPresence({ cwd: '/w/a', sessionId: 's1', windowId: 27, now: Date.now() - 60_000 });
  recordPresence({ cwd: '/w/b', sessionId: 's1', windowId: 27, now: Date.now() - 60_000 });
  recordPresence({ cwd: '/w/a', sessionId: 's1', windowId: null, windowKnown: true });
  assert.equal(find('/w/a').windowId, undefined);
  assert.equal(find('/w/b').windowId, 27, 'only the tree the tick measured is cleared');
});

test('file backend: the same clear and the same merge-only default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-window-file-'));
  const file = path.join(dir, 'presence.json');
  recordPresence({ file, cwd: '/w/a', sessionId: 's1', windowId: 27, now: Date.now() - 60_000 });
  recordPresence({ file, cwd: '/w/a', sessionId: 's1' });
  assert.equal(readAllPresence({ file })[0].windowId, 27);
  recordPresence({ file, cwd: '/w/a', sessionId: 's1', windowId: null, windowKnown: true });
  assert.equal(readAllPresence({ file })[0].windowId, undefined);
});

// ---- the reader: a parked legacy row proves its window by its cwd ----------

const legacyRow = (cwd, windowId) => ({
  sessionId: 'old-seat', cwd, ...(windowId != null ? { windowId } : {}),
  firstTick: twoHoursAgo(), lastTick: twoHoursAgo(),
});

test('reader: a legacy row parks only in the window whose cwd it names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-window-read-'));
  const file = path.join(dir, 'presence.json');
  fs.writeFileSync(file, JSON.stringify({ beacons: [legacyRow('/repo/other', 9)] }));
  const wins = [{ id: 9, cwd: '/repo/a' }];
  assert.deepEqual(
    idleBeacons({ presenceFile: file, wins, agentWindows: new Set([9]) }),
    [],
    'window 9 runs an agent on /repo/a; a row naming /repo/other is not that window\'s seat',
  );

  fs.writeFileSync(file, JSON.stringify({ beacons: [legacyRow('/repo/a', 9)] }));
  const kept = idleBeacons({ presenceFile: file, wins, agentWindows: new Set([9]) });
  assert.equal(kept.length, 1, 'the row whose cwd is the window\'s cwd is the parked seat');
  assert.equal(kept[0].sessionId, 'old-seat');
});

test('reader: a window that names no cwd cannot park a legacy row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-window-nocwd-'));
  const file = path.join(dir, 'presence.json');
  fs.writeFileSync(file, JSON.stringify({ beacons: [legacyRow('/repo/a', 9)] }));
  assert.deepEqual(
    idleBeacons({ presenceFile: file, wins: [{ id: 9, cwd: null }], agentWindows: new Set([9]) }),
    [],
    'an unprovable window is not a parked seat',
  );
});

// ---- a server-hosted row past the TTL still answers its key ----------------
// An unbound serve daemon writes windowId null, so its rows have no window to
// park on. Past PRESENCE_STALE_MS (20 min) they classified `stale` and were in
// neither reachable set, so a mailbox key naming a live seat read "no live
// session" while the process that drains that seat's mail was still running.

const staleRow = (overrides = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-stale-key-'));
  const file = path.join(dir, 'presence.json');
  const old = new Date(Date.now() - 40 * 60_000).toISOString();
  const row = {
    sessionId: 'srv-seat', cwd: '/repo/a', mailbox: true, bootId: currentBootId(),
    writerPid: process.pid, writerStart: procStat(process.pid).start,
    firstTick: old, lastTick: old, ...overrides,
  };
  fs.writeFileSync(file, JSON.stringify({ beacons: [row] }));
  return { file, key: recipientKey({ cwd: '/repo/a', sessionId: 'srv-seat' }) };
};

test('reader: a mailbox key reaches a server-hosted row whose writer still runs', () => {
  const { file, key } = staleRow();
  const r = resolveRecipient(key, { presenceFile: file });
  assert.equal(r.sessionId, 'srv-seat');
  assert.equal(r.hasConsumer, true, 'the live writer drains its mailbox');
  assert.equal(r.idleMinutes, 40);
});

test('reader: a dead writer leaves the same row unreachable by key', () => {
  const start = procStat(process.pid).start;
  const { file, key } = staleRow({ writerStart: start - 1 });
  assert.throws(() => resolveRecipient(key, { presenceFile: file }), /no live session/u);
});

test('reader: a stale row is not a parkable window seat either', () => {
  const { file } = staleRow({ windowId: 9 });
  // It answers its own key (a writer drains it), but with no window proof it is
  // never a window candidate: idleBeacons parks it, seatedBeacons drops it.
  assert.ok(idleBeacons({ presenceFile: file }).some((b) => b.sessionId === 'srv-seat'));
});
