// Tests for scripts/agent-send.mjs and scripts/lib/agent-mailbox.mjs
//.
//
// Fixtures: AGENT_MAILBOX_DIR points at a temp dir, AGENT_MAILBOX_PRESENCE_FILE
// at a temp presence file with three live beacons (s1 on /repo/a WITH the
// mailbox consumer flag, s2 on /repo/a without it, s3 on /repo/b without it),
// and AGENT_MAILBOX_KITTY at a stub serving two canned windows (991001 on
// /repo/a titled "opencode: example-project review", 991002 on /repo/b titled
// "opencode: example-project review docs") that records every invocation. The
// no-consumer fallback is stubbed via AGENT_SEND_KITTY_SEND, which records
// its argv and exits 5 to prove exit-code passthrough. The withdraw-path
// tests use a second stub that runs the real kitty-send.sh's argument rules
//, so a flag pair kitty-send refuses fails here too.
//
// Run: node --test tests/agent-send.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ack,
  appendMessage,
  cancelQueued,
  findRow,
  DELIVERED_AS,
  findRecentTopicDelivery,
  mailboxPath,
  pruneStale,
  readUnacked,
  readUnackedBySession,
  recipientKey,
  resolveRecipient,
} from '../lib/agent-mailbox.mjs';

const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));
const REAL_KITTY_SEND = fileURLToPath(new URL('../bin/kitty-send.sh', import.meta.url));
const KEY_S1 = '-repo-a__s1';

let binDir, mboxDir, presFile, kittyStub, kittyLog, kittyLs, fallbackStub, fallbackArgv, realRulesStub;

const nowIso = () => new Date().toISOString();

const writePresence = (beacons) =>
  fs.writeFileSync(presFile, JSON.stringify({ beacons: beacons.map((b) => ({ ...b, firstTick: nowIso(), lastTick: nowIso() })) }));

before(async () => {
  binDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentsend-bin-'));
  mboxDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentsend-mbox-'));
  presFile = path.join(binDir, 'presence.json');
  kittyLog = path.join(binDir, 'kitty-calls.log');
  kittyLs = path.join(binDir, 'kitty-ls.json');
  fallbackArgv = path.join(binDir, 'fallback-argv.log');
  fs.writeFileSync(kittyLs, JSON.stringify([{
    tabs: [{
      title: 'tab-one',
      windows: [
        { id: 991001, title: 'opencode: example-project review', pid: 111, cwd: '/repo/a' },
        { id: 991002, title: 'opencode: example-project review docs', pid: 112, cwd: '/repo/b' },
      ],
    }],
  }]));
  kittyStub = path.join(binDir, 'kitty');
  fs.writeFileSync(kittyStub, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(kittyLog)}`,
    'if [ "$1/$2" = "@ /ls" ] || [ "$1" = "@" -a "$2" = "ls" ]; then',
    `  cat ${JSON.stringify(kittyLs)}`,
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  fallbackStub = path.join(binDir, 'kitty-send-stub.sh');
  fs.writeFileSync(fallbackStub, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$@" > ${JSON.stringify(fallbackArgv)}`,
    'exit 5',
    '',
  ].join('\n'), { mode: 0o755 });
  // kitty-send.sh's own argument rules, not a stub's idea of them (the
  // accept-anything stub above let `--now --deadline` through, which the real
  // script refuses). This wrapper runs the real script against a kitty that
  // always fails: kitty_up runs after every flag check, so "remote control
  // unavailable" means the real script accepted the flags. Then it records the
  // argv and exits $KITTY_SEND_STUB_EXIT (default 0, delivered); a refusal
  // passes through with the real message and code.
  const failKittyDir = path.join(binDir, 'fail-kitty');
  fs.mkdirSync(failKittyDir);
  fs.writeFileSync(path.join(failKittyDir, 'kitty'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  realRulesStub = path.join(binDir, 'kitty-send-real-rules.sh');
  fs.writeFileSync(realRulesStub, [
    '#!/usr/bin/env bash',
    `err=$(PATH=${JSON.stringify(failKittyDir)}:"$PATH" bash ${JSON.stringify(REAL_KITTY_SEND)} "$@" 2>&1 >/dev/null)`,
    'rc=$?',
    'if [ "$rc" = 1 ] && printf \'%s\' "$err" | grep -q "remote control unavailable"; then',
    `  printf '%s\\n' "$@" > ${JSON.stringify(fallbackArgv)}`,
    '  exit "${KITTY_SEND_STUB_EXIT:-0}"',
    'fi',
    'printf \'%s\\n\' "$err" >&2',
    'exit "$rc"',
    '',
  ].join('\n'), { mode: 0o755 });
  process.env.AGENT_MAILBOX_KITTY = kittyStub;
  writePresence([
    { sessionId: 's1', cwd: '/repo/a', mailbox: true },
    { sessionId: 's2', cwd: '/repo/a' },
    { sessionId: 's3', cwd: '/repo/b' },
  ]);
});

after(async () => {
  delete process.env.AGENT_MAILBOX_KITTY;
  await fs.promises.rm(binDir, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(mboxDir, { recursive: true, force: true }).catch(() => {});
});

// A kitty stand-in whose window carries the typing proof a --queue send needs:
// a Claude Code process, an idle session record and an empty composer.
const provenKitty = (winId, cwd) => {
  const pid = 4000 + (winId % 1000);
  const sessDir = path.join(binDir, `proven-sessions-${winId}`);
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, `${pid}.json`), JSON.stringify({ sessionId: `proven-${winId}`, cwd, status: 'idle' }));
  const screen = path.join(binDir, `proven-screen-${winId}`);
  fs.writeFileSync(screen, '● Done.\n────────────────────\n❯ \n────────────────────\n');
  const kitty = path.join(binDir, `kitty-proven-${winId}`);
  fs.writeFileSync(kitty, [
    '#!/usr/bin/env bash',
    `if [ "$2" = "get-text" ]; then cat ${JSON.stringify(screen)}; exit 0; fi`,
    `printf '%s' '[{"tabs":[{"windows":[{"id":${winId},"title":"claude: idle seat","cwd":"${cwd}","foreground_processes":[{"pid":${pid},"cmdline":["claude"]}]}]}]}]'`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { AGENT_MAILBOX_KITTY: kitty, CLAUDE_SESSIONS_DIR: sessDir };
};
const libOpts = () => ({ dir: mboxDir, presenceFile: presFile });
const childEnv = (extra = {}) => isolatedEnv({
  AGENT_MAILBOX_DIR: mboxDir,
  AGENT_MAILBOX_PRESENCE_FILE: presFile,
  AGENT_MAILBOX_KITTY: kittyStub,
  AGENT_SEND_KITTY_SEND: fallbackStub,
  ...extra,
});

const runSend = (args, env) =>
  new Promise((resolve) => {
    const child = spawn('node', [SEND, ...args], { env: env ?? childEnv() });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stderr }));
  });

test('recipientKey is deterministic and filesystem-safe', () => {
  const a = recipientKey({ cwd: '/repo/a', sessionId: 's1' });
  assert.equal(a, recipientKey({ cwd: '/repo/a', sessionId: 's1' }));
  assert.match(a, /^[A-Za-z0-9._-]+$/);
  assert.notEqual(a, recipientKey({ cwd: '/repo/a', sessionId: 's2' }));
  assert.notEqual(a, recipientKey({ cwd: '/repo/b', sessionId: 's1' }));
});

test('resolveRecipient accepts a mailbox key with the consumer flag', () => {
  const r = resolveRecipient(KEY_S1, { presenceFile: presFile });
  assert.equal(r.key, KEY_S1);
  assert.equal(r.cwd, '/repo/a');
  assert.equal(r.sessionId, 's1');
  assert.equal(r.hasConsumer, true);
});

test('resolveRecipient maps a window id to the other beacon on a shared cwd', () => {
  const r = resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's2', senderCwd: '/repo/a' });
  assert.equal(r.key, KEY_S1);
  assert.equal(r.windowId, 991001);
  assert.equal(r.hasConsumer, true);
});

test('resolveRecipient without a sender stays ambiguous on a shared cwd', () => {
  assert.throws(() => resolveRecipient('991001', { presenceFile: presFile }), /2 live sessions/);
});

test('resolveRecipient reports a window with no consumer', () => {
  const r = resolveRecipient('991002', { presenceFile: presFile });
  assert.equal(r.hasConsumer, false);
  assert.equal(r.windowId, 991002);
});

test('resolveRecipient refuses a title that matches two windows', () => {
  assert.throws(() => resolveRecipient('review', { presenceFile: presFile }), /ambiguous/);
});

test('resolveRecipient throws on an unknown window id', () => {
  assert.throws(() => resolveRecipient('123456', { presenceFile: presFile }), /no kitty window/);
});

test('each priority lands as its own value in the row', () => {
  for (const priority of ['now', 'stop', 'idle', 'queue']) {
    const row = appendMessage({ to: KEY_S1, from: 'test', priority, text: `prio ${priority}`, ...libOpts() });
    assert.equal(row.priority, priority);
    assert.match(row.id, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(row.ts)));
  }
});

test('appendMessage rejects an unknown priority', () => {
  assert.throws(() => appendMessage({ to: KEY_S1, priority: 'urgent', text: 'x', ...libOpts() }), /priority/);
});

test('readUnacked returns only messages without an ack row', () => {
  const key = '-repo-a__unack';
  const first = appendMessage({ to: key, priority: 'now', text: 'one', ...libOpts() });
  const second = appendMessage({ to: key, priority: 'now', text: 'two', ...libOpts() });
  ack({ key, id: first.id, deliveredAs: 'prompt', ...libOpts() });
  const unacked = readUnacked(key, { dir: mboxDir });
  assert.deepEqual(unacked.map((r) => r.id), [second.id]);
});

test('DELIVERED_AS is the closed delivery-label set', () => {
  assert.deepEqual([...DELIVERED_AS], ['prompt', 'tool', 'stop', 'mcp', 'steer', 'followUp', 'nextTurn', 'typed']);
});
test('ack stays fail-open on an unknown label: the message still clears', () => {
  const key = '-repo-a__failopen';
  const row = appendMessage({ to: key, priority: 'now', text: 'x', ...libOpts() });
  ack({ key, id: row.id, deliveredAs: 'carrier-pigeon', ...libOpts() });
  assert.deepEqual(readUnacked(key, { dir: mboxDir }), []);
});
test('pruneStale removes only files whose recipient left presence', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentsend-prune-'));
  try {
    const staleKey = '-gone__s9';
    fs.writeFileSync(mailboxPath(staleKey, { dir }), '{"id":"x"}\n');
    fs.writeFileSync(mailboxPath(KEY_S1, { dir }), '');
    const removed = pruneStale({ dir, presenceFile: presFile });
    assert.deepEqual(removed, [staleKey]);
    assert.ok(!fs.existsSync(mailboxPath(staleKey, { dir })));
    assert.ok(fs.existsSync(mailboxPath(KEY_S1, { dir })));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('ack within deadline exits 0', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const child = spawn('node', [SEND, '--to', KEY_S1, '--text', 'hello within deadline', '--deadline', '10'], { env: childEnv() });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', resolve));
  let rowId = null;
  const pollEnd = Date.now() + 8000;
  while (rowId == null && Date.now() < pollEnd) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const lines = fs.readFileSync(mailboxPath(KEY_S1, { dir: mboxDir }), 'utf-8').split('\n').filter(Boolean);
      const row = lines.map((l) => JSON.parse(l)).find((r) => r.id);
      if (row) rowId = row.id;
    } catch { /* mailbox not written yet */ }
  }
  assert.ok(rowId, 'sender never queued the row');
  const queued = readUnacked(KEY_S1, { dir: mboxDir }).find((r) => r.id === rowId);
  assert.equal(queued.from, recipientKey({ cwd: process.cwd(), sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null }));
  ack({ key: KEY_S1, id: rowId, deliveredAs: 'mcp', dir: mboxDir });
  const code = await done;
  assert.equal(code, 0);
  assert.match(stderr, new RegExp(rowId));
  assert.match(stderr, new RegExp(mailboxPath(KEY_S1, { dir: mboxDir }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the real-rules stub measures kitty-send: it refuses --now with --deadline and accepts --now alone', () => {
  // Without this, a stub that accepted everything would pass the tests
  // below for the reason the accept-anything stub did.
  const refused = spawnSync(realRulesStub, ['--to', '1', '--text', 'x', '--now', '--deadline', '5'], { encoding: 'utf-8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--now and --wait-idle\/--deadline are mutually exclusive/);
  const accepted = spawnSync(realRulesStub, ['--to', '1', '--text', 'x', '--now'], { encoding: 'utf-8' });
  assert.equal(accepted.status, 0, accepted.stderr);
});
test('no ack in the wait window withdraws the row and falls through to kitty-send', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(
    ['--to', '991001', '--text', 'parked recipient', '--deadline', '1'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub }),
  );
  assert.equal(code, 0, stderr);
  assert.match(stderr, /withdrew the mailbox row, next: kitty-send to 991001/);
  assert.equal(stderr.match(/queued, recipient busy\/parked for \S+ in /g)?.length, 1, 'the busy/parked line prints once');
  assert.doesNotMatch(stderr, /delivers it now/);
  const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
  assert.ok(argv.includes('--to') && argv.includes('991001'));
  // The withdrawn mailbox copy must not deliver later on top of the kitty copy.
  assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), []);
});

test('an idle recipient caps the ack wait instead of blocking the full default (row 58)', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const t0 = Date.now();
  const { code, stderr } = await runSend(
    ['--to', '991001', '--text', 'parked steer'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '10' }),
  );
  const elapsed = Date.now() - t0;
  // The kitty stub reports an idle title, so the 120 s default caps at 5 s;
  // exit 10 (typed, not proven submitted) passes through, never re-queued.
  assert.equal(code, 10, stderr);
  assert.match(stderr, /ack wait capped at 5s/);
  assert.match(stderr, /kitty-send exit 10 for 991001: typed, not proven submitted/);
  assert.ok(elapsed < 30_000, `idle recipient must not wait the full default (took ${elapsed}ms)`);
  assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), [], 'a typed message must not be queued a second time');
});

// First path, the quoted moment: `--to 39 --now --deadline 60` withdrew the
// row, then kitty-send refused `--now --deadline` with exit 1 and nothing was
// delivered. The deadline bounded agent-send's ack wait; it is not forwarded
// with --now, on the withdraw path and on the no-consumer path alike.
test('--now --deadline falls back without --deadline, and kitty-send accepts it ', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const env = childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub });
  const parked = await runSend(['--to', '991001', '--now', '--deadline', '1', '--text', 'urgent steer'], env);
  assert.equal(parked.code, 0, parked.stderr);
  let argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
  assert.ok(argv.includes('--now'));
  assert.ok(!argv.includes('--deadline'));
  assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), []);
  fs.rmSync(fallbackArgv, { force: true });
  const noConsumer = await runSend(['--to', '991002', '--stop', '--deadline', '5', '--text', 'stop now'], env);
  assert.equal(noConsumer.code, 0, noConsumer.stderr);
  argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
  assert.ok(argv.includes('--now') && !argv.includes('--deadline'));
});

// Second path: a mailbox key whose beacon carries no window id. The row used
// to be withdrawn before the window lookup, which then died; now the lookup
// comes first and the row stays queued for the consumer.
test('an unacked mailbox key with no known window keeps its row queued and exits 3 ', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(['--to', KEY_S1, '--text', 'parked recipient', '--deadline', '1']);
  assert.equal(code, 3);
  assert.match(stderr, /no kitty window for .*stays queued.*do not resend/);
  assert.ok(!fs.existsSync(fallbackArgv), 'no window means no kitty call');
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1, 'the row is still there for the consumer');
  assert.equal(left[0].text, 'parked recipient');
  assert.match(stderr, new RegExp(`withdraw it with --cancel --id ${left[0].id}`));
});

// A withdrawn row whose kitty fallback sends NOTHING (exit 7: mid-turn with
// none of --now/--queue/--wait-idle) goes back in the mailbox, carrying the
// original text rather than the act-once kitty copy.
test('a fallback that sends nothing puts the message back in the mailbox ', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(
    ['--to', '991001', '--text', 'bare steer', '--deadline', '1'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '7' }),
  );
  assert.equal(code, 3);
  assert.match(stderr, /kitty-send exit 7 sent nothing \(mid-turn without --now\/--queue\/--wait-idle\) for \S+; re-queued as \S+/);
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1);
  assert.equal(left[0].text, 'bare steer');
});

// Exit 9 (a dirty composer holding a chip kitty-send does not own) also sends
// nothing, so the withdrawn row must go back too, or the message is lost.
test('a fallback refused at a dirty composer (exit 9) puts the message back in the mailbox', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(
    ['--to', '991001', '--text', 'dirty composer steer', '--deadline', '1'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '9' }),
  );
  assert.equal(code, 3);
  assert.match(stderr, /kitty-send exit 9 sent nothing \(composer holds unsubmitted text\) for \S+; re-queued as \S+/);
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1);
  assert.equal(left[0].text, 'dirty composer steer');
});

// the exit code is the delivery verdict. On the withdraw
// path kitty-send must run SYNCHRONOUSLY (--wait-idle, never --queue, whose
// detached waiter returns 0 at once), so a wait that runs out (exit 5) is seen
// and the row is re-queued instead of lost behind an exit 0.
test('withdraw path under --queue --deadline forwards --wait-idle, re-queues on exit 5, prints one verdict', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(
    ['--to', '991001', '--queue', '--deadline', '1', '--text', 'queued steer'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '5', ...provenKitty(991001, '/repo/a') }),
  );
  const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
  assert.ok(!argv.includes('--queue'), `--queue must not be forwarded: ${argv}`);
  assert.equal(argv[argv.indexOf('--wait-idle') + 1], '1', `argv: ${argv}`);
  assert.ok(!argv.includes('--deadline'));
  assert.equal(code, 3, stderr);
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1, 're-queued row exists');
  assert.equal(left[0].text, 'queued steer');
  assert.match(stderr, /kitty-send exit 5 sent nothing \(idle wait ran out\) for \S+; re-queued as \S+/);
  assert.doesNotMatch(stderr, /check the tab first/);
  assert.doesNotMatch(stderr, /nothing was sent/);
});

test('a fallback that sent but could not prove it (exit 3) is not re-queued', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code } = await runSend(
    ['--to', '991001', '--text', 'sent unproven', '--deadline', '1'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '3' }),
  );
  assert.equal(code, 3);
  assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), [], 'a sent message must not be queued a second time');
});

// Exit 11 is "nothing sent, screen unreadable or composer not clear". Exit 3 is
// reserved for "sent, delivery not proven", so the two never share a code: the
// first goes back to the queue (exactly one row), the second never does.
const fallbackWith = async (stubExit, text) => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const r = await runSend(
    ['--to', '991001', '--text', text, '--deadline', '1'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: String(stubExit) }),
  );
  return { ...r, left: readUnacked(KEY_S1, { dir: mboxDir }) };
};

test('kitty-send "nothing sent" (exit 11) leaves exactly one queued row, no duplicate', async () => {
  const { code, stderr, left } = await fallbackWith(11, 'unreadable screen steer');
  assert.equal(code, 3, stderr);
  assert.equal(left.length, 1, `exactly one queued row: ${JSON.stringify(left)}`);
  assert.equal(left[0].text, 'unreadable screen steer');
  assert.match(stderr, /kitty-send exit 11 sent nothing \([^)]*\) for \S+; re-queued as \S+/);
});

test('kitty-send "sent, not proven" (exit 3) leaves no queued row and exits non-zero with an unproven line', async () => {
  const { code, stderr, left } = await fallbackWith(3, 'sent unproven steer');
  assert.notEqual(code, 0);
  assert.deepEqual(left, [], 'a sent message is never queued a second time');
  assert.match(stderr, /delivery is unproven/);
});

test('kitty-send success (exit 0) leaves no queued row and exits 0', async () => {
  const { code, stderr, left } = await fallbackWith(0, 'delivered steer');
  assert.equal(code, 0, stderr);
  assert.deepEqual(left, []);
});

test('no consumer falls through to the stub kitty-send with the argv', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  const { code, stderr } = await runSend(['--to', '991002', '--text', 'hello fallback']);
  assert.equal(code, 5);
  assert.match(stderr, /agent-send: no mailbox consumer flag for 991002 \(live beacon, flag off\), falling back to kitty-send/);
  const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
  assert.ok(argv.includes('--to') && argv.includes('991002'));
  assert.ok(argv.includes('--text') && argv.includes('hello fallback'));
});

// 2026-09-11 mailbox key-resolution fix: two sessions sharing one cwd, one
// addressing the other by window id or title. Before the fix the window's cwd
// picked the most-recent/consumer beacon, which could be the SENDER itself
// (peer's reply to "Stjórnir í einingar" landed in its own inbox).
test('a window id shared by two sessions resolves to the OTHER session, never the sender', () => {
  const r = resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/a' });
  assert.equal(r.key, '-repo-a__s2');
  assert.equal(r.windowId, 991001);
});

test('a window shared by three sessions is ambiguous even after excluding the sender', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's2', cwd: '/repo/a' },
      { sessionId: 's2b', cwd: '/repo/a' },
      { sessionId: 's3', cwd: '/repo/b' },
    ]);
    assert.throws(
      () => resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/a' }),
      /-repo-a__s2.*-repo-a__s2b|-repo-a__s2b.*-repo-a__s2/,
    );
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

// one Claude Code session whose worktree subagent wrote a
// second presence beacon under the worktree cwd is ONE recipient: both
// beacons carry the same sessionId, and every consumer drains by session id.
const writePresenceTicks = (beacons) =>
  fs.writeFileSync(presFile, JSON.stringify({ beacons: beacons.map((b) => ({ firstTick: b.lastTick, ...b })) }));
const sameSessionBeacons = () => [
  { sessionId: 's1', cwd: '/repo/z', mailbox: true, lastTick: new Date(Date.now() - 60000).toISOString() },
  { sessionId: 'sx', cwd: '/repo/a', mailbox: true, windowId: 991001, lastTick: new Date(Date.now() - 30000).toISOString() },
  { sessionId: 'sx', cwd: '/repo/a/.claude/worktrees/agent-1', mailbox: true, windowId: 991001, lastTick: nowIso() },
];

test('two beacons of one session on one window are one recipient, the newest-tick key', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresenceTicks(sameSessionBeacons());
    const r = resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/z' });
    assert.equal(r.key, '-repo-a-.claude-worktrees-agent-1__sx');
    assert.equal(r.sessionId, 'sx');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a mailbox key whose session id matches two same-session beacons resolves to the newest', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresenceTicks(sameSessionBeacons());
    const r = resolveRecipient('-repo-gone__sx', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/z' });
    assert.equal(r.key, '-repo-a-.claude-worktrees-agent-1__sx');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('same-session collapse leaves two different session ids ambiguous', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresenceTicks([
      ...sameSessionBeacons(),
      { sessionId: 'sy', cwd: '/repo/a', mailbox: true, windowId: 991001, lastTick: nowIso() },
    ]);
    assert.throws(
      () => resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/z' }),
      /matches 2 live sessions/,
    );
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a window whose only live beacon is the sender is an error, never a self-send', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's3', cwd: '/repo/b' },
    ]);
    assert.throws(
      () => resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/a' }),
      /sender itself/,
    );
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a mailbox key may still address the sender itself', () => {
  const r = resolveRecipient(KEY_S1, { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/a' });
  assert.equal(r.key, KEY_S1);
});

test('a title naming one window resolves to the other session on the shared cwd', () => {
  const savedLs = fs.readFileSync(kittyLs, 'utf-8');
  const savedPres = fs.readFileSync(presFile, 'utf-8');
  try {
    fs.writeFileSync(kittyLs, JSON.stringify([{ tabs: [
      { title: 'Stjórnir í einingar', windows: [{ id: 991101, title: 'x', pid: 111, cwd: '/repo/a' }] },
      { title: 'kennitala-encryption-cleanup', windows: [{ id: 991102, title: 'y', pid: 112, cwd: '/repo/a' }] },
    ] }]));
    writePresence([
      { sessionId: 's-overseer', cwd: '/repo/a', mailbox: true },
      { sessionId: 's-peer', cwd: '/repo/a', mailbox: true },
    ]);
    const r = resolveRecipient('Stjórnir í einingar', { presenceFile: presFile, senderSessionId: 's-peer', senderCwd: '/repo/a' });
    assert.equal(r.key, '-repo-a__s-overseer');
  } finally {
    fs.writeFileSync(kittyLs, savedLs);
    fs.writeFileSync(presFile, savedPres);
  }
});

test('pruneStale keeps a pre-move key while its session is live under another cwd', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const key = '-repo-a__s-peer';
  try {
    writePresence([{ sessionId: 's-peer', cwd: '/repo/wt-a', mailbox: true }]);
    appendMessage({ to: key, from: 'test', priority: 'now', text: 'pre-move row', ...libOpts() });
    const removed = pruneStale({ ...libOpts(), presenceFile: presFile });
    assert.ok(!removed.includes(key));
    assert.ok(fs.existsSync(mailboxPath(key, { dir: mboxDir })));
  } finally {
    fs.writeFileSync(presFile, saved);
    fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
  }
});

// 2026-09-11: a window with no mailbox consumer behind it (a
// tab, a plain shell, a sender-only cwd) falls back to kitty-send — the
// supervisor steer path — while ambiguity stays fatal.
test('agent-send to a sender-only window falls back to kitty-send, never self-sends', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const ownFile = mailboxPath('-repo-a__s1', { dir: mboxDir });
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's3', cwd: '/repo/b' },
    ]);
    fs.rmSync(ownFile, { force: true });
    fs.rmSync(fallbackArgv, { force: true });
    const { code, stderr } = await runSend(
      ['--to', '991001', '--text', 'steer to a tab'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(code, 5);
    assert.match(stderr, /no mailbox consumer at 991001, falling back to kitty-send/);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--to') && argv.includes('991001'));
    assert.ok(!fs.existsSync(ownFile), 'no row may land in the sender\'s own file');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('agent-send to a window with no beacon at all falls back to kitty-send', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true }]);
    fs.rmSync(fallbackArgv, { force: true });
    const { code, stderr } = await runSend(
      ['--to', '991002', '--text', 'plain shell hello'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(code, 5);
    assert.match(stderr, /no mailbox consumer at 991002, falling back to kitty-send/);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--to') && argv.includes('991002'));
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('an ambiguous window stays fatal in agent-send, no kitty call', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's2', cwd: '/repo/a' },
      { sessionId: 's2b', cwd: '/repo/a' },
    ]);
    fs.rmSync(kittyLog, { force: true });
    fs.rmSync(fallbackArgv, { force: true });
    const { code, stderr } = await runSend(
      ['--to', '991001', '--text', 'must not guess'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(code, 1);
    assert.match(stderr, /matches 2 live sessions \(-repo-a__s2, -repo-a__s2b\)/);
    assert.ok(!fs.existsSync(fallbackArgv), 'ambiguity must not reach kitty-send');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('priority flags reach kitty-send unchanged on the fallback path', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true }]);
    fs.rmSync(fallbackArgv, { force: true });
    const idle = await runSend(
      ['--to', '991002', '--idle-when', '5m', '--text', 'idle steer'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(idle.code, 5);
    let argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--idle-when') && argv.includes('5m'));
    assert.ok(!argv.includes('--now'));
    fs.rmSync(fallbackArgv, { force: true });
    const queued = await runSend(
      ['--to', '991002', '--queue', '--text', 'queued steer'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1', ...provenKitty(991002, '/repo/b') }),
    );
    assert.equal(queued.code, 5);
    argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--wait-idle'), `a --queue fallback runs in the foreground: ${argv}`);
    assert.ok(!argv.includes('--queue'), `${argv}`);
    fs.rmSync(fallbackArgv, { force: true });
    const now = await runSend(
      ['--to', '991002', '--now', '--text', 'urgent steer'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1' }),
    );
    assert.equal(now.code, 5);
    argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--now'));
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});
// Bare send (no mode) is priority now: an idle recipient gets --now so kitty-send
// types and submits at once; a busy one (spinner in the title) does not, so
// kitty-send's mid-turn guard still applies.
const bareSendArgv = async (extraArgs, title, extraEnv = null) => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const busyKitty = path.join(binDir, 'kitty-title-stub');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true }]);
    fs.writeFileSync(busyKitty, [
      '#!/usr/bin/env bash',
      `echo '[{"tabs":[{"windows":[{"id":991002,"title":${JSON.stringify(title)},"cwd":"/repo/b"}]}]}]'`,
      '',
    ].join('\n'), { mode: 0o755 });
    fs.rmSync(fallbackArgv, { force: true });
    const r = await runSend(['--to', '991002', ...extraArgs, '--text', 'hello'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1', AGENT_MAILBOX_KITTY: busyKitty, ...extraEnv }));
    return { code: r.code, argv: fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean) };
  } finally {
    fs.writeFileSync(presFile, saved);
  }
};

test('a bare send to an idle recipient forwards --now to kitty-send', async () => {
  const { code, argv } = await bareSendArgv([], 'claude: idle seat');
  assert.equal(code, 5);
  assert.ok(argv.includes('--now'), `argv: ${argv}`);
  assert.ok(!argv.includes('--deadline'));
});

test('a bare send to a busy recipient does not forward --now', async () => {
  const { argv } = await bareSendArgv([], '\u2807 claude: working');
  assert.ok(!argv.includes('--now'), `argv: ${argv}`);
});

test('an explicit --queue to an idle recipient is unchanged', async () => {
  const { argv } = await bareSendArgv(['--queue'], 'claude: idle seat', provenKitty(991002, '/repo/b'));
  assert.ok(argv.includes('--wait-idle') && !argv.includes('--queue'), `argv: ${argv}`);
  assert.ok(!argv.includes('--now'), `argv: ${argv}`);
});

test('resolution errors carry codes; no-consumer messages name kitty-send', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const capture = (fn) => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    assert.fail('expected resolveRecipient to throw');
  };
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true }]);
    const opts = { presenceFile: presFile, senderSessionId: 's1', senderCwd: '/repo/a' };
    // What send_message switches its agent-send hint on (index.mjs cannot run
    // here — no MCP SDK on the box — so the codes and message text are pinned
    // at the lib boundary instead).
    const self = capture(() => resolveRecipient('991001', opts));
    assert.equal(self.code, 'mailbox-self');
    assert.match(self.message, /kitty-send\.sh/);
    const none = capture(() => resolveRecipient('991002', opts));
    assert.equal(none.code, 'mailbox-no-beacon');
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's2', cwd: '/repo/a' },
    ]);
    const amb = capture(() => resolveRecipient('991001', {
      presenceFile: presFile, senderSessionId: 'nobody', senderCwd: '/elsewhere',
    }));
    assert.equal(amb.code, 'mailbox-ambiguous');
    assert.match(amb.message, /2 live sessions/);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

// 2026-09-11: a sender addressing the PRE-move key after the move.
// The exact-key lookup misses (no beacon carries the old cwd), but the
// session id never moves, so the `__<sid>` suffix resolves to the beacon's
// current key.
test('a pre-move key resolves to the moved session\'s current key', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/wt-a', mailbox: true }]);
    const r = resolveRecipient('-repo-a__s1', { presenceFile: presFile });
    assert.equal(r.key, '-repo-wt-a__s1');
    assert.equal(r.cwd, '/repo/wt-a');
    assert.equal(r.sessionId, 's1');
    assert.equal(r.hasConsumer, true);
    assert.equal(r.windowId, null);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a stale key whose session id has no live beacon keeps the no-live-session error', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's2', cwd: '/repo/a', mailbox: true }]);
    assert.throws(
      () => resolveRecipient('-repo-a__s1', { presenceFile: presFile }),
      /no live session for mailbox key '-repo-a__s1'/,
    );
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

// the two beacons carry one session id, so they are one
// recipient (the old expectation was mailbox-ambiguous, which refused a send
// to a session whose worktree subagent wrote a second beacon).
test('a pre-move key shared by two live beacons of one session resolves to one recipient', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 's1', cwd: '/repo/wt-a', mailbox: true },
      { sessionId: 's1', cwd: '/repo/wt-b' },
    ]);
    const r = resolveRecipient('-repo-a__s1', { presenceFile: presFile });
    assert.equal(r.sessionId, 's1');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('agent-send to a pre-move key queues in the current key file and is acked', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const currentFile = mailboxPath('-repo-wt-a__s9', { dir: mboxDir });
  try {
    writePresence([{ sessionId: 's9', cwd: '/repo/wt-a', mailbox: true }]);
    fs.rmSync(currentFile, { force: true });
    const child = spawn('node', [SEND, '--to', '-repo-a__s9', '--text', 'hello after the move', '--deadline', '10'], { env: childEnv() });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const done = new Promise((resolve) => child.on('close', resolve));
    const pollEnd = Date.now() + 8000;
    let rowId = null;
    while (rowId == null && Date.now() < pollEnd) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const lines = fs.readFileSync(currentFile, 'utf-8').split('\n').filter(Boolean);
        const row = lines.map((l) => JSON.parse(l)).find((r) => r.id);
        if (row) rowId = row.id;
      } catch { /* mailbox not written yet */ }
    }
    assert.ok(rowId, 'sender never queued the row in the current key file');
    ack({ key: '-repo-wt-a__s9', id: rowId, deliveredAs: 'mcp', dir: mboxDir });
    const code = await done;
    assert.equal(code, 0);
    assert.match(stderr, new RegExp(rowId));
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

// 2026-09-12: a window id resolves by the window id the recipient recorded
// in its beacon, not by cwd. Two sessions sharing one cwd in different
// windows are addressable by window id (a window
// matched 2 live sessions on one cwd).
test('a window id resolves by recorded window id on a shared cwd', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const savedLs = fs.readFileSync(kittyLs, 'utf-8');
  try {
    fs.writeFileSync(kittyLs, JSON.stringify([{ tabs: [
      { title: 'supervisor', windows: [{ id: 35, title: 'sup', pid: 111, cwd: '/repo/shared' }] },
      { title: 'pkg-a', windows: [{ id: 36, title: 'a', pid: 112, cwd: '/repo/shared' }] },
    ] }]));
    writePresence([
      { sessionId: 's-sup', cwd: '/repo/shared', mailbox: true, windowId: 35 },
      { sessionId: 's-a', cwd: '/repo/shared', mailbox: true, windowId: 36 },
    ]);
    const toA = resolveRecipient('36', { presenceFile: presFile, senderSessionId: 's-elsewhere', senderCwd: '/other' });
    assert.equal(toA.key, '-repo-shared__s-a');
    assert.equal(toA.windowId, 36);
    const toSup = resolveRecipient('35', { presenceFile: presFile, senderSessionId: 's-elsewhere', senderCwd: '/other' });
    assert.equal(toSup.key, '-repo-shared__s-sup');
  } finally {
    fs.writeFileSync(kittyLs, savedLs);
    fs.writeFileSync(presFile, saved);
  }
});

test('targeting the sender window by id never delivers to the cwd-sharer', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const savedLs = fs.readFileSync(kittyLs, 'utf-8');
  try {
    fs.writeFileSync(kittyLs, JSON.stringify([{ tabs: [
      { title: 'supervisor', windows: [{ id: 35, title: 'sup', pid: 111, cwd: '/repo/shared' }] },
      { title: 'pkg-a', windows: [{ id: 36, title: 'a', pid: 112, cwd: '/repo/shared' }] },
    ] }]));
    writePresence([
      { sessionId: 's-sup', cwd: '/repo/shared', mailbox: true, windowId: 35 },
      { sessionId: 's-a', cwd: '/repo/shared', mailbox: true, windowId: 36 },
    ]);
    // Sender session id unknown (a caller without a session id), but its window is known.
    const err = (() => {
      try {
        resolveRecipient('35', { presenceFile: presFile, senderWindowId: 35 });
      } catch (e) {
        return e;
      }
      assert.fail('expected resolveRecipient to throw');
    })();
    assert.equal(err.code, 'mailbox-self');
  } finally {
    fs.writeFileSync(kittyLs, savedLs);
    fs.writeFileSync(presFile, saved);
  }
});

test('cancelQueued withdraws a row: no later drain delivers it', () => {
  const key = '-repo-a__withdrawn';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  cancelQueued({ key, id: row.id, ...libOpts() });
  assert.deepEqual(readUnacked(key, { dir: mboxDir }), []);
  assert.deepEqual(readUnackedBySession('withdrawn', { dir: mboxDir }), []);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('agent-send --cancel withdraws one row by id', async () => {
  const key = '-repo-a__cancelcli';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  const child = spawn('node', [SEND, '--cancel', '--to', key, '--id', row.id], { env: childEnv() });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.match(stderr, new RegExp(row.id));
  assert.deepEqual(readUnacked(key, { dir: mboxDir }), []);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

// --cancel resolves the row by id and withdraws it under the row's OWN
// recipient key: a caller's --to is a hint, not the address.
const rowLines = (key) => {
  try {
    return fs.readFileSync(mailboxPath(key, { dir: mboxDir }), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const runCancel = (args) => {
  const r = spawnSync('node', [SEND, '--cancel', ...args], { env: childEnv(), encoding: 'utf-8' });
  return { code: r.status, stderr: r.stderr };
};

test('--cancel --to <wrong key> --id withdraws under the row\'s real key (file mode)', () => {
  const key = '-repo-a__realkey';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  const { code, stderr } = runCancel(['--to', 'role:some-role', '--id', row.id]);
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`withdrew ${row.id} \\(recipient ${key}\\)`));
  assert.match(stderr, /--to named role:some-role, the row's own recipient was used/);
  assert.deepEqual(readUnacked(key, { dir: mboxDir }), []);
  assert.equal(rowLines(key).filter((r) => r.withdraw === row.id).length, 1);
  assert.equal(rowLines('role:some-role').length, 0, 'nothing written under the literal --to');
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('--cancel --id alone withdraws (file mode)', () => {
  const key = '-repo-a__idonly';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  const { code, stderr } = runCancel(['--id', row.id]);
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /--to named/);
  assert.deepEqual(readUnacked(key, { dir: mboxDir }), []);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('--cancel on a delivered row exits 13, names the ack, writes nothing (file mode)', () => {
  const key = '-repo-a__delivered';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  const a = ack({ key, id: row.id, deliveredAs: 'typed', ...libOpts() });
  const before = rowLines(key).length;
  const { code, stderr } = runCancel(['--to', key, '--id', row.id]);
  assert.equal(code, 13);
  assert.match(stderr, new RegExp(`not withdrawn: ${row.id} was already delivered at ${a.ts} as ${a.deliveredAs}`));
  assert.equal(rowLines(key).length, before);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('--cancel on an unknown id exits 14, writes nothing (file mode)', () => {
  // Every mailbox file's size, so an append to an existing file shows too.
  const snapshot = () => fs.readdirSync(mboxDir).map((f) => `${f}:${fs.statSync(path.join(mboxDir, f)).size}`).sort();
  const before = snapshot();
  const { code, stderr } = runCancel(['--to', '-repo-a__nobody', '--id', 'no-such-id']);
  assert.equal(code, 14);
  assert.match(stderr, /not withdrawn: no row no-such-id/);
  assert.deepEqual(snapshot(), before);
});

test('--cancel on an already-withdrawn row exits 13 and writes no second withdraw (file mode)', () => {
  const key = '-repo-a__twice';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  assert.equal(runCancel(['--id', row.id]).code, 0);
  const { code, stderr } = runCancel(['--id', row.id]);
  assert.equal(code, 13);
  assert.match(stderr, /was already withdrawn at \d{4}-/);
  assert.equal(rowLines(key).filter((r) => r.withdraw === row.id).length, 1);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('cancelQueued and findRow return the documented shapes (file mode)', () => {
  const key = '-repo-a__shapes';
  const row = appendMessage({ to: key, priority: 'now', text: 'steer', ...libOpts() });
  assert.equal(findRow({ id: row.id, dir: mboxDir }).state, 'queued');
  const w = cancelQueued({ key: '-other__key', id: row.id, ...libOpts() });
  assert.deepEqual(w, { withdrawn: true, key, keyCorrected: true });
  assert.equal(findRow({ id: row.id, dir: mboxDir }).state, 'withdrawn');
  const again = cancelQueued({ key, id: row.id, ...libOpts() });
  assert.equal(again.withdrawn, false);
  assert.equal(again.state, 'withdrawn');
  assert.ok(again.withdrawTs);
  const gone = cancelQueued({ key, id: 'nope', ...libOpts() });
  assert.deepEqual({ w: gone.withdrawn, s: gone.state }, { w: false, s: 'missing' });
  const k2 = '-repo-a__shapes2';
  const r2 = appendMessage({ to: k2, priority: 'now', text: 'x', ...libOpts() });
  const a = ack({ key: k2, id: r2.id, deliveredAs: 'typed', ...libOpts() });
  const d = cancelQueued({ key: k2, id: r2.id, ...libOpts() });
  assert.deepEqual({ w: d.withdrawn, s: d.state, k: d.key, t: d.ackTs, as: d.deliveredAs }, { w: false, s: 'delivered', k: k2, t: a.ts, as: 'typed' });
  for (const k of [key, k2]) fs.rmSync(mailboxPath(k, { dir: mboxDir }), { force: true });
});

test('agent-send --read prints and acks this session inbox rows', async () => {
  const key = '-repo-a__reader';
  appendMessage({ to: key, from: 's-peer', priority: 'now', text: 'hello reader', ...libOpts() });
  const runRead = () => new Promise((resolve) => {
    const child = spawn('node', [SEND, '--read', '--as', 'reader'], { env: childEnv() });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const first = await runRead();
  assert.equal(first.code, 0);
  assert.match(first.stdout, /hello reader/);
  assert.match(first.stderr, /1 unacked/);
  const second = await runRead();
  assert.equal(second.code, 0);
  assert.match(second.stderr, /0 unacked/);
  fs.rmSync(mailboxPath(key, { dir: mboxDir }), { force: true });
});

test('agent-send --read drains mail queued for a role the session holds (#69)', async () => {
  const queued = appendMessage({ to: 'role:drain-probe', from: 's-peer', priority: 'queue', text: 'queued for the role', ...libOpts() });
  const claim = await runSend(['--claim-role', 'drain-probe', '--as', 'role-reader']);
  assert.equal(claim.code, 0);
  const runRead = () => new Promise((resolve) => {
    const child = spawn('node', [SEND, '--read', '--as', 'role-reader'], { env: childEnv() });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const first = await runRead();
  assert.equal(first.code, 0);
  assert.match(first.stdout, /queued for the role/);
  assert.match(first.stderr, /1 unacked/);
  assert.equal(readUnacked('role:drain-probe', libOpts()).some((r) => r.id === queued.id), false);
  assert.match((await runRead()).stderr, /0 unacked/);
});

test('agent-send --help names the inbox read verb', async () => {
  const out = await new Promise((resolve) => {
    const child = spawn('node', [SEND, '--help'], { env: childEnv() });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout }));
  });
  assert.equal(out.code, 0);
  assert.match(out.stdout, /--read/);
  assert.match(out.stdout, /inbox/i);
});

// kitty-send exit 8 means sent under
// --now while mid-turn and still mid-turn at the deadline — pending in the
// steering queue, not lost. agent-send passes the code through and names it
// as pending instead of a failure.
test('a kitty-send exit 8 passes through as pending, never a failure', async () => {
  const pendingStub = path.join(binDir, 'kitty-send-pending-stub.sh');
  fs.writeFileSync(pendingStub, [
    '#!/usr/bin/env bash',
    'echo "sent to window $2 while it was mid-turn (--now); still mid-turn" >&2',
    'exit 8',
    '',
  ].join('\n'), { mode: 0o755 });
  const { code, stderr } = await runSend(
    ['--to', '991002', '--now', '--text', 'mid-turn steer'],
    { ...childEnv(), AGENT_SEND_KITTY_SEND: pendingStub },
  );
  assert.equal(code, 8);
  assert.match(stderr, /kitty-send exit 8 for 991002: pending in the steering queue until the tool boundary, not lost; do not resend/);
});

// A kitty fallback that ends in exit 9 (composer held unsubmitted text,
// nothing sent) must report non-zero plus one stderr line naming the queue
// log; a fallback the target queues (exit 0 under --queue) must name the
// queue log to confirm, since the verdict arrives later and asynchronously.
test('a no-consumer fallback refused at a dirty composer (exit 9) names the queue log and stays non-zero', async () => {
  const queueDir = path.join(binDir, 'xdg-run');
  fs.mkdirSync(queueDir, { recursive: true });
  const { code, stderr } = await runSend(
    ['--to', '991002', '--text', 'dirty composer direct'],
    childEnv({ AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '9', XDG_RUNTIME_DIR: queueDir }),
  );
  assert.notEqual(code, 0, 'exit 9 must reach the caller as a failure');
  assert.match(stderr, /kitty-send exit 9 for 991002: nothing was sent \(composer holds unsubmitted text\)/);
  assert.match(stderr, new RegExp(`kitty queue log: ${queueDir}/kitty-send/queue-991002\\.log`));
});

test('a --queue kitty fallback runs in the foreground: its exit 0 is the delivery verdict', async () => {
  const queueDir = path.join(binDir, 'xdg-run');
  fs.mkdirSync(queueDir, { recursive: true });
  const queueStub = path.join(binDir, 'kitty-send-queued-stub.sh');
  fs.writeFileSync(queueStub, ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'), { mode: 0o755 });
  const { code, stderr } = await runSend(
    ['--to', '991002', '--text', 'queued steer', '--queue'],
    { ...childEnv(), AGENT_SEND_KITTY_SEND: queueStub, XDG_RUNTIME_DIR: queueDir, ...provenKitty(991002, '/repo/b') },
  );
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /do not resend/);
});

// A supervisor idle ~30 min ages past the 20-min presence window. With its
// writer pid alive and its window open it is an IDLE seat (role-ownership.test.mjs);
// with a dead writer pid (these fixtures) it is stale. The fallback line must
// say WHY: no beacon, stale beacon since <time>, or live beacon with the flag off.
test('a steer to a window whose beacon went stale names the last tick', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    fs.writeFileSync(presFile, JSON.stringify({ beacons: [
      { sessionId: 's9', cwd: '/repo/b', mailbox: true, windowId: 991002, pid: spawnSync('node', ['-e', '0']).pid, firstTick: old, lastTick: old },
    ] }));
    const { code, stderr } = await runSend(
      ['--to', '991002', '--text', 'stale steer'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's3' }),
    );
    assert.equal(code, 5);
    assert.match(stderr, /stale mailbox beacon for 991002.*last tick .* past the presence window/);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('a live beacon without the flag says flag off', async () => {
  const { code, stderr } = await runSend(['--to', '991002', '--text', 'flag off steer']);
  assert.equal(code, 5);
  assert.match(stderr, /no mailbox consumer flag for 991002 \(live beacon, flag off\)/);
});

// 2026-10-26: a multi-line --text was queued, the
// recipient stayed busy, and the withdraw path handed the text to kitty-send,
// which refuses an embedded newline (exit 1, nothing sent). The mailbox
// carries any text; only the kitty fallback needs one line, so the sender
// writes the text to a note and sends kitty-send the --file pointer.
const notesEnv = (notesDir, extra = {}) => childEnv({ AGENT_SWITCHBOARD_NOTES_DIR: notesDir, ...extra });

test('a multi-line --text reaches kitty-send as a --file note on the withdraw path', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-notes-'));
  try {
    // A note past the retention window is pruned when a new one is written.
    const stale = path.join(notesDir, 'old.md');
    fs.writeFileSync(stale, 'old');
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(stale, past, past);
    const text = 'line one\nline two\n\nline four';
    const { code, stderr } = await runSend(
      ['--to', '991001', '--text', text, '--deadline', '1'],
      notesEnv(notesDir, { CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub }),
    );
    assert.equal(code, 0, stderr);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(!argv.includes('--text'), `kitty-send got --text: ${argv.join(' ')}`);
    const note = argv[argv.indexOf('--file') + 1];
    assert.ok(note?.startsWith(notesDir + path.sep), `note outside the notes dir: ${note}`);
    const body = fs.readFileSync(note, 'utf-8');
    assert.ok(body.startsWith(text), 'the note carries the full text');
    assert.match(body, /act on it once/);
    assert.ok(!fs.existsSync(stale), 'a note past retention is pruned');
    assert.match(stderr, /multi-line text written to .* for kitty-send --file/);
    assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), []);
  } finally {
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});

test('a multi-line --text reaches kitty-send as a --file note on the no-consumer path', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-notes-'));
  try {
    const { code, stderr } = await runSend(
      ['--to', '991002', '--text', 'first\nsecond'],
      notesEnv(notesDir, { AGENT_SEND_KITTY_SEND: realRulesStub }),
    );
    assert.equal(code, 0, stderr);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(!argv.includes('--text'));
    assert.equal(fs.readFileSync(argv[argv.indexOf('--file') + 1], 'utf-8'), 'first\nsecond\n');
  } finally {
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});

test('a one-line --text still goes to kitty-send inline', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-notes-'));
  try {
    const { code } = await runSend(['--to', '991002', '--text', 'one line'], notesEnv(notesDir, { AGENT_SEND_KITTY_SEND: realRulesStub }));
    assert.equal(code, 0);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    assert.ok(argv.includes('--text') && argv.includes('one line'));
    assert.deepEqual(fs.readdirSync(notesDir), []);
  } finally {
    fs.rmSync(notesDir, { recursive: true, force: true });
  }
});

// 2026-10-26: another session's `pkill -f
// '[o]pencode.ai/docs/go'`, meant for its own curl, matched a waiting
// agent-send whose --text quoted that URL, and SIGTERM ended the send 53 s
// into its ack wait. The sender rewrites its process title once the argv is
// parsed, so the payload is not in /proc/<pid>/cmdline for any pattern kill.
test('the message text is not left in the waiting sender\'s command line', { skip: !fs.existsSync('/proc/self/cmdline') }, async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const marker = 'payload-marker-opencode.ai/docs/go';
  const child = spawn('node', [SEND, '--to', KEY_S1, '--text', `see ${marker}`, '--deadline', '10'], { env: childEnv() });
  const done = new Promise((resolve) => child.on('close', resolve));
  let rowId = null;
  const pollEnd = Date.now() + 8000;
  while (rowId == null && Date.now() < pollEnd) {
    await new Promise((r) => setTimeout(r, 100));
    rowId = readUnacked(KEY_S1, { dir: mboxDir })[0]?.id ?? null;
  }
  assert.ok(rowId, 'sender never queued the row');
  const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf-8').replace(/\0/g, ' ');
  ack({ key: KEY_S1, id: rowId, deliveredAs: 'mcp', dir: mboxDir });
  assert.equal(await done, 0);
  assert.ok(!cmdline.includes(marker), `payload visible in cmdline: ${cmdline.trim()}`);
  assert.match(cmdline, /^agent-send/);
});

// a seat's own beacon had aged out
// while its seat sat in one long turn, and the cwd fallback delivered the
// note to the only live beacon on that cwd: another seat's, whose beacon
// recorded a different window. A beacon that names another window is that window's
// session, never a candidate for this one.
test('the cwd fallback skips a beacon that recorded another window id', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fs.writeFileSync(presFile, JSON.stringify({ beacons: [
      { sessionId: 'busy-seat', cwd: '/repo/a', mailbox: true, windowId: 991001, pid: spawnSync('node', ['-e', '0']).pid, firstTick: old, lastTick: old },
      { sessionId: 'other-seat', cwd: '/repo/a', mailbox: true, windowId: 991777, firstTick: nowIso(), lastTick: nowIso() },
    ] }));
    const err = (() => {
      try {
        resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 'sender', senderCwd: '/elsewhere' });
      } catch (e) {
        return e;
      }
      assert.fail('expected resolveRecipient to throw, not to deliver to the other window');
    })();
    assert.equal(err.code, 'mailbox-stale');
    assert.match(err.message, /window\x20991001 has no LIVE presence beacon/);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

test('the cwd fallback still resolves a beacon that recorded no window id', () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([
      { sessionId: 'legacy', cwd: '/repo/a', mailbox: true },
      { sessionId: 'other-seat', cwd: '/repo/a', mailbox: true, windowId: 991777 },
    ]);
    const r = resolveRecipient('991001', { presenceFile: presFile, senderSessionId: 'sender', senderCwd: '/elsewhere' });
    assert.equal(r.sessionId, 'legacy');
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});

// a typed fallback leaves an acked row, and a send whose
// topic was already delivered inside --topic-window sends nothing.
test('a typed fallback records an acked via:typed row; the same topic is then not sent again', async () => {
  const KEY_S3 = recipientKey({ cwd: '/repo/b', sessionId: 's3' });
  fs.rmSync(mailboxPath(KEY_S3, { dir: mboxDir }), { force: true });
  const okStub = path.join(binDir, 'kitty-send-ok.sh');
  fs.writeFileSync(okStub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(fallbackArgv)}\nexit 0\n`, { mode: 0o755 });
  fs.rmSync(fallbackArgv, { force: true });
  const env = childEnv({ AGENT_SEND_KITTY_SEND: okStub });
  const first = await runSend(['--to', '991002', '--text', 'RESUME', '--topic', 'resume'], env);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(fs.existsSync(fallbackArgv), 'first send typed');
  const rows = fs.readFileSync(mailboxPath(KEY_S3, { dir: mboxDir }), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const msg = rows.find((r) => r.topic === 'resume');
  assert.equal(msg.via, 'typed');
  assert.ok(rows.some((r) => r.ack === msg.id && r.deliveredAs === 'typed'), 'acked at once');
  assert.deepEqual(readUnacked(KEY_S3, { dir: mboxDir }), []);

  fs.rmSync(fallbackArgv, { force: true });
  const second = await runSend(['--to', '991002', '--text', 'RESUME again', '--topic', 'resume'], env);
  assert.equal(second.code, 15, 'topic suppression exits 15, not 0');
  assert.match(second.stderr, /already delivered: topic resume at \S+ from /);
  assert.ok(!fs.existsSync(fallbackArgv), 'second send typed nothing');

  const forced = await runSend(['--to', '991002', '--text', 'RESUME forced', '--topic', 'resume', '--force-topic'], env);
  assert.equal(forced.code, 0);
  assert.ok(fs.existsSync(fallbackArgv), '--force-topic sends anyway');
  fs.rmSync(fallbackArgv, { force: true });
  const zero = await runSend(['--to', '991002', '--text', 'RESUME zero', '--topic', 'resume', '--topic-window', '0'], env);
  assert.ok(fs.existsSync(fallbackArgv), 'a zero window sends anyway');
  assert.equal(zero.code, 0);
  fs.rmSync(fallbackArgv, { force: true });
  const other = await runSend(['--to', '991002', '--text', 'other', '--topic', 'different'], env);
  assert.equal(other.code, 0);
  assert.ok(fs.existsSync(fallbackArgv), 'a different topic is sent');
});

test('findRecentTopicDelivery honours the window and ignores unacked rows', () => {
  const key = '-repo-a__tw';
  const now = Date.now();
  const m = appendMessage({ to: key, from: 'x', priority: 'now', text: 't', topic: 'win', now: now - 2 * 3600_000, ...libOpts() });
  assert.equal(findRecentTopicDelivery({ key, topic: 'win', windowMs: 3600_000, now, dir: mboxDir }), null, 'unacked');
  ack({ key, id: m.id, deliveredAs: 'prompt', now: now - 2 * 3600_000, ...libOpts() });
  assert.equal(findRecentTopicDelivery({ key, topic: 'win', windowMs: 3600_000, now, dir: mboxDir }), null, 'outside the window');
  assert.equal(findRecentTopicDelivery({ key, topic: 'win', windowMs: 3 * 3600_000, now, dir: mboxDir }).from, 'x');
  assert.equal(findRecentTopicDelivery({ key, topic: 'win', windowMs: 0, now, dir: mboxDir }), null, 'a zero window disables');
});

test('a bare send to a recipient with Claude Code\'s half-circle busy mark does not forward --now', async () => {
  for (const mark of ['◐', '◑']) {
    const { argv } = await bareSendArgv([], `${mark} claude: working`);
    assert.ok(!argv.includes('--now'), `${mark} argv: ${argv}`);
  }
});

// One end-to-end budget for a send to a BUSY recipient (the send blocked past two minutes, then ran kitty-send's own 20 s proof
// wait on top). AGENT_SEND_BUDGET_S bounds process start to exit;
// AGENT_SEND_BUSY_WAIT_S is the ack wait inside it; kitty-send gets only what
// is left as --timeout.
const busySend = async (env, title = '⠇ claude: working') => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const titleKitty = path.join(binDir, 'kitty-title-stub');
  try {
    fs.writeFileSync(titleKitty, [
      '#!/usr/bin/env bash',
      `echo '[{"tabs":[{"windows":[{"id":991001,"title":${JSON.stringify(title)},"cwd":"/repo/a"}]}]}]'`,
      '',
    ].join('\n'), { mode: 0o755 });
    fs.rmSync(fallbackArgv, { force: true });
    const t0 = Date.now();
    const r = await runSend(['--to', '991001', '--text', 'budgeted'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_MAILBOX_KITTY: titleKitty, ...env }));
    const elapsedMs = Date.now() - t0;
    const argv = fs.existsSync(fallbackArgv) ? fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean) : null;
    return { ...r, elapsedMs, argv };
  } finally {
    fs.writeFileSync(presFile, saved);
  }
};

test('a busy recipient returns within the budget and kitty-send gets only the remaining time', async () => {
  const { code, elapsedMs, argv, stderr } = await busySend({ AGENT_SEND_BUDGET_S: '4', AGENT_SEND_BUSY_WAIT_S: '1' });
  assert.ok(argv, `kitty-send ran: ${stderr}`);
  const i = argv.indexOf('--timeout');
  assert.ok(i >= 0, `kitty-send got --timeout: ${argv}`);
  const timeout = Number(argv[i + 1]);
  assert.ok(timeout >= 1 && timeout <= 3, `--timeout ${timeout} fits 4 s budget minus a 1 s ack wait`);
  assert.equal(code, 3, `stub kitty-send exit 5 sent nothing: re-queued, exit 3: ${stderr}`);
  assert.ok(elapsedMs < 4000, `elapsed ${elapsedMs} ms within the 4 s budget`);
});

test('a busy recipient with the budget spent leaves the row queued, skips kitty-send, exits 3', async () => {
  const { code, elapsedMs, argv, stderr } = await busySend({ AGENT_SEND_BUDGET_S: '1', AGENT_SEND_BUSY_WAIT_S: '30' });
  assert.equal(code, 3, stderr);
  assert.equal(argv, null, 'kitty-send was not run');
  assert.ok(elapsedMs < 2500, `elapsed ${elapsedMs} ms: the busy wait is clamped to the 1 s budget`);
  const id = stderr.match(/queued (\S+) for /)?.[1];
  assert.ok(id, stderr);
  assert.match(stderr, new RegExp(`budget.*row ${id}.*--cancel --id ${id}`));
  assert.ok(readUnacked(KEY_S1, libOpts()).some((r) => r.id === id), 'the row is still queued');
  cancelQueued({ key: KEY_S1, id, ...libOpts() });
});

test('an idle recipient is unchanged by the budget: no --timeout forwarded', async () => {
  const { argv } = await busySend({ AGENT_SEND_BUDGET_S: '4', AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_IDLE_WAIT_S: '0.5' }, 'claude: idle seat');
  assert.ok(argv && !argv.includes('--timeout'), `argv: ${argv}`);
});

// --queue to a seat with a mailbox consumer. A Claude Code seat drains only at
// its next tool call, its next prompt or its Stop, so an IDLE seat never acks a
// queued row: the sender used to wait for that ack forever while the row sat in
// the mailbox (one seat missed three messages for about 35 minutes). Now a
// recipient PROVEN idle gets the row typed in through kitty-send --wait-idle,
// and anything else keeps the row queued for its own drain. Proof is all of: a
// title with no spinner, a session record whose status is `idle`, a readable
// screen with no dialog on it, and a Claude composer showing an empty prompt
// line. The kitty stub reads the window title and screen from files the test
// rewrites, so a recipient can go idle mid-wait; a missing screen file is an
// unreadable screen.
const EMPTY_COMPOSER = ['● Done.', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ? for shortcuts'].join('\n');
const QUEUE_WIN_PID = 424242;
const queueSend = (args, { title, status = 'idle', screen = EMPTY_COMPOSER, envExtra = {}, killAfterMs = 20_000, whileRunning = null, text = 'queued for an idle seat' } = {}) => {
  const titleFile = path.join(binDir, 'queue-title');
  const screenFile = path.join(binDir, 'queue-screen');
  const sessDir = path.join(binDir, 'queue-claude-sessions');
  const titleKitty = path.join(binDir, 'kitty-queue-title-stub');
  fs.writeFileSync(titleFile, title);
  fs.rmSync(screenFile, { force: true });
  if (screen != null) fs.writeFileSync(screenFile, screen);
  fs.rmSync(sessDir, { recursive: true, force: true });
  fs.mkdirSync(sessDir);
  if (status != null) fs.writeFileSync(path.join(sessDir, `${QUEUE_WIN_PID}.json`), JSON.stringify({ sessionId: 'q1', cwd: '/repo/a', status }));
  fs.writeFileSync(titleKitty, [
    '#!/usr/bin/env bash',
    'if [ "$2" = "get-text" ]; then',
    `  cat ${JSON.stringify(screenFile)} 2>/dev/null || exit 1`,
    '  exit 0',
    'fi',
    `node -e 'process.stdout.write(JSON.stringify([{tabs:[{windows:[{id:991001,title:require("fs").readFileSync(process.argv[1],"utf-8"),cwd:"/repo/a",foreground_processes:[{pid:${QUEUE_WIN_PID},cmdline:["claude"]}]}]}]}]))' ${JSON.stringify(titleFile)}`,
    '',
  ].join('\n'), { mode: 0o755 });
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  let side = null;
  const env = childEnv({
    CLAUDE_CODE_SESSION_ID: 's2', AGENT_MAILBOX_KITTY: titleKitty, AGENT_SEND_KITTY_SEND: realRulesStub, AGENT_SEND_IDLE_WAIT_S: '0', CLAUDE_SESSIONS_DIR: sessDir, ...envExtra,
  });
  const run = new Promise((resolve) => {
    const child = spawn('node', [SEND, ...args, '--text', text], { env });
    let stderr = '';
    let killed = false;
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, killAfterMs);
    const ctl = { setTitle: (t) => fs.writeFileSync(titleFile, t), rowId: () => stderr.match(/queued (\S+) for /)?.[1] ?? null };
    side = whileRunning?.(ctl);
    child.on('close', (code) => {
      clearTimeout(timer);
      const argv = fs.existsSync(fallbackArgv) ? fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean) : null;
      resolve({ code, killed, stderr, argv });
    });
  });
  // The side task's own assertions fail the test, not an unhandled rejection.
  return run.then(async (r) => { await side; return r; });
};
const typedRows = () => {
  const p = mailboxPath(KEY_S1, { dir: mboxDir });
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.via === 'typed') : [];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('--queue to an idle recipient is typed in at once and exits 0, not left waiting for a drain', async () => {
  const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], { title: 'claude: idle seat' });
  assert.equal(killed, false, `the sender waited forever on an idle seat: ${stderr}`);
  assert.equal(code, 0, stderr);
  assert.ok(argv, `kitty-send ran: ${stderr}`);
  assert.ok(argv.includes('--wait-idle'), `typed only once idle: ${argv}`);
  assert.ok(!argv.includes('--queue') && !argv.includes('--now'), `argv: ${argv}`);
  // No double delivery: the mailbox copy is withdrawn, so no later drain shows
  // it, and the typed copy is recorded as an acked row.
  assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), []);
  assert.equal(typedRows().length, 1);
});

// Real shape (read from live screens, text removed): a seat whose turn ended
// while background tasks still run records status `shell` and shows an empty
// composer above a footer that lists them. That is idle at the prompt.
const BACKGROUND_FOOTER_SCREEN = ['● Done.', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ← 2 agents · ↓ to manage'].join('\n');
test('--queue types into an idle seat whose record status is shell (background tasks running)', async () => {
  const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], {
    title: '✳ claude: idle seat',
    status: 'shell',
    screen: BACKGROUND_FOOTER_SCREEN,
    envExtra: { AGENT_SEND_IDLE_WAIT_S: '1' },
  });
  assert.equal(killed, false, stderr);
  assert.equal(code, 0, stderr);
  assert.ok(argv?.includes('--wait-idle'), `argv: ${argv}`);
});

test('--queue to a busy recipient stays queued and is acked by its drain, never typed', async () => {
  const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], {
    title: '⠇ claude: working',
    whileRunning: async (ctl) => {
      let id = null;
      for (let i = 0; i < 100 && id == null; i += 1) { await sleep(50); id = ctl.rowId(); }
      await sleep(2500); // longer than one idle poll: a busy seat is left alone
      assert.equal(fs.existsSync(fallbackArgv), false, 'nothing typed into a busy window');
      assert.ok(readUnacked(KEY_S1, { dir: mboxDir }).some((r) => r.id === id), 'the row is still queued');
      ack({ key: KEY_S1, id, deliveredAs: 'tool', dir: mboxDir }); // the seat's tool-boundary drain
    },
  });
  assert.equal(killed, false, stderr);
  assert.equal(code, 0, stderr);
  assert.equal(argv, null, 'kitty-send never ran');
  assert.equal(typedRows().length, 0);
});

test('--queue to a busy recipient that goes idle without draining is typed in then', async () => {
  const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], {
    title: '⠇ claude: working',
    whileRunning: async (ctl) => { await sleep(2500); ctl.setTitle('✳ claude: idle seat'); },
  });
  assert.equal(killed, false, `the sender waited forever after the seat went idle: ${stderr}`);
  assert.equal(code, 0, stderr);
  assert.ok(argv?.includes('--wait-idle'), `argv: ${argv}`);
  assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), []);
  assert.equal(typedRows().length, 1, 'one delivery, recorded once');
});

test('--queue to an idle recipient whose drain acks inside the idle wait is not typed a second time', async () => {
  const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], {
    title: 'claude: idle seat',
    envExtra: { AGENT_SEND_IDLE_WAIT_S: '4' },
    whileRunning: async (ctl) => {
      let id = null;
      for (let i = 0; i < 100 && id == null; i += 1) { await sleep(50); id = ctl.rowId(); }
      ack({ key: KEY_S1, id, deliveredAs: 'stop', dir: mboxDir }); // the Stop drain of a turn that just ended
    },
  });
  assert.equal(killed, false, stderr);
  assert.equal(code, 0, stderr);
  assert.equal(argv, null, 'an acked row is never typed');
  assert.equal(typedRows().length, 0);
});

test('--queue --deadline still bounds the wait for a busy recipient', async () => {
  const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue', '--deadline', '1'], {
    title: '⠇ claude: working',
    envExtra: { KITTY_SEND_STUB_EXIT: '5' },
  });
  assert.equal(killed, false, stderr);
  assert.equal(code, 3, stderr);
  assert.equal(argv[argv.indexOf('--wait-idle') + 1], '1', `argv: ${argv}`);
  assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 1, 're-queued for the drain');
});

// Fail closed: text is typed only on positive proof that the seat is idle AND
// its composer is empty. Every case below leaves the row queued, sends no
// keystroke (the fake sender never runs) and says on one stderr line why.
// Dialog fixtures. A permission prompt and a plan approval are caught by the
// session record status `waiting`, so their screens carry NO footer string here:
// nothing is invented for them. QUESTION_DIALOG's footer is ASSUMED, composed
// from the strings in the Claude Code 2.1.323 binary ("↑/↓ to navigate", "Enter
// to select", "Esc to cancel"); no live dialog was captured to confirm it.
const PERMISSION_DIALOG = ['● Bash(rm -rf build)', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');
const QUESTION_DIALOG = ['Which database should we use?', ' ❯ 1. Postgres', '   2. SQLite', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
const PLAN_DIALOG = ['Ready to code?', ' Here is Claude\'s plan:', ' Would you like to proceed?', ' ❯ 1. Yes, and auto-accept edits', '   2. No, keep planning'].join('\n');
const notTyped = async (why, opts, reason) => {
  const { killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], { title: '✳ claude: idle seat', killAfterMs: 2500, ...opts });
  assert.equal(killed, true, `${why}: the sender must keep waiting, not type or exit: ${stderr}`);
  assert.equal(argv, null, `${why}: no keystroke may be sent: ${argv}`);
  assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 1, `${why}: the row stays queued`);
  assert.equal(typedRows().length, 0, why);
  assert.match(stderr, reason, `${why}: one line says why nothing was typed: ${stderr}`);
};
test('--queue never types into a seat whose record status is waiting', () => notTyped('waiting', { status: 'waiting' }, /not typed.*status waiting/));
test('--queue never types into a seat whose record status is blocked', () => notTyped('blocked', { status: 'blocked' }, /not typed.*status blocked/));
test('--queue never types into a seat whose record status is unknown', () => notTyped('unknown status', { status: 'thinking' }, /not typed.*status thinking/));
test('--queue never types into a seat with no session record', () => notTyped('no record', { status: null }, /not typed.*no session record/));
test('--queue never types over a permission prompt', () => notTyped('permission', { status: 'waiting', screen: PERMISSION_DIALOG }, /not typed.*status waiting/));
test('--queue never types over a question dialog', () => notTyped('question', { screen: QUESTION_DIALOG }, /not typed.*dialog/));
test('--queue never types over a plan approval', () => notTyped('plan', { status: 'waiting', screen: PLAN_DIALOG }, /not typed.*status waiting/));
test('--queue never types when the screen cannot be read', () => notTyped('unreadable', { screen: null }, /not typed.*screen could not be read/));
test('--queue never types onto a half-typed draft', () => notTyped('draft', { screen: ['● Done.', '─'.repeat(40), '❯ half a thought', '─'.repeat(40)].join('\n') }, /not typed.*composer holds text/));
// Prose in the seat's own last reply must not read as a dialog.
test('--queue types into an idle seat whose last reply asks a question', async () => {
  const screen = ['● All checks passed. Do you want to merge it now? Would you like to proceed?', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ? for shortcuts'].join('\n');
  const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], { title: '✳ claude: idle seat', screen });
  assert.equal(killed, false, stderr);
  assert.equal(code, 0, stderr);
  assert.ok(argv?.includes('--wait-idle'), `argv: ${argv}`);
});

test('--queue never types onto a multi-line draft whose first line is empty', () => notTyped('multi-line draft', { screen: ['● Done.', '─'.repeat(40), '❯ ', '  second line of a draft', '─'.repeat(40), '  ? for shortcuts'].join('\n') }, /not typed.*composer holds text/));
test('--queue never types onto a draft with several lines under an empty first line', () => notTyped('multi-line draft', { screen: ['● Done.', '─'.repeat(40), '❯', '', '  third line of a draft', '─'.repeat(40)].join('\n') }, /not typed.*composer holds text/));
test('--queue never types text that starts with "/": it would run as a command in the seat', () => notTyped('slash text', { text: '/compact now' }, /not typed.*starts with "\/"/));
test('after the proof, kitty-send waits only a few seconds for idle, so a seat woken since is not typed into late', async () => {
  const { argv, stderr } = await queueSend(['--to', '991001', '--queue'], { title: 'claude: idle seat' });
  assert.ok(argv, stderr);
  const wait = Number(argv[argv.indexOf('--wait-idle') + 1]);
  assert.ok(wait > 0 && wait <= 10, `--wait-idle ${wait}: argv ${argv}`);
});
test('kitty-send exit 11 on the direct fallback exits 1, never 11 (that is --claim-role refused)', async () => {
  const queueDir = path.join(binDir, 'xdg-run-11');
  fs.mkdirSync(queueDir, { recursive: true });
  const { code, stderr } = await runSend(
    ['--to', '991002', '--text', 'direct'],
    childEnv({ AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '11', XDG_RUNTIME_DIR: queueDir }),
  );
  assert.equal(code, 1, stderr);
  assert.match(stderr, /nothing was sent/);
});

// A seat with no mailbox consumer, reached by --queue through the kitty fallback,
// gets the same proof as every other queued send.
test('--queue through the kitty fallback is never typed onto a half-typed draft', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a' }]); // beacon without the consumer flag
    const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], {
      title: 'claude: idle seat', screen: ['● Done.', '─'.repeat(40), '❯ half a thought', '─'.repeat(40)].join('\n'),
    });
    assert.equal(killed, false, stderr);
    assert.equal(argv, null, `kitty-send must not run: ${stderr}`);
    assert.notEqual(code, 0, stderr);
    assert.match(stderr, /not typed.*composer holds text/);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});
test('--queue through the kitty fallback is typed when the composer is proven empty', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a' }]);
    const { killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], { title: 'claude: idle seat' });
    assert.equal(killed, false, stderr);
    assert.ok(argv?.includes('--wait-idle') && !argv.includes('--queue'), `argv: ${argv}`);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});
test('--queue never types when no prompt line is on screen', () => notTyped('no prompt', { screen: '● Done.\n' }, /not typed.*no composer box/));

// ---- review scenarios: the early verdict decides only whether to WITHDRAW ----

// Idle title, `❯ half a thought`, --deadline 2. The deadline used to withdraw the
// row and type it through kitty-send --wait-idle with no composer check. Now the
// row stays queued (never withdrawn first in the hope that kitty-send refuses),
// kitty-send is never reached, and the sender exits 3 saying why.
test('--queue --deadline against an idle seat with a draft: the row stays queued, kitty-send never runs', async () => {
  const draft = ['● Done.', '─'.repeat(40), '❯ half a thought', '─'.repeat(40), '  ? for shortcuts'].join('\n');
  const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue', '--deadline', '2'], { title: '✳ claude: idle seat', screen: draft, killAfterMs: 15_000 });
  assert.equal(killed, false, stderr);
  assert.equal(code, 3, stderr);
  assert.equal(argv, null, `no keystroke path may run: ${argv}`);
  assert.match(stderr, /--deadline ran out; not typed into 991001: composer holds text/);
  assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 1, 'the row was not withdrawn');
  assert.equal(typedRows().length, 0);
});

// The fallback (a seat with no mailbox consumer) passes the text to the proof
// too: `/compact now` would otherwise run as a command in the seat.
test('--queue --text "/compact now" through the kitty fallback is never typed', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a' }]);
    const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], { title: 'claude: idle seat', text: '/compact now' });
    assert.equal(killed, false, stderr);
    assert.equal(argv, null, `kitty-send must not run: ${stderr}`);
    assert.notEqual(code, 0, stderr);
    assert.match(stderr, /not typed into 991001: the text starts with "\//);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});
