// A seat's LOKA-DONE marker is its end, not a message like any other.
//
// Issue #91: a seat that sent the marker still held its role, so the close
// refused ("holds a seat role"); releasing the role from outside did not end
// the seat's claim, because its next claim recreated the row, and a role-store
// notice recorded after the marker counted as "working again". Here the marker
// releases every role the session holds, closes the session to further claims,
// and role events are not mail.
//
// Run: node --test tests/loka-release.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { appendMessage, recipientKey } from '../lib/agent-mailbox.mjs';
import { claimRole, roleClaimsForSession, rolesForSession, seatClosed } from '../lib/seat-roles.mjs';
import { openStore } from '../lib/store.mjs';

const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));
const FINISHED = fileURLToPath(new URL('../bin/seat-finished.mjs', import.meta.url));
const SID = 'ses_loka1234567890abcdef';
const OTHER = 'ses_other9999999999999999';

let tmp, dbPath, seq = 0;

const withDb = (fn) => {
  const db = openStore(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
const childEnv = (extra = {}) => isolatedEnv({ AGENT_SWITCHBOARD_DB: dbPath, ...extra });
const send = (args, extra = {}) =>
  spawnSync(process.execPath, [SEND, ...args], { encoding: 'utf8', cwd: tmp, env: childEnv(extra), timeout: 30_000 });
const key = (sessionId = SID, cwd = '/repo/one') => recipientKey({ cwd, sessionId });
const marker = (text = `LOKA-DONE ${SID}`, from = key()) =>
  appendMessage({ to: key(), from, priority: 'queue', text });
// The store row an older switchboard wrote for a marker, inserted without the
// sender's hook, as a seat's marker already on disk looks to this code.
const storedMarker = (over = {}) => {
  const row = {
    id: `m-${Math.random()}`, ts: new Date(Date.now() - 30_000).toISOString(), from: key(),
    to: 'role:lead', priority: 'now', text: `LOKA-DONE ${SID}`, ...over,
  };
  withDb((db) => db.run(
    'INSERT INTO mailbox_rows (recipient_key, kind, msg_id, ts, row_json) VALUES (?, ?, ?, ?, ?)',
    'role-lead', 'message', row.id, row.ts, JSON.stringify(row),
  ));
  return row;
};
const transcript = (body = '') => {
  const file = path.join(tmp, `transcript-${(seq += 1)}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
};
const finished = (sinceMs = 0, file = transcript()) =>
  spawnSync(process.execPath, [FINISHED, 'check', SID, String(sinceMs), file], { encoding: 'utf8', env: childEnv(), timeout: 30_000 });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loka-release-'));
});
after(() => {
  delete process.env.AGENT_SWITCHBOARD_DB;
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  seq += 1;
  dbPath = path.join(tmp, `state-${seq}.db`);
  // The parent's appendMessage and the child's sender must share one store.
  process.env.AGENT_SWITCHBOARD_DB = dbPath;
});

// A seat holding two roles claimed in two places: one row per role, each with
// its own cwd, which is what "on every location row" means in seat_roles.
const holdTwoRoles = (sessionId = SID) => withDb((db) => {
  claimRole(db, { role: 'lane-one', sessionId, cwd: '/repo/one' });
  claimRole(db, { role: 'lane-two', sessionId, cwd: '/repo/two' });
});

test('the marker releases every role the session holds, in every location', () => {
  holdTwoRoles();
  // Sent through the sender, from the session's own id: the row the seat
  // writes for its close-out. --queue needs no window.
  const r = send(['--to', 'role:steering', '--queue', '--text', `LOKA-DONE ${SID}`], { CLAUDE_CODE_SESSION_ID: SID });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`); // queued for the role, and the marker stands
  const after = withDb((db) => ({ held: rolesForSession(db, SID), closed: seatClosed(db, SID) }));
  assert.deepEqual(after.held, [], 'the marker ended the claims it held');
  assert.ok(after.closed, 'the closure is recorded');
  assert.ok(after.closed.marker_id, 'naming the row that proved it');
});

test('after its marker the session cannot claim a role again', () => {
  holdTwoRoles();
  marker();
  const r = send(['--claim-role', 'lane-three', '--as', SID]);
  assert.equal(r.status, 11, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /LOKA-DONE/);
  assert.deepEqual(withDb((db) => rolesForSession(db, SID)), [], 'nothing was claimed');
  // Nor can it take one back through a takeover.
  const t = send(['--claim-role', 'lane-one', '--take-over', '--as', SID]);
  assert.equal(t.status, 11, `${t.stdout}${t.stderr}`);
});

test("only this session's own whole-text marker ends its claims", () => {
  holdTwoRoles();
  // Free text, a marker for another session, and a marker whose sender key is
  // somebody else's all leave the held roles alone.
  marker(`loka done ${SID}`);
  marker(`LOKA-DONE ${SID} and more`);
  appendMessage({ to: key(OTHER), from: key(OTHER), priority: 'queue', text: `LOKA-DONE ${OTHER}` });
  marker(`LOKA-DONE ${SID}`, key(OTHER));
  const state = withDb((db) => ({ held: rolesForSession(db, SID), closed: seatClosed(db, SID) }));
  assert.deepEqual(state.held, ['lane-one', 'lane-two']);
  assert.equal(state.closed, null);
});

test('a role-store notice newer than the marker is not mail: the seat is still finished', () => {
  // The state a seat is in when it closes out: a role claimed before the
  // marker, and a marker recorded without the sender hook (a store written by
  // an older switchboard). The verdict ends the claim itself.
  withDb((db) => claimRole(db, { role: 'lane-one', sessionId: SID, cwd: '/repo/one', now: Date.now() - 60_000 }));
  storedMarker();
  // The role store's own notice to the session, after the marker: delivered
  // mail, but bookkeeping, so it does not make the seat "working again".
  appendMessage({ to: key(), from: 'role:lead', priority: 'now', roleEvent: true, text: 'role lane-one was taken over by window 7 (session x)' });
  const body = `${JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 45_000).toISOString(), message: { content: 'close out' } })}\n`;
  const r = finished(Date.now() - 120_000, transcript(body));
  assert.equal(r.status, 0, r.stderr);
  const verdict = JSON.parse(r.stdout);
  assert.equal(verdict.finished, true, JSON.stringify(verdict));
  // The check ends the claims it found, so the role row is gone too.
  const state = withDb((db) => ({ held: rolesForSession(db, SID), closed: seatClosed(db, SID) }));
  assert.deepEqual(state.held, []);
  assert.ok(state.closed);
});

test('ordinary mail after the marker still refuses', () => {
  storedMarker();
  appendMessage({ to: key(), from: key(OTHER), priority: 'now', text: 'one more thing' });
  const verdict = JSON.parse(finished().stdout);
  assert.equal(verdict.finished, false);
  assert.equal(verdict.reason, 'later-mail');
});

test('a role row claimed after the marker is activity, not a claim the marker ended', () => {
  storedMarker();
  // Written by hand, as an older writer could: claimRole now refuses.
  withDb((db) => db.run(
    'INSERT INTO seat_roles (role, session_id, cwd, window_id, claimed_at) VALUES (?, ?, ?, ?, ?)',
    'lane-late', SID, '/repo/one', null, Date.now(),
  ));
  assert.equal(withDb((db) => roleClaimsForSession(db, SID)).length, 1);
  const verdict = JSON.parse(finished().stdout);
  assert.equal(verdict.finished, false);
  assert.equal(verdict.reason, 'holds-role');
});
