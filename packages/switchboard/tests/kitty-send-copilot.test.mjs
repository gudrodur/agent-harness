// Tests kitty-send proof against a Copilot session-state events.jsonl file.
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/kitty-send.sh', import.meta.url));
const WID = '991003';
const SID = 'copilot-session-test';
const CWD = process.cwd();
const MSG = 'ping from the switchboard fixture';
const LONG_MSG = `long Copilot prompt ${'x'.repeat(1280)}`;

let binDir;
let stateDir;
let copilotDir;
let events;
let proof;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-copilot-bin-'));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-copilot-state-'));
  copilotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-copilot-home-'));
  const sessionDir = path.join(copilotDir, SID);
  const otherSessionDir = path.join(copilotDir, 'aaa-other-session');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(otherSessionDir, { recursive: true });
  events = path.join(sessionDir, 'events.jsonl');
  await fs.writeFile(events, `${JSON.stringify({
    type: 'user.message',
    data: { content: 'an earlier prompt' },
  })}\n`);
  await fs.writeFile(path.join(sessionDir, `inuse.${process.pid}.lock`), '');
  await fs.writeFile(path.join(otherSessionDir, `inuse.${process.ppid}.lock`), '');
  proof = path.join(stateDir, 'typing-proof.mjs');
  await fs.writeFile(proof, 'process.exit(0);\n');
  const lsJson = JSON.stringify([{
    tabs: [{
      title: 'copilot',
      windows: [{
        id: Number(WID),
        title: 'Copilot',
        pid: process.pid,
        cwd: CWD,
        foreground_processes: [{ pid: process.pid, cmdline: ['copilot'], cwd: CWD }],
      }],
    }],
  }]);
  const lsDeadJson = JSON.stringify([{
    tabs: [{
      title: 'copilot',
      windows: [{
        id: Number(WID),
        title: 'Copilot',
        pid: process.pid,
        cwd: CWD,
        foreground_processes: [{ pid: process.pid, cmdline: ['bash'], cwd: CWD }],
      }],
    }],
  }]);
  const stub = [
    '#!/usr/bin/env bash',
    `events=${JSON.stringify(events)}`,
    `state=${JSON.stringify(stateDir)}`,
    `ls_json=${JSON.stringify(lsJson)}`,
    'case "$1/$2" in',
    '  @/ls) if [ -f "$state/no-copilot" ]; then printf "%s\\n" ' + JSON.stringify(lsDeadJson) + '; else printf "%s\\n" "$ls_json"; fi ;;',
    '  @/send-text)',
    '    text="${@: -1}";',
    '    if [ "$text" = $' + "'\\r'" + ' ]; then echo enter >> "$state/calls"; if [ -f "$state/composer" ] && [ "$(wc -c < "$state/composer")" -gt 500 ] && [ ! -f "$state/long-first-enter" ]; then touch "$state/long-first-enter"; else jq -cn --arg text "$(cat "$state/composer")" \'{type:"user.message",data:{content:$text}}\' >> "$events"; rm -f "$state/composer"; fi;',
    '    elif [[ "$text" == *$' + "'\\r'" + ' ]]; then echo burst >> "$state/calls"; printf "%s" "${text%' + "'\\r'" + '}" > "$state/composer";',
    '    else echo text >> "$state/calls"; printf "%s" "$text" > "$state/composer"; if [ -f "$state/dialog_after_text" ]; then jq -cn \'{type:"permission.requested"}\' >> "$events"; fi; fi ;;',
    '  @/get-text) if [ -f "$state/composer" ]; then cat "$state/composer"; else printf "%s\\n" "copilot prompt"; fi ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'kitty'), stub, { mode: 0o755 });
});

after(async () => {
  for (const dir of [binDir, stateDir, copilotDir]) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('a Copilot prompt is proved by its new user.message event', async () => {
  let result;
  try {
    result = await run(SCRIPT, ['--to', WID, '--text', MSG, '--timeout', '5'], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: copilotDir,
        XDG_RUNTIME_DIR: stateDir,
        COPILOT_STATE_DIR: copilotDir,
        KITTY_SEND_TYPING_PROOF: proof,
      }),
      timeout: 15_000,
    });
  } catch (error) {
    result = error;
  }
  assert.equal(result.code ?? 0, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.match(result.stderr, /proved by Copilot session event/);
  assert.deepEqual((await fs.readFile(path.join(stateDir, 'calls'), 'utf8')).trim().split('\n'), ['text', 'enter']);
});

test('same-cwd Copilot sessions use the window process lock, not another live process', async () => {
  let result;
  try {
    result = await run(SCRIPT, ['--to', WID, '--text', MSG, '--timeout', '5'], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: copilotDir,
        XDG_RUNTIME_DIR: stateDir,
        COPILOT_STATE_DIR: copilotDir,
        KITTY_SEND_TYPING_PROOF: proof,
      }),
      timeout: 15_000,
    });
  } catch (error) {
    result = error;
  }
  assert.equal(result.code ?? 0, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.match(result.stderr, /proved by Copilot session event/);
});

test('a long Copilot prompt gets a guarded second Enter after the measured delay', async () => {
  await fs.writeFile(events, `${JSON.stringify({
    type: 'user.message',
    data: { content: 'an earlier prompt' },
  })}\n`);
  await fs.rm(path.join(stateDir, 'calls'), { force: true });
  await fs.rm(path.join(stateDir, 'composer'), { force: true });
  await fs.rm(path.join(stateDir, 'long-first-enter'), { force: true });
  let result;
  try {
    result = await run(SCRIPT, ['--to', WID, '--text', LONG_MSG, '--timeout', '6'], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: copilotDir,
        XDG_RUNTIME_DIR: stateDir,
        COPILOT_STATE_DIR: copilotDir,
        KITTY_SEND_TYPING_PROOF: proof,
        KITTY_SEND_CLAUDE_ENTER_AFTER: '1',
      }),
      timeout: 15_000,
    });
  } catch (error) {
    result = error;
  }
  assert.equal(result.code ?? 0, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.deepEqual((await fs.readFile(path.join(stateDir, 'calls'), 'utf8')).trim().split('\n').slice(-3), ['text', 'enter', 'enter']);
  assert.match(result.stderr, /proved by Copilot session event/);
});

test('a busy Copilot target is never sent even with --now', async () => {
  await fs.writeFile(events, `${JSON.stringify({ type: 'assistant.turn_start' })}\n`);
  let result;
  try {
    result = await run(SCRIPT, ['--to', WID, '--text', MSG, '--now'], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: copilotDir,
        XDG_RUNTIME_DIR: stateDir,
        COPILOT_STATE_DIR: copilotDir,
        KITTY_SEND_TYPING_PROOF: proof,
      }),
      timeout: 15_000,
    });
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, 7);
  assert.match(result.stderr, /busy Copilot/);
});

test('a Copilot permission dialog refuses the send', async () => {
  await fs.writeFile(events, `${JSON.stringify({ type: 'permission.requested' })}\n`);
  let result;
  try {
    result = await run(SCRIPT, ['--to', WID, '--text', MSG], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: copilotDir,
        XDG_RUNTIME_DIR: stateDir,
        COPILOT_STATE_DIR: copilotDir,
        KITTY_SEND_TYPING_PROOF: proof,
      }),
      timeout: 15_000,
    });
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, 4);
  assert.match(result.stderr, /permission dialog/);
});

test('a Copilot permission dialog that opens after the text gets no Enter', async () => {
  await fs.writeFile(events, `${JSON.stringify({ type: 'user.message', data: { content: 'an earlier prompt' } })}\n`);
  for (const f of ['calls', 'composer']) await fs.rm(path.join(stateDir, f), { force: true });
  await fs.writeFile(path.join(stateDir, 'dialog_after_text'), '');
  try {
    let result;
    try {
      result = await run(SCRIPT, ['--to', WID, '--text', MSG, '--timeout', '3'], {
        env: isolatedEnv({
          PATH: `${binDir}:${process.env.PATH}`,
          HOME: copilotDir,
          XDG_RUNTIME_DIR: stateDir,
          COPILOT_STATE_DIR: copilotDir,
          KITTY_SEND_TYPING_PROOF: proof,
        }),
        timeout: 15_000,
      });
    } catch (error) {
      result = error;
    }
    assert.deepEqual((await fs.readFile(path.join(stateDir, 'calls'), 'utf8')).trim().split('\n'), ['text']);
    assert.equal(result.code, 3, `${result.stdout ?? ''}${result.stderr ?? ''}`);
    assert.match(result.stderr, /Enter withheld/);
  } finally {
    for (const f of ['dialog_after_text', 'composer', 'calls']) await fs.rm(path.join(stateDir, f), { force: true });
  }
});

test('a window still titled Copilot with a bare shell in front is refused', async () => {
  await fs.writeFile(path.join(stateDir, 'no-copilot'), '');
  await fs.rm(path.join(stateDir, 'calls'), { force: true });
  let result;
  try {
    result = await run(SCRIPT, ['--to', WID, '--text', MSG], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: copilotDir,
        XDG_RUNTIME_DIR: stateDir,
        COPILOT_STATE_DIR: copilotDir,
        KITTY_SEND_TYPING_PROOF: proof,
      }),
      timeout: 15_000,
    });
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, 17);
  assert.match(result.stderr, /no live Copilot process in its foreground/);
  assert.equal(await fs.readFile(path.join(stateDir, 'calls'), 'utf8').catch(() => ''), '');
});

// A Copilot seat whose Copilot has gone. Realistic layout: the kitty window's
// pid is the shell the seat runs in (this test process stands in for it), and
// Copilot is a CHILD of that shell holding the inuse.<child pid>.lock. Once
// Copilot exits the shell resets the title, so neither the title nor the lock
// can say "this was a Copilot seat"; the binding written while Copilot was
// alive (by its status-line hook, or by a send that found it) does, and the
// liveness answer comes only from the window's foreground processes.
const HOOK = fileURLToPath(new URL('../hooks/copilot/presence.mjs', import.meta.url));
const NATIVE = '/opt/npm/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-x64/copilot';

const seatFixture = async (wid) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-copilot-seat-'));
  const fx = {
    wid,
    dir,
    bin: path.join(dir, 'bin'),
    state: path.join(dir, 'run'),
    sessions: path.join(dir, 'session-state'),
    store: path.join(dir, 'switchboard'),
    children: [],
  };
  await fs.mkdir(fx.bin, { recursive: true });
  await fs.mkdir(fx.state, { recursive: true });
  await fs.mkdir(fx.sessions, { recursive: true });
  fx.events = path.join(fx.sessions, 'seat-session', 'events.jsonl');
  await fs.mkdir(path.dirname(fx.events), { recursive: true });
  await fs.writeFile(fx.events, `${JSON.stringify({ type: 'user.message', data: { content: 'an earlier prompt' } })}\n`);
  const stub = [
    '#!/usr/bin/env bash',
    `state=${JSON.stringify(fx.state)}`,
    `events=${JSON.stringify(fx.events)}`,
    'case "$1/$2" in',
    '  @/ls) cat "$state/ls.json" ;;',
    '  @/send-text)',
    '    text="${@: -1}";',
    '    if [ "$text" = $' + "'\\r'" + ' ]; then echo enter >> "$state/calls"; jq -cn --arg text "$(cat "$state/composer" 2>/dev/null)" \'{type:"user.message",data:{content:$text}}\' >> "$events"; rm -f "$state/composer";',
    '    else echo text >> "$state/calls"; printf "%s" "$text" > "$state/composer"; fi ;;',
    '  @/get-text) if [ -f "$state/composer" ]; then cat "$state/composer"; else printf "%s\\n" "$"; fi ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  await fs.writeFile(path.join(fx.bin, 'kitty'), stub, { mode: 0o755 });
  await fs.writeFile(path.join(fx.state, 'proof.mjs'), 'process.exit(0);\n');
  return fx;
};

// What `kitty @ ls` reports for the seat window: its pid is the shell, the
// title is whatever the shell or Copilot last set, and the foreground is
// either Copilot or the bare shell.
const showWindow = (fx, { title, foreground }) =>
  fs.writeFile(path.join(fx.state, 'ls.json'), JSON.stringify([{
    id: 1,
    tabs: [{
      title,
      windows: [{
        id: Number(fx.wid),
        title,
        pid: process.pid,
        cwd: CWD,
        cmdline: ['/bin/bash'],
        user_vars: {},
        foreground_processes: foreground,
      }],
    }],
  }]));
const bareShell = [{ pid: process.pid, cmdline: ['/bin/bash'], cwd: CWD }];

// A live "Copilot": a real child of this process (the window shell) whose
// /proc cmdline starts with copilot, holding its session's inuse lock.
const startCopilot = async (fx) => {
  const child = spawn('sleep', ['300'], { argv0: 'copilot', stdio: 'ignore' });
  fx.children.push(child);
  await fs.writeFile(path.join(path.dirname(fx.events), `inuse.${child.pid}.lock`), '');
  return child;
};
const copilotForeground = (child) => [{ pid: child.pid, cmdline: [NATIVE, '--continue'], cwd: CWD }];
const kill = async (child) => {
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await gone;
};

const seatEnv = (fx, extra = {}) => isolatedEnv({
  PATH: `${fx.bin}:${process.env.PATH}`,
  HOME: fx.dir,
  XDG_RUNTIME_DIR: fx.state,
  COPILOT_STATE_DIR: fx.sessions,
  AGENT_SWITCHBOARD_DIR: fx.store,
  KITTY_SEND_TYPING_PROOF: path.join(fx.state, 'proof.mjs'),
  ...extra,
});
const sendTo = async (fx, text = MSG) => {
  try {
    const r = await run(SCRIPT, ['--to', fx.wid, '--text', text, '--timeout', '5'], { env: seatEnv(fx), timeout: 15_000 });
    return { code: 0, ...r };
  } catch (error) {
    return error;
  }
};
const calls = async (fx) => (await fs.readFile(path.join(fx.state, 'calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);

// The status-line hook as Copilot runs it: a descendant of the window shell,
// with the window id and the kitty pid kitty puts in every window's env.
const runStatusHook = (fx) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ cwd: CWD }),
  env: seatEnv(fx, { KITTY_WINDOW_ID: fx.wid, KITTY_PID: String(process.ppid) }),
  timeout: 15_000,
});

const cleanup = async (fx) => {
  for (const child of fx.children) child.kill('SIGKILL');
  await fs.rm(fx.dir, { recursive: true, force: true }).catch(() => {});
};

test('a Copilot that exited cleanly (no lock, title reset) is refused, never typed into the shell', async () => {
  const fx = await seatFixture('991101');
  try {
    const copilot = await startCopilot(fx);
    await showWindow(fx, { title: 'repo - GitHub Copilot', foreground: copilotForeground(copilot) });
    assert.equal(runStatusHook(fx).status, 0);
    // Clean exit: Copilot removes its lock, and the shell resets the title.
    await kill(copilot);
    await fs.rm(path.join(path.dirname(fx.events), `inuse.${copilot.pid}.lock`));
    await showWindow(fx, { title: 'bash', foreground: bareShell });
    const r = await sendTo(fx);
    assert.equal(r.code, 17, `${r.stdout ?? ''}${r.stderr ?? ''}`);
    assert.match(r.stderr, /no live Copilot process in its foreground/);
    assert.deepEqual(await calls(fx), []);
  } finally {
    await cleanup(fx);
  }
});

test('a killed Copilot (lock left under its dead pid, title reset) is refused, never typed into the shell', async () => {
  const fx = await seatFixture('991102');
  try {
    const copilot = await startCopilot(fx);
    await showWindow(fx, { title: 'repo - GitHub Copilot', foreground: copilotForeground(copilot) });
    assert.equal(runStatusHook(fx).status, 0);
    await kill(copilot);
    await showWindow(fx, { title: 'bash', foreground: bareShell });
    const r = await sendTo(fx);
    assert.equal(r.code, 17, `${r.stdout ?? ''}${r.stderr ?? ''}`);
    assert.match(r.stderr, /no live Copilot process in its foreground/);
    assert.deepEqual(await calls(fx), []);
  } finally {
    await cleanup(fx);
  }
});

test('a window a send proved to be Copilot stays bound without the status-line hook', async () => {
  const fx = await seatFixture('991103');
  try {
    const copilot = await startCopilot(fx);
    await showWindow(fx, { title: 'repo - GitHub Copilot', foreground: copilotForeground(copilot) });
    const first = await sendTo(fx);
    assert.equal(first.code, 0, `${first.stdout ?? ''}${first.stderr ?? ''}`);
    await kill(copilot);
    await fs.rm(path.join(fx.state, 'calls'), { force: true });
    await showWindow(fx, { title: 'bash', foreground: bareShell });
    const r = await sendTo(fx);
    assert.equal(r.code, 17, `${r.stdout ?? ''}${r.stderr ?? ''}`);
    assert.deepEqual(await calls(fx), []);
  } finally {
    await cleanup(fx);
  }
});

test('a live Copilot under a title that does not say Copilot still delivers', async () => {
  const fx = await seatFixture('991104');
  try {
    const copilot = await startCopilot(fx);
    await showWindow(fx, { title: 'feature work', foreground: copilotForeground(copilot) });
    assert.equal(runStatusHook(fx).status, 0);
    const r = await sendTo(fx);
    assert.equal(r.code, 0, `${r.stdout ?? ''}${r.stderr ?? ''}`);
    assert.match(r.stderr, /proved by Copilot session event/);
    assert.deepEqual(await calls(fx), ['text', 'enter']);
  } finally {
    await cleanup(fx);
  }
});

test('a binding left by an earlier window with the same id does not refuse a plain shell', async () => {
  const fx = await seatFixture('991105');
  try {
    // Another kitty instance once had a Copilot seat under this window id;
    // its window shell was a different process.
    await fs.mkdir(path.join(fx.state, 'kitty-send'), { recursive: true });
    await fs.writeFile(path.join(fx.state, 'kitty-send', `copilot-window-${fx.wid}`), '999999999\n');
    await showWindow(fx, { title: 'bash', foreground: bareShell });
    const r = await sendTo(fx, 'echo hello');
    assert.notEqual(r.code, 17, `${r.stdout ?? ''}${r.stderr ?? ''}`);
    assert.deepEqual((await calls(fx)).slice(0, 1), ['text']);
  } finally {
    await cleanup(fx);
  }
});
