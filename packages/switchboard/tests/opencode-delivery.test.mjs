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
import { isOpencodeSessionId, resolveService, deliverPrompt, parsePromptStream, discoverServerUrls } from '../lib/opencode-server.mjs';
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

// The prompt's 200 is a Session.Inbox.User: it sits in the session's inbox
// until the agent consumes it, and only then is there a message to read. An
// attached seat that has not started a run therefore had every real delivery
// reported as unproven (exit 3, "could not be read back"), while the text was
// in the inbox all along. The accepted item's own home is the proof.
test('a prompt held in the session inbox is delivered, not unproven', async () => {
  const stub = await startStubServer({ inbox: true });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-inbox.json') });
  try {
    const r = await runEntry(['send', '--session', SID, '--text', 'waiting for the turn'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.answer?.ok, true);
    assert.equal(r.answer?.proof, 'inbox');
    assert.equal(r.answer?.messageId, stub.state.prompts[0].messageId);
    assert.deepEqual(stub.state.inboxReads.map((x) => x.sessionId), [SID]);
    assert.deepEqual(stub.state.reads, [], 'an unconsumed item is not looked for in the message log');
  } finally {
    await stub.close();
  }
});

// The ruling of 2026-11-28: a `queue` item is delivered only when the current
// work ends, and a seat looping inside one turn never ends it — window 3 held
// 18 notes that way. The drain turns the backlog into ONE steer, delivered
// before the agent's next model call, and each note carries the time it was
// queued so a stale one is visible as stale.
const jsonLines = (text) =>
  String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const queuedSeed = (id, text, iso) => ({
  id, sessionID: SID, type: 'user', delivery: 'queue', time: { created: Date.parse(iso) }, payload: { text },
});

test('send --drain folds a queued backlog into one steer, each note with the time it was queued', async () => {
  const stub = await startStubServer({
    inbox: true,
    inboxItems: [
      queuedSeed('msg_backlog01', 'first queued note', '2026-11-28T10:02:03.000Z'),
      queuedSeed('msg_backlog02', 'second queued note\nwith a second line', '2026-11-28T10:44:05.000Z'),
      queuedSeed('msg_backlog03', 'third queued note', '2026-11-28T11:22:00.000Z'),
    ],
  });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-drain-send.json') });
  try {
    const r = await runEntryWithStdin(
      ['send', '--session', SID, '--delivery', 'steer', '--drain', '--timeout', '8000'],
      { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg },
      'the new note\n',
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(stub.state.prompts.length, 2, 'one combined steer for the backlog, then the new note');
    const [combined, fresh] = stub.state.prompts;
    assert.equal(combined.body.delivery, 'steer');
    assert.match(combined.body.text, /3 notes queued while your turn was running/);
    assert.match(combined.body.text, /- \[queued 2026-11-28T10:02:03.000Z\] first queued note/);
    assert.match(combined.body.text, /- \[queued 2026-11-28T10:44:05.000Z\] second queued note\n {2}with a second line/, 'a multi-line note stays indented under its line');
    assert.match(combined.body.text, /- \[queued 2026-11-28T11:22:00.000Z\] third queued note/);
    assert.equal(fresh.body.text.trim(), 'the new note');
    assert.equal(fresh.body.delivery, 'steer');
    assert.deepEqual(stub.state.inboxDeletes.map((x) => x.id), ['msg_backlog01', 'msg_backlog02', 'msg_backlog03']);
    assert.ok(!stub.state.prompts.some((p) => p.body.delivery === 'queue'), 'no note is left on the never-ending queue');
    assert.ok(!stub.state.inboxItems.some((i) => i.delivery === 'queue'), 'the backlog is gone from the inbox');
    const drained = jsonLines(r.out).find((l) => l.phase === 'drained');
    assert.equal(drained?.drained, 3);
  } finally {
    await stub.close();
  }
});

test('drain alone posts the backlog as one steer, and a second drain with an empty inbox sends nothing', async () => {
  const stub = await startStubServer({
    inbox: true,
    inboxItems: [
      queuedSeed('msg_only00001', 'one held note', '2026-11-28T09:00:00.000Z'),
      queuedSeed('msg_only00002', 'another held note', '2026-11-28T09:30:00.000Z'),
    ],
  });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-drain-only.json') });
  try {
    const first = await runEntry(['drain', '--session', SID], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(first.code, 0, first.err);
    assert.equal(first.answer?.drained, 2);
    assert.equal(stub.state.prompts.length, 1);
    assert.equal(stub.state.prompts[0].body.delivery, 'steer');
    assert.match(stub.state.prompts[0].body.text, /2 notes queued/);
    assert.match(stub.state.prompts[0].body.text, /\[queued 2026-11-28T09:00:00.000Z\] one held note/);
    const second = await runEntry(['drain', '--session', SID], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(second.code, 0, second.err);
    assert.equal(second.answer?.drained, 0);
    assert.equal(stub.state.prompts.length, 1, 'the first drain is the only one that posts');
    assert.equal(stub.state.inboxDeletes.length, 2);
  } finally {
    await stub.close();
  }
});

test('a drain leaves a steer item alone: only what is waiting on the queue is coalesced', async () => {
  const stub = await startStubServer({
    inbox: true,
    inboxItems: [
      { id: 'msg_steer0001', sessionID: SID, type: 'user', delivery: 'steer', time: { created: Date.parse('2026-11-28T11:00:00.000Z') }, payload: { text: 'already going to the next call' } },
      queuedSeed('msg_queued001', 'held for the turn end', '2026-11-28T11:01:00.000Z'),
    ],
  });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-drain-mixed.json') });
  try {
    const r = await runEntry(['drain', '--session', SID], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.answer?.drained, 1);
    assert.deepEqual(stub.state.inboxDeletes.map((x) => x.id), ['msg_queued001'], 'the steer item is not deleted');
    assert.match(stub.state.prompts[0].body.text, /1 note queued/);
    assert.doesNotMatch(stub.state.prompts[0].body.text, /already going to the next call/);
  } finally {
    await stub.close();
  }
});

// A resume started with `--standalone` runs its own server on the loopback:
// the session lives there, and the shared registry's server only has the
// session's record, where it would take the prompt into an inbox nobody reads.
// The tab's own server is tried first, and the read-back is done on it.
test('the tab own server takes the prompt before the shared registry', async () => {
  const own = await startStubServer({ inbox: true });
  const shared = await startStubServer({ inbox: true });
  const reg = writeRegistry(dir, shared.port, shared.password, { file: path.join(dir, 'reg-own.json') });
  try {
    const r = await runEntry(
      ['send', '--session', SID, '--text', 'into the tab', '--server', own.url],
      { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg },
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.answer?.server, own.url);
    assert.equal(own.state.prompts.length, 1);
    assert.equal(own.state.inboxReads.length, 1);
    assert.equal(shared.state.prompts.length, 0, 'the shared server must not take a prompt it cannot deliver');
  } finally {
    await own.close();
    await shared.close();
  }
});

test('a candidate that does not know the session hands the prompt to the registry server', async () => {
  const own = await startStubServer({ promptStatus: 404 });
  const shared = await startStubServer({ inbox: true });
  const reg = writeRegistry(dir, shared.port, shared.password, { file: path.join(dir, 'reg-next.json') });
  try {
    const r = await runEntry(
      ['send', '--session', SID, '--text', 'the tab moved servers', '--server', own.url],
      { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg },
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.answer?.server, shared.url);
    assert.equal(shared.state.prompts.length, 1);
  } finally {
    await own.close();
    await shared.close();
  }
});

// A server that accepts the POST and then does not answer may have taken the
// prompt: the answer is what was lost. The walk stops there, because asking the
// next server would deliver the same text twice.
test('a candidate that does not answer ends the walk, never a second delivery', async () => {
  const own = await startStubServer({ inbox: true, delayMs: 5000 });
  const shared = await startStubServer({ inbox: true });
  const reg = writeRegistry(dir, shared.port, shared.password, { file: path.join(dir, 'reg-slow.json') });
  try {
    const r = await runEntry(
      ['send', '--session', SID, '--text', 'only once', '--server', own.url, '--timeout', '600'],
      { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg },
    );
    assert.equal(r.code, 12, r.err);
    assert.equal(shared.state.prompts.length, 0, 'the registry server was never asked');
  } finally {
    await own.close();
    await shared.close();
  }
});

// The tab's server is found from the tab: the process family's loopback
// listeners, the way the launcher finds them, so no registry has to know them.
test('send --pid reaches the server the tab process holds', async () => {
  const stub = await startStubServer({ inbox: true });
  // The registry is dead, and only its password is shared with the tab's own
  // server: the candidate list is what has to find the server that holds it.
  const reg = writeRegistry(dir, 1, stub.password, { file: path.join(dir, 'reg-dead.json') });
  try {
    const r = await runEntry(
      ['send', '--session', SID, '--text', 'find the tab server', '--pid', String(process.pid)],
      { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg },
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.answer?.server, stub.url);
    assert.equal(stub.state.prompts.length, 1);
  } finally {
    await stub.close();
  }
});

test('the servers a process family listens on are the candidate list', () => {
  const proc = fs.mkdtempSync(path.join(dir, 'fake-proc-'));
  const mk = (pid, children = []) => {
    fs.mkdirSync(path.join(proc, String(pid), 'task', String(pid)), { recursive: true });
    fs.mkdirSync(path.join(proc, String(pid), 'fd'), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), 'task', String(pid), 'children'), children.length ? `${children.join(' ')}\n` : '');
  };
  const fd = (pid, n, target) => fs.symlinkSync(target, path.join(proc, String(pid), 'fd', String(n)));
  mk(4001, [4002]);
  mk(4002, [4003]);
  mk(4003);
  fd(4001, 3, '/dev/null');
  fd(4002, 4, 'socket:[71]');
  fd(4003, 5, 'socket:[72]');
  const listening = new Map([[71, 5102], [72, 5101]]);
  assert.deepEqual(discoverServerUrls(4001, { procDir: proc, listening }), ['http://127.0.0.1:5101', 'http://127.0.0.1:5102']);
  assert.deepEqual(discoverServerUrls(4999, { procDir: proc, listening }), []);
  fs.rmSync(proc, { recursive: true, force: true });
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

// A `queue` delivery waits for the end of the current work, which a seat
// looping inside one turn never reaches: 18 notes were held that way by the
// supervisor on 2026-11-28. --queue therefore posts a steer (delivered before
// the agent's next model call, mid-work) and drains any backlog the inbox still
// holds as ONE combined note, each with the time it was queued.
test('agent-send --queue to an OpenCode seat steers mid-turn and folds the backlog into one note', async () => {
  const stub = await startStubServer({
    inbox: true,
    inboxItems: [queuedSeed('msg_held00001', 'earlier queued note', '2026-11-28T10:10:00.000Z')],
  });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-12.json') });
  writeBeacon();
  try {
    const r = await runSend(['--to', KEY, '--queue', '--text', 'when you finish, list the CI failures'], agentEnv(reg));
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(stub.state.prompts.length, 2);
    assert.equal(stub.state.prompts[0].body.delivery, 'steer', 'the backlog does not wait for the turn end');
    assert.match(stub.state.prompts[0].body.text, /\[queued 2026-11-28T10:10:00.000Z\] earlier queued note/);
    assert.equal(stub.state.prompts[1].body.delivery, 'steer', 'the new note does not wait for the turn end either');
    assert.equal(stub.state.prompts[1].body.text, 'when you finish, list the CI failures');
    assert.deepEqual(stub.state.inboxDeletes.map((x) => x.id), ['msg_held00001']);
  } finally {
    await stub.close();
  }
});

// A drain that cannot resolve stops the send before it posts: the new text was
// never sent, so its row must stay pending (a later drain delivers it), not be
// closed as an unproven delivery.
test('agent-send keeps the text pending when the drain itself is refused', async () => {
  const stub = await startStubServer({
    drainStatus: 500,
    inboxItems: [queuedSeed('msg_held00002', 'held note the drain could not fold', '2026-11-28T11:05:00.000Z')],
  });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-drain-refused.json') });
  writeBeacon();
  try {
    const r = await runSend(['--to', KEY, '--queue', '--deadline', '1', '--text', 'this text was never posted'], agentEnv(reg));
    assert.equal(r.code, 3, `${r.out}${r.err}`);
    assert.equal(stub.state.prompts.length, 0, 'the new text was not posted after the refused drain');
    assert.equal(stub.state.inboxReads.length, 1, 'the drain really asked the inbox, so the backlog was in the way');
    assert.equal(stub.state.inboxDeletes.length, 0, 'nothing was deleted while the combined note was refused');
    const rows = readRows(KEY, { dir: mboxDir });
    const msg = rows.find((x) => x && typeof x.id === 'string' && x.text === 'this text was never posted');
    assert.ok(msg, 'the text is queued in the mailbox');
    assert.equal(rows.find((x) => x && x.ack === msg.id), undefined, 'the row is not closed');
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
    // --status reads that marker back as "unproven, do not resend", not as a
    // delivery: the text may be in the session, and a resend could double it.
    const st = await runSend(['--status', '--id', msg.id], agentEnv(reg));
    assert.equal(st.code, 10, `${st.out}${st.err}`);
    assert.match(st.out, /delivery unproven/);
    assert.match(st.out, /look at the session/);
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

test("agent-send names the seat process, so a standalone tab's own server is asked", async () => {
  // The beacon's pid is the seat's own process, and a `--standalone` tab's
  // server is found from it. The entry here records its argv and answers
  // nothing, so the send falls back to the mailbox; the pid is what this pins.
  const argvFile = path.join(dir, `argv-${n}.json`);
  const entry = path.join(dir, `entry-argv-${n}.mjs`);
  fs.writeFileSync(entry, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n`);
  const reg = writeRegistry(dir, 1, 'x', { file: path.join(dir, 'reg-pid.json') });
  // The row's host identity is the client process (the default), the way an
  // OpenCode seat records it.
  writeBeacon();
  try {
    const r = await runSend(['--to', KEY, '--deadline', '1', '--text', 'let the tab server answer'], agentEnv(reg, { AGENT_SEND_OPENCODE_PROMPT: entry }));
    assert.equal(r.code, 3, `${r.out}${r.err}`);
    const args = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    assert.equal(args[args.indexOf('--pid') + 1], String(process.pid));
  } finally {
    fs.rmSync(entry, { force: true });
    fs.rmSync(argvFile, { force: true });
  }
});

test('a sender report names the file, never the registry password', async () => {  const secret = 'never-print-me-7c1d';
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
// ---- a slow server must never cause a second delivery ----------------------
//
// The hazard is structural: the helper makes two requests (POST, then the
// read-back) and a caller bounds the whole helper process. If the parent's
// kill lands after the POST was accepted but before the read-back answers, a
// caller that reads "no final JSON" as "nothing was sent" delivers the text a
// second time through the mailbox or kitty. Two rules close it: `--timeout` is
// ONE budget for both requests, and the helper prints an `accepted` line the
// moment the server takes the prompt, so a cut-off call is unproven, not absent.

test('the prompt entry splits one budget across both requests, not one each', async () => {
  const stub = await startStubServer({ readBackDelayMs: 3000 });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-17.json') });
  try {
    const started = Date.now();
    const r = await runEntry(['send', '--session', SID, '--text', 'one budget', '--timeout', '700'], {
      AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg,
    });
    const took = Date.now() - started;
    assert.equal(r.code, 3, `${r.out}${r.err}`);
    assert.equal(r.answer?.code, 'unproven');
    // The POST landed: the server has the text, so this is "do not resend".
    assert.equal(stub.state.prompts.length, 1);
    assert.ok(took < 2600, `the whole call must stay inside its budget, took ${took} ms`);
  } finally {
    await stub.close();
  }
});

test('a stream cut off after the accepted line is read as unproven, not as nothing sent', () => {
  const cut = `${JSON.stringify({ ok: true, phase: 'accepted', messageId: 'msg_cut' })}\n`;
  const parsed = parsePromptStream(cut);
  assert.equal(parsed.final, null);
  assert.equal(parsed.accepted?.messageId, 'msg_cut');
  // A truncated final line is not JSON and must not erase the marker either.
  const torn = `${cut}{"ok":true,"messageId":"msg_c`;
  assert.equal(parsePromptStream(torn).accepted?.messageId, 'msg_cut');
  // No marker and no final answer is genuinely "nothing was sent".
  assert.deepEqual(parsePromptStream(''), { final: null, accepted: null });
});

test('agent-send treats a helper killed after the POST as unproven: one copy, no fallback', async () => {
  const stub = await startStubServer({ readBackDelayMs: 5000 });
  const reg = writeRegistry(dir, stub.port, stub.password, { file: path.join(dir, 'reg-18.json') });
  writeBeacon();
  try {
    // The helper would wait for the slow read-back; the parent kills it first.
    const r = await runSend(['--to', KEY, '--text', 'exactly one copy'], agentEnv(reg, {
      AGENT_SEND_OPENCODE_TIMEOUT_MS: '4000',
      AGENT_SEND_OPENCODE_SPAWN_TIMEOUT_MS: '1200',
    }));
    assert.equal(r.code, 3, `${r.out}${r.err}`);
    assert.match(r.err, /do not resend/);
    // The server has the prompt once, and nothing was typed or queued after it.
    assert.equal(stub.state.prompts.length, 1);
    assert.equal(fs.existsSync(kittyLog), false);
    const rows = readRows(KEY, { dir: mboxDir });
    const msg = rows.find((x) => x && x.id && x.text === 'exactly one copy');
    const acked = rows.find((x) => x && x.ack === msg.id);
    assert.equal(acked?.deliveredAs, 'apiUnproven');
    assert.equal(msg.messageId, stub.state.prompts[0].messageId);
  } finally {
    await stub.close();
  }
});
