// Tests for resource leases: one holder at a time, a first-come-first-served
// line, expiry by missed heartbeats or a dead holder session, the implicit
// lease authorize() grants a lone session, and the human hold that outranks
// every session.
//
// Run: node --import ./tests/helpers/isolate-setup.mjs --test tests/resource-leases.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { acquire, authorize, heartbeat, release, holdHuman, status, validateResource, IMPLICIT_TTL_MS, QUEUE_STALE_MS } from '../lib/resource-leases.mjs';

const R = 'device:test-1';
let tmp, db;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leases-'));
  db = openStore(path.join(tmp, 'state.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a free resource is granted; a second session is refused and queued', () => {
  const a = acquire(db, { resource: R, sessionId: 'A', purpose: 'camera', now: 1000 });
  assert.equal(a.granted, true);
  assert.equal(a.lease.holder, 'A');
  const b = acquire(db, { resource: R, sessionId: 'B', purpose: 'payment', now: 1100 });
  assert.equal(b.granted, false);
  assert.equal(b.holder.holder, 'A');
  assert.equal(b.position, 1);
  assert.equal(acquire(db, { resource: R, sessionId: 'A', now: 1200 }).renewed, true, 'the holder renews');
});

test('the line is first come first served after release', () => {
  acquire(db, { resource: R, sessionId: 'A', now: 0 });
  acquire(db, { resource: R, sessionId: 'B', now: 10 });
  acquire(db, { resource: R, sessionId: 'C', now: 20 });
  assert.deepEqual(release(db, { resource: R, sessionId: 'A', now: 30 }), { released: true });
  assert.equal(acquire(db, { resource: R, sessionId: 'C', now: 40 }).granted, false, 'C may not jump B');
  assert.equal(acquire(db, { resource: R, sessionId: 'B', now: 50 }).granted, true);
  assert.deepEqual(status(db, { resource: R, now: 60 }).queue.map((q) => q.session), ['C']);
});

test('only the holder releases; a stranger gets the holder back', () => {
  acquire(db, { resource: R, sessionId: 'A', now: 0 });
  const r = release(db, { resource: R, sessionId: 'B', now: 1 });
  assert.equal(r.released, false);
  assert.equal(r.holder.holder, 'A');
});

test('a lease with no heartbeat within its TTL expires', () => {
  acquire(db, { resource: R, sessionId: 'A', ttlMs: 1000, now: 0 });
  assert.equal(heartbeat(db, { resource: R, sessionId: 'A', now: 900 }).ok, true);
  assert.equal(acquire(db, { resource: R, sessionId: 'B', now: 1800 }).granted, false, 'heartbeat at 900 holds until 1900');
  // B keeps polling, so it stays in line and is first when A expires.
  assert.equal(acquire(db, { resource: R, sessionId: 'B', now: 1950 }).granted, true);
});

test('a dead holder session loses the lease at once', () => {
  acquire(db, { resource: R, sessionId: 'A', now: 0 });
  const isLive = (s) => s !== 'A';
  assert.equal(acquire(db, { resource: R, sessionId: 'B', now: 5, isLive }).granted, true);
});

test('a waiter that stops polling drops out of the line', () => {
  acquire(db, { resource: R, sessionId: 'A', now: 0 });
  acquire(db, { resource: R, sessionId: 'B', now: 0 });
  release(db, { resource: R, sessionId: 'A', now: 10 });
  assert.equal(acquire(db, { resource: R, sessionId: 'C', now: QUEUE_STALE_MS + 1 }).granted, true);
});

test('authorize grants a lone session an implicit lease, and refuses others while it lasts', () => {
  const a = authorize(db, { resource: R, sessionId: 'A', now: 0 });
  assert.deepEqual([a.allowed, a.implicit, a.lease.implicit], [true, true, true]);
  const b = authorize(db, { resource: R, sessionId: 'B', now: 1000 });
  assert.deepEqual([b.allowed, b.reason, b.holder.holder], [false, 'held', 'A']);
  assert.equal(status(db, { resource: R, now: 1000 }).queue.length, 0, 'a refused call does not join the line');
  assert.equal(authorize(db, { resource: R, sessionId: 'A', now: IMPLICIT_TTL_MS - 1 }).allowed, true, 'holder use refreshes');
  assert.equal(authorize(db, { resource: R, sessionId: 'B', now: 2 * IMPLICIT_TTL_MS - 2 }).allowed, false);
  assert.equal(authorize(db, { resource: R, sessionId: 'B', now: 2 * IMPLICIT_TTL_MS + 1 }).allowed, true, 'idle implicit lease lapsed');
});

test('authorize on a free resource still honours the line', () => {
  acquire(db, { resource: R, sessionId: 'A', now: 0 });
  acquire(db, { resource: R, sessionId: 'B', now: 1 });
  release(db, { resource: R, sessionId: 'A', now: 2 });
  const c = authorize(db, { resource: R, sessionId: 'C', now: 3 });
  assert.deepEqual([c.allowed, c.reason], [false, 'queued']);
  assert.equal(authorize(db, { resource: R, sessionId: 'B', now: 4 }).allowed, true, 'the head of the line may act');
});

test('an explicit acquire turns an implicit lease explicit with the longer TTL', () => {
  authorize(db, { resource: R, sessionId: 'A', now: 0 });
  const a = acquire(db, { resource: R, sessionId: 'A', purpose: 'camera pulls', now: 1 });
  assert.equal(a.lease.implicit, false);
  assert.equal(a.lease.purpose, 'camera pulls');
});

test('a human hold refuses everyone, displaced holder first in line after release', () => {
  acquire(db, { resource: R, sessionId: 'A', now: 0 });
  acquire(db, { resource: R, sessionId: 'B', now: 1 });
  const h = holdHuman(db, { resource: R, purpose: 'typing a one-time code', by: 'B', now: 2 });
  assert.equal(h.displaced, 'A');
  assert.equal(authorize(db, { resource: R, sessionId: 'A', now: 3 }).reason, 'human');
  assert.equal(acquire(db, { resource: R, sessionId: 'B', now: 4 }).granted, false);
  assert.equal(release(db, { resource: R, sessionId: 'A', now: 5 }).released, false, 'a session cannot end a human hold as its own');
  assert.deepEqual(status(db, { resource: R, now: 5 }).queue.map((q) => q.session), ['B'], 'A left the line by calling release');
  acquire(db, { resource: R, sessionId: 'A', now: 6 });
  assert.equal(release(db, { resource: R, human: true, now: 7 }).released, true);
  assert.equal(acquire(db, { resource: R, sessionId: 'B', now: 8 }).granted, true, 'B rejoined before A re-queued');
});

test('a displaced holder that stays in line gets the resource back first', () => {
  acquire(db, { resource: R, sessionId: 'A', now: 0 });
  acquire(db, { resource: R, sessionId: 'B', now: 1 });
  holdHuman(db, { resource: R, now: 2 });
  release(db, { resource: R, human: true, now: 3 });
  assert.equal(acquire(db, { resource: R, sessionId: 'B', now: 4 }).granted, false);
  assert.equal(acquire(db, { resource: R, sessionId: 'A', now: 5 }).granted, true);
});

test('a human hold is not ended by a dead-session check, only by its TTL', () => {
  holdHuman(db, { resource: R, ttlMs: 100, now: 0 });
  assert.equal(authorize(db, { resource: R, sessionId: 'A', now: 50, isLive: () => false }).reason, 'human');
  assert.equal(authorize(db, { resource: R, sessionId: 'A', now: 101 }).allowed, true);
});

test('resource names are validated', () => {
  assert.throws(() => validateResource('has space'), /invalid resource/);
  assert.throws(() => acquire(db, { resource: R }), /needs a session id/);
});

test('eight processes racing for a free resource: exactly one wins', async () => {
  const dbPath = path.join(tmp, 'state.db');
  const lib = fileURLToPath(new URL('../lib/resource-leases.mjs', import.meta.url));
  const store = fileURLToPath(new URL('../lib/store.mjs', import.meta.url));
  // Every child opens the store, then spins until one shared instant, so the acquires really overlap.
  const start = Date.now() + 1500;
  const script = (sid) =>
    `import {openStore} from ${JSON.stringify(store)};import {acquire} from ${JSON.stringify(lib)};` +
    `const db=openStore(${JSON.stringify(dbPath)});while(Date.now()<${start}){}` +
    `process.stdout.write(String(acquire(db,{resource:${JSON.stringify(R)},sessionId:${JSON.stringify(sid)}}).granted));db.close();`;
  const run = (sid) =>
    new Promise((resolve, reject) => {
      const c = spawn('node', ['--input-type=module', '-e', script(sid)], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('error', reject);
      c.on('exit', () => resolve(out));
    });
  const results = await Promise.all(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'].map(run));
  assert.equal(results.filter((r) => r === 'true').length, 1, results.join(','));
  assert.equal(results.filter((r) => r === 'false').length, 7, results.join(','));
  assert.equal(status(db, { resource: R }).queue.length, 7, 'the losers are in line');
});
