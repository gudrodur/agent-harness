// A busy store is waited out, never failed on first contact (#85).
// - an already-imported store is opened for a read without the write lock;
// - a send made while another connection holds the write lock past
//   busy_timeout lands once it releases;
// - a lock held past the deadline throws, never reporting a send that is not
//   in the store.
//
// Run: node --test tests/store-busy.test.mjs (or the full suite)

import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const MAILBOX = path.join(LIB, 'agent-mailbox.mjs');
const STORE = path.join(LIB, 'store.mjs');

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-busy-'));
  return { dir, db: path.join(dir, 'busy.db'), env: isolatedEnv({ AGENT_SWITCHBOARD_DB: path.join(dir, 'busy.db'), AGENT_SWITCHBOARD_DIR: path.join(dir, 'sb') }) };
};

const runChild = (code, env) =>
  new Promise((resolve) => {
    const child = spawn('node', ['--input-type=module', '-e', code], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const busy = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });

test('busy errors from both runtimes are recognised, and nothing else is', async () => {
  const { isStoreBusy } = await import('../lib/store.mjs');
  const bunBusy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', errno: 5 });
  const snapshot = Object.assign(busy(), { errcode: 517 });
  for (const e of [busy(), snapshot, bunBusy]) assert.equal(isStoreBusy(e), true, e.code);
  const corrupt = Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11 });
  for (const e of [corrupt, new Error('ENOENT'), null, 'database is locked']) assert.equal(isStoreBusy(e), false, String(e));
});

test('retryBusy waits out a busy store, throws past the deadline, never retries another error', async () => {
  const { retryBusy } = await import('../lib/store.mjs');
  let clock = 0;
  const opts = { deadlineMs: 1000, now: () => clock, sleep: (ms) => { clock += ms; } };
  let calls = 0;
  assert.equal(retryBusy(() => { calls += 1; if (calls < 4) throw busy(); return 'ok'; }, opts), 'ok');
  assert.equal(calls, 4);
  clock = 0;
  calls = 0;
  assert.throws(() => retryBusy(() => { calls += 1; throw busy(); }, opts), /database is locked/);
  assert.ok(calls > 1 && clock >= 1000, `retried until the deadline (calls ${calls}, clock ${clock})`);
  calls = 0;
  assert.throws(() => retryBusy(() => { calls += 1; throw new Error('no such table'); }, opts), /no such table/);
  assert.equal(calls, 1);
});

test('opening an already-imported store for a read takes no write lock', async () => {
  const { dir, db, env } = tmp();
  try {
    const seed = await runChild(`const m = await import(${JSON.stringify(MAILBOX)}); m.readPresenceBeacons({});`, env);
    assert.equal(seed.status, 0, seed.stderr);
    const holder = new DatabaseSync(db);
    holder.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
    try {
      const t0 = Date.now();
      const r = await runChild(`const m = await import(${JSON.stringify(MAILBOX)}); process.stdout.write(JSON.stringify(m.readPresenceBeacons({})));`, env);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), []);
      assert.ok(Date.now() - t0 < 4500, 'the read did not wait for busy_timeout');
    } finally {
      holder.exec('COMMIT;');
      holder.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a send made while another connection holds the write lock past busy_timeout lands', async () => {
  const { dir, db, env } = tmp();
  try {
    const seed = await runChild(`const m = await import(${JSON.stringify(MAILBOX)}); m.readPresenceBeacons({});`, env);
    assert.equal(seed.status, 0, seed.stderr);
    const holder = new DatabaseSync(db);
    holder.exec('BEGIN IMMEDIATE;');
    const child = runChild(
      `const m = await import(${JSON.stringify(MAILBOX)}); m.appendMessage({ to: 'busy__s', from: 'a', priority: 'queue', text: 'held' });`,
      env,
    );
    await sleep(6500); // past the 5 s busy_timeout: the first attempt throws SQLITE_BUSY
    holder.exec('COMMIT;');
    holder.close();
    const r = await child;
    assert.equal(r.status, 0, r.stderr);
    const check = new DatabaseSync(db);
    const rows = check.prepare("SELECT row_json FROM mailbox_rows WHERE recipient_key = 'busy__s'").all();
    check.close();
    assert.equal(rows.length, 1, 'the message is in the store');
    assert.equal(JSON.parse(rows[0].row_json).text, 'held');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock held past the deadline throws and no row is reported sent', async () => {
  const { dir, db, env } = tmp();
  try {
    const seed = await runChild(`const m = await import(${JSON.stringify(MAILBOX)}); m.readPresenceBeacons({});`, env);
    assert.equal(seed.status, 0, seed.stderr);
    const holder = new DatabaseSync(db);
    holder.exec('BEGIN IMMEDIATE;');
    try {
      const r = await runChild(
        `const s = await import(${JSON.stringify(STORE)});
const m = await import(${JSON.stringify(MAILBOX)});
try {
  m.appendMessage({ to: 'busy__d', from: 'a', priority: 'queue', text: 'never' });
  process.stdout.write('returned');
} catch (e) { process.stdout.write('threw:' + s.isStoreBusy(e)); }`,
        { ...env, AGENT_SWITCHBOARD_BUSY_DEADLINE_MS: '300' },
      );
      assert.equal(r.stdout, 'threw:true', r.stderr);
    } finally {
      holder.exec('COMMIT;');
      holder.close();
    }
    const check = new DatabaseSync(db);
    assert.equal(check.prepare("SELECT count(*) AS n FROM mailbox_rows WHERE recipient_key = 'busy__d'").get().n, 0);
    check.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('busyTimeoutMs reads AGENT_SWITCHBOARD_BUSY_TIMEOUT_MS and falls back to 5000 on anything invalid', async () => {
  const { busyTimeoutMs, STORE_BUSY_TIMEOUT_MS } = await import('../lib/store.mjs');
  assert.equal(STORE_BUSY_TIMEOUT_MS, 5000);
  assert.equal(busyTimeoutMs(undefined), 5000);
  assert.equal(busyTimeoutMs('250'), 250);
  assert.equal(busyTimeoutMs('0'), 0);
  for (const bad of ['', 'abc', '-5', '1.5', '25ms', 'NaN', 'Infinity']) assert.equal(busyTimeoutMs(bad), 5000, bad);
});
