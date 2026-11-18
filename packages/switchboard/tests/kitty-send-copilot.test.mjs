// Tests kitty-send proof against a Copilot session-state events.jsonl file.
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
let presence;
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
  presence = path.join(stateDir, 'presence.json');
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
  const stub = [
    '#!/usr/bin/env bash',
    `events=${JSON.stringify(events)}`,
    `state=${JSON.stringify(stateDir)}`,
    `ls_json=${JSON.stringify(lsJson)}`,
    'case "$1/$2" in',
    '  @/ls) printf "%s\\n" "$ls_json" ;;',
    '  @/send-text)',
    '    text="${@: -1}";',
    '    if [ "$text" = $' + "'\\r'" + ' ]; then echo enter >> "$state/calls"; if [ -f "$state/composer" ] && [ "$(wc -c < "$state/composer")" -gt 500 ] && [ ! -f "$state/long-first-enter" ]; then touch "$state/long-first-enter"; else jq -cn --arg text "$(cat "$state/composer")" \'{type:"user.message",data:{content:$text}}\' >> "$events"; rm -f "$state/composer"; fi;',
    '    elif [[ "$text" == *$' + "'\\r'" + ' ]]; then echo burst >> "$state/calls"; printf "%s" "${text%' + "'\\r'" + '}" > "$state/composer";',
    '    else echo text >> "$state/calls"; printf "%s" "$text" > "$state/composer"; fi ;;',
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

test('a dead Copilot presence pid refuses typing into the shell left behind', async () => {
  await fs.writeFile(presence, JSON.stringify({
    beacons: [{
      sessionId: SID,
      cwd: CWD,
      windowId: Number(WID),
      pid: 999999,
      lastTick: new Date().toISOString(),
    }],
  }));
  let result;
  try {
    result = await run(SCRIPT, ['--to', WID, '--text', MSG], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: copilotDir,
        XDG_RUNTIME_DIR: stateDir,
        COPILOT_STATE_DIR: copilotDir,
        AGENT_MAILBOX_PRESENCE_FILE: presence,
        KITTY_SEND_TYPING_PROOF: proof,
      }),
      timeout: 15_000,
    });
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, 1);
  assert.match(result.stderr, /presence pid is gone/);
});
