// Which of a seat's rows a send resolves to when the seat has several, one per tree it works in.
//
// A plugin-driven seat (an out-of-band writer drains its mailbox) works in several trees. Its tool hooks record one
// row per tree with no writer and no mailbox flag, on every tool call, while the writer ticks its own row at most
// every 20 s, so the newest row is nearly always one without a consumer. Every consumer drains by session id, so one
// row with a live consumer makes the whole session reachable: the pick must not answer "no consumer" for it.
//
// Store mode, in its own temp db so these rows and roles never show up in another file's hint lists.
//
// Run: node --import ./tests/helpers/isolate-setup.mjs --test tests/role-route-consumer.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordPresence, procStat } from '../lib/presence.mjs';
import { recipientKey, resolveRecipient } from '../lib/agent-mailbox.mjs';

let tmp, dbPath;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'role-route-'));
  dbPath = path.join(tmp, 'state.db');
  process.env.AGENT_SWITCHBOARD_DB = dbPath;
});
after(() => {
  delete process.env.AGENT_SWITCHBOARD_DB;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const claim = async (role, sessionId, cwd) => {
  const { openStore } = await import('../lib/store.mjs');
  const { claimRole } = await import('../lib/seat-roles.mjs');
  const db = openStore(dbPath);
  try { claimRole(db, { role, sessionId, cwd }); } finally { db.close(); }
};

const liveWriter = () => ({ pid: process.pid, start: procStat(process.pid).start });
const deadPid = () => spawnSync('true').pid;
const pluginSeat = (sessionId, { hookCwd = '/repo/wt-review', writerCwd = '/repo/main' } = {}) => {
  const t = Date.now();
  recordPresence({ sessionId, cwd: writerCwd, mailbox: true, writer: liveWriter(), now: t - 4_000 });
  recordPresence({ sessionId, cwd: hookCwd, homeCwd: writerCwd, now: t });
};

test('role:<name> picks the holder row with a live consumer over a newer hook row without one', async () => {
  pluginSeat('ses-plugin-1');
  // The claim's cwd matches neither row: the pick falls back past it.
  await claim('plugin-sup', 'ses-plugin-1', '/repo');
  const r = resolveRecipient('role:plugin-sup');
  assert.equal(r.key, recipientKey({ cwd: '/repo/main', sessionId: 'ses-plugin-1' }));
  assert.equal(r.hasConsumer, true);
});

test('role:<name> prefers a live-consumer row over the claimed cwd, and takes the claimed cwd when no row has one', async () => {
  pluginSeat('ses-plugin-2', { hookCwd: '/repo/wt-claimed' });
  await claim('plugin-sup-2', 'ses-plugin-2', '/repo/wt-claimed');
  // The claimed cwd's row has no consumer, the other one does: the live consumer wins.
  assert.equal(resolveRecipient('role:plugin-sup-2').key, recipientKey({ cwd: '/repo/main', sessionId: 'ses-plugin-2' }));
  // No row has a consumer: today's order (the claimed cwd, not the newest) holds.
  const t = Date.now();
  recordPresence({ sessionId: 'ses-bare', cwd: '/repo/a', now: t });
  recordPresence({ sessionId: 'ses-bare', cwd: '/repo/b', now: t - 4_000 });
  await claim('bare-sup', 'ses-bare', '/repo/b');
  const bare = resolveRecipient('role:bare-sup');
  assert.equal(bare.key, recipientKey({ cwd: '/repo/b', sessionId: 'ses-bare' }));
  assert.equal(bare.hasConsumer, false);
});

test('a session key picks the live-consumer row over a flagged row whose writer is dead', () => {
  const t = Date.now();
  recordPresence({ sessionId: 'ses-restart', cwd: '/repo/live', mailbox: true, writer: liveWriter(), now: t - 4_000 });
  recordPresence({ sessionId: 'ses-restart', cwd: '/repo/old', mailbox: true, writer: { pid: deadPid(), start: 1 }, now: t });
  // A key of the session no row answers exactly (its tree moved): resolved by session id.
  const r = resolveRecipient(recipientKey({ cwd: '/repo/gone', sessionId: 'ses-restart' }));
  assert.equal(r.key, recipientKey({ cwd: '/repo/live', sessionId: 'ses-restart' }));
  assert.equal(r.hasConsumer, true);
});

test('an exact key of a hook row is delivered when the same session has a live consumer elsewhere', () => {
  pluginSeat('ses-plugin-3');
  const r = resolveRecipient(recipientKey({ cwd: '/repo/wt-review', sessionId: 'ses-plugin-3' }));
  assert.equal(r.key, recipientKey({ cwd: '/repo/wt-review', sessionId: 'ses-plugin-3' }));
  assert.equal(r.hasConsumer, true);
});

test('an exact key of a session with no live consumer anywhere still reads as no consumer', () => {
  recordPresence({ sessionId: 'ses-none', cwd: '/repo/x', now: Date.now() });
  recordPresence({ sessionId: 'ses-none', cwd: '/repo/y', mailbox: true, writer: { pid: deadPid(), start: 1 }, now: Date.now() });
  assert.equal(resolveRecipient(recipientKey({ cwd: '/repo/x', sessionId: 'ses-none' })).hasConsumer, false);
});
