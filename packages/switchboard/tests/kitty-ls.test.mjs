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
  assert.match(c.out, /^reason=overloaded$/m, 'the failure lines are on stdout too, for the shell reader');
  assert.doesNotMatch(c.out, /^\[/m, 'and nothing that parses as a list');
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
  assert.deepEqual([0, 1, 2, 3].map((a) => nextDelay(a, { ...opts, rand: () => 1 })), [2400, 4800, 9600, 10_000], 'the jitter never passes the cap');
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

test('created_at keeps every digit: kitty gives nanoseconds past 2^53, and a window id is matched on it', () => {
  const f = fixture();
  const BIG = '1795198327834963891';
  fs.writeFileSync(path.join(f.stub.dir, 'ls.json'), `[{"id":1,"tabs":[{"id":1,"title":"tab","windows":[{"id":11,"title":"one","pid":101,"created_at":${BIG}}]}]}]`);
  const cached = f.env({ AGENT_KITTY_LS_TTL_MS: '60000' });
  for (const [label, args, env] of [
    ['full', ['--fresh'], f.env()],
    ['narrow', ['--match', 'id:11', '--fresh'], f.env()],
    ['cache fill', [], cached],
    ['from the cache', [], cached],
  ]) {
    const r = cli(args, env);
    assert.equal(r.code, 0, `${label}: ${r.err}`);
    assert.match(r.out, new RegExp(`"created_at":${BIG}\\b`), `${label}: ${r.out}`);
  }
  // The shell reader, which every window-identity record goes through.
  const sh = spawnSync('bash', ['-c', `. ${JSON.stringify(fileURLToPath(new URL('../lib/kitty-ls.sh', import.meta.url)))}; win_record 11 fresh; echo "rc=$? created=$WREC_CREATED"`],
    { env: f.env({ PATH: `${f.stub.dir}:${process.env.PATH}` }), encoding: 'utf-8' });
  assert.equal(sh.stdout.trim(), `rc=0 created=${BIG}`, sh.stderr);
  fs.rmSync(f.root, { recursive: true, force: true });
});

// A fan-out (a broadcast, a wind-down) sends to many windows at once, each
// asking for its own window fresh. Against a kitty that takes 1.2 s a call,
// one lock for every read queued them past the waiters' deadline and failed
// the late ones with "busy"; each window id has its own lock, so they run side
// by side.
test('14. eight concurrent fresh reads of eight windows against a slow kitty all answer', async () => {
  const wins = Array.from({ length: 8 }, (_, i) => ({ id: 11 + i, title: `w${i}`, pid: 101 + i }));
  const fx = fixture({ windows: wins });
  fx.stub.setMode('slow:1.2');
  const env = fx.env({ AGENT_KITTY_LS_TTL_MS: '2000' });
  const rs = await Promise.all(wins.map((w) => importer(`m.kittyList({ match: "id:${w.id}", fresh: true })`, env)));
  rs.forEach((r, i) => {
    assert.equal(r.r?.ok, true, `window ${wins[i].id}: ${JSON.stringify(r.r)} ${r.err}`);
    assert.deepEqual(ids(r.r.data), [wins[i].id]);
  });
});

// A waiter whose holder is alive but has not answered by the waiter's
// deadline (the read timeout plus 1 s) makes its own read, unlocked, rather
// than fail with "busy": a slow kitty delays a send, it never fails it.
test('15. a waiter past its deadline behind a live holder reads kitty itself; it is never "busy"', async () => {
  const fx = fixture();
  const env = fx.env({ AGENT_KITTY_LS_TIMEOUT_MS: '500' });
  const key = (await importer('m.cacheKey()', env)).r;
  fs.mkdirSync(fx.stateDir, { recursive: true });
  // A live holder (this test process) that took the lock just now.
  fs.writeFileSync(path.join(fx.stateDir, `${key}.lock`), JSON.stringify({ pid: process.pid, at: Date.now() }));
  const r = await importer('m.kittyList({ fresh: true })', env);
  assert.equal(r.r?.ok, true, `${JSON.stringify(r.r)} ${r.err}`);
  assert.deepEqual(ids(r.r.data), [11, 12]);
  assert.ok(r.ms >= 1400 && r.ms < 2500, `waited ${r.ms} ms: past the 1.5 s deadline, before the lock counts as orphaned`);
  assert.equal(fx.stub.lsCalls().length, 1);
});

test('16. "no such window" drops the window from the full cache too: a later cached read does not find it', async () => {
  const fx = fixture();
  const env = fx.env({ AGENT_KITTY_LS_TTL_MS: '60000' });
  assert.deepEqual(ids((await importer('m.kittyLs()', env)).r), [11, 12]);
  fx.stub.setMode('nomatch');
  assert.deepEqual((await importer('m.kittyLs({ match: "id:11", fresh: true })', env)).r, []);
  assert.deepEqual((await importer('m.kittyLs({ match: "id:11" })', env)).r, [], 'not served from the older full answer');
});

test('17. a restarted kitty on the same socket path is another instance: its breaker and cache are not shared', async () => {
  const fx = fixture();
  const sock = path.join(fx.root, 'kitty.sock');
  fs.writeFileSync(sock, '');
  const env = fx.env({ KITTY_LISTEN_ON: `unix:${sock}` });
  const before = (await importer('m.cacheKey()', env)).r;
  assert.equal((await importer('m.cacheKey()', env)).r, before, 'the same socket keeps its key');
  // A new socket bound over the old path while the old file still exists:
  // both inodes are live at once, so they differ.
  const next = `${sock}.new`;
  fs.writeFileSync(next, '');
  fs.renameSync(next, sock);
  const renamed = (await importer('m.cacheKey()', env)).r;
  assert.notEqual(renamed, before, 'a socket renamed over the path is a new key');
  // Deleted and created again: the filesystem may hand the freed inode number
  // straight back, so the inode alone cannot tell the two apart. Pin the new
  // file to the old inode number in the stat the module sees.
  const ino = fs.statSync(sock, { bigint: true }).ino;
  // Past the kernel's coarse timestamp tick, so the change time moves.
  await new Promise((r) => setTimeout(r, 25));
  fs.rmSync(sock);
  fs.writeFileSync(sock, '');
  const reuse = path.join(fx.root, 'same-ino.cjs');
  fs.writeFileSync(reuse, [
    "const fs = require('node:fs');",
    'const real = fs.statSync;',
    `fs.statSync = (p, o) => { const st = real(p, o); if (p === ${JSON.stringify(sock)}) st.ino = o && o.bigint ? ${ino}n : Number(${ino}n); return st; };`,
    '',
  ].join('\n'));
  const reused = (await importer('m.cacheKey()', { ...env, NODE_OPTIONS: `--require ${reuse}` })).r;
  assert.notEqual(reused, renamed, 'a re-created socket that reuses the inode number is still a new key');
  const abstract = fx.env({ KITTY_LISTEN_ON: 'unix:@kitty-test', KITTY_PID: '4242' });
  const k1 = (await importer('m.cacheKey()', abstract)).r;
  const k2 = (await importer('m.cacheKey()', { ...abstract, KITTY_PID: '4343' })).r;
  assert.notEqual(k1, k2, 'an abstract socket is told apart by the kitty pid');
});

test('18. the jitter never takes a delay past the cap, in node and in the shell', async () => {
  const { nextDelay } = await import(BACKOFF);
  assert.equal(nextDelay(9, { baseMs: 5000, capMs: 60_000, rand: () => 1 }), 60_000);
  assert.equal(nextDelay(0, { baseMs: 5000, capMs: 60_000, rand: () => 1 }), 6000, 'below the cap the jitter still spreads up');
  const fx = fixture();
  const bin = path.join(fx.root, 'nosleep');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const lib = fileURLToPath(new URL('../lib/kitty-ls.sh', import.meta.url));
  const sh = spawnSync('bash', ['-c', `. ${JSON.stringify(lib)}; BACKOFF_ATTEMPT=5; for i in $(seq 60); do backoff_sleep; echo "$BACKOFF_SLEPT_MS"; done`],
    { env: fx.env({ PATH: `${bin}:${process.env.PATH}`, BACKOFF_BASE_MS: '1000', BACKOFF_CAP_MS: '4000' }), encoding: 'utf-8' });
  const slept = sh.stdout.trim().split('\n').map(Number);
  assert.equal(slept.length, 60, sh.stderr);
  for (const ms of slept) assert.ok(ms >= 3200 && ms <= 4000, `slept ${ms} ms past the 4000 ms cap`);
});

// The shell reader takes stdout alone: a node warning on stderr (a deprecation,
// a NODE_OPTIONS preload) must not turn a found window into "gone".
test('19. a warning on node\'s stderr does not change what the shell reader sees', () => {
  const fx = fixture();
  const warn = path.join(fx.root, 'warn.cjs');
  fs.writeFileSync(warn, 'process.stderr.write("(node) Warning: something deprecated\\n");\n');
  const lib = fileURLToPath(new URL('../lib/kitty-ls.sh', import.meta.url));
  const env = fx.env({ PATH: `${fx.stub.dir}:${process.env.PATH}`, NODE_OPTIONS: `--require ${warn}` });
  const sh = spawnSync('bash', ['-c', `. ${JSON.stringify(lib)}; win_record 11 fresh; echo "rc=$? pid=$WREC_PID"; live_pid_map fresh; echo "map=$? $(live_pid_of 12)"`], { env, encoding: 'utf-8' });
  assert.equal(sh.stdout.trim(), 'rc=0 pid=101\nmap=0 102', sh.stderr);
  fx.stub.setMode('refused');
  const down = spawnSync('bash', ['-c', `. ${JSON.stringify(lib)}; win_record 11 fresh; echo "rc=$? reason=$KITTY_LS_REASON"`], { env, encoding: 'utf-8' });
  assert.equal(down.stdout.trim(), 'rc=2 reason=unreachable', down.stderr);
});
