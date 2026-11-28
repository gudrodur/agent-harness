// Delivery into an OpenCode seat, through its server's own API.
//
// The sender and the prompt entry talk to a real (stub) HTTP server on the
// loopback, so these tests prove the request itself: the path, the `directory`
// query, the JSON body, the basic-auth header, the message id the server
// answers with, and the read-back that is the proof of delivery. A stubbed
// function would have agreed with itself on any shape.
//
// They also pin the two things that must never happen: the registry password
// reaching the caller's output, and a delivered prompt being delivered a second
// time by the recipient's own mailbox drain.
//
// Run: node --test tests/opencode-delivery.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { startStubServer, writeRegistry } from './helpers/opencode-stub.mjs';
import { isOpencodeSessionId, resolveService, deliverPrompt } from '../lib/opencode-server.mjs';
import { listSeats, readRows, resetOpencodeLivenessCache } from '../lib/agent-mailbox.mjs';
import { procStat, currentBootId } from '../lib/presence.mjs';

const run = promisify(execFile);
const ENTRY = fileURLToPath(new URL('../bin/opencode-prompt.mjs', import.meta.url));
const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));
const STUB_CHILD = fileURLToPath(new URL('./helpers/opencode-stub-child.mjs', import.meta.url));

let dir;
const SID = 'ses_stubStubStub01';
const KEY = `-repo-a__${SID}`;

// The stub server lives in THIS process, so the child must run asynchronously:
// spawnSync would block the event loop that has to answer the child's requests.
const runEntry = async (args, env, input = '') => {
  try {
    const r = await run(process.execPath, [ENTRY, ...args], {
      encoding: 'utf8', timeout: 30_000, env: isolatedEnv(env),
    });
    return { code: 0, out: r.stdout ?? '', err: r.stderr ?? '', answer: lastJson(r.stdout) };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '', answer: lastJson(e.stdout) };
  }
};

// A run that feeds stdin: promisified execFile has no input option, and the
// text must arrive on stdin (a real sender's argv is not where it goes).
const runEntryWithStdin = (args, env, input) => new Promise((resolve) => {
  const child = spawn(process.execPath, [ENTRY, ...args], { env: isolatedEnv(env) });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('close', (code) => resolve({ code, out, err, answer: lastJson(out) }));
  child.stdin.end(input);
});

const lastJson = (text) => {
  const line = String(text ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const runSend = async (args, env) => {
  try {
    const r = await run(process.execPath, [SEND, ...args], { encoding: 'utf8', timeout: 40_000, env: isolatedEnv(env) });
    return { code: 0, out: r.stdout ?? '', err: r.stderr ?? '' };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-delivery-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
let mboxDir;
let presFile;
let kittyLog;
let kittyStub;
beforeEach(() => {
  n += 1;
  mboxDir = path.join(dir, `mbox-${n}`);
  presFile = path.join(dir, `presence-${n}.json`);
  kittyLog = path.join(dir, `kitty-${n}.log`);
  kittyStub = path.join(dir, `kitty-send-${n}.sh`);
  // Any kitty call is recorded and reported as "nothing sent": no test here may
  // depend on typing into a window, and a test that reaches it should fail
  // loudly rather than pass by accident.
  fs.writeFileSync(kittyStub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(kittyLog)}\nexit 5\n`, { mode: 0o755 });
  fs.mkdirSync(mboxDir, { recursive: true });
});

const writeBeacon = (over = {}) => {
  const now = new Date().toISOString();
  // A full host identity (boot id + pid + start) is what makes a row past the
  // freshness TTL readable as a parked seat rather than an unknown one.
  const st = procStat(process.pid);
  fs.writeFileSync(presFile, JSON.stringify({
    beacons: [{
      sessionId: SID, cwd: '/repo/a', branch: 'main', repo: 'x/repo', mailbox: true,
      windowId: 991001, firstTick: now, lastTick: now,
      ...(st ? { hostPid: process.pid, hostStart: st.start, bootId: currentBootId() } : {}),
      ...over,
    }],
  }));
};

const agentEnv = (registry, extra = {}) => ({
  AGENT_MAILBOX_DIR: mboxDir,
  AGENT_MAILBOX_PRESENCE_FILE: presFile,
  AGENT_MAILBOX_KITTY: path.join(dir, 'no-kitty'),
  AGENT_SEND_KITTY_SEND: kittyStub,
  AGENT_SWITCHBOARD_OPENCODE_SERVICE: registry,
  AGENT_SEND_BUDGET_S: '2',
  AGENT_SEND_IDLE_WAIT_S: '0',
  AGENT_SEND_BUSY_WAIT_S: '1',
  ...extra,
});

// ---- the prompt entry: request shape, read-back, and the codes -------------

test('send posts the text with its delivery and reads the message back', async () => {
  const stub = await startStubServer();
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-1.json') });
  try {
    const r = await runEntry(['send', '--session', SID, '--delivery', 'queue', '--directory', '/repo/a', '--text', 'prompt from the test'], {
      AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg,
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.answer?.ok, true);
    assert.match(r.answer?.messageId ?? '', /^msg_stub/);
    assert.equal(stub.state.prompts.length, 1);
    const p = stub.state.prompts[0];
    assert.equal(p.sessionId, SID);
    assert.deepEqual(p.body, { text: 'prompt from the test', delivery: 'queue' });
    assert.equal(p.query.directory, '/repo/a');
    assert.deepEqual(stub.state.reads, [{ sessionId: SID, messageId: p.messageId }]);
    assert.equal(stub.state.authFailures, 0);
    assert.match(r.err, /delivered to/);
  } finally {
    await stub.close();
  }
}, { skip: false });

// The text comes from stdin in every real caller (a process's argv is
// readable by any user), and the body shape must not change for it.
test('send takes the text on stdin, one line, as the senders pass it', async () => {
  const stub = await startStubServer();
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-2.json') });
  try {
    const r = await runEntryWithStdin(['send', '--session', SID, '--delivery', 'steer'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg }, 'line one\nline two');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(stub.state.prompts[0].body, { text: 'line one\nline two', delivery: 'steer' });
    // No directory was named, so the query stays empty rather than guessing one.
    assert.deepEqual(stub.state.prompts[0].query, {});
  } finally {
    await stub.close();
  }
});

test('a prompt the server took but cannot read back is exit 3, never silent', async () => {
  const stub = await startStubServer({ readBack: 'missing' });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-3.json') });
  try {
    const r = await runEntry(['send', '--session', SID, '--text', 'only once'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 3, r.err);
    assert.equal(r.answer?.ok, false);
    assert.equal(r.answer?.code, 'unproven');
    assert.match(r.answer?.messageId ?? '', /^msg_stub/);
    assert.match(r.err, /do not resend/);
  } finally {
    await stub.close();
  }
});

test('a read-back that answers with another id is unproven too', async () => {
  const stub = await startStubServer({ readBack: 'different' });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-4.json') });
  try {
    const r = await runEntry(['send', '--session', SID, '--text', 'only once'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 3, r.err);
    assert.equal(r.answer?.code, 'unproven');
  } finally {
    await stub.close();
  }
});

test('a session the server does not know is exit 1 and says so', async () => {
  const stub = await startStubServer({ promptStatus: 404 });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-5.json') });
  try {
    const r = await runEntry(['send', '--session', SID, '--text', 'hello'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 1);
    assert.equal(r.answer?.code, 'not-found');
    assert.equal(stub.state.reads.length, 0);
  } finally {
    await stub.close();
  }
});

test('a password the server refuses is exit 1, and the password is never printed', async () => {
  const stub = await startStubServer({ password: 'the-right-one' });
  const secret = 'the-wrong-one-9f3a';
  const reg = writeRegistry(dir, stub.port, secret, { file: path.join(dir, 'reg-6.json') });
  try {
    const r = await runEntry(['send', '--session', SID, '--text', 'hello'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 1);
    assert.equal(r.answer?.code, 'unauthorized');
    assert.equal(stub.state.authFailures, 1);
    assert.doesNotMatch(`${r.out}${r.err}`, new RegExp(secret));
    assert.doesNotMatch(`${r.out}${r.err}`, /Basic [A-Za-z0-9+/=]{8,}/);
  } finally {
    await stub.close();
  }
});

test('no registry and no server: exit 12, nothing attempted', async () => {
  const r = await runEntry(['send', '--session', SID, '--text', 'hello'], {
    AGENT_SWITCHBOARD_OPENCODE_SERVICE: path.join(dir, 'no-such-registry.json'),
  });
  assert.equal(r.code, 12);
  assert.equal(r.answer?.code, 'unconfigured');
  assert.match(r.err, /registry/);
});

test('a registry that answers nothing at all is exit 12, not a hang', async () => {
  // A port nothing listens on: the connection is refused at once.
  const reg = writeRegistry(dir, 1, 'x', { file: path.join(dir, 'reg-7.json') });
  const r = await runEntry(['send', '--session', SID, '--text', 'hello', '--timeout', '1500'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
  assert.equal(r.code, 12);
  assert.equal(r.answer?.code, 'unreachable');
});

test('a session id that is not OpenCode is refused before any request', async () => {
  const r = await runEntry(['send', '--session', '4e1f5a90-0000-4000-8000-000000000000', '--text', 'hello'], {
    AGENT_SWITCHBOARD_OPENCODE_SERVICE: path.join(dir, 'no-such-registry.json'),
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /not an OpenCode session id/);
});

test('active names the sessions the server reports running', async () => {
  const stub = await startStubServer({ active: [SID, 'ses_otherOther02'] });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-8.json') });
  try {
    const r = await runEntry(['active'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.answer, { ok: true, running: [SID, 'ses_otherOther02'].sort() });
  } finally {
    await stub.close();
  }
});

test('sessions carry the directory the prompt call names', async () => {
  const stub = await startStubServer({ sessions: [{ id: SID, location: { directory: '/repo/a' } }] });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-9.json') });
  try {
    const r = await runEntry(['sessions'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.answer?.sessions, [{ id: SID, directory: '/repo/a' }]);
  } finally {
    await stub.close();
  }
});

test('the service registry: config port first, password from the first that has one', () => {
  const cfg = path.join(dir, 'cfg-service.json');
  const state = path.join(dir, 'state-service.json');
  fs.writeFileSync(cfg, JSON.stringify({ port: 4123 }));
  fs.writeFileSync(state, JSON.stringify({ port: 4999, password: 'from-state' }));
  const svc = resolveService({ files: [cfg, state] });
  assert.equal(svc.url, 'http://127.0.0.1:4123');
  assert.equal(svc.password, 'from-state');
  assert.equal(svc.source, state);
  assert.equal(resolveService({ files: [path.join(dir, 'none.json')] }).url, null);
});

test('only ses_-shaped ids are OpenCode sessions', () => {
  assert.equal(isOpencodeSessionId(SID), true);
  assert.equal(isOpencodeSessionId('4e1f5a90-0000-4000-8000-000000000000'), false);
  assert.equal(isOpencodeSessionId('ses_'), false);
  assert.equal(isOpencodeSessionId(null), false);
});

test('deliverPrompt refuses a delivery mode the server does not have', async () => {
  const r = await deliverPrompt({ sessionId: SID, text: 'x', delivery: 'later', service: { url: 'http://127.0.0.1:1', password: 'x' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'refused');
});

// ---- the sender: an OpenCode seat is reached without kitty -----------------

test('agent-send delivers to an OpenCode seat through its server and closes the row', async () => {
  const stub = await startStubServer();
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-11.json') });
  writeBeacon();
  try {
    const r = await runSend(['--to', KEY, '--text', 'carry on with the render'], agentEnv(reg));
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.err, /through its OpenCode server/);
    assert.match(r.err, new RegExp(stub.state.prompts[0].messageId));
    assert.equal(stub.state.prompts.length, 1);
    assert.equal(stub.state.prompts[0].body.text, 'carry on with the render');
    assert.equal(stub.state.prompts[0].body.delivery, 'steer');
    assert.equal(stub.state.prompts[0].query.directory, '/repo/a');
    // Nothing was typed into any window.
    assert.equal(fs.existsSync(kittyLog), false);
    // The row exists and is closed as an api delivery, so the recipient's own
    // drain cannot deliver the same text again.
    const rows = readRows(KEY, { dir: mboxDir });
    const msg = rows.find((x) => x && typeof x.id === 'string' && x.text === 'carry on with the render');
    assert.ok(msg, 'the delivery left a message row');
    const acked = rows.find((x) => x && x.ack === msg.id);
    assert.equal(acked?.deliveredAs, 'api');
    assert.equal(msg.delivery, 'steer');
    assert.equal(msg.messageId, stub.state.prompts[0].messageId);
  } finally {
    await stub.close();
  }
});

test('agent-send --queue asks the server to queue after the current work', async () => {
  const stub = await startStubServer();
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-12.json') });
  writeBeacon();
  try {
    const r = await runSend(['--to', KEY, '--queue', '--text', 'when you finish, list the CI failures'], agentEnv(reg));
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(stub.state.prompts[0].body.delivery, 'queue');
  } finally {
    await stub.close();
  }
});

test('agent-send reports an unproven prompt as exit 3 and does not let it arrive twice', async () => {
  const stub = await startStubServer({ readBack: 'missing' });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-13.json') });
  writeBeacon();
  try {
    const r = await runSend(['--to', KEY, '--text', 'one copy only'], agentEnv(reg));
    assert.equal(r.code, 3, `${r.out}${r.err}`);
    assert.match(r.err, /not resent/);
    assert.equal(fs.existsSync(kittyLog), false);
    const rows = readRows(KEY, { dir: mboxDir });
    const msg = rows.find((x) => x && x.id && x.text === 'one copy only');
    const acked = rows.find((x) => x && x.ack === msg.id);
    assert.equal(acked?.deliveredAs, 'apiUnproven');
  } finally {
    await stub.close();
  }
});

test('agent-send falls back to the mailbox when no server answers', async () => {
  const reg = writeRegistry(dir, 1, 'x', { file: path.join(dir, 'reg-14.json') });
  writeBeacon();
  const r = await runSend(['--to', KEY, '--deadline', '1', '--text', 'the server is down'], agentEnv(reg));
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  // It queued a row (closed or not) and never reported delivery.
  const rows = readRows(KEY, { dir: mboxDir });
  const msg = rows.find((x) => x && x.id && x.text === 'the server is down');
  assert.ok(msg, 'the text is in the mailbox');
  assert.doesNotMatch(r.err, /through its OpenCode server/);
});

test('a sender report names the file, never the registry password', async () => {
  const secret = 'never-print-me-7c1d';
  const stub = await startStubServer({ password: secret });
  const reg = writeRegistry(dir, stub.port, secret, { file: path.join(dir, 'reg-15.json') });
  writeBeacon();
  try {
    const r = await runSend(['--to', KEY, '--text', 'a message'], agentEnv(reg));
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.doesNotMatch(`${r.out}${r.err}`, new RegExp(secret));
  } finally {
    await stub.close();
  }
});

// ---- liveness: the server's word beats a stale beacon ----------------------

// `listSeats` asks the server synchronously (the listing must have its answer
// before it returns), so the stub has to live in another process: one in this
// one could not answer while the call blocks.
const startChildStub = async (opts) => {
  const child = spawn(process.execPath, [STUB_CHILD, JSON.stringify(opts)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`child stub said nothing: ${buf}`)), 10_000);
    child.stdout.on('data', (c) => {
      buf += c;
      const line = buf.split('\n')[0];
      if (line && /^\d+$/.test(line.trim())) {
        clearTimeout(timer);
        resolve(Number(line.trim()));
      }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`child stub exited ${code}: ${buf}`)); });
  });
  return { port, close: () => new Promise((resolve) => { child.on('exit', resolve); child.kill(); }) };
};

test('a seat its server reports running is listed live, not idle', async () => {
  const stub = await startChildStub({ active: [SID], password: 'child-password' });
  const reg = writeRegistry(dir, stub.port, 'child-password', { file: path.join(dir, 'reg-16.json') });
  writeBeacon({ lastTick: new Date(Date.now() - 25 * 60_000).toISOString() });
  try {
    process.env.AGENT_SWITCHBOARD_OPENCODE_SERVICE = path.join(dir, 'no-such-registry.json');
    resetOpencodeLivenessCache();
    const before = listSeats({ presenceFile: presFile, wins: [] });
    const idle = before.find((s) => s.sessionId === SID);
    assert.ok(idle, 'the parked seat is still listed');
    assert.ok(idle.idleMinutes != null, 'without the server it reads as idle');

    process.env.AGENT_SWITCHBOARD_OPENCODE_SERVICE = reg;
    resetOpencodeLivenessCache();
    const after = listSeats({ presenceFile: presFile, wins: [] });
    const live = after.find((s) => s.sessionId === SID);
    assert.equal(live?.serverRunning, true);
    assert.equal(live?.idleMinutes, undefined);
    assert.equal(live?.state, 'fresh');
  } finally {
    process.env.AGENT_SWITCHBOARD_OPENCODE_SERVICE = path.join(dir, 'no-such-registry.json');
    resetOpencodeLivenessCache();
    await stub.close();
  }
});
