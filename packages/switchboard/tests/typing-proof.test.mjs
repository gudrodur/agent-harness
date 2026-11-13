// Tests for lib/typing-proof.mjs: the fail-closed proof that gates every
// keystroke kitty-send types. The unit cases call proofVerdict directly; the CLI
// cases run the same module the way bin/kitty-send.sh does (exit 0 proven, 2
// refused, 3 dialog, 64 usage, the reason on stderr).
//
// Screens are fixtures. The empty composer is the shape read from live Claude
// Code windows (top rule, a `❯` line, bottom rule, a footer line); the dialog
// footers are ASSUMED from strings in the Claude Code 2.1.323 binary, because
// no live dialog was available to capture. A permission prompt is refused
// through the record status `waiting`, so it carries no footer string here.
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proofVerdict, typingVerdict, PROVEN, REFUSED, DIALOG } from '../lib/typing-proof.mjs';

const CLI = fileURLToPath(new URL('../lib/typing-proof.mjs', import.meta.url));
const WIN = 991007;
const PID = 424299;
let dir, titleFile, screenFile, sessDir;

const RULE = '─'.repeat(40);
const NARROW_RULE = '─'.repeat(12);
// Read from a live window: the composer's prompt line is `❯` plus a no-break space.
const EMPTY = ['● Done.', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage'].join('\n');

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typing-proof-'));
  titleFile = path.join(dir, 'title');
  screenFile = path.join(dir, 'screen');
  sessDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessDir);
  const kitty = path.join(dir, 'kitty');
  fs.writeFileSync(kitty, [
    '#!/usr/bin/env bash',
    `if [ "$2" = "get-text" ]; then cat ${JSON.stringify(screenFile)} 2>/dev/null || exit 1; exit 0; fi`,
    `node -e 'process.stdout.write(JSON.stringify([{tabs:[{windows:[{id:${WIN},title:require("fs").readFileSync(process.argv[1],"utf-8"),foreground_processes:[{pid:${PID},cmdline:["claude"]}]}]}]}]))' ${JSON.stringify(titleFile)}`,
    '',
  ].join('\n'), { mode: 0o755 });
  process.env.AGENT_MAILBOX_KITTY = kitty;
  process.env.KITTY_SEND_CLAUDE_SESSIONS_DIR = sessDir;
});
after(() => {
  delete process.env.AGENT_MAILBOX_KITTY;
  delete process.env.KITTY_SEND_CLAUDE_SESSIONS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const seat = ({ title = '✳ claude: seat', status = 'idle', screen = EMPTY } = {}) => {
  fs.writeFileSync(titleFile, title);
  fs.rmSync(screenFile, { force: true });
  if (screen != null) fs.writeFileSync(screenFile, screen);
  fs.rmSync(path.join(sessDir, `${PID}.json`), { force: true });
  if (status != null) fs.writeFileSync(path.join(sessDir, `${PID}.json`), JSON.stringify({ sessionId: 'x', status }));
};
const verdict = (opts = {}, call = {}) => { seat(opts); return proofVerdict(WIN, call); };

test('a live-shaped empty composer is proven', () => {
  assert.equal(verdict().kind, PROVEN);
  assert.equal(typingVerdict(WIN), null);
});

test('status shell (background tasks still running) with an empty composer is proven', () => {
  assert.equal(verdict({ status: 'shell' }).kind, PROVEN);
});

test('a narrow window with an empty composer is proven', () => {
  const screen = ['● Done.', NARROW_RULE, '❯ ', NARROW_RULE, '  ? for shortcuts'].join('\n');
  assert.equal(verdict({ screen }).kind, PROVEN);
});

// ---- the composer is read by its top AND bottom rule -------------------------

test('a draft line of box-drawing characters does not end the box early', () => {
  // Before: the box ended at the first line of five or more rule characters, so
  // the draft written under it passed as an empty composer.
  const screen = ['● Done.', RULE, '❯ ', RULE, 'text the human typed after a rule line', RULE, '  ? for shortcuts'].join('\n');
  const v = verdict({ screen });
  assert.equal(v.kind, REFUSED, JSON.stringify(v));
  assert.match(v.reason, /composer holds text/);
});

test('a draft whose first line is a rule-shaped line is refused', () => {
  const screen = ['● Done.', RULE, '❯ ──────────', 'and more', RULE, '  ? for shortcuts'].join('\n');
  assert.equal(verdict({ screen }).kind, REFUSED);
});

test('a draft wrapped over several lines in a narrow window is refused', () => {
  const screen = ['● Done.', NARROW_RULE, '❯ half a thou', '  ght that wra', '  pped around', NARROW_RULE, '  ? for short'].join('\n');
  const v = verdict({ screen });
  assert.equal(v.kind, REFUSED);
  assert.match(v.reason, /composer holds text/);
});

test('bash mode (a `!` prompt) is a shape not known: refused', () => {
  for (const line of ['! ls -la', '!']) {
    const screen = ['● Done.', RULE, line, RULE, '  ! for bash mode'].join('\n');
    const v = verdict({ screen });
    assert.equal(v.kind, REFUSED, `${line}: ${JSON.stringify(v)}`);
    assert.match(v.reason, /no composer box/);
  }
});

test('a screen with no closing rule, or no top rule above the prompt, is refused', () => {
  assert.match(verdict({ screen: ['● Done.', RULE, '❯ '].join('\n') }).reason, /no composer box/);
  assert.match(verdict({ screen: ['● Done.', '❯ ', RULE].join('\n') }).reason, /no composer box/);
});

test('a prompt-looking line inside the reply above the box is not the composer', () => {
  const screen = ['❯ an old prompt in the scrollback', '● Done.', RULE, '❯ half a thought', RULE].join('\n');
  assert.equal(verdict({ screen }).kind, REFUSED);
});

test('a fresh session placeholder hint reads as text: refused', () => {
  const screen = [RULE, '❯ Try "fix the failing test"', RULE].join('\n');
  assert.equal(verdict({ screen }).kind, REFUSED);
});

// ---- dialog is its own verdict ----------------------------------------------

test('record status waiting and blocked are a DIALOG, not busy', () => {
  for (const status of ['waiting', 'blocked']) {
    const v = verdict({ status });
    assert.equal(v.kind, DIALOG, status);
    assert.match(v.reason, new RegExp(`status ${status}`));
    assert.equal(proofVerdict(WIN, { mode: 'dialog' }).kind, DIALOG, `${status} in dialog mode too`);
  }
});

test('a dialog footer in the bottom rows is a DIALOG in both modes (assumed footers)', () => {
  for (const footer of ['Enter to select · ↑/↓ to navigate · Esc to cancel', '↑/↓ to navigate · Enter to select · ←/→ to switch · Esc to cancel']) {
    const screen = ['Which database?', ' ❯ 1. Postgres', '   2. SQLite', '', footer].join('\n');
    assert.equal(verdict({ screen }).kind, DIALOG);
    assert.equal(proofVerdict(WIN, { mode: 'dialog' }).kind, DIALOG);
  }
});

test('an answered dialog far up the scrollback is not a dialog', () => {
  const screen = ['Enter to select · ↑/↓ to navigate · Esc to cancel', ...Array(20).fill('output'), RULE, '❯ ', RULE].join('\n');
  assert.equal(verdict({ screen }).kind, PROVEN);
});

test('prose that asks a question is not a dialog', () => {
  const screen = ['● Do you want to merge it now? Would you like to proceed?', '', RULE, '❯ ', RULE].join('\n');
  assert.equal(verdict({ screen }).kind, PROVEN);
});

// ---- the dialog-only mode: --now keeps a busy seat, needs no empty composer --

test('dialog mode lets a busy mid-turn seat with a draft through; idle mode does not', () => {
  const screen = ['● Working', RULE, '❯ half a thought', RULE].join('\n');
  assert.equal(verdict({ title: '⠹ claude: busy', status: 'busy', screen }, { mode: 'dialog' }).kind, PROVEN);
  assert.equal(proofVerdict(WIN, { mode: 'idle' }).kind, REFUSED);
});

test('dialog mode with an unreadable screen is refused, never "no dialog"', () => {
  assert.equal(verdict({ screen: null }, { mode: 'dialog' }).kind, REFUSED);
});

// ---- the text ----------------------------------------------------------------

test('idle mode refuses a text starting with "/"; dialog mode (--now) keeps slash commands', () => {
  assert.match(verdict({}, { text: '/compact now' }).reason, /starts with "\/"/);
  assert.match(verdict({}, { text: '  /compact now' }).reason, /starts with "\/"/);
  assert.equal(verdict({}, { text: 'see /compact' }).kind, PROVEN);
  assert.equal(proofVerdict(WIN, { mode: 'dialog', text: '/join x' }).kind, PROVEN);
});

test('refusals: busy title, not a claude tab, no record, unknown status', () => {
  assert.match(verdict({ title: '⠹ claude: busy' }).reason, /turn in progress/);
  assert.match(verdict({ title: '◐ claude: busy' }).reason, /turn in progress/);
  assert.match(verdict({ status: null }).reason, /no session record/);
  assert.match(verdict({ status: 'thinking' }).reason, /status thinking/);
  assert.match(verdict({ screen: null }).reason, /screen could not be read/);
});

// ---- the CLI bin/kitty-send.sh runs ------------------------------------------

const cli = (args, input = '') => {
  const r = spawnSync('node', [CLI, ...args], { input, encoding: 'utf-8', env: process.env });
  return { code: r.status, err: r.stderr };
};

test('CLI: 0 proven, 2 refused with the reason on stderr, 3 dialog, 64 usage', () => {
  seat();
  assert.deepEqual(cli(['--window', String(WIN), '--mode', 'idle', '--stdin'], 'hello'), { code: 0, err: '' });
  const slash = cli(['--window', String(WIN), '--mode', 'idle', '--stdin'], '/compact now');
  assert.equal(slash.code, 2);
  assert.match(slash.err, /starts with "\/"/);
  seat({ status: 'waiting' });
  assert.equal(cli(['--window', String(WIN), '--mode', 'dialog']).code, 3);
  assert.equal(cli(['--window', 'x']).code, 64);
  assert.equal(cli(['--window', String(WIN), '--mode', 'sideways']).code, 64);
});

test('CLI: a window that is not there is refused', () => {
  seat();
  const r = cli(['--window', '5', '--mode', 'idle', '--stdin'], 'x');
  assert.equal(r.code, 2);
  assert.match(r.err, /window not found/);
});
