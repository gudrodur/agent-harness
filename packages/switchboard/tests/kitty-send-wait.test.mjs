// Tests for kitty-send.sh's WAIT semantics: --queue is unbounded
// by default (with a heartbeat), --deadline N caps the wait, and the two bound
// spellings (--wait-idle/--deadline) refuse to be passed together.
// Also --idle-when: a spinning target whose screen says it is parked is
// steerable, a dialog still is not, and --queue forwards the flag.
//
// The delivery-proof half of the script (cases 1-14 in kitty-send.test.sh)
// needs REAL kitty windows — a fixture reproduces none of the rendering bugs.
// These cases need none: parsing and deadline/heartbeat math run before any
// real keystroke, so `kitty` is a PATH stand-in that reports ONE window whose
// title never stops spinning and whose screen is always empty. That is enough
// for the script to parse, spawn its detached waiter, and let the waiter run
// against the deadline, without a real kitty or a real target. This file runs
// in CI (node --test); kitty-send.test.sh cannot (no kitty remote control on
// a hosted runner) and exits 2 there.
//
// Run: node --test tests/kitty-send-wait.test.mjs (or the full suite)
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/kitty-send.sh', import.meta.url));
// A numeric id: the script resolves numeric --to directly, no title matching.
const WID = '991001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Resolves once `file` exists (the mock's send-text marker), or after `ms`.
const sentBy = async (file, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (await fs.access(file).then(() => true, () => false)) return;
  }
};

let binDir, queueDir;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-mock-'));
  // The mock: `@ ls` reports one window whose title carries a braille spinner
  // (a braille "busy" marker, U+2839) and whose pid is alive, so the waiter never
  // sees it go idle and never sees it die. get-text/send-text succeed quietly.
  // KITTY_MOCK_SCREEN is what `@ get-text` returns, so a test can put the
  // target in a state ("parked", "showing a dialog") without a real kitty.
  // Empty by default, which is what every earlier case assumed.
  await fs.writeFile(path.join(binDir, 'kitty'), `#!/usr/bin/env bash
if [ "\${1:-}" = "@" ] && [ "\${2:-}" = "ls" ]; then
  printf '%s\\n' '[{"tabs":[{"title":"mock-tab","windows":[{"id":${WID},"title":"π ⠹ mock busy (never idle)","pid":424242,"cwd":"/tmp/kitty-wait-cwd"}]}]}]'
fi
if [ "\${1:-}" = "@" ] && [ "\${2:-}" = "get-text" ]; then
  printf '%s\\n' "\${KITTY_MOCK_SCREEN:-}"
fi
if [ "\${1:-}" = "@" ] && [ "\${2:-}" = "send-text" ] && [ -n "\${KITTY_MOCK_SENT:-}" ]; then
  : > "\$KITTY_MOCK_SENT"
fi
exit 0
`, { mode: 0o755 });
  queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-queue-'));
});

after(async () => {
  // A leftover unbounded waiter must not survive a failed test: cancel by the
  // recorded pid, then drop the whole per-test runtime dir.
  try {
    await fs.rm(queueDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
});

const runScript = async (args, extraEnv = {}) => {
  try {
    const r = await run(SCRIPT, args, {
      env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: queueDir, ...extraEnv }),
      timeout: 20_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

const logPath = () => path.join(queueDir, 'kitty-send', `queue-${WID}.log`);
const pidPath = () => path.join(queueDir, 'kitty-send', `queue-${WID}.pid`);
const readLog = async () => fs.readFile(logPath(), 'utf-8').catch(() => '');
const pidGone = async () => fs.access(pidPath()).then(() => false, () => true);

// Wait until a predicate holds, polling every 200 ms.
const until = async (pred, what, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await sleep(200);
  }
  assert.fail(`timed out waiting for: ${what}`);
};

// ---- argument parsing (no kitty behaviour involved) --------------------------

test('--deadline rejects a non-number', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--deadline', 'soon']);
  assert.equal(code, 1);
  assert.match(err, /--deadline must be a number of seconds/);
});

test('--wait-idle and --deadline are the same bound; both given is refused', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--wait-idle', '30', '--deadline', '60']);
  assert.equal(code, 1);
  assert.match(err, /--wait-idle and --deadline both bound the wait/);
});

test('--now with --deadline is refused like --now with --wait-idle', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--now', '--deadline', '60']);
  assert.equal(code, 1);
  assert.match(err, /mutually exclusive/);
});

// ---- deadline math: a capped queue dies AT the cap, nothing sent -------------

test('--queue --deadline N dies at N with exit 5 semantics, nothing sent', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--queue', '--deadline', '2']);
  assert.equal(code, 0);
  assert.match(err, /queued for window\x20991001: waits up to 2s for it to go idle/);
  // The detached waiter must hit the 2 s deadline on a never-idle target.
  await until(async () => (await readLog()).includes('target still busy after 2s (nothing was sent)'), 'deadline message in the log');
  await until(pidGone, 'the waiter removed its pid file on exit');
  const log = await readLog();
  assert.doesNotMatch(log, /delivered/);
});

// ---- verdict line: every way the waiter ends leaves one in the log ----------
// The wrapper removes the pid file however the waiter ends, so without a line
// of its own a waiter that died silently (the log
// stopped at a heartbeat, no pid file, nothing delivered) read the same as one
// that sent. The last line of the log is the verdict.

const lastLine = async () => (await readLog()).trimEnd().split('\n').at(-1);

test('a waiter that ends on its own logs its exit code last', async () => {
  await runScript(['--to', WID, '--text', 'hi', '--queue', '--deadline', '2']);
  await until(pidGone, 'the waiter removed its pid file on exit');
  assert.match(await lastLine(), /^kitty-send: queued waiter exit rc=5 at \d\d:\d\d:\d\d$/);
});

test('a waiter killed from outside still logs an exit line, not a heartbeat', async () => {
  await runScript(['--to', WID, '--text', 'hi', '--queue'], { KITTY_SEND_HEARTBEAT_S: '1' });
  await until(async () => (await readLog()).includes('still waiting'), 'heartbeat line in the log');
  const wrapper = (await fs.readFile(pidPath(), 'utf-8')).trim();
  const inner = execFileSync('pgrep', ['-P', wrapper], { encoding: 'utf-8' }).trim().split('\n')[0];
  process.kill(Number(inner), 'SIGKILL');
  await until(pidGone, 'the wrapper removed the pid file');
  assert.match(await lastLine(), /^kitty-send: queued waiter exit rc=137 \(SIGKILL\) at /);
});

test('--cancel writes its own verdict line into the log', async () => {
  await runScript(['--to', WID, '--text', 'hi', '--queue']);
  await until(async () => !(await pidGone()), 'the waiter wrote its pid file');
  const { code } = await runScript(['--cancel', '--to', WID]);
  assert.equal(code, 0);
  await until(pidGone, 'cancel removed the pid file');
  assert.match(await lastLine(), /^kitty-send: queued waiter cancelled by --cancel at /);
});

// ---- unbounded default: waits indefinitely, refuses a second queue -----------

test('--queue with no bound waits indefinitely (no 600 s default) and --cancel stops it', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--queue']);
  assert.equal(code, 0);
  assert.match(err, /queued for window\x20991001: waits until it goes idle \(no deadline; heartbeat every 300s\)/);
  assert.doesNotMatch(err, /waits up to 600s/);
  // Still held after a few seconds: the old fixed default would already be gone.
  await sleep(2500);
  assert.equal(await pidGone(), false, 'the unbounded waiter must still be alive');
  const { code: c2, err: e2 } = await runScript(['--to', WID, '--text', 'hi', '--queue']);
  assert.equal(c2, 6);
  assert.match(e2, /already queued/);
  const { code: c3, err: e3 } = await runScript(['--cancel', '--to', WID]);
  assert.equal(c3, 0);
  assert.match(e3, /cancelled the queued send/);
  await until(pidGone, 'cancel removed the pid file');
  const { code: c4 } = await runScript(['--cancel', '--to', WID]);
  assert.equal(c4, 1);
});

// ---- heartbeat: an unbounded wait logs a line every KITTY_SEND_HEARTBEAT_S ---

test('an unbounded waiter logs a heartbeat so a long wait reads as alive', async () => {
  const { code } = await runScript(['--to', WID, '--text', 'hi', '--queue'], { KITTY_SEND_HEARTBEAT_S: '1' });
  assert.equal(code, 0);
  await until(async () => (await readLog()).includes('still waiting for window\x20991001'), 'heartbeat line in the log');
  const log = await readLog();
  assert.match(log, /still waiting for window\x20991001 to go idle after \d+s \(nothing sent yet\)/);
  await runScript(['--cancel', '--to', WID]);
  await until(pidGone, 'cancel removed the pid file');
});

// ---- --idle-when: a spinner is not always work  ------------------

const PARKED = 'Bíð eftir næsta skilaboði.';

test('a spinning target with no --idle-when is exit 7, nothing sent', async () => {
  const { code, err } = await runScript(['--to', WID, '--text', 'hi'], { KITTY_MOCK_SCREEN: PARKED });
  assert.equal(code, 7);
  assert.match(err, /refusing to send into a mid-turn target/);
});

test('--idle-when matching the screen makes a spinning target steerable', async () => {
  const { code, err } = await runScript(
    // --timeout 2: the send is attempted and the proof then fails on a mock
    // screen that never echoes it. Waiting the default 20 s proves nothing more.
    ['--to', WID, '--text', 'hi', '--idle-when', 'Bíð eftir næsta', '--timeout', '2'],
    { KITTY_MOCK_SCREEN: PARKED },
  );
  // It must get PAST the busy refusal. It cannot reach exit 0 against a mock
  // whose screen never echoes the message, so the proof fails at exit 3 — the
  // point is only that exit 7 is gone and the send was attempted.
  assert.notEqual(code, 7);
  assert.doesNotMatch(err, /refusing to send into a mid-turn target/);
  assert.match(err, /screen matches --idle-when: treating it as parked, not working/);
});

test('--idle-when that does not match leaves the target busy', async () => {
  const { code, err } = await runScript(
    ['--to', WID, '--text', 'hi', '--idle-when', 'waiting for the next message'],
    { KITTY_MOCK_SCREEN: PARKED },
  );
  assert.equal(code, 7);
  assert.match(err, /refusing to send into a mid-turn target/);
});

test('a dialog still wins over --idle-when: it is the human\'s to answer', async () => {
  const { code, err } = await runScript(
    ['--to', WID, '--text', 'hi', '--idle-when', 'Bíð eftir næsta'],
    { KITTY_MOCK_SCREEN: `${PARKED}\n  ↑/↓ move   Enter select   Esc cancel` },
  );
  assert.equal(code, 4);
  assert.match(err, /refusing to type into a dialog/);
});

// Footer strings the screen check keys on. ASSUMED, not captured from a live
// dialog: composed from the strings in the Claude Code 2.1.323 binary
// ("↑/↓ to navigate", "Enter to select", "←/→ to switch", "Esc to cancel"). A
// permission prompt and a plan approval are refused through the session record
// status `waiting` (kitty-send-claude.test.mjs), not through a screen string,
// so no footer is invented for them here.
for (const [name, screen] of [
  ['a question dialog footer', 'Which one?\n  Enter to select · ↑/↓ to navigate · Esc to cancel'],
  ['a tabbed question dialog footer', 'Which one?\n  ↑/↓ to navigate · Enter to select · ←/→ to switch · Esc to cancel'],
]) {
  test(`${name} is a dialog: refused with exit 4`, async () => {
    const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--idle-when', 'Bíð eftir næsta'], { KITTY_MOCK_SCREEN: `Bíð eftir næsta\n${screen}` });
    assert.equal(code, 4);
    assert.match(err, /refusing to type into a dialog/);
  });
}

// Prose in a seat's own last reply is not a dialog. Only the footer strings
// Claude Code renders for one count; an open permission prompt or question is
// otherwise caught by the record status `waiting`.
for (const prose of ['Do you want to merge it now?', 'Would you like to proceed with the rebase?', 'Use the arrow keys to navigate; Ready to code? Say so.']) {
  test(`a reply that says "${prose}" is not a dialog`, async () => {
    const { code, err } = await runScript(['--to', WID, '--text', 'hi', '--idle-when', 'Bíð eftir næsta', '--timeout', '2'], { KITTY_MOCK_SCREEN: `${prose}\nBíð eftir næsta` });
    assert.notEqual(code, 4, err);
    assert.doesNotMatch(err, /refusing to type into a dialog/);
  });
}

test('--queue forwards --idle-when to its detached waiter', async () => {
  const { code } = await runScript(
    ['--to', WID, '--text', 'hi', '--queue', '--deadline', '4', '--idle-when', 'Bíð eftir næsta'],
    { KITTY_MOCK_SCREEN: PARKED },
  );
  assert.equal(code, 0);
  // The waiter must break out of the wait loop on the parked screen instead of
  // burning the 4 s deadline: without the forward it would time out at exit 5.
  await until(async () => (await readLog()).includes('--idle-when'), 'the waiter saw the parked screen');
  const log = await readLog();
  assert.doesNotMatch(log, /target still busy after 4s/);
  await runScript(['--cancel', '--to', WID]).catch(() => {});
});

// ---- proof by state first: the tab's own record decides, the spinner does not ----
//
// The mock window spins forever, so on the spinner alone every send below is
// exit 7. An OpenCode session row (opencode.db) says otherwise, and the state
// wins, except --idle-when, which is the caller's own parked proof and wins
// over busy. Tests above run with no store, so the state is unknown and the
// spinner decides, exactly as before.

const W_SID = 'ses_wait0000000000000test';
const wStore = async (lastRow) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-wait-state-'));
  const file = path.join(dir, 'opencode.db');
  const now = Date.now();
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, directory TEXT, model TEXT, parent_id TEXT,
    time_created INTEGER, time_updated INTEGER, time_idle INTEGER, idle_outcome TEXT)`);
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT)`);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?)')
    .run(W_SID, '/tmp/kitty-wait-cwd', '{"id":"m"}', null, now - 60_000, now, null, null);
  db.close();
  await wAppend(file, 4, 'user', { time: { created: now - 9000 }, text: 'earlier' });
  await wAppend(file, 11, lastRow, lastRow === 'idle'
    ? { time: { created: now - 1000 }, outcome: 'succeeded' }
    : { time: { created: now - 1000 }, content: [{ type: 'tool', name: 'shell', state: { status: 'running' } }] });
  return { dir, file };
};
const wAppend = async (file, seq, type, data) => {
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)')
    .run(`m-${seq}`, W_SID, type, seq, Date.now(), Date.now(), JSON.stringify(data));
  db.close();
};
const wSend = (args, file, extraEnv = {}) => run(SCRIPT, args, {
  env: isolatedEnv({ PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: queueDir, OPENCODE_TAB_DB: file, ...extraEnv }),
}).then(
  (ok) => ({ code: 0, out: ok.stdout, err: ok.stderr }),
  (e) => ({ code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' }),
);

test('state=idle sends past a spinner title with no flag', async () => {
  const { dir, file } = await wStore('idle');
  try {
    const sent = path.join(dir, 'sent');
    const p = wSend(['--to', WID, '--text', 'hi from the state test', '--timeout', '8'], file, { KITTY_MOCK_SENT: sent });
    // The row lands once the text was typed, as in a live tab: a fixed sleep
    // raced the send on a loaded machine.
    await sentBy(sent);
    await wAppend(file, 12, 'user', { time: { created: Date.now() }, text: 'hi from the state test' });
    const { code, err } = await p;
    assert.equal(code, 0, err);
    assert.match(err, /proved by opencode\.db session_message row/);
    assert.doesNotMatch(err, /refusing to send into a mid-turn target/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--idle-when still wins over state=busy', async () => {
  const { dir, file } = await wStore('assistant');
  try {
    const sent = path.join(dir, 'sent');
    const p = wSend(['--to', WID, '--text', 'hi from the state test', '--idle-when', 'Bíð eftir næsta', '--timeout', '8'], file, { KITTY_MOCK_SCREEN: PARKED, KITTY_MOCK_SENT: sent });
    await sentBy(sent);
    await wAppend(file, 12, 'user', { time: { created: Date.now() }, text: 'hi from the state test' });
    const { code, err } = await p;
    assert.equal(code, 0, err);
    assert.match(err, /proved by opencode\.db session_message row/);
    assert.doesNotMatch(err, /refusing to send into a mid-turn target/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- kitty not answering is not a dead window; the wait backs off ----------
// A second stub with state files: `title` is the window's title, `hang-after`
// makes every `@ ls` past that many hang (a remote control that stopped
// answering), `gone` lists no window. Every call is logged to `calls`; a
// `sleep` stub logs its argument to `sleeps` and, from the sixth call on,
// marks the window gone so the wait ends.
const slowStub = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-slow-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(dir, 'title'), 'π ⠹ mock busy (never idle)');
  await fs.writeFile(path.join(bin, 'kitty'), `#!/usr/bin/env bash
st=${JSON.stringify(dir)}
printf '%s\\n' "$*" >> "$st/calls"
if [ "\${1:-}" = "@" ] && [ "\${2:-}" = "ls" ]; then
  n=$(( $(cat "$st/ls-n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$st/ls-n"
  if [ -f "$st/hang-after" ] && [ "$n" -gt "$(cat "$st/hang-after")" ]; then exec /usr/bin/sleep 8; fi
  [ -f "$st/gone" ] && { echo '[]'; exit 0; }
  jq -cn --arg t "$(cat "$st/title")" '[{"tabs":[{"title":"mock-tab","windows":[{"id":${WID},"title":$t,"pid":424242,"cwd":"/tmp/kitty-wait-cwd"}]}]}]'
fi
exit 0
`, { mode: 0o755 });
  const sleepBin = path.join(dir, 'sleep-bin');
  await fs.mkdir(sleepBin);
  await fs.writeFile(path.join(sleepBin, 'sleep'), `#!/usr/bin/env bash
st=${JSON.stringify(dir)}
printf '%s\\n' "$1" >> "$st/sleeps"
[ "$(wc -l < "$st/sleeps")" -ge 6 ] && : > "$st/gone"
exit 0
`, { mode: 0o755 });
  const read = (f) => fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
  return {
    dir, bin, sleepBin, read,
    lsCalls: async () => (await read('calls')).split('\n').filter((l) => /^@ (--to \S+ )?ls\b/.test(l)),
    env: (extra = {}) => ({ PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: dir, AGENT_KITTY_LS_DIR: path.join(dir, 'kls'), ...extra }),
  };
};
const runIn = async (env, args, timeout = 40_000) => {
  try {
    const r = await run(SCRIPT, args, { env: isolatedEnv(env), timeout });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? e.signal ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

test('a bounded wait while kitty stops answering exits 12, nothing sent, and never says the window died', async () => {
  const s = await slowStub();
  try {
    // The first two reads answer (the up check, the fresh read of the
    // target); every later one hangs past the read timeout.
    await fs.writeFile(path.join(s.dir, 'hang-after'), '2');
    const t0 = Date.now();
    const { code, err } = await runIn(s.env({ AGENT_KITTY_LS_TIMEOUT_MS: '500' }), ['--to', WID, '--text', 'hi', '--wait-idle', '3']);
    assert.equal(code, 12, err);
    assert.doesNotMatch(err, /died/);
    assert.match(err, /nothing was sent/);
    assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
    assert.equal((await s.read('calls')).split('\n').filter((l) => l.startsWith('@ send-text')).length, 0);
  } finally {
    await fs.rm(s.dir, { recursive: true, force: true });
  }
});

test('the wait for a busy target backs off: 2, 4, 8, 10, 10 s, each within 20%', async () => {
  const s = await slowStub();
  try {
    const env = s.env();
    env.PATH = `${s.sleepBin}:${env.PATH}`;
    const { code, err } = await runIn(env, ['--to', WID, '--text', 'hi', '--wait-idle', '600']);
    assert.equal(code, 1, err);
    assert.match(err, /died while waiting/);
    const slept = (await s.read('sleeps')).split('\n').filter(Boolean).map(Number);
    const want = [2, 4, 8, 10, 10];
    assert.ok(slept.length >= want.length, `slept ${slept.join(', ')}`);
    want.forEach((w, i) => assert.ok(slept[i] >= w * 0.8 && slept[i] <= w * 1.2, `sleep ${i + 1} was ${slept[i]} s, want ${w} +/-20%: ${slept.join(', ')}`));
  } finally {
    await fs.rm(s.dir, { recursive: true, force: true });
  }
});

test('a cached listing never decides the send: a window that is now a Copilot seat with no Copilot is exit 17', async () => {
  const s = await slowStub();
  try {
    const env = s.env({ AGENT_KITTY_LS_TTL_MS: '600000' });
    // A cached read sees a plain shell; then kitty's own answer changes to a
    // Copilot title, with no Copilot in the foreground.
    await fs.writeFile(path.join(s.dir, 'title'), 'bash');
    const kls = fileURLToPath(new URL('../lib/kitty-ls.mjs', import.meta.url));
    await run(process.execPath, [kls, '--match', `id:${WID}`], { env: isolatedEnv({ ...env, AGENT_MAILBOX_KITTY: 'kitty' }) }).catch(() => {});
    await run(process.execPath, [kls], { env: isolatedEnv({ ...env, AGENT_MAILBOX_KITTY: 'kitty' }) }).catch(() => {});
    await fs.writeFile(path.join(s.dir, 'title'), 'GitHub Copilot');
    await fs.writeFile(path.join(s.dir, 'calls'), '');
    const { code, err } = await runIn(env, ['--to', WID, '--text', 'hi']);
    assert.equal(code, 17, err);
    const calls = (await s.read('calls')).split('\n').filter(Boolean);
    assert.equal(calls.filter((l) => l.startsWith('@ send-text')).length, 0, 'nothing typed');
    const ls = calls.filter((l) => /^@ (--to \S+ )?ls\b/.test(l));
    assert.ok(ls.length > 0, 'kitty itself was asked');
    assert.match(ls.at(-1), new RegExp(`^@ ls( --match id:${WID})?$`));
  } finally {
    await fs.rm(s.dir, { recursive: true, force: true });
  }
});

// The idle wait types into the target on the pass that finds it idle, so that
// read is fresh: a listing cached while the seat was idle, up to the TTL old,
// would show idle a seat that has just started a turn. The suite runs with the
// cache off (TTL 0); this test turns it on and primes it with an idle title.
test('the idle wait reads fresh: a cached idle listing does not let it type into a busy seat', async () => {
  const s = await slowStub();
  try {
    const env = s.env({ AGENT_KITTY_LS_TTL_MS: '600000' });
    await fs.writeFile(path.join(s.dir, 'title'), 'claude: idle seat');
    const kls = fileURLToPath(new URL('../lib/kitty-ls.mjs', import.meta.url));
    const primed = await run(process.execPath, [kls, '--fresh'], { env: isolatedEnv({ ...env, AGENT_MAILBOX_KITTY: 'kitty' }) });
    assert.match(primed.stdout, /claude: idle seat/);
    await fs.writeFile(path.join(s.dir, 'title'), 'π ⠹ claude: working');
    const { code, err } = await runIn(env, ['--to', WID, '--text', 'hi', '--wait-idle', '2']);
    assert.equal(code, 5, err);
    assert.match(err, /nothing was sent/);
    assert.equal((await s.read('calls')).split('\n').filter((l) => l.startsWith('@ send-text')).length, 0, 'nothing typed');
  } finally {
    await fs.rm(s.dir, { recursive: true, force: true });
  }
});
