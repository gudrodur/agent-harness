// Tests for lib/kitty-ls.mjs: the shared cache, the one-call-in-flight lock and
// the circuit breaker in front of `kitty @ ls`, and lib/backoff.mjs's curve.
//
// Every read runs in a child process (the state is shared between processes,
// not inside one), against tests/helpers/kitty-stub.mjs, with its own
// AGENT_KITTY_LS_DIR so no test sees another's cache or breaker.
//
// Run: node --import ./tests/helpers/isolate-setup.mjs --test tests/kitty-ls.test.mjs
import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { makeKittyStub } from './helpers/kitty-stub.mjs';

const LIB = new URL('../lib/kitty-ls.mjs', import.meta.url).href;
const CLI = fileURLToPath(new URL('../lib/kitty-ls.mjs', import.meta.url));
const BACKOFF = new URL('../lib/backoff.mjs', import.meta.url).href;

const fixture = (opts = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kitty-ls-test-'));
  const stub = makeKittyStub(path.join(root, 'stub'), opts);
  const stateDir = path.join(root, 'state');
  const env = (extra = {}) => isolatedEnv({
    AGENT_MAILBOX_KITTY: stub.bin,
    AGENT_KITTY_LS_DIR: stateDir,
    AGENT_KITTY_LS_TTL_MS: '0',
    KITTY_LISTEN_ON: 'unix:kitty-ls-test',
    ...extra,
  });
  const breakerFile = () => (fs.existsSync(stateDir) ? fs.readdirSync(stateDir).find((f) => f.endsWith('.breaker.json')) : undefined);
  const readBreaker = () => { const f = breakerFile(); return f ? JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf-8')) : null; };
  return { root, stub, stateDir, env, breakerFile, readBreaker };
};

// One read in a fresh process: `expr` runs with the module as `m`; the child
// prints {ms, r, down} (the read's own duration, its result, kittyKnownDown).
const importer = (expr, env) => new Promise((resolve) => {
  const code = `const m = await import(${JSON.stringify(LIB)}); const t0 = Date.now(); let r; try { r = await (async () => (${expr}))(); } catch (e) { r = { threw: String(e) }; } process.stdout.write(JSON.stringify({ ms: Date.now() - t0, r: r === undefined ? null : r, down: typeof m.kittyKnownDown === 'function' ? m.kittyKnownDown() : null }));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (status) => {
    let parsed = null;
    try { parsed = JSON.parse(out); } catch { /* left null */ }
    resolve({ status, err, ...(parsed ?? { r: null, ms: null, down: null }) });
  });
});
const cli = (args, env) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8' });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (ls) => (ls ?? []).flatMap((o) => o.tabs ?? []).flatMap((t) => t.windows ?? []).map((w) => w.id);

test('1. eight concurrent readers against a slow kitty make one ls call', async () => {
  const fx = fixture();
  fx.stub.setMode('slow:0.5');
  const env = fx.env({ AGENT_KITTY_LS_TTL_MS: '5000' });
  const rs = await Promise.all(Array.from({ length: 8 }, () => importer('m.kittyLs()', env)));
  for (const r of rs) assert.deepEqual(ids(r.r), [11, 12], r.err);
  assert.equal(fx.stub.lsCalls().length, 1, fx.stub.calls().join('\n'));
});

test('2. two reads within the TTL make one call; after the TTL, two', async () => {
  const fx = fixture();
  const env = fx.env({ AGENT_KITTY_LS_TTL_MS: '400' });
  await importer('m.kittyLs()', env);
  await importer('m.kittyLs()', env);
  assert.equal(fx.stub.lsCalls().length, 1);
  await sleep(500);
  await importer('m.kittyLs()', env);
  assert.equal(fx.stub.lsCalls().length, 2);
});

test('3. a fresh read after a cached one asks kitty again and never returns an older answer', async () => {
  const fx = fixture({ windows: [{ id: 11, title: 'n=__N__', pid: 101 }], counting: true });
  const env = fx.env({ AGENT_KITTY_LS_TTL_MS: '60000' });
  const first = await importer('m.kittyLs()', env);
  assert.equal(first.r[0].tabs[0].windows[0].title, 'n=1');
  const fresh = await importer('m.kittyLs({ fresh: true })', env);
  assert.equal(fresh.r[0].tabs[0].windows[0].title, 'n=2');
  const cached = await importer('m.kittyLs()', env);
  assert.equal(cached.r[0].tabs[0].windows[0].title, 'n=2', 'the cache holds the newer answer');
  assert.equal(fx.stub.lsCalls().length, 2);
});

test('4. a timeout opens the breaker: five more readers add no call and return at once; the CLI exits 75', async () => {
  const fx = fixture();
  fx.stub.setMode('hang');
  const env = fx.env({ AGENT_KITTY_LS_TIMEOUT_MS: '300' });
  const first = await importer('m.kittyList()', env);
  assert.equal(first.r?.ok, false, first.err);
  assert.equal(first.r.reason, 'timeout');
  assert.equal(fx.stub.lsCalls().length, 1);
  const rs = await Promise.all(Array.from({ length: 5 }, () => importer('m.kittyList({ fresh: true })', env)));
  for (const r of rs) {
    assert.equal(r.r?.reason, 'overloaded', r.err);
    assert.ok(r.ms < 200, `returned in ${r.ms} ms`);
    assert.equal(r.down, true);
  }
  assert.equal(fx.stub.lsCalls().length, 1, 'no call while the breaker is open');
  const c = cli(['--match', 'id:11', '--fresh'], env);
  assert.equal(c.code, 75, c.err);
  assert.match(c.err, /overloaded.*backing off until/);
  assert.match(c.err, /^retry_in_ms=\d+$/m);
  assert.equal(c.out, '');
  assert.equal(fx.stub.lsCalls().length, 1);
});

test('5. repeated timeouts double the interval; a success deletes the breaker', async () => {
  const fx = fixture();
  fx.stub.setMode('hang');
  const env = fx.env({ AGENT_KITTY_LS_TIMEOUT_MS: '200', AGENT_KITTY_LS_BREAKER_BASE_MS: '300' });
  await importer('m.kittyList()', env);
  const b1 = fx.readBreaker();
  assert.equal(b1.failures, 1);
  assert.ok(b1.until - b1.openedAt >= 240 && b1.until - b1.openedAt <= 360, `first interval ${b1.until - b1.openedAt}`);
  await sleep(Math.max(0, b1.until - Date.now()) + 30);
  await importer('m.kittyList()', env);
  const b2 = fx.readBreaker();
  assert.equal(b2.failures, 2);
  assert.ok(b2.until - b2.openedAt >= 480 && b2.until - b2.openedAt <= 720, `second interval ${b2.until - b2.openedAt}`);
  assert.equal(fx.stub.lsCalls().length, 2);
  fx.stub.setMode('ok');
  await sleep(Math.max(0, b2.until - Date.now()) + 30);
  const ok = await importer('m.kittyList()', env);
  assert.equal(ok.r.ok, true, ok.err);
  assert.equal(fx.breakerFile(), undefined, 'the breaker file is gone');
});

test('6. connection refused opens no breaker, and the next read asks again', async () => {
  const fx = fixture();
  fx.stub.setMode('refused');
  const env = fx.env();
  const r = await importer('m.kittyList()', env);
  assert.equal(r.r.ok, false);
  assert.equal(r.r.reason, 'unreachable');
  assert.match(r.r.detail, /Connection refused/);
  assert.equal(r.down, true);
  assert.equal(fx.breakerFile(), undefined);
  await importer('m.kittyList()', env);
  assert.equal(fx.stub.lsCalls().length, 2);
  const c = cli([], env);
  assert.equal(c.code, 2);
  assert.match(c.err, /^reason=unreachable$/m);
});

test('7. a narrow read of a missing window is [] ("gone"): kitty is up and no breaker opens', async () => {
  const fx = fixture();
  fx.stub.setMode('nomatch');
  const env = fx.env();
  const r = await importer('m.kittyList({ match: "id:5" })', env);
  assert.deepEqual(r.r, { ok: true, data: [] });
  assert.equal(r.down, false);
  assert.equal(fx.breakerFile(), undefined);
  assert.match(fx.stub.lsCalls()[0], / @ ls --match id:5$/);
  const c = cli(['--match', 'id:5'], env);
  assert.equal(c.code, 0, c.err);
  assert.equal(c.out.trim(), '[]');
});

test('8. a narrow read with the cache allowed: a present id comes from the cache, an absent one asks kitty', async () => {
  const fx = fixture();
  const env = fx.env({ AGENT_KITTY_LS_TTL_MS: '60000' });
  await importer('m.kittyLs()', env);
  assert.equal(fx.stub.lsCalls().length, 1);
  const present = await importer('m.kittyLs({ match: "id:11" })', env);
  assert.deepEqual(ids(present.r), [11]);
  assert.equal(fx.stub.lsCalls().length, 1, 'served from the cache');
  const absent = await importer('m.kittyLs({ match: "id:99" })', env);
  assert.deepEqual(absent.r, []);
  assert.equal(fx.stub.lsCalls().length, 2);
  assert.match(fx.stub.lsCalls()[1], / @ ls --match id:99$/);
});

test('9. a kitty that rejects --match gets the full read, filtered here, for the rest of the process', async () => {
  const fx = fixture();
  fx.stub.setMode('badopt');
  const env = fx.env();
  const r = await importer('[m.kittyLs({ match: "id:11" }), m.kittyLs({ match: "id:12" })]', env);
  assert.deepEqual(ids(r.r[0]), [11]);
  assert.deepEqual(ids(r.r[1]), [12]);
  const calls = fx.stub.lsCalls().map((l) => l.replace(/^\d+ /, ''));
  assert.deepEqual(calls, ['@ ls --match id:11', '@ ls', '@ ls']);
});

test('10. another kitty binary or another kitty instance never shares a cache', async () => {
  const fx = fixture();
  const other = makeKittyStub(path.join(fx.root, 'stub2'));
  const env = fx.env({ AGENT_KITTY_LS_TTL_MS: '60000' });
  await importer('m.kittyLs()', env);
  await importer('m.kittyLs()', { ...env, AGENT_MAILBOX_KITTY: other.bin });
  assert.equal(fx.stub.lsCalls().length, 1);
  assert.equal(other.lsCalls().length, 1);
  await importer('m.kittyLs()', { ...env, KITTY_LISTEN_ON: 'unix:another-kitty' });
  assert.equal(fx.stub.lsCalls().length, 2);
});

test('11. a lock left by a dead process does not delay the read', async () => {
  const fx = fixture();
  const env = fx.env();
  const key = (await importer('m.cacheKey()', env)).r;
  assert.match(String(key), /^[0-9a-f]+$/);
  const dead = spawnSync('true').pid;
  fs.mkdirSync(fx.stateDir, { recursive: true });
  fs.writeFileSync(path.join(fx.stateDir, `${key}.lock`), JSON.stringify({ pid: dead, at: Date.now() }));
  const r = await importer('m.kittyList()', env);
  assert.equal(r.r.ok, true, r.err);
  assert.ok(r.ms < 1000, `took ${r.ms} ms`);
  assert.equal(fx.stub.lsCalls().length, 1);
});

test('12. no result and no cache file carries a window\'s env', async () => {
  const fx = fixture({ windows: [{ id: 11, title: 'one', pid: 101, env: { SECRET_TOKEN: 'leak' } }] });
  const env = fx.env({ AGENT_KITTY_LS_TTL_MS: '60000' });
  const full = await importer('m.kittyLs()', env);
  const narrow = await importer('m.kittyLs({ match: "id:11", fresh: true })', env);
  const c = cli(['--match', 'id:11'], env);
  for (const out of [JSON.stringify(full.r), JSON.stringify(narrow.r), c.out]) {
    assert.ok(out.includes('"id":11'), out);
    assert.doesNotMatch(out, /SECRET_TOKEN|"env"/);
  }
  const files = fs.readdirSync(fx.stateDir);
  assert.ok(files.some((f) => f.endsWith('.json')), files.join(','));
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(fx.stateDir, f), 'utf-8'), /SECRET_TOKEN|"env"/, f);
});

test('13. nextDelay follows the doubling curve to the cap, within the jitter bounds', async () => {
  const { nextDelay } = await import(BACKOFF);
  const opts = { baseMs: 2000, capMs: 10_000 };
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((a) => nextDelay(a, { ...opts, rand: () => 0.5 })), [2000, 4000, 8000, 10_000, 10_000, 10_000]);
  assert.deepEqual([0, 1, 2, 3].map((a) => nextDelay(a, { ...opts, rand: () => 0 })), [1600, 3200, 6400, 8000]);
  assert.deepEqual([0, 1, 2, 3].map((a) => nextDelay(a, { ...opts, rand: () => 1 })), [2400, 4800, 9600, 12_000]);
  assert.equal(nextDelay(2, { baseMs: 5000, capMs: 60_000, factor: 3, jitter: 0, rand: () => 0.9 }), 45_000);
  for (let i = 0; i < 200; i += 1) {
    const d = nextDelay(1, opts);
    assert.ok(d >= 3200 && d <= 4800, String(d));
  }
});

test('the probe: a narrow read of this window; "no such window" and unreadable output still mean kitty answered', async () => {
  const fx = fixture();
  fx.stub.setMode('nomatch');
  const env = fx.env({ KITTY_WINDOW_ID: '42' });
  assert.equal(cli(['--probe'], env).code, 0);
  assert.match(fx.stub.lsCalls().at(-1), / @ ls --match id:42$/);
  fs.writeFileSync(path.join(fx.stub.dir, 'ls.json'), 'not json');
  fx.stub.setMode('ok');
  assert.equal(cli(['--probe'], env).code, 0);
  assert.equal(cli([], env).code, 2, 'a real read of the same output is not an answer');
  fx.stub.setMode('refused');
  const down = cli(['--probe'], env);
  assert.equal(down.code, 2);
  assert.match(down.err, /^detail=.*Connection refused/m);
});
