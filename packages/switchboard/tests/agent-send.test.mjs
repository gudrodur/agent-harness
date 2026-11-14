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
        { id: 991002, title: 'opencode: example-project review docs', pid: 112, cwd: '/repo/b', foreground_processes: [{ pid: 112, cmdline: ['/usr/bin/claude'] }] },
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
    'if [ "$rc" = 12 ] && printf \'%s\' "$err" | grep -q "remote control unavailable"; then',
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
  // The assertions below read the step-by-step trace; the quiet default has its own tests.
  AGENT_SEND_VERBOSE: '1',
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

// kitty-send exit 16 (a slash command still in the composer after its extra
// Enters) is typed, not proven submitted: like 10 it passes through, is never
// re-queued, and its own chatter is held because agent-send prints the verdict.
test('kitty-send exit 16 passes through with one verdict line and no kitty-send chatter', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const chatter = path.join(binDir, 'chatter-16');
  fs.writeFileSync(chatter, '#!/usr/bin/env bash\necho "kitty-send: raw chatter line" >&2\nexit 16\n', { mode: 0o755 });
  const { code, stderr } = await runSend(
    ['--to', '991001', '--text', 'parked steer'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: chatter, AGENT_SEND_VERBOSE: '' }),
  );
  assert.equal(code, 16, stderr);
  assert.match(stderr, /kitty-send exit 16 for 991001: .*typed, not proven submitted/);
  assert.doesNotMatch(stderr, /raw chatter line/);
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

// ---- kitty remote control down: point a Claude Code caller at SendMessage ----
//
// kitty-send exits 12 when `kitty @ ls` does not answer. The row stays queued
// where one exists, and one stderr line names the built-in channel (ListAgents
// + SendMessage) and the --cancel of the queued row. Each hint site has its
// own test; deleting any one of them turns a test red.
const startOf = (pid) => { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8'); return st.slice(st.lastIndexOf(')') + 2).split(' ')[19]; };
// A Claude sessions dir: [{ sessionId, name, live }] -> one record each. A live
// record names this test process (so /proc agrees with procStart); a dead one
// carries a start time that process never had.
const sessionsWith = (records) => {
  const dir = path.join(binDir, `rc-sessions-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir);
  records.forEach((r, i) => fs.writeFileSync(path.join(dir, `${7000 + i}.json`), JSON.stringify({
    pid: process.pid, procStart: r.live === false ? '1' : startOf(process.pid), sessionId: r.sessionId, name: r.name,
  })));
  return dir;
};
const kittyStubOf = (name, body) => {
  const f = path.join(binDir, name);
  fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return f;
};
const DOWN_KITTY = () => kittyStubOf('kitty-down', 'exit 1');
const NAMED = [{ sessionId: 's1', name: 'reviewer · example · docs' }];
const hintRe = /SendMessage\(\{to: "reviewer · example · docs", message: <the same text>\}\) \(ListAgents lists the live sessions\)/;
const withPresence = async (beacons, fn) => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try { writePresence(beacons); return await fn(); } finally { fs.writeFileSync(presFile, saved); }
};
const rcDownSend = (args, extra = {}) => runSend(args, childEnv({ CLAUDE_CODE_SESSION_ID: 's2', CLAUDE_SESSIONS_DIR: sessionsWith(NAMED), ...extra }));

test('busy-path re-queue: kitty-send exit 12 keeps the row queued and prints the SendMessage hint with the cancel id', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await rcDownSend(['--to', '991001', '--text', 'steer while kitty is down', '--deadline', '1'], {
    AGENT_SEND_KITTY_SEND: kittyStubOf('send-12', 'exit 12'),
  });
  assert.equal(code, 3, stderr);
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1, 'the row stays queued');
  assert.match(stderr, hintRe);
  assert.match(stderr, new RegExp(`--cancel --id ${left[0].id}`));
  assert.equal((stderr.match(/SendMessage\(/g) ?? []).length, 1, 'the hint prints once');
});

test('kitty-send exit 1 (a usage failure) while kitty answers prints no hint', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await rcDownSend(['--to', '991001', '--text', 'usage failure', '--deadline', '1'], {
    AGENT_SEND_KITTY_SEND: kittyStubOf('send-1', 'exit 1'),
  });
  assert.equal(code, 3, stderr);
  assert.doesNotMatch(stderr, /SendMessage/);
});

test('plain fallback (no mailbox consumer): exit 12 from kitty-send exits 1 with the hint and no cancel clause', async () => {
  const { code, stderr } = await withPresence([{ sessionId: 's3', cwd: '/repo/b' }], () =>
    rcDownSend(['--to', '991002', '--text', 'plain fallback'], { AGENT_SEND_KITTY_SEND: kittyStubOf('send-12', 'exit 12') }));
  assert.equal(code, 1, `kitty-send's 12 must leave as 1, never agent-send's own 12: ${stderr}`);
  assert.match(stderr, /kitty remote control is not answering/);
  assert.match(stderr, /ListAgents/);
  assert.match(stderr, /nothing is queued, so there is no row to withdraw/);
});

test('--queue with no mailbox to park in: exit 12 exits 1 with the hint', async () => {
  const { code, killed, stderr } = await withPresence([{ sessionId: 's1', cwd: '/repo/a' }], () =>
    queueSend(['--to', '991001', '--queue'], { title: 'claude: idle seat', envExtra: { KITTY_SEND_STUB_EXIT: '12' } }));
  assert.equal(killed, false, stderr);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /kitty remote control is not answering/);
});

test('--queue to a busy tab with no mailbox: the waiter path sees exit 12 and prints the hint', async () => {
  const { code, killed, stderr } = await withPresence([{ sessionId: 's1', cwd: '/repo/a' }], () =>
    queueSend(['--to', '991001', '--queue'], { title: '⠋ claude: busy seat', status: 'busy', envExtra: { KITTY_SEND_STUB_EXIT: '12' } }));
  assert.equal(killed, false, stderr);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /kitty remote control is not answering/);
});

test('--queue to an idle seat: exit 12 re-queues the row and the hint names the cancel id', async () => {
  const procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-proc-'));
  fs.mkdirSync(path.join(procDir, '4001'));
  fs.writeFileSync(path.join(procDir, '4001', 'comm'), 'claude\n');
  fs.writeFileSync(path.join(procDir, '4001', 'environ'), 'KITTY_WINDOW_ID=991001\0');
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    fs.writeFileSync(presFile, JSON.stringify({ beacons: [{ sessionId: 's1', cwd: '/repo/a', mailbox: true, windowId: 991001, pid: process.pid, firstTick: old, lastTick: old }] }));
    const { code, killed, stderr } = await queueSend(['--to', '991001', '--queue'], {
      title: 'claude: idle seat',
      extraSessions: NAMED, envExtra: { KITTY_SEND_STUB_EXIT: '12', AGENT_MAILBOX_PROC_DIR: procDir },
    });
    assert.equal(killed, false, stderr);
    assert.equal(code, 3, stderr);
    const left = readUnacked(KEY_S1, { dir: mboxDir });
    assert.equal(left.length, 1);
    assert.match(stderr, hintRe);
    assert.match(stderr, new RegExp(`--cancel --id ${left[0].id}`));
  } finally {
    fs.writeFileSync(presFile, saved);
    fs.rmSync(procDir, { recursive: true, force: true });
  }
});

test('kitty unreachable from the start: a window id is not "no such window"; exit 1 with the hint', async () => {
  const { code, stderr } = await withPresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true, windowId: 991001 }], () =>
    rcDownSend(['--to', '991001', '--text', 'kitty is gone'], { AGENT_MAILBOX_KITTY: DOWN_KITTY() }));
  assert.equal(code, 1, stderr);
  assert.doesNotMatch(stderr, /no kitty window with id/);
  assert.match(stderr, /kitty remote control is not answering, so window '991001' cannot be looked up/);
  assert.match(stderr, hintRe);
});

test('kitty unreachable from the start: a title target gets the hint too', async () => {
  const { code, stderr } = await rcDownSend(['--to', 'review docs', '--text', 'kitty is gone'], { AGENT_MAILBOX_KITTY: DOWN_KITTY() });
  assert.equal(code, 1, stderr);
  assert.doesNotMatch(stderr, /no kitty window matches/);
  assert.match(stderr, /SendMessage\(\{to: <that name>/);
});

test('--queue with no --deadline and kitty down does not wait forever: exit 3, row queued, hint', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const hang = kittyStubOf('kitty-hang', 'sleep 30');
  const started = Date.now();
  const { code, stderr } = await withPresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true, windowId: 991001 }], () =>
    rcDownSend(['--to', KEY_S1, '--queue', '--text', 'queued while kitty hangs'], { AGENT_MAILBOX_KITTY: hang, AGENT_KITTY_LS_TIMEOUT_MS: '300' }));
  assert.equal(code, 3, stderr);
  assert.ok(Date.now() - started < 10_000, 'the probe timeout bounds the wait');
  assert.match(stderr, hintRe);
  assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 1, 'the row stays queued');
});

test('the budget spent against a busy recipient with kitty down: exit 3 with the hint, no extra probe', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const started = Date.now();
  const { code, stderr } = await withPresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true, windowId: 991001 }], () =>
    rcDownSend(['--to', KEY_S1, '--text', 'busy and kitty down'], {
      AGENT_MAILBOX_KITTY: kittyStubOf('kitty-hang', 'sleep 30'), AGENT_KITTY_LS_TIMEOUT_MS: '300', AGENT_SEND_BUDGET_S: '1', AGENT_SEND_BUSY_WAIT_S: '1',
    }));
  assert.equal(code, 3, stderr);
  assert.match(stderr, /budget of 1s spent/);
  assert.match(stderr, hintRe);
  assert.ok(Date.now() - started < 8000, `no re-probe past the budget (${Date.now() - started}ms)`);
});

test('kitty-send exit 11 while kitty has dropped since its own check: the hint still prints', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  fs.rmSync(path.join(binDir, 'drop-flag'), { force: true });
  const { code, stderr } = await rcDownSend(['--to', '991001', '--text', 'kitty dropped mid-send', '--deadline', '1'], {
    // answers like the fixture stub until kitty-send has run, then drops
    AGENT_MAILBOX_KITTY: kittyStubOf('kitty-drops', `if [ -e ${path.join(binDir, 'drop-flag')} ]; then exit 1; fi\nexec ${kittyStub} "$@"`),
    AGENT_SEND_KITTY_SEND: kittyStubOf('send-11-drop', `touch ${path.join(binDir, 'drop-flag')}\nexit 11`),
  });
  assert.equal(code, 3, stderr);
  assert.match(stderr, hintRe);
});

test('kitty-send exit 11 while kitty answers prints no hint', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await rcDownSend(['--to', '991001', '--text', 'screen unreadable', '--deadline', '1'], {
    AGENT_SEND_KITTY_SEND: kittyStubOf('send-11', 'exit 11'),
  });
  assert.equal(code, 3, stderr);
  assert.doesNotMatch(stderr, /SendMessage/);
});

test('kittyLs: non-array JSON is "not answering" (null, known down), never a throw downstream', async () => {
  const { kittyLs, kittyKnownDown, flattenWindows } = await import('../lib/kitty-ls.mjs');
  const saved = process.env.AGENT_MAILBOX_KITTY;
  try {
    process.env.AGENT_MAILBOX_KITTY = kittyStubOf('kitty-obj', `echo '{"error":"x"}'`);
    assert.equal(kittyLs(), null);
    assert.equal(kittyKnownDown(), true);
    assert.deepEqual(flattenWindows(kittyLs()), []);
  } finally { if (saved === undefined) delete process.env.AGENT_MAILBOX_KITTY; else process.env.AGENT_MAILBOX_KITTY = saved; }
});

test('kittyLs: a missing kitty binary is not an outage, so it earns no hint', async () => {
  const { kittyLs, kittyKnownDown } = await import('../lib/kitty-ls.mjs');
  const saved = process.env.AGENT_MAILBOX_KITTY;
  try {
    process.env.AGENT_MAILBOX_KITTY = path.join(binDir, 'no-such-kitty');
    assert.equal(kittyLs(), null);
    assert.equal(kittyKnownDown(), false);
  } finally { if (saved === undefined) delete process.env.AGENT_MAILBOX_KITTY; else process.env.AGENT_MAILBOX_KITTY = saved; }
});

test('the budget spent with kitty down reuses the earlier failed probe: kitty @ ls is not asked again', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const calls = path.join(binDir, 'ls-calls');
  fs.rmSync(calls, { force: true });
  const { code, stderr } = await withPresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true, windowId: 991001 }], () =>
    rcDownSend(['--to', KEY_S1, '--text', 'busy and kitty down'], {
      AGENT_MAILBOX_KITTY: kittyStubOf('kitty-count', `echo x >> ${calls}\nsleep 30`), AGENT_KITTY_LS_TIMEOUT_MS: '300', AGENT_SEND_BUDGET_S: '1', AGENT_SEND_BUSY_WAIT_S: '1',
    }));
  assert.equal(code, 3, stderr);
  assert.match(stderr, hintRe);
  const n = fs.readFileSync(calls, 'utf-8').trim().split('\n').length;
  assert.ok(n <= 1, `kitty @ ls asked ${n} times`);
});

test('a role whose idle holder cannot be seen because kitty is down: exit 3 queued for the role, with the hint', async () => {
  const fx = await handoverFixture('rc-role');
  await seatHolder(fx, { minutesAgo: 30, windowId: 991002, pid: process.pid });
  const procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-proc-'));
  fs.mkdirSync(path.join(procDir, '4002'));
  fs.writeFileSync(path.join(procDir, '4002', 'comm'), 'claude\n');
  fs.writeFileSync(path.join(procDir, '4002', 'environ'), 'KITTY_WINDOW_ID=991002\0');
  try {
    const { code, stderr } = await runSend(['--to', 'role:lead', '--text', 'to the parked lead'], handoverEnv(fx.db, {
      CLAUDE_CODE_SESSION_ID: 's2', AGENT_MAILBOX_KITTY: DOWN_KITTY(), AGENT_MAILBOX_PROC_DIR: procDir,
      CLAUDE_SESSIONS_DIR: sessionsWith([{ sessionId: 'old-seat', name: 'reviewer · example · docs' }]),
    }));
    assert.equal(code, 3, stderr);
    assert.match(stderr, /queued for role lead; no live holder/);
    assert.match(stderr, hintRe);
    assert.match(stderr, /--cancel --id \S+ so it does not arrive twice/);
  } finally {
    fs.rmSync(procDir, { recursive: true, force: true });
  }
});

test('a role with a gone holder and a healthy kitty gets no hint', async () => {
  const fx = await handoverFixture('rc-role-ok');
  const { code, stderr } = await runSend(['--to', 'role:nobody-here', '--text', 'x'], handoverEnv(fx.db, { CLAUDE_CODE_SESSION_ID: 's2' }));
  assert.equal(code, 3, stderr);
  assert.doesNotMatch(stderr, /SendMessage/);
});

// ---- who the hint names: a live, unique session name, else ListAgents ----

test('a session record that is not live (a resumed session leaves one behind) is never named', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { stderr } = await rcDownSend(['--to', '991001', '--text', 'x', '--deadline', '1'], {
    AGENT_SEND_KITTY_SEND: kittyStubOf('send-12', 'exit 12'), CLAUDE_SESSIONS_DIR: sessionsWith([{ ...NAMED[0], live: false }]),
  });
  assert.doesNotMatch(stderr, /reviewer · example · docs/);
  assert.match(stderr, /run ListAgents, find the recipient by its name/);
});

test('a session name shared by two live sessions is not offered as the SendMessage target', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { stderr } = await rcDownSend(['--to', '991001', '--text', 'x', '--deadline', '1'], {
    AGENT_SEND_KITTY_SEND: kittyStubOf('send-12', 'exit 12'), CLAUDE_SESSIONS_DIR: sessionsWith([NAMED[0], { sessionId: 'other', name: NAMED[0].name }]),
  });
  assert.doesNotMatch(stderr, /SendMessage\(\{to: "reviewer/);
  assert.match(stderr, /is shared by more than one live session, so pick the entry for session s1/);
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
// types and submits at once; a busy one is never typed into, so kitty-send does
// not run at all.
const bareSendArgv = async (extraArgs, title, extraEnv = null, to = '991002') => {
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
    const r = await runSend(['--to', to, ...extraArgs, '--text', 'hello'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1', AGENT_MAILBOX_KITTY: busyKitty, ...extraEnv }));
    return { code: r.code, stderr: r.stderr, argv: fs.existsSync(fallbackArgv) ? fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean) : null };
  } finally {
    fs.writeFileSync(presFile, saved);
  }
};

// A title with no spinner is not proof the seat is idle: kitty-send also reads
// the session state file, and a window it finds mid-turn under --now gets the
// text in its steering queue with the in-flight tool result DISCARDED. So a
// bare send never forwards --now; a mid-turn target is kitty-send's exit 7,
// which agent-send re-queues.
test('a bare send to a title-idle recipient does not forward --now to kitty-send', async () => {
  const { code, argv } = await bareSendArgv([], 'claude: idle seat');
  assert.equal(code, 5);
  assert.ok(argv.length > 0, 'kitty-send was still run');
  assert.ok(!argv.includes('--now'), `argv: ${argv}`);
  assert.ok(!argv.includes('--deadline'));
});

test('a bare send whose idle-looking recipient is mid-turn for kitty-send keeps the row queued, never --now', async () => {
  // The title shows no spinner, but kitty-send's own state check finds the seat
  // mid-turn: with --now it would type into the steering queue (exit 8) and
  // discard the in-flight tool result; without it, exit 7 sends nothing.
  const midTurnStub = path.join(binDir, 'kitty-send-midturn.sh');
  fs.writeFileSync(midTurnStub, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$@" > ${JSON.stringify(fallbackArgv)}`,
    'for a in "$@"; do [ "$a" = --now ] && exit 8; done',
    'exit 7',
    '',
  ].join('\n'), { mode: 0o755 });
  const { code, argv, stderr } = await busySend(
    { AGENT_SEND_BUDGET_S: '4', AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_IDLE_WAIT_S: '0.5', AGENT_SEND_KITTY_SEND: midTurnStub, AGENT_SEND_VERBOSE: '1' },
    'claude: idle seat',
  );
  assert.ok(argv, `kitty-send ran: ${stderr}`);
  assert.ok(!argv.includes('--now'), `argv: ${argv}`);
  assert.equal(code, 3, `exit 7 sent nothing: the row is re-queued, pending: ${stderr}`);
  // One classification per call: a recipient read as idle is never also called busy.
  assert.match(stderr, /idle recipient/, stderr);
  assert.doesNotMatch(stderr, /recipient busy\/parked/, stderr);
  const id = stderr.match(/re-queued as (\S+) in /)?.[1];
  assert.ok(id, stderr);
  assert.ok(readUnacked(KEY_S1, libOpts()).some((r) => r.id === id), 'the row is queued again');
  cancelQueued({ key: KEY_S1, id, ...libOpts() });
});

test('a bare send to a no-consumer mid-turn recipient is held with kitty-send --queue: pending exit 3, never --now, never dropped', async () => {
  // kitty-send's own state check finds the seat mid-turn: exit 7 (nothing sent)
  // unless --now (exit 8, tool result discarded) or --queue (waiter started, 0).
  const calls = path.join(binDir, 'kitty-send-calls.log');
  const stub = path.join(binDir, 'kitty-send-nocons-midturn.sh');
  fs.writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`,
    'for a in "$@"; do',
    '  [ "$a" = --now ] && exit 8',
    '  [ "$a" = --queue ] && exit 0',
    'done',
    'exit 7',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.rmSync(calls, { force: true });
  const { code, stderr } = await (async () => {
    const saved = fs.readFileSync(presFile, 'utf-8');
    try {
      writePresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true }]);
      return await runSend(['--to', '991002', '--text', 'hello'], childEnv({ CLAUDE_CODE_SESSION_ID: 's1', AGENT_SEND_KITTY_SEND: stub }));
    } finally {
      fs.writeFileSync(presFile, saved);
    }
  })();
  const lines = fs.readFileSync(calls, 'utf-8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, stderr);
  assert.ok(lines.every((l) => !/(^| )--now( |$)/.test(l)), `never --now: ${lines}`);
  assert.ok(lines.some((l) => /(^| )--queue( |$)/.test(l)), `a --queue call: ${lines}`);
  assert.equal(code, 3, `pending, do not resend: ${stderr}`);
  // One pending line only: no failure wording that invites a resend or --now.
  const pendingLines = stderr.split('\n').filter((l) => /pending/.test(l));
  assert.equal(pendingLines.length, 1, `exactly one pending line: ${stderr}`);
  assert.match(pendingLines[0], /held/);
  assert.match(pendingLines[0], /do not resend/);
  assert.doesNotMatch(stderr, /failure|send again/i);
});

// A busy recipient with no mailbox is HELD, never refused and never typed into:
// kitty-send --queue types the text at the seat's next idle point, the sender
// exits 3 with one line (pending, do not resend), and --now is never forwarded.
const holdEnv = () => ({ AGENT_SEND_KITTY_SEND: realRulesStub, AGENT_SEND_VERBOSE: '', AGENT_SEND_BUDGET_S: '4' });
const assertHeld = ({ code, argv, stderr }, label = '') => {
  assert.ok(argv?.includes('--queue'), `${label} kitty-send --queue must hold it: ${argv} / ${stderr}`);
  assert.ok(!argv.includes('--now'), `${label} never --now: ${argv}`);
  assert.equal(code, 3, `${label}${stderr}`);
  assert.match(stderr, /pending, do not resend/);
  assert.equal(stderr.split('\n').filter((l) => l.trim()).length, 1, `${label}one verdict line: ${stderr}`);
};
test('the race hold in the default (non-verbose) mode prints one line, not kitty-send\'s own exit-7 refusal', async () => {
  const stub = path.join(binDir, 'kitty-send-race-quiet.sh');
  fs.writeFileSync(stub, [
    '#!/usr/bin/env bash',
    'for a in "$@"; do',
    '  [ "$a" = --queue ] && exit 0',
    'done',
    'echo "kitty-send: refusing to send into a mid-turn target (nothing was sent); use --now to type anyway" >&2',
    'exit 7',
    '',
  ].join('\n'), { mode: 0o755 });
  const saved = fs.readFileSync(presFile, 'utf-8');
  let r;
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a', mailbox: true }]);
    r = await runSend(['--to', '991002', '--text', 'hello'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's1', AGENT_SEND_KITTY_SEND: stub, AGENT_SEND_VERBOSE: '' }));
  } finally {
    fs.writeFileSync(presFile, saved);
  }
  assert.equal(r.code, 3, r.stderr);
  const lines = r.stderr.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 1, `one verdict line: ${r.stderr}`);
  assert.match(lines[0], /held/);
  assert.match(lines[0], /do not resend/);
  assert.doesNotMatch(r.stderr, /refusing|exit 7|--now/);
});

test('a bare send to a busy recipient with no mailbox is held by kitty-send --queue: exit 3, never --now', async () => {
  assertHeld(await bareSendArgv([], '\u2807 claude: working', holdEnv()));
});

// A session record that says busy is trusted however old it is (README: no
// staleness bound). A seat that sits idle behind such a record is therefore
// held by kitty-send --queue, never typed into with --now and never reported as
// delivered; the trade-off is that the text waits until the record changes.
test('a bare send to an idle-looking seat whose session record says busy long ago is still held, never --now', async () => {
  const env = provenKitty(991002, '/repo/b');
  const recFile = path.join(env.CLAUDE_SESSIONS_DIR, `${4000 + (991002 % 1000)}.json`);
  fs.writeFileSync(recFile, JSON.stringify({ sessionId: 'proven-991002', cwd: '/repo/b', status: 'busy', statusUpdatedAt: Date.now() - 3 * 3600_000 }));
  assertHeld(await bareSendArgv([], 'claude: idle seat', { ...holdEnv(), ...env }), 'stale busy record: ');
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

test('a bare send to a recipient with Claude Code\'s half-circle busy mark is held, not typed', async () => {
  for (const mark of ['◐', '◑']) {
    assertHeld(await bareSendArgv([], `${mark} claude: working`, holdEnv()), `${mark} `);
  }
});

// One end-to-end budget for a send to a BUSY recipient (the send blocked past two minutes, then ran kitty-send's own 20 s proof
// wait on top). AGENT_SEND_BUDGET_S bounds process start to exit;
// AGENT_SEND_BUSY_WAIT_S is the ack wait inside it; kitty-send gets only what
// is left as --timeout.
// idleAfterMs: the window's title turns idle after that long (a turn that ends
// during the ack wait); without it the window stays as titled. A window that
// still shows the busy marker when the wait ends is never typed into.
const busySend = async (env, title = '⠇ claude: working', { idleAfterMs = null } = {}) => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  const titleKitty = path.join(binDir, 'kitty-title-stub');
  const idleFlag = path.join(binDir, 'kitty-title-idle-flag');
  try {
    fs.rmSync(idleFlag, { force: true });
    fs.writeFileSync(titleKitty, [
      '#!/usr/bin/env bash',
      `if [ -e ${JSON.stringify(idleFlag)} ]; then t='claude: idle seat'; else t='${title}'; fi`,
      `echo "[{\\"tabs\\":[{\\"windows\\":[{\\"id\\":991001,\\"title\\":\\"$t\\",\\"cwd\\":\\"/repo/a\\"}]}]}]"`,
      '',
    ].join('\n'), { mode: 0o755 });
    if (idleAfterMs != null) setTimeout(() => fs.writeFileSync(idleFlag, ''), idleAfterMs);
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
  const { code, elapsedMs, argv, stderr } = await busySend({ AGENT_SEND_BUDGET_S: '4', AGENT_SEND_BUSY_WAIT_S: '1' }, '⠇ claude: working', { idleAfterMs: 300 });
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
const queueSend = (args, { title, status = 'idle', screen = EMPTY_COMPOSER, envExtra = {}, killAfterMs = 20_000, whileRunning = null, text = 'queued for an idle seat', cmdline = 'claude', extraSessions = [] } = {}) => {
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
  extraSessions.forEach((r, i) => fs.writeFileSync(path.join(sessDir, `${8000 + i}.json`), JSON.stringify({ pid: process.pid, procStart: startOf(process.pid), sessionId: r.sessionId, name: r.name })));
  fs.writeFileSync(titleKitty, [
    '#!/usr/bin/env bash',
    'if [ "$2" = "get-text" ]; then',
    `  cat ${JSON.stringify(screenFile)} 2>/dev/null || exit 1`,
    '  exit 0',
    'fi',
    `node -e 'process.stdout.write(JSON.stringify([{tabs:[{windows:[{id:991001,title:require("fs").readFileSync(process.argv[1],"utf-8"),cwd:"/repo/a",foreground_processes:[{pid:${QUEUE_WIN_PID},cmdline:["${cmdline}"]}]}]}]}]))' ${JSON.stringify(titleFile)}`,
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

// A typed fallback never lands on a busy seat: typing mid-turn discards the
// tool result in flight. A recipient window that still shows the busy marker
// when the ack wait ends gets the row left in its mailbox for the tool-boundary
// drain, whatever the send mode, and kitty-send (the only thing that types)
// never runs.
for (const mode of ['--now', '--stop']) {
  test(`${mode} to a busy recipient types nothing and leaves one queued row, exit 3`, async () => {
    const { code, killed, stderr, argv } = await queueSend(['--to', '991001', mode], {
      title: '⠇ claude: working',
      status: 'busy',
      envExtra: { AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_BUDGET_S: '10' },
    });
    assert.equal(killed, false, stderr);
    assert.equal(argv, null, `kitty-send ran, so text was typed into a busy seat: ${argv}`);
    assert.equal(code, 3, stderr);
    assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 1, 'exactly one queued row');
    assert.equal(typedRows().length, 0);
    assert.match(stderr, /busy/);
    assert.match(stderr, /--cancel --id/);
  });
}

// A renamed Claude Code seat shows no spinner in its title while it works, so
// busy is read from its session record first (as kitty-send does), the title
// only without a record.
for (const args of [['--now'], ['--stop'], []]) {
  test(`${args[0] ?? 'a bare send'} to a renamed busy seat (no spinner, record busy) types nothing and leaves one queued row`, async () => {
    const { code, killed, stderr, argv } = await queueSend(['--to', '991001', ...args], {
      title: 'my renamed seat',
      status: 'busy',
      envExtra: { AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_BUDGET_S: '10' },
    });
    assert.equal(killed, false, stderr);
    assert.equal(argv, null, `kitty-send ran, so text was typed into a busy seat: ${argv}`);
    assert.equal(code, 3, stderr);
    assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 1, 'exactly one queued row');
    assert.match(stderr, /next tool call/);
    assert.doesNotMatch(stderr, /next prompt/);
  });
}

test('a renamed seat whose record says idle is still typed into (the record outranks a spinner-free title)', async () => {
  const { argv } = await queueSend(['--to', '991001', '--now'], { title: 'my renamed seat', status: 'idle' });
  assert.ok(argv?.includes('--now'), `argv: ${argv}`);
});

// --idle-when is the caller's own parked proof (a seat that spins while it
// waits for input); it outranks every busy signal, so it is never guarded.
test('--idle-when to a spinner-title seat still runs kitty-send (the caller proof outranks the busy marker)', async () => {
  const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--idle-when', 'parked'], {
    title: '\u2807 claude: working',
    status: 'busy',
    envExtra: { AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_BUDGET_S: '10' },
  });
  assert.equal(killed, false, stderr);
  assert.ok(argv?.includes('--idle-when'), `kitty-send did not run: ${argv} / ${stderr}`);
  // Without the skip the guard would hold it: --queue is added and a "holds" line printed.
  assert.ok(!argv.includes('--queue'), `the busy guard held an --idle-when send: ${argv}`);
  assert.doesNotMatch(stderr, /holds the message/);
  assert.equal(code, 0, stderr);
});

test('--stop to a busy seat says on stderr that it queues like --now and interrupts nothing', async () => {
  const { stderr } = await queueSend(['--to', '991001', '--stop'], {
    title: '\u2807 claude: working',
    status: 'busy',
    envExtra: { AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_BUDGET_S: '10', AGENT_SEND_VERBOSE: '' },
  });
  assert.match(stderr, /--stop on a busy seat queues like --now; nothing is interrupted/);
  const lines = stderr.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 2, `the notice must ride inside the one verdict line, then the pending hint: ${stderr}`);
  assert.doesNotMatch(lines[1], /queues like --now/);
});

test('--stop to a busy seat with no mailbox is held and carries the notice in its single line', async () => {
  const r = await bareSendArgv(['--stop'], '\u2807 claude: working', holdEnv());
  assertHeld(r);
  assert.match(r.stderr, /--stop on a busy seat queues like --now; nothing is interrupted/);
});

test('--idle-when to a spinner-title seat with no mailbox still runs kitty-send (typed-fallback guard)', async () => {
  const { argv, stderr } = await bareSendArgv(['--idle-when', 'parked'], '\u2807 claude: waiting for input', { AGENT_SEND_BUDGET_S: '4' });
  assert.ok(argv?.includes('--idle-when'), `kitty-send did not run: ${argv} / ${stderr}`);
  assert.ok(!argv.includes('--queue'), `the busy guard held an --idle-when send: ${argv}`);
  assert.doesNotMatch(stderr, /holds the message/);
});

// The real kitty-send prints two note lines on stderr for a --queue run unless
// it is given --quiet. This stub does the same, so the hold's one-line verdict
// is checked against what the real script prints.
const noisyHoldStub = (exitCode = 0) => {
  const stub = path.join(binDir, `kitty-send-noisy-${exitCode}.sh`);
  fs.writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$@" > ${JSON.stringify(fallbackArgv)}`,
    'quiet=0; for a in "$@"; do [ "$a" = --quiet ] && quiet=1; done',
    '[ "$quiet" = 1 ] || { echo "kitty-send: note one" >&2; echo "kitty-send: note two" >&2; }',
    `exit ${exitCode}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return stub;
};
test('the hold passes --quiet to kitty-send, so its notes never add lines to the one verdict', async () => {
  const r = await bareSendArgv([], '\u2807 claude: working', { ...holdEnv(), AGENT_SEND_KITTY_SEND: noisyHoldStub(0) });
  assertHeld(r);
  assert.ok(r.argv.includes('--quiet'), `argv: ${r.argv}`);
});

test('a hold that kitty-send refuses with exit 6 says an earlier message is already held, not "send again"', async () => {
  const { code, stderr } = await bareSendArgv([], '\u2807 claude: working', { ...holdEnv(), AGENT_SEND_KITTY_SEND: noisyHoldStub(6) });
  assert.notEqual(code, 0, stderr);
  assert.match(stderr, /an earlier message is already held for that window/);
  assert.doesNotMatch(stderr, /send again/);
});

test('--now to a busy seat prints no --stop notice', async () => {
  const { stderr } = await queueSend(['--to', '991001', '--now'], {
    title: '\u2807 claude: working',
    status: 'busy',
    envExtra: { AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_BUDGET_S: '10' },
  });
  assert.doesNotMatch(stderr, /--stop on a busy seat/);
});

test('a window addressed by a title substring is guarded like one addressed by id', async () => {
  const r = await bareSendArgv(['--now'], '\u2807 claude: working', holdEnv(), 'claude: working');
  assertHeld(r);
});

test('a typed wake-up fallback to a busy seat (idle beacon) queues the row instead of typing', async () => {
  const procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-proc-'));
  fs.mkdirSync(path.join(procDir, '4001'));
  fs.writeFileSync(path.join(procDir, '4001', 'comm'), 'claude\n');
  fs.writeFileSync(path.join(procDir, '4001', 'environ'), 'KITTY_WINDOW_ID=991001\0');
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    fs.writeFileSync(presFile, JSON.stringify({ beacons: [{ sessionId: 's1', cwd: '/repo/a', mailbox: true, windowId: 991001, pid: process.pid, firstTick: old, lastTick: old }] }));
    const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--now'], {
      title: '⠇ claude: working', status: 'busy',
      extraSessions: NAMED, envExtra: { AGENT_MAILBOX_PROC_DIR: procDir },
    });
    assert.equal(killed, false, stderr);
    assert.equal(argv, null, `kitty-send ran, so text was typed into a busy seat: ${argv}`);
    assert.equal(code, 3, stderr);
    assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 1, 'exactly one queued row');
  } finally {
    fs.writeFileSync(presFile, saved);
    fs.rmSync(procDir, { recursive: true, force: true });
  }
});

test('the race hold to a seat with a mailbox parks a withdrawable row instead of a detached waiter', async () => {
  const procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-proc-'));
  fs.mkdirSync(path.join(procDir, '4001'));
  fs.writeFileSync(path.join(procDir, '4001', 'comm'), 'claude\n');
  fs.writeFileSync(path.join(procDir, '4001', 'environ'), 'KITTY_WINDOW_ID=991001\0');
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const calls = path.join(binDir, 'kitty-send-race-mailbox.log');
  const stub = path.join(binDir, 'kitty-send-race-mailbox.sh');
  fs.writeFileSync(stub, ['#!/usr/bin/env bash', `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`, 'exit 7', ''].join('\n'), { mode: 0o755 });
  fs.rmSync(calls, { force: true });
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    fs.writeFileSync(presFile, JSON.stringify({ beacons: [{ sessionId: 's1', cwd: '/repo/a', mailbox: true, windowId: 991001, pid: process.pid, firstTick: old, lastTick: old }] }));
    const { code, killed, stderr } = await queueSend(['--to', '991001'], {
      title: 'claude: idle seat', status: 'idle',
      extraSessions: NAMED, envExtra: { AGENT_MAILBOX_PROC_DIR: procDir, AGENT_SEND_KITTY_SEND: stub },
    });
    assert.equal(killed, false, stderr);
    const lines = fs.readFileSync(calls, 'utf-8').split('\n').filter(Boolean);
    assert.ok(lines.every((l) => !/--queue|--now/.test(l)), `no waiter, no --now: ${lines}`);
    assert.equal(code, 3, stderr);
    assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 1, 'exactly one withdrawable row');
  } finally {
    fs.writeFileSync(presFile, saved);
    fs.rmSync(procDir, { recursive: true, force: true });
  }
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

test('--queue --deadline still bounds the wait for a busy recipient, which is then never typed into', async () => {
  const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue', '--deadline', '1'], {
    title: '⠇ claude: working',
    envExtra: { KITTY_SEND_STUB_EXIT: '5' },
  });
  assert.equal(killed, false, stderr);
  assert.equal(code, 3, stderr);
  assert.equal(argv, null, `a busy window is never typed into: ${argv}`);
  assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 1, 'left queued for the drain');
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

// --queue promises to be safe whether the seat is idle or busy. A seat with no
// mailbox consumer has nowhere to park the row, so a busy one (or a tab that is
// not Claude Code) is handed to kitty-send's detached --queue waiter, which
// re-proves at typing time: exit 3, pending. Exit 1 here dropped the message.
test('--queue to a busy seat with no mailbox consumer starts the waiter (exit 3), not exit 1', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a' }]); // beacon without the consumer flag
    const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], { title: '⠇ claude: working', status: 'busy' });
    assert.equal(killed, false, stderr);
    assert.equal(code, 3, stderr);
    assert.ok(argv?.includes('--queue') && !argv.includes('--now'), `the waiter must be started: ${argv}`);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
});
test('--queue to a non-Claude-Code tab with no mailbox consumer starts the waiter (exit 3), not exit 1', async () => {
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    writePresence([{ sessionId: 's1', cwd: '/repo/a' }]);
    const { code, killed, stderr, argv } = await queueSend(['--to', '991001', '--queue'], { title: 'pi: waiting', cmdline: 'pi' });
    assert.equal(killed, false, stderr);
    assert.equal(code, 3, stderr);
    assert.ok(argv?.includes('--queue'), `the waiter must be started: ${argv}`);
  } finally {
    fs.writeFileSync(presFile, saved);
  }
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

// Handover rows: --claim-role --take-over leaves the evidence that lets the
// taker retire the window it displaced (claude-tab.sh --retire).
//
// A store of its own, and presence in that store: AGENT_SWITCHBOARD_DB wins
// over the file pins above, in this process and in the child.
const handoverEnv = (db, extra = {}) => childEnv({ AGENT_SWITCHBOARD_DB: db, CLAUDE_SESSIONS_DIR: path.join(binDir, 'claude-sessions'), ...extra });
// The session record of the claude process in the fake kitty window (pid 112): the
// proof that the window still holds the displaced session.
const sessionRecord = (sessionId) => {
  fs.mkdirSync(path.join(binDir, 'claude-sessions'), { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude-sessions', '112.json'), JSON.stringify({ pid: 112, sessionId, cwd: '/repo/b' }));
};
const withHandoverStore = async (db, fn) => {
  const { openStore } = await import('../lib/store.mjs');
  const store = openStore(db);
  try { return await fn(store); } finally { store.close(); }
};
const handoverFixture = async (name) => {
  const db = path.join(binDir, `handover-${name}.db`);
  const prev = process.env.AGENT_SWITCHBOARD_DB;
  process.env.AGENT_SWITCHBOARD_DB = db;
  try {
    const { recordPresence } = await import('../lib/presence.mjs');
    const { claimRole } = await import('../lib/seat-roles.mjs');
    return { db, recordPresence, claimRole };
  } finally {
    if (prev === undefined) delete process.env.AGENT_SWITCHBOARD_DB; else process.env.AGENT_SWITCHBOARD_DB = prev;
  }
};
const seatHolder = async (fx, { minutesAgo = 0, windowId = 991002, pid = undefined } = {}) => {
  const prev = process.env.AGENT_SWITCHBOARD_DB;
  process.env.AGENT_SWITCHBOARD_DB = fx.db;
  try {
    fx.recordPresence({ sessionId: 'old-seat', cwd: '/repo/b', windowId, mailbox: true, pid: pid ?? (minutesAgo ? process.pid : null), now: Date.now() - minutesAgo * 60_000 });
    await withHandoverStore(fx.db, (s) => fx.claimRole(s, { role: 'lead', sessionId: 'old-seat', cwd: '/repo/b', windowId }));
  } finally {
    if (prev === undefined) delete process.env.AGENT_SWITCHBOARD_DB; else process.env.AGENT_SWITCHBOARD_DB = prev;
  }
};
const handovers = (db) => withHandoverStore(db, (s) => s.all('SELECT * FROM seat_handovers ORDER BY id'));
const takeOverAs = (db, args, session = 'new-seat') =>
  runSend(['--claim-role', 'lead', ...args], handoverEnv(db, { CLAUDE_CODE_SESSION_ID: session, KITTY_WINDOW_ID: '991001' }));

test('--take-over of a live holder records a handover row naming window and pid', async () => {
  sessionRecord('old-seat');
  const fx = await handoverFixture('live');
  await seatHolder(fx);
  const r = await takeOverAs(fx.db, ['--take-over']);
  assert.equal(r.code, 0, r.stderr);
  const rows = await handovers(fx.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'lead');
  assert.equal(rows[0].displaced_session, 'old-seat');
  assert.equal(rows[0].displaced_window, 991002);
  assert.equal(rows[0].displaced_pid, 112, 'the pid kitty reports for that window');
  assert.equal(rows[0].taker_session, 'new-seat');
  assert.ok(Number(rows[0].ts) > 0);
  assert.equal(rows[0].retired_at, null);
});

test('--take-over of a parked (idle) holder records a handover row too', async () => {
  sessionRecord('old-seat');
  const fx = await handoverFixture('idle');
  await seatHolder(fx, { minutesAgo: 60 });
  const r = await takeOverAs(fx.db, ['--take-over']);
  assert.equal(r.code, 0, r.stderr);
  const rows = await handovers(fx.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].displaced_window, 991002);
});

test('a claim that takes nothing records no handover: refused, free role, re-claim, plain claim of a dead holder', async () => {
  const fx = await handoverFixture('none');
  await seatHolder(fx);
  const refused = await takeOverAs(fx.db, []);
  assert.equal(refused.code, 11);
  assert.equal((await handovers(fx.db)).length, 0, 'a refused claim displaces nobody');
  const free = await runSend(['--claim-role', 'other-role', '--take-over'], handoverEnv(fx.db, { CLAUDE_CODE_SESSION_ID: 'new-seat' }));
  assert.equal(free.code, 0, free.stderr);
  await takeOverAs(fx.db, ['--take-over']);
  const again = await takeOverAs(fx.db, ['--take-over']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal((await handovers(fx.db)).length, 1, 'only the first takeover displaced anyone');
});

test('a stale beacon whose window id now holds another session records no handover', async () => {
  // The window id was reused after a restart: kitty reports a pid for it, but
  // the session record in that window names someone else.
  sessionRecord('a-stranger');
  const fx = await handoverFixture('stale');
  await seatHolder(fx, { minutesAgo: 30 * 60 });
  const r = await takeOverAs(fx.db, ['--take-over']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await handovers(fx.db)).length, 0, 'no row for a window that is not proven to be the displaced seat');
  assert.match(r.stderr, /no handover recorded/);
});

test('a window with no session record and no matching beacon pid records no handover', async () => {
  fs.rmSync(path.join(binDir, 'claude-sessions'), { recursive: true, force: true });
  const fx = await handoverFixture('norecord');
  await seatHolder(fx);
  const r = await takeOverAs(fx.db, ['--take-over']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await handovers(fx.db)).length, 0);
});

// Quiet default output. A send to a busy recipient that ends queued (exit 3)
// used to print about six lines (queued, withdrew, kitty-send fallback, "sent
// nothing", re-queued) and read like a failure. The default is now one line,
// the final verdict; --verbose or AGENT_SEND_VERBOSE brings the trace back.
const quiet = (extra = {}) => ({ AGENT_SEND_VERBOSE: '', ...extra });
const nonEmptyLines = (s) => s.split('\n').filter(Boolean);

test('a busy recipient that ends queued prints one verdict line by default', async () => {
  const { code, stderr } = await busySend(quiet({ AGENT_SEND_BUDGET_S: '4', AGENT_SEND_BUSY_WAIT_S: '1' }), '⠇ claude: working', { idleAfterMs: 300 });
  assert.equal(code, 3, stderr);
  const lines = nonEmptyLines(stderr);
  assert.equal(lines.length, 2, `verdict line plus the pending hint, got:\n${stderr}`);
  assert.match(lines[1], /^agent-send: pending: row \S+; check with agent-send --status --id \S+$/);
  assert.match(lines[0], /^agent-send: queued for 991001 \(not typed: idle wait ran out\), delivered at its next tool call.*\(id \S+; exit 3: pending, do not resend/);
  assert.doesNotMatch(stderr, /falling back|withdrew|sent nothing/);
  for (const r of readUnacked(KEY_S1, libOpts())) cancelQueued({ key: KEY_S1, id: r.id, ...libOpts() });
});

test('--verbose and AGENT_SEND_VERBOSE bring the step-by-step trace back', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const viaEnv = await busySend({ AGENT_SEND_BUDGET_S: '4', AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_VERBOSE: '1' }, '⠇ claude: working', { idleAfterMs: 300 });
  assert.match(viaEnv.stderr, /withdrew the mailbox row/);
  assert.match(viaEnv.stderr, /falling back to kitty-send/);
  assert.ok(nonEmptyLines(viaEnv.stderr).length >= 4, viaEnv.stderr);
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(['--to', KEY_S1, '--text', 'flag', '--deadline', '1', '--verbose'], childEnv(quiet()));
  assert.equal(code, 3);
  assert.match(stderr, /queued \S+ for .*withdraw with --cancel --id/);
});

test('an error stays visible in the quiet default', async () => {
  const { code, stderr } = await runSend(['--to', '991001'], childEnv(quiet()));
  assert.equal(code, 1);
  assert.match(stderr, /pass --text LINE or --file/);
});

// --queue waited for the recipient's drain for as long as 120 s. Its unbounded
// wait is documented and relied on (an idle seat is typed into), so the fast
// path is a new flag instead.
test('--no-wait returns as soon as the row is written: exit 3, no ack wait, no kitty-send', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const t0 = Date.now();
  const { code, stderr } = await runSend(['--to', KEY_S1, '--text', 'fire and forget', '--queue', '--no-wait'], childEnv(quiet({ CLAUDE_CODE_SESSION_ID: 's2' })));
  assert.equal(code, 3, stderr);
  assert.ok(Date.now() - t0 < 3000, 'no ack wait');
  assert.ok(!fs.existsSync(fallbackArgv), 'kitty-send was not run');
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1);
  assert.equal(left[0].text, 'fire and forget');
  assert.equal(left[0].priority, 'queue');
  assert.equal(nonEmptyLines(stderr).length, 1, stderr);
  assert.match(stderr, new RegExp(`queued for ${KEY_S1}.*id ${left[0].id}; exit 3`));
});

test('--queue without --no-wait still waits for the drain (documented contract)', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const t0 = Date.now();
  const { code } = await runSend(['--to', KEY_S1, '--text', 'wait', '--queue', '--deadline', '2'], childEnv(quiet({ CLAUDE_CODE_SESSION_ID: 's2' })));
  assert.ok(Date.now() - t0 >= 1800, 'the queue wait ran to its deadline');
  assert.equal(code, 3);
  for (const r of readUnacked(KEY_S1, libOpts())) cancelQueued({ key: KEY_S1, id: r.id, ...libOpts() });
});

// Mail for a role nobody holds exits 3 and nobody notices. With
// AGENT_SEND_NOTICE_ROLE set, the notice role gets one short row saying so.
test('a send to a role with no live holder also notifies the configured notice role', async () => {
  fs.rmSync(mailboxPath('role:unheld-role', { dir: mboxDir }), { force: true });
  fs.rmSync(mailboxPath('role:watch-role', { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(['--to', 'role:unheld-role', '--text', 'ci fault'], childEnv(quiet({ AGENT_SEND_NOTICE_ROLE: 'watch-role' })));
  assert.equal(code, 3, stderr);
  const own = readUnacked('role:unheld-role', { dir: mboxDir });
  assert.equal(own.length, 1);
  assert.equal(own[0].text, 'ci fault');
  const notice = readUnacked('role:watch-role', { dir: mboxDir });
  assert.equal(notice.length, 1, 'one notice');
  assert.match(notice[0].text, /Mail for role unheld-role has no reader/);
  assert.match(notice[0].text, new RegExp(own[0].id));
  // A repeat collapses into one notice through the topic.
  await runSend(['--to', 'role:unheld-role', '--text', 'again'], childEnv(quiet({ AGENT_SEND_NOTICE_ROLE: 'watch-role' })));
  assert.equal(readUnacked('role:watch-role', { dir: mboxDir }).length, 1, 'repeats do not pile up');
});

test('no notice without AGENT_SEND_NOTICE_ROLE, and none for the notice role itself', async () => {
  fs.rmSync(mailboxPath('role:unheld-role', { dir: mboxDir }), { force: true });
  fs.rmSync(mailboxPath('role:watch-role', { dir: mboxDir }), { force: true });
  await runSend(['--to', 'role:unheld-role', '--text', 'x'], childEnv(quiet({ AGENT_SEND_NOTICE_ROLE: '' })));
  assert.equal(readUnacked('role:watch-role', { dir: mboxDir }).length, 0, 'unset: no notice');
  const self = await runSend(['--to', 'role:watch-role', '--text', 'y'], childEnv(quiet({ AGENT_SEND_NOTICE_ROLE: 'watch-role' })));
  assert.equal(self.code, 3);
  const rows = readUnacked('role:watch-role', { dir: mboxDir });
  assert.equal(rows.length, 1, 'only the message itself, no notice to itself');
  assert.equal(rows[0].text, 'y');
});

test('--no-wait with --now, --stop or --idle-when is refused with exit 2 and writes nothing', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  for (const flags of [['--now'], ['--stop'], ['--idle-when', 'x']]) {
    const { code, stderr } = await runSend(['--to', KEY_S1, '--text', 'x', '--no-wait', ...flags], childEnv(quiet()));
    assert.equal(code, 2, `${flags}: ${stderr}`);
    assert.match(stderr, /--no-wait.*cannot interrupt/);
  }
  assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 0);
});

test('a kitty-send exit 1 reason survives the re-queue in the quiet default', async () => {
  const failStub = path.join(binDir, 'kitty-send-exit1.sh');
  fs.writeFileSync(failStub, '#!/usr/bin/env bash\necho "kitty-send: no such window for the reason test" >&2\nexit 1\n', { mode: 0o755 });
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await busySend(quiet({ AGENT_SEND_BUDGET_S: '4', AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_KITTY_SEND: failStub }), '⠇ claude: working', { idleAfterMs: 300 });
  assert.equal(code, 3, stderr);
  assert.match(stderr, /no such window for the reason test/);
  assert.match(stderr, /queued for 991001/);
  for (const r of readUnacked(KEY_S1, libOpts())) cancelQueued({ key: KEY_S1, id: r.id, ...libOpts() });
});

test('a long role name keeps its own notice topic', async () => {
  const a = `${'r'.repeat(55)}-a`;
  const b = `${'r'.repeat(55)}-b`;
  for (const r of [a, b, 'watch-role']) fs.rmSync(mailboxPath(`role:${r}`, { dir: mboxDir }), { force: true });
  for (const r of [a, b]) await runSend(['--to', `role:${r}`, '--text', 'x'], childEnv(quiet({ AGENT_SEND_NOTICE_ROLE: 'watch-role' })));
  assert.equal(readUnacked('role:watch-role', { dir: mboxDir }).length, 2, 'one notice per role');
});

// ---- review round 3 (supervisor findings on f32fecc) ---------------------------

const exitStub = (name, code, noise = null) => {
  const f = path.join(binDir, `kitty-send-${name}.sh`);
  fs.writeFileSync(f, `#!/usr/bin/env bash\n${noise ? `echo ${JSON.stringify(noise)} >&2\n` : ''}exit ${code}\n`, { mode: 0o755 });
  return f;
};
const clearKey = (key) => { for (const r of readUnacked(key, { dir: mboxDir })) cancelQueued({ key, id: r.id, dir: mboxDir }); };

// A quiet --queue send waits unbounded; a caller killed during the wait must
// still know the row id to --cancel.
test('--queue prints the queued id line at once, not only when it exits', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const child = spawn('node', [SEND, '--to', KEY_S1, '--text', 'id early', '--queue', '--deadline', '3'], { env: childEnv(quiet({ CLAUDE_CODE_SESSION_ID: 's2' })) });
  let stderr = '';
  let closed = false;
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', () => { closed = true; resolve(); }));
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(closed, false, 'still waiting');
  const left = readUnacked(KEY_S1, { dir: mboxDir });
  assert.equal(left.length, 1);
  assert.match(stderr, new RegExp(`queued for ${KEY_S1}.*id ${left[0].id}.*--cancel --id ${left[0].id}`));
  await done;
  clearKey(KEY_S1);
});

// A re-queue after kitty-send sent nothing must keep the reason, and must not
// promise a tool-call delivery to a seat that sits on a dialog or a draft.
for (const [st, reason] of [[4, /selection dialog open/], [9, /composer holds unsubmitted text/], [11, /screen unreadable or composer not clear/]]) {
  test(`a re-queue after kitty-send exit ${st} names the reason and does not promise a tool-call delivery`, async () => {
    fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
    const { code, stderr } = await busySend(quiet({ AGENT_SEND_BUDGET_S: '4', AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_KITTY_SEND: exitStub(`exit${st}`, st) }), '⠇ claude: working', { idleAfterMs: 300 });
    assert.equal(code, 3, stderr);
    assert.match(stderr, reason);
    assert.doesNotMatch(stderr, /next tool call/);
    // The verdict line, then the pending hint the ended ack wait adds.
    const lines = nonEmptyLines(stderr);
    assert.equal(lines.length, 2, stderr);
    assert.match(lines[1], /^agent-send: pending: row \S+; check with agent-send --status --id \S+$/);
    clearKey(KEY_S1);
  });
}

// --no-wait only writes a row. Against an idle seat (or no consumer) it used
// to fall into the kitty fallback and type, then block on the proof.
const IDLE_BEACON = () => {
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  return [{ sessionId: 's1', cwd: '/repo/a', mailbox: true, windowId: 991001, pid: process.pid, firstTick: old, lastTick: old }];
};

test('--no-wait to an idle seat only queues: nothing is typed', async () => {
  const procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-proc-'));
  fs.mkdirSync(path.join(procDir, '4001'));
  fs.writeFileSync(path.join(procDir, '4001', 'comm'), 'claude\n');
  fs.writeFileSync(path.join(procDir, '4001', 'environ'), 'KITTY_WINDOW_ID=991001\0');
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    fs.writeFileSync(presFile, JSON.stringify({ beacons: IDLE_BEACON() }));
    fs.rmSync(fallbackArgv, { force: true });
    fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
    const { code, stderr } = await runSend(['--to', '991001', '--text', 'wake later', '--no-wait'], childEnv(quiet({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_MAILBOX_PROC_DIR: procDir })));
    assert.equal(code, 3, stderr);
    assert.ok(!fs.existsSync(fallbackArgv), 'kitty-send was not run');
    assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 1);
    assert.match(stderr, /queued for 991001/);
  } finally {
    fs.writeFileSync(presFile, saved);
    fs.rmSync(procDir, { recursive: true, force: true });
    clearKey(KEY_S1);
  }
});

test('--no-wait to a seat with no mailbox key fails: nothing typed, nothing queued', async () => {
  fs.rmSync(fallbackArgv, { force: true });
  const { code, stderr } = await runSend(['--to', '991002', '--text', 'x', '--no-wait'], childEnv(quiet()));
  assert.equal(code, 1, stderr);
  assert.ok(!fs.existsSync(fallbackArgv), 'kitty-send was not run');
  assert.match(stderr, /--no-wait.*nothing is queued/);
});

test('--no-wait with --deadline is refused with exit 2: the deadline would be ignored', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(['--to', KEY_S1, '--text', 'x', '--no-wait', '--deadline', '5'], childEnv(quiet()));
  assert.equal(code, 2, stderr);
  assert.match(stderr, /--no-wait.*--deadline/);
  assert.equal(readUnacked(KEY_S1, { dir: mboxDir }).length, 0);
});

// The no-reader notice is the switchboard's, not the original sender's, and
// reading it does not make the next send raise a new one inside the window.
test('the no-reader notice comes from a switchboard label, not the original sender', async () => {
  fs.rmSync(mailboxPath('role:unheld-role', { dir: mboxDir }), { force: true });
  fs.rmSync(mailboxPath('role:watch-role', { dir: mboxDir }), { force: true });
  await runSend(['--to', 'role:unheld-role', '--text', 'ci fault'], childEnv(quiet({ AGENT_SEND_NOTICE_ROLE: 'watch-role' })));
  const [notice] = readUnacked('role:watch-role', { dir: mboxDir });
  assert.equal(notice.from, 'switchboard');
  assert.match(notice.text, /row \S+ \(from \S+\) waits/);
});

test('a notice already read is not raised again inside the notice window', async () => {
  fs.rmSync(mailboxPath('role:unheld-role', { dir: mboxDir }), { force: true });
  fs.rmSync(mailboxPath('role:watch-role', { dir: mboxDir }), { force: true });
  const env = childEnv(quiet({ AGENT_SEND_NOTICE_ROLE: 'watch-role' }));
  await runSend(['--to', 'role:unheld-role', '--text', 'one'], env);
  const [first] = readUnacked('role:watch-role', { dir: mboxDir });
  ack({ key: 'role:watch-role', id: first.id, dir: mboxDir });
  await runSend(['--to', 'role:unheld-role', '--text', 'two'], env);
  assert.equal(readUnacked('role:watch-role', { dir: mboxDir }).length, 0, 'read once, not raised again');
  await runSend(['--to', 'role:unheld-role', '--text', 'three'], childEnv(quiet({ AGENT_SEND_NOTICE_ROLE: 'watch-role', AGENT_SEND_NOTICE_WINDOW_MIN: '0' })));
  assert.equal(readUnacked('role:watch-role', { dir: mboxDir }).length, 1, 'a zero window raises one every time');
});

// kitty-send's own stderr is trace in the quiet default: agent-send's line is
// the verdict, and EVERY exit prints exactly one. Failures it cannot explain
// itself still pass through.
for (const [st, verdictRe] of [[0, /delivered/], [3, /typed.*not proven|unproven/], [8, /steering queue/], [10, /not proven submitted/]]) {
  test(`busy path, kitty-send exit ${st}: one verdict line, kitty-send chatter not replayed`, async () => {
    fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
    const { stderr } = await busySend(quiet({ AGENT_SEND_BUDGET_S: '4', AGENT_SEND_BUSY_WAIT_S: '1', AGENT_SEND_KITTY_SEND: exitStub(`noise${st}`, st, 'kitty-send: chatty detail') }), '⠇ claude: working', { idleAfterMs: 300 });
    assert.doesNotMatch(stderr, /chatty detail/);
    const lines = nonEmptyLines(stderr);
    assert.equal(lines.length, 1, stderr);
    assert.match(lines[0], verdictRe);
    clearKey(KEY_S1);
  });
}

// The direct kitty fallback (a window with no mailbox consumer) owes the same
// single verdict line on every outcome kitty-send can end with.
for (const [st, code, verdictRe] of [[0, 0, /delivered/], [3, 3, /typed.*not proven|unproven/]]) {
  test(`kitty fallback to a window with no consumer, kitty-send exit ${st}: one verdict line`, async () => {
    const { code: got, stderr } = await runSend(['--to', '991002', '--text', 'direct'], childEnv(quiet({ AGENT_SEND_KITTY_SEND: exitStub(`direct${st}`, st, 'kitty-send: chatty detail') })));
    assert.equal(got, code, stderr);
    assert.doesNotMatch(stderr, /chatty detail/);
    const lines = nonEmptyLines(stderr);
    assert.equal(lines.length, 1, stderr);
    assert.match(lines[0], verdictRe);
  });
}

// Output larger than the 64 KiB pipe buffer must arrive whole: a write
// followed by process.exit() drops whatever the pipe has not yet taken. The
// reader here is deliberately slow to start, so the child hits a full pipe.
test('--who --json into a slow pipe delivers the whole document, not 64 KiB', async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ sessionId: `big-${i}`, cwd: `/repo/${'x'.repeat(200)}/${i}`, mailbox: true }));
  writePresence(many);
  try {
    const child = spawn('node', [SEND, '--who', '--json'], { env: childEnv() });
    const chunks = [];
    await new Promise((r) => setTimeout(r, 1000));
    child.stdout.on('data', (d) => chunks.push(d));
    await new Promise((resolve) => child.on('close', resolve));
    const out = Buffer.concat(chunks).toString('utf8');
    assert.ok(out.length > 65536, `fixture must exceed one pipe buffer, got ${out.length}`);
    assert.equal(JSON.parse(out).length >= 600, true);
  } finally {
    writePresence([
      { sessionId: 's1', cwd: '/repo/a', mailbox: true },
      { sessionId: 's2', cwd: '/repo/a' },
      { sessionId: 's3', cwd: '/repo/b' },
    ]);
  }
});

// --queue --deadline holds the row when the proof refuses: the line must key its
// wording on WHY, as the kitty-status path does. A draft or a dialog takes
// nothing at a tool call.
for (const [name, screen, why] of [
  ['a draft', ['● Done.', '─'.repeat(40), '❯ half a thought', '─'.repeat(40)].join('\n'), /composer/],
  ['a dialog', ['● Done.', 'Do you want to proceed?', 'Enter to select · Esc to cancel'].join('\n'), /dialog/],
]) {
  test(`--queue --deadline held on ${name}: the quiet line does not promise a tool-call delivery`, async () => {
    const { code, killed, stderr } = await queueSend(['--to', '991001', '--queue', '--deadline', '2'], { title: '✳ claude: idle seat', screen, envExtra: quiet(), killAfterMs: 15_000 });
    assert.equal(killed, false, stderr);
    assert.equal(code, 3, stderr);
    assert.doesNotMatch(stderr, /next tool call/);
    assert.match(stderr, why);
    assert.match(stderr, /exit 3/);
  });
}

// An idle seat with a mailbox consumer, stuck on a dialog: the parked row is not
// delivered "at its next prompt"; someone has to clear the dialog first.
test('--queue to an idle seat on a dialog: the re-queue line says the dialog must clear first', async () => {
  const procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-proc-'));
  fs.mkdirSync(path.join(procDir, '4001'));
  fs.writeFileSync(path.join(procDir, '4001', 'comm'), 'claude\n');
  fs.writeFileSync(path.join(procDir, '4001', 'environ'), 'KITTY_WINDOW_ID=991001\0');
  const saved = fs.readFileSync(presFile, 'utf-8');
  try {
    fs.writeFileSync(presFile, JSON.stringify({ beacons: IDLE_BEACON() }));
    const { code, killed, stderr } = await queueSend(['--to', '991001', '--queue'], {
      title: '✳ claude: idle seat', screen: ['● Done.', 'Enter to select · Esc to cancel'].join('\n'),
      envExtra: quiet({ AGENT_MAILBOX_PROC_DIR: procDir }),
    });
    assert.equal(killed, false, stderr);
    assert.equal(code, 3, stderr);
    assert.doesNotMatch(stderr, /next prompt|next tool call/);
    assert.match(stderr, /dialog/);
  } finally {
    fs.writeFileSync(presFile, saved);
    fs.rmSync(procDir, { recursive: true, force: true });
    clearKey(KEY_S1);
  }
});

// --help must describe what the code does.
test('--help lists exit 2 and does not claim --no-wait falls back to kitty', async () => {
  const child = spawn('node', [SEND, '--help'], { env: childEnv() });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((resolve) => child.on('close', resolve));
  assert.match(out, /^\s+2\s+--no-wait/m);
  assert.doesNotMatch(out, /kitty path runs as usual/);
  assert.match(out, /no mailbox[^]*?exit 1|exit 1[^]*?no mailbox/i);
});

// --status asks later what became of a row: the exit code is the verdict
// (0 delivered, 3 pending, 13 withdrawn, 14 no such row) and one stdout line
// says when and how.
const runStatus = (args) => {
  const r = spawnSync('node', [SEND, '--status', ...args], { encoding: 'utf-8', env: childEnv(), timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

test('--status --id reports pending (exit 3), delivered (0), withdrawn (13) and unknown (14)', () => {
  const pend = appendMessage({ to: KEY_S1, from: 'x', priority: 'now', text: 'p', dir: mboxDir });
  let r = runStatus(['--id', pend.id]);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.match(r.stdout.trim(), new RegExp(`^pending \\(since ${pend.ts.replace(/[.]/g, '\\.')}, ${KEY_S1}\\)$`));

  const done = appendMessage({ to: KEY_S1, from: 'x', priority: 'now', text: 'd', dir: mboxDir });
  ack({ key: KEY_S1, id: done.id, deliveredAs: 'steer', dir: mboxDir });
  r = runStatus(['--id', done.id]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout.trim(), /^delivered \(at \d{4}-\d\d-\d\dT[\d:.]+Z, steer\)$/);

  const gone = appendMessage({ to: KEY_S1, from: 'x', priority: 'now', text: 'w', dir: mboxDir });
  cancelQueued({ key: KEY_S1, id: gone.id, dir: mboxDir });
  r = runStatus(['--id', gone.id]);
  assert.equal(r.code, 13, r.stderr);
  assert.match(r.stdout.trim(), /^withdrawn \(at \d{4}-\d\d-\d\dT[\d:.]+Z\)$/);

  r = runStatus(['--id', 'no-such-row']);
  assert.equal(r.code, 14, r.stderr);
  assert.match(r.stderr, /no row no-such-row/);
  assert.equal(runStatus([]).code, 1, '--status needs --id');
});

test('an ack wait that ends without an ack prints the pending hint and keeps exit 3', async () => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  const { code, stderr } = await runSend(
    ['--to', '991001', '--queue', '--deadline', '1', '--text', 'queued steer'],
    childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '5', ...provenKitty(991001, '/repo/a') }),
  );
  assert.equal(code, 3, stderr);
  const id = readUnacked(KEY_S1, { dir: mboxDir })[0].id;
  assert.ok(stderr.includes(`pending: row ${id}; check with agent-send --status --id ${id}`), stderr);
});

// --file: relative paths resolve against the caller's cwd, and the note is
// copied into the durable notes dir so a cleared scratch dir cannot dangle it.
const fileSend = (args, cwd, notesDir) => {
  fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
  return spawnSync('node', [SEND, '--to', KEY_S1, '--no-wait', ...args], {
    cwd, encoding: 'utf-8', timeout: 30_000,
    env: childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_VERBOSE: '0', AGENT_SWITCHBOARD_NOTES_DIR: notesDir }),
  });
};

test('a relative --file resolves against the caller cwd; a missing one is refused', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-rel-'));
  const notes = path.join(scratch, 'notes');
  try {
    fs.writeFileSync(path.join(scratch, 'brief.md'), 'do the thing\n');
    const r = fileSend(['--file', 'brief.md'], scratch, notes);
    assert.equal(r.status, 3, r.stderr);
    const [row] = readUnacked(KEY_S1, { dir: mboxDir });
    assert.match(row.text, /read \S+\.md, a note written for you, and act on what it says\./);
    const miss = fileSend(['--file', 'nope.md'], scratch, notes);
    assert.equal(miss.status, 1);
    assert.match(miss.stderr, /no such file: /);
    assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('--file is copied into the notes dir and the pointer names the copy and the message id', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-copy-'));
  const notes = path.join(scratch, 'notes');
  try {
    const src = path.join(scratch, 'brief.md');
    fs.writeFileSync(src, 'durable body\n');
    const r = fileSend(['--file', src], scratch, notes);
    assert.equal(r.status, 3, r.stderr);
    const [row] = readUnacked(KEY_S1, { dir: mboxDir });
    const copy = path.join(notes, `${row.id}.md`);
    assert.equal(fs.readFileSync(copy, 'utf-8'), 'durable body\n');
    assert.ok(row.text.includes(`read ${copy}, a note written for you`), row.text);
    assert.ok(row.text.includes(`Message id: ${row.id}`), row.text);
    fs.rmSync(src);
    assert.equal(fs.readFileSync(copy, 'utf-8'), 'durable body\n', 'the copy outlives the source');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// A row the sender withdrew and replaced (a re-queue, or the typed fallback)
// must still answer --status for the id the pointer names.
const msgIdOf = (text) => text.match(/Message id: ([0-9a-f-]{36})\./)[1];

test('--status on a --file id follows a re-queue to the live row', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-chain-'));
  try {
    const src = path.join(scratch, 'brief.md');
    fs.writeFileSync(src, 'chain\n');
    fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
    const { code, stderr } = await runSend(
      ['--to', '991001', '--queue', '--deadline', '1', '--file', src],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '5', AGENT_SWITCHBOARD_NOTES_DIR: path.join(scratch, 'notes'), ...provenKitty(991001, '/repo/a') }),
    );
    assert.equal(code, 3, stderr);
    const [live] = readUnacked(KEY_S1, { dir: mboxDir });
    const named = msgIdOf(live.text);
    assert.notEqual(named, live.id, 'the live row is the re-queued one');
    let r = runStatus(['--id', named]);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^pending \\(since \\S+, ${KEY_S1}; ${named} was withdrawn and replaced by ${live.id}\\)`));
    ack({ key: KEY_S1, id: live.id, deliveredAs: 'prompt', dir: mboxDir });
    r = runStatus(['--id', named]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^delivered \(at \S+, prompt; /);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('--status on a --file id follows the typed fallback to its delivery record', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-typed-'));
  try {
    const src = path.join(scratch, 'brief.md');
    fs.writeFileSync(src, 'typed\n');
    fs.rmSync(mailboxPath(KEY_S1, { dir: mboxDir }), { force: true });
    fs.rmSync(fallbackArgv, { force: true });
    const { code, stderr } = await runSend(
      ['--to', '991001', '--file', src, '--deadline', '1'],
      childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SEND_KITTY_SEND: realRulesStub, KITTY_SEND_STUB_EXIT: '0', AGENT_SWITCHBOARD_NOTES_DIR: path.join(scratch, 'notes') }),
    );
    assert.equal(code, 0, stderr);
    const argv = fs.readFileSync(fallbackArgv, 'utf-8').split('\n').filter(Boolean);
    const named = path.basename(argv[argv.indexOf('--file') + 1], '.md');
    const r = runStatus(['--id', named]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^delivered \(at \S+, typed; /);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('--file copies the bytes (binary, non-UTF-8, no added newline) and the pointer keeps the source path', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-bytes-'));
  const notes = path.join(scratch, 'notes');
  try {
    const src = path.join(scratch, 'blob.bin');
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41, 0xc3]);
    fs.writeFileSync(src, bytes);
    const r = fileSend(['--file', src], scratch, notes);
    assert.equal(r.status, 3, r.stderr);
    const [row] = readUnacked(KEY_S1, { dir: mboxDir });
    assert.ok(fs.readFileSync(path.join(notes, `${row.id}.md`)).equals(bytes));
    assert.ok(row.text.includes(`Source: ${src}.`), row.text);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a refused --file send leaves no copy; a directory or unreadable file is refused', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-refused-'));
  const notes = path.join(scratch, 'notes');
  try {
    const src = path.join(scratch, 'brief.md');
    fs.writeFileSync(src, 'x\n');
    const bad = fileSend(['--file', src, '--deadline', '5'], scratch, notes);
    assert.equal(bad.status, 2, bad.stderr);
    assert.ok(!fs.existsSync(notes) || fs.readdirSync(notes).length === 0, 'no copy after a refused send');
    const dirRes = fileSend(['--file', scratch], scratch, notes);
    assert.equal(dirRes.status, 1);
    assert.match(dirRes.stderr, /no such file/);
    if (process.getuid?.() !== 0) {
      fs.chmodSync(src, 0o000);
      const unreadable = fileSend(['--file', src], scratch, notes);
      assert.equal(unreadable.status, 1);
      assert.match(unreadable.stderr, /no such file/);
      fs.chmodSync(src, 0o600);
    }
    assert.deepEqual(readUnacked(KEY_S1, { dir: mboxDir }), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('the note cleanup keeps an old copy whose row is still queued and drops an orphan', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-prune-'));
  const notes = path.join(scratch, 'notes');
  try {
    fs.mkdirSync(notes);
    const queued = appendMessage({ to: KEY_S1, from: 'x', priority: 'now', text: 'q', dir: mboxDir });
    const kept = path.join(notes, `${queued.id}.md`);
    const orphan = path.join(notes, 'orphan.md');
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    for (const f of [kept, orphan]) {
      fs.writeFileSync(f, 'old');
      fs.utimesSync(f, past, past);
    }
    fs.writeFileSync(path.join(scratch, 'brief.md'), 'new\n');
    const r = spawnSync('node', [SEND, '--to', KEY_S1, '--no-wait', '--file', 'brief.md'], {
      cwd: scratch, encoding: 'utf-8', env: childEnv({ CLAUDE_CODE_SESSION_ID: 's2', AGENT_SWITCHBOARD_NOTES_DIR: notes }),
    });
    assert.equal(r.status, 3, r.stderr);
    assert.ok(fs.existsSync(kept), 'queued row keeps its copy');
    assert.ok(!fs.existsSync(orphan), 'an orphan past retention is pruned');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('--status refuses stray flags, reads without creating the store, and names where it looked', () => {
  for (const extra of [['--to', KEY_S1], ['--claim-role', 'r'], ['--text', 'x'], ['--read']]) {
    const r = runStatus(['--id', 'x', ...extra]);
    assert.equal(r.code, 1, `${extra}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--status takes only --id/);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsend-nodb-'));
  try {
    const db = path.join(scratch, 'state.db');
    const env = childEnv({ AGENT_SWITCHBOARD_DB: db });
    delete env.AGENT_MAILBOX_DIR;
    const r = spawnSync('node', [SEND, '--status', '--id', 'nope'], { encoding: 'utf-8', env, timeout: 30_000 });
    assert.equal(r.status, 14, r.stderr);
    assert.ok(r.stderr.includes(db), r.stderr);
    assert.ok(!fs.existsSync(db), 'asking must not create the store');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.ok(runStatus(['--id', 'nope']).stderr.includes(mboxDir), 'file mode names the mailbox dir');
});
