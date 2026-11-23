// Tests for lib/typing-proof.mjs: the fail-closed proof that gates every
// keystroke kitty-send types. The unit cases call proofVerdict directly; the CLI
// cases run the same module the way bin/kitty-send.sh does (exit 0 proven, 2
// refused, 3 dialog, 64 usage, the reason on stderr).
//
// Screens are fixtures. The empty composer is the shape read from live Claude
// Code windows (top rule, a `❯` line, bottom rule, a footer line); the dialog
// footers are ASSUMED from strings in the Claude Code 2.1.323 binary, because
// no live dialog was available to capture. A permission prompt is refused
// through the record status `waiting` or its footer, and before an Enter also
// through the composer it replaces (--mode enter).
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proofVerdict, typingVerdict, windowIsBusy, claudeSeatState, PROVEN, REFUSED, DIALOG } from '../lib/typing-proof.mjs';
import * as BG from './fixtures/claude-background-screens.mjs';

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
    // `get-text --ansi` returns the fixture as is, escapes included; a plain
    // `get-text` returns it with its SGR sequences stripped, as kitty does. With
    // the `no-ansi` file present, `--ansi` fails the way an unsupported option would.
    'if [ "$2" = "get-text" ]; then',
    '  ansi=0; for a in "$@"; do [ "$a" = --ansi ] && ansi=1; done',
    `  if [ "$ansi" = 1 ] && [ -f ${JSON.stringify(path.join(dir, 'no-ansi'))} ]; then echo "Error: Unknown option: --ansi" >&2; exit 1; fi`,
    `  if [ "$ansi" = 1 ] && [ -f ${JSON.stringify(path.join(dir, 'ansi-fails-otherwise'))} ]; then echo "Error: No matching windows" >&2; exit 1; fi`,
    `  if [ "$ansi" = 1 ]; then cat ${JSON.stringify(screenFile)} 2>/dev/null || exit 1; exit 0; fi`,
    `  sed 's/\\x1b\\[[0-9;]*m//g' ${JSON.stringify(screenFile)} 2>/dev/null || exit 1; exit 0`,
    'fi',
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

const seat = ({ title = '✳ claude: seat', status = 'idle', screen = EMPTY, noAnsi = false } = {}) => {
  fs.writeFileSync(titleFile, title);
  fs.rmSync(path.join(dir, 'no-ansi'), { force: true });
  if (noAnsi) fs.writeFileSync(path.join(dir, 'no-ansi'), '');
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

// Claude Code embeds the session's custom title in the composer's top rule, so
// every named seat showed `───── example seat title ─` there. The proof read it
// as "no prompt line under a top rule" and a --queue send waited forever.
const LABELLED_RULE = `${'─'.repeat(40)} example seat title ─`;

test('a composer whose top rule carries the session title is proven', () => {
  const screen = ['● Done.', LABELLED_RULE, '❯\u00a0', RULE, '  ⏵⏵ bypass permissions on · 1 shell'].join('\n');
  const v = verdict({ screen });
  assert.equal(v.kind, PROVEN, JSON.stringify(v));
});

// A narrow split gives the rule fewer leading characters, and a long title is
// cut off at the edge: no trailing rule characters at all.
test('a narrow top rule whose long title runs to the edge is proven', () => {
  const screen = ['● Done.', `${'─'.repeat(4)} a very long example seat title that is cut off at the ed…`, '❯\u00a0', RULE, '  ? for shortcuts'].join('\n');
  const v = verdict({ screen });
  assert.equal(v.kind, PROVEN, JSON.stringify(v));
});

test('a labelled top rule with no trailing rule characters is proven', () => {
  const screen = ['● Done.', `${'─'.repeat(40)} example seat title`, '❯\u00a0', RULE, '  ? for shortcuts'].join('\n');
  assert.equal(verdict({ screen }).kind, PROVEN);
});

test('a labelled top rule with text in the composer is still refused', () => {
  const screen = ['● Done.', LABELLED_RULE, '❯ a draft', RULE, '  ? for shortcuts'].join('\n');
  const v = verdict({ screen });
  assert.equal(v.kind, REFUSED, JSON.stringify(v));
  assert.match(v.reason, /composer holds text/);
});

test('a label on the bottom rule does not make a box: it stays strict', () => {
  const screen = ['● Done.', RULE, '❯ ', LABELLED_RULE, '  ? for shortcuts'].join('\n');
  assert.match(verdict({ screen }).reason, /no composer box/);
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

// The proof reads the composer's attributes, so a hint is judged by how it is
// drawn, not by being text: drawn faint it is not typed input (the first
// keystroke replaces it); at normal intensity it cannot be told from a draft.
test('a placeholder hint drawn faint is proven; the same hint at normal intensity is refused', () => {
  assert.equal(verdict({ screen: [RULE, '❯ \x1b[2mTry "fix the failing test"\x1b[22m', RULE].join('\n') }).kind, PROVEN);
  const v = verdict({ screen: [RULE, '❯ Try "fix the failing test"', RULE].join('\n') });
  assert.equal(v.kind, REFUSED);
  assert.match(v.reason, /composer holds text/);
});

// ---- faint text: a prompt suggestion is not a draft --------------------------
//
// When a turn ends Claude Code puts a prompt suggestion in the composer, drawn
// faint (SGR 2). Read without attributes it looked like a draft, and an idle
// seat refused every typed delivery for hours. The proof reads `get-text
// --ansi` and drops faint runs inside the box; anything it cannot read for
// certain still refuses, since a false "empty" types into a human's draft.
const E = '\x1b';
const faintBox = (...rows) => ['● Done.', RULE, ...rows, RULE, '  ⏵⏵ bypass permissions on · 1 shell'].join('\n');
const holdsText = (v) => { assert.equal(v.kind, REFUSED, JSON.stringify(v)); assert.match(v.reason, /composer holds text/); };

test('a composer holding only a faint prompt suggestion is proven', () => {
  const v = verdict({ screen: [RULE, `❯ ${E}[22;2mBuilders at high${E}[22m`, RULE].join('\n') });
  assert.equal(v.kind, PROVEN, JSON.stringify(v));
  assert.equal(typingVerdict(WIN), null);
});

// The shape kitty really emits: a reset at the start of each line, one faint
// run per word with plain spaces between, the last run left open at the end of
// the line, a coloured top rule carrying the seat title, and a hyperlink in the
// footer. Trimmed from a captured screen, names replaced.
test('a captured live screen with a faint suggestion is proven', () => {
  const words = ['Builders', 'at', 'high', 'for', 'stateful', 'work'];
  const screen = [
    `${E}[m${E}[90m✻${E}[39m ${E}[90mWaiting${E}[39m ${E}[90mfor${E}[39m ${E}[22;1;90m6${E}[22m background${E}[39m ${E}[90magents`,
    '',
    `${E}[m${E}[37m${'─'.repeat(40)}${E}[39m ${E}[37mclaude:${E}[39m ${E}[37mexample-seat${E}[39m ${E}[37m─`,
    `${E}[m❯ ${words.map((w) => `${E}[22;2m${w}`).join(`${E}[22m `)}`,
    `${E}[m${E}[37m${'─'.repeat(40)}`,
    `${E}[m  ${E}[31m⏵⏵${E}[39m ${E}[31mbypass${E}[39m ${E}[31mpermissions${E}[39m ${E}[31mon${E}[39m   ${E}]8;id=abc;https://example.com/session${E}\\${E}[32m/rc${E}]8;;${E}\\`,
    '',
    `${E}[m  ${E}[22;1m●${E}[22m ${E}[22;1mmain`,
  ].join('\n');
  const v = verdict({ screen });
  assert.equal(v.kind, PROVEN, JSON.stringify(v));
});

test('normal-intensity text after a faint run is refused', () => {
  holdsText(verdict({ screen: faintBox(`❯ ${E}[2mBuilders at high${E}[22m and a draft`) }));
  holdsText(verdict({ screen: faintBox(`❯ ${E}[2mBuilders${E}[0m draft`) }));
  holdsText(verdict({ screen: faintBox(`❯ ${E}[2mBuilders${E}[m draft`) }));
});

test('a faint run left open at the end of a row does not cover normal text on the next row', () => {
  holdsText(verdict({ screen: faintBox(`❯ ${E}[2mBuilders at high`, '  a draft on the second row') }));
  holdsText(verdict({ screen: faintBox(`❯ ${E}[2mBuilders at high`, `${E}[m  a draft on the second row`) }));
});

test('colour alone is never faint, and bold or SGR 22 ends a faint run', () => {
  holdsText(verdict({ screen: faintBox(`❯ ${E}[90mgrey draft${E}[39m`) }));
  holdsText(verdict({ screen: faintBox(`❯ ${E}[38;5;8mgrey draft${E}[39m`) }));
  holdsText(verdict({ screen: faintBox(`❯ ${E}[2;22mdraft`) }));
  holdsText(verdict({ screen: faintBox(`❯ ${E}[2;1mdraft`) }));
  holdsText(verdict({ screen: faintBox(`❯ ${E}[22;1;90mdraft`) }));
});

// The 2 inside `38;2;r;g;b` (and `38;5;2`) is a colour argument, not SGR 2.
test('a 2 inside an extended colour is not read as faint', () => {
  holdsText(verdict({ screen: faintBox(`❯ ${E}[38;2;120;120;120mdraft${E}[39m`) }));
  holdsText(verdict({ screen: faintBox(`❯ ${E}[38;5;2mdraft${E}[39m`) }));
  holdsText(verdict({ screen: faintBox(`❯ ${E}[48;2;0;0;2mdraft${E}[49m`) }));
});

test('a malformed or unknown escape sequence in the box is refused', () => {
  for (const row of [
    `❯ ${E}[2mBuilders${E}[22`,
    `❯ ${E}[2mBuilders${E}[2Kdraft`,
    `❯ ${E}[2mBuilders${E}Xdraft`,
    `❯ ${E}[2;xmdraft`,
    `❯ ${E}[38;2mdraft`,
    `❯ ${E}[2mBuilders${E}]8;;unterminated`,
    `❯ ${E}[2mBuilders${E}`,
  ]) {
    const v = verdict({ screen: faintBox(row) });
    assert.equal(v.kind, REFUSED, `${JSON.stringify(row)}: ${JSON.stringify(v)}`);
  }
});

test('when get-text --ansi fails, the plain read is used and a suggestion refuses as before', () => {
  holdsText(verdict({ screen: faintBox(`❯ ${E}[22;2mBuilders at high${E}[22m`), noAnsi: true }));
  assert.equal(verdict({ noAnsi: true }).kind, PROVEN, 'an empty composer is still proven on the plain read');
  assert.match(verdict({ screen: null, noAnsi: true }).reason, /screen could not be read/);
});

// A read that fails for any other reason is not retried without --ansi: a
// transient error stays "could not read", never a second read that types.
test('a get-text --ansi failure that is not about --ansi is not retried: refused', () => {
  seat({ screen: null });
  assert.match(proofVerdict(WIN).reason, /screen could not be read/);
  fs.writeFileSync(screenFile, EMPTY); // present for the plain read only
  fs.writeFileSync(path.join(dir, 'ansi-fails-otherwise'), '');
  try {
    assert.match(proofVerdict(WIN).reason, /screen could not be read/);
  } finally {
    fs.rmSync(path.join(dir, 'ansi-fails-otherwise'), { force: true });
  }
});

test('a faint dialog footer is still a dialog: faint text is dropped only inside the box', () => {
  const screen = ['Which database?', ' ❯ 1. Postgres', '   2. SQLite', '', `${E}[2mEnter to select · ↑/↓ to navigate · Esc to cancel${E}[22m`].join('\n');
  assert.equal(verdict({ screen }).kind, DIALOG);
});

test('a paste or image chip in the box is refused even when drawn faint', () => {
  holdsText(verdict({ screen: faintBox(`❯ ${E}[2m[Pasted text #1 +20 lines]${E}[22m`) }));
  holdsText(verdict({ screen: faintBox(`❯ ${E}[2m[Image #2]${E}[22m`) }));
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

// --mode composer: does the composer still hold a text? Exit 0 no, 2 yes, 3 could not tell.
const composerCli = (screen, text = '/rename x') => {
  seat({ screen });
  return spawnSync(process.execPath, [CLI, '--window', String(WIN), '--mode', 'composer', '--stdin'], { input: text, encoding: 'utf-8', env: process.env }).status;
};
const boxWith = (line, top = RULE) => ['● Done.', top, line, RULE, '  ⏵⏵ bypass permissions on · 1 shell'].join('\n');

test('--mode composer: 0 for an empty box, 2 while it holds the text, also under a titled top rule', () => {
  assert.equal(composerCli(EMPTY), 0);
  assert.equal(composerCli(boxWith('❯ /rename x')), 2);
  assert.equal(composerCli(boxWith('❯ /rename x', LABELLED_RULE)), 2);
});

test('--mode composer reads the box with the same parser: a faint suggestion is not held text', () => {
  assert.equal(composerCli(boxWith(`❯ ${E}[22;2m/rename x${E}[22m`)), 0);
  assert.equal(composerCli(boxWith(`❯ ${E}[22;2mBuilders${E}[22m /rename x`)), 2);
  assert.equal(composerCli(boxWith(`❯ ${E}[2m/rename${E}[2K x`)), 3, 'an escape it cannot read is "could not tell"');
});

test('--mode composer: 3 (could not tell) with no box on the screen, and with a dialog open', () => {
  assert.equal(composerCli('just text'), 3);
  assert.equal(composerCli([boxWith('❯ /rename x'), 'Enter to select · Esc to cancel'].join('\n')), 3);
});

// ---- a busy record: its own turn, or only background work -----------------------
//
// Claude Code records `busy` while its own turn runs AND while its turn has
// ended and only background agents still work. The second is a seat waiting at
// its prompt: queued mail to it sat undelivered for up to two hours, because
// every reader took the record's `busy` as a turn in progress. The screen tells
// the two apart (fixtures/claude-background-screens.mjs).

const winRecord = (title = 'example renamed seat') => ({ id: WIN, title, foreground_processes: [{ pid: PID, cmdline: ['claude'] }] });
const busyOn = (screen, title = 'example renamed seat') => { seat({ title, status: 'busy', screen }); return windowIsBusy(winRecord(title)); };

test('(a) a busy record over an idle prompt with background agents is idle and proven', () => {
  for (const screen of [BG.BACKGROUND_AT_PROMPT, BG.BACKGROUND_AT_PROMPT_TITLED, BG.BACKGROUND_FOOTER_LINES, BG.BACKGROUND_FOOTER_RC, BG.BACKGROUND_WAIT_LINE_ONLY]) {
    assert.equal(busyOn(screen), false, screen);
    const v = proofVerdict(WIN);
    assert.equal(v.kind, PROVEN, JSON.stringify(v));
  }
});

test('(b) a spinner in the title keeps a background-looking screen busy', () => {
  // A seat that was never renamed shows Claude Code's own title, which spins
  // only while its turn runs (a live seat at its prompt with background agents
  // showed none): the spinner wins over the screen.
  assert.equal(busyOn(BG.BACKGROUND_AT_PROMPT, '◐ claude: seat'), true);
  assert.equal(proofVerdict(WIN).kind, REFUSED);
});

test('(b) a busy record with its own turn running stays busy and refused', () => {
  for (const screen of [BG.OWN_TURN_WITH_BACKGROUND, BG.OWN_TURN_FOOTER_CUT]) {
    assert.equal(busyOn(screen), true, screen);
    const v = proofVerdict(WIN);
    assert.equal(v.kind, REFUSED, JSON.stringify(v));
    assert.match(v.reason, /^session record status busy/);
  }
});

test('(b) a busy record the screen cannot settle stays busy: cut footer, no background listed, no composer, unreadable', () => {
  for (const [name, screen] of [
    ['footer cut before the esc slot', BG.FOOTER_CUT_NO_SPINNER],
    ['no background work listed', BG.BUSY_NO_BACKGROUND],
    ['no composer box', '● Working\n  ⏵⏵ bypass permissions on · 2 background tasks'],
    ['unreadable screen', null],
  ]) {
    assert.equal(busyOn(screen), true, name);
    assert.notEqual(proofVerdict(WIN).kind, PROVEN, name);
  }
});

// Each group trips exactly one guard: every other sign on those screens says
// the seat is at its prompt, so deleting that guard fails its test.
for (const [guard, screens, reason] of [
  ['the esc hint', BG.ONLY_ESC_HINT, /esc to interrupt: its own turn runs/],
  ['the spinner line', BG.ONLY_SPINNER, /a spinner line stands above the composer/],
  ['the manage hint', BG.ONLY_FOOTER_UNPROVEN, /↓ to manage/],
  ['the empty composer', BG.ONLY_DRAFT, /composer (holds text|could not be read)/],
]) {
  for (const [name, screen] of Object.entries(screens)) {
    test(`(b) ${guard} alone keeps a busy record busy: ${name}`, () => {
      assert.equal(busyOn(screen), true);
      const v = proofVerdict(WIN);
      assert.equal(v.kind, REFUSED, JSON.stringify(v));
      assert.match(v.reason, /^session record status busy, not idle/);
      assert.match(v.reason, reason);
      assert.equal(seatCli({ status: 'busy', screen }).out, 'busy');
    });
  }
}

for (const [name, screen] of [
  ['A, compacting with a draft', BG.COMPACTING_WITH_DRAFT],
  ['B, compacting with a clipped footer', BG.COMPACTING_CLIPPED],
  ['C, a spinner above a task list with a draft', BG.SPINNER_ABOVE_TASKS_WITH_DRAFT],
  ['a draft under the waiting line', BG.WAITING_WITH_DRAFT],
]) {
  test(`(b) screen ${name} is busy and never proven`, () => {
    assert.equal(busyOn(screen), true);
    assert.equal(proofVerdict(WIN).kind, REFUSED);
    assert.equal(seatCli({ status: 'busy', screen }).out, 'busy');
  });
}

test('(a) a faint prompt suggestion is an empty composer for a background-idle seat', () => {
  const screen = BG.BACKGROUND_AT_PROMPT.replace(BG.EMPTY_PROMPT, `${BG.EMPTY_PROMPT}\x1b[22;2mcheck on the agents\x1b[22m`);
  assert.equal(busyOn(screen), false);
  assert.equal(proofVerdict(WIN).kind, PROVEN);
});

test('(c) a question raised while background agents run is a DIALOG in every mode', () => {
  for (const status of ['waiting', 'busy']) {
    seat({ title: 'example renamed seat', status, screen: BG.QUESTION_WITH_BACKGROUND });
    assert.equal(proofVerdict(WIN).kind, DIALOG, status);
    assert.equal(proofVerdict(WIN, { mode: 'dialog' }).kind, DIALOG, status);
  }
  // A busy record with a dialog drawn is never idle for the busy readers either.
  assert.equal(busyOn(BG.QUESTION_WITH_BACKGROUND), true);
});

test('(c) a dialog drawn under a screen that otherwise reads idle-with-background is a dialog, not idle', () => {
  const screen = `${BG.BACKGROUND_AT_PROMPT}\n  Enter to select · ↑/↓ to navigate · Esc to cancel`;
  assert.equal(busyOn(screen), true);
  assert.equal(claudeSeatState({ status: 'busy', title: 'example renamed seat', lines: screen.split('\n').map((text) => ({ text, faint: [] })) }).state, 'dialog');
  assert.equal(proofVerdict(WIN).kind, DIALOG);
  assert.equal(proofVerdict(WIN, { mode: 'dialog' }).kind, DIALOG);
});

// --mode seat: the one reading for the shell callers (tab-state.sh, claude-session.sh).
const seatCli = (opts) => {
  seat({ title: 'example renamed seat', ...opts });
  const r = spawnSync(process.execPath, [CLI, '--window', String(WIN), '--mode', 'seat'], { encoding: 'utf-8', env: process.env });
  return { code: r.status, out: r.stdout.trim() };
};

test('--mode seat prints idle, busy, dialog or unknown for the record and screen', () => {
  assert.deepEqual(seatCli({ status: 'busy', screen: BG.BACKGROUND_AT_PROMPT }), { code: 0, out: 'idle' });
  assert.deepEqual(seatCli({ status: 'busy', screen: BG.OWN_TURN_WITH_BACKGROUND }), { code: 0, out: 'busy' });
  assert.deepEqual(seatCli({ status: 'busy', screen: null }), { code: 0, out: 'busy' });
  assert.deepEqual(seatCli({ status: 'waiting', screen: BG.QUESTION_WITH_BACKGROUND }), { code: 0, out: 'dialog' });
  assert.deepEqual(seatCli({ status: 'busy', screen: BG.QUESTION_WITH_BACKGROUND }), { code: 0, out: 'dialog' });
  assert.deepEqual(seatCli({ status: 'idle' }), { code: 0, out: 'idle' });
  assert.deepEqual(seatCli({ status: 'shell' }), { code: 0, out: 'idle' });
  assert.deepEqual(seatCli({ status: null }), { code: 0, out: 'unknown' });
});

// --mode ending: may a command that ends or wipes the conversation be typed?
// 0 yes, 2 only background work runs, 3 its own turn runs with background work
// listed, 1 could not tell.
const endingCli = (text, opts, window = WIN) => {
  seat({ title: 'example renamed seat', ...opts });
  return spawnSync(process.execPath, [CLI, '--window', String(window), '--mode', 'ending', '--stdin'], { input: text, encoding: 'utf-8', env: process.env }).status;
};
// Without the agents panel, whose "waiting on 1 shell" would match by itself.
const ownTurnListing = (label) => BG.OWN_TURN_WITH_BACKGROUND.split('\n  ● main')[0].replace('2 background tasks', label);
for (const [name, status, screen, code] of [
  ['idle only by background work', 'busy', BG.BACKGROUND_AT_PROMPT, 2],
  ['idle with only the waiting line', 'busy', BG.BACKGROUND_WAIT_LINE_ONLY, 2],
  ['idle with a background shell', 'shell', EMPTY, 2],
  ['its own turn with background tasks', 'busy', BG.OWN_TURN_WITH_BACKGROUND, 3],
  // The other labels Claude Code gives background work in that footer.
  ...['1 shell', '2 shells', '1 monitor', '2 background agents', '1 team', '1 MCP task', '2 background dynamic workflows', '1 cloud session']
    .map((label) => [`its own turn with ${label}`, 'busy', ownTurnListing(label), 3]),
  ['its own turn with only the waiting line', 'busy', BG.BACKGROUND_WAIT_LINE_ONLY.replace('↓ to manage', 'esc to interrupt'), 3],
  ['its own turn with no background work', 'busy', BG.BUSY_NO_BACKGROUND, 0],
  ['its own turn with no count in the footer', 'busy', ownTurnListing('accept edits'), 0],
  ['truly idle', 'idle', EMPTY, 0],
  ['busy with no screen to read', 'busy', null, 1],
  ['busy with no composer to read', 'busy', BG.PERMISSION_PROMPT_NO_FOOTER, 1],
]) {
  test(`--mode ending on a seat ${name} exits ${code}`, () => assert.equal(endingCli('/exit', { status, screen }), code));
}
test('--mode ending cannot tell for a window that is not there', () => {
  assert.equal(endingCli('/exit', { status: 'idle', screen: EMPTY }, WIN + 1), 1);
});
test('--mode ending passes any other text without reading the seat', () => {
  for (const text of ['an ordinary message', '/rename x', '/compact', '/newer', '/clear-cache', 'exit now']) {
    assert.equal(endingCli(text, { status: 'busy', screen: null }, WIN + 1), 0, text);
  }
});

// --mode enter: the proof before an Enter that follows typed text.
test('--mode enter passes a composer holding the typed text, whatever the record', () => {
  for (const status of ['idle', 'shell', 'busy']) {
    seat({ status, screen: BG.typedInto('the message') });
    assert.equal(proofVerdict(WIN, { mode: 'enter' }).kind, PROVEN, status);
  }
});

for (const [name, status, screen, kind] of [
  ['a permission prompt', 'busy', BG.PERMISSION_PROMPT, DIALOG],
  ['a permission prompt without its footer', 'busy', BG.PERMISSION_PROMPT_NO_FOOTER, REFUSED],
  ['a waiting record over a composer not yet redrawn', 'waiting', BG.typedInto('the message'), DIALOG],
  ['an unreadable screen', 'busy', null, REFUSED],
]) {
  test(`--mode enter refuses ${name}`, () => {
    seat({ status, screen });
    assert.equal(proofVerdict(WIN, { mode: 'enter' }).kind, kind);
    const r = spawnSync(process.execPath, [CLI, '--window', String(WIN), '--mode', 'enter'], { encoding: 'utf-8', env: process.env });
    assert.equal(r.status, kind === DIALOG ? 3 : 2, r.stderr);
  });
}

// A permission prompt from a background agent while the main session is idle at
// its own prompt: the record may read busy or idle, and the dialog footer
// (with the "ctrl+x ctrl+k twice to stop background agents" hint) can stand
// above the composer, the footer and a tall agents panel. Every mode refuses it.
for (const [name, screen] of [
  ['with a short footer under it', BG.SUBAGENT_DIALOG_SHORT],
  ['with a tall agents panel under it', BG.SUBAGENT_DIALOG_AT_IDLE_PROMPT],
  ['with a long agents panel under it', BG.SUBAGENT_DIALOG_LONG_PANEL],
  ['with no-break spaces in its footer', BG.SUBAGENT_DIALOG_NBSP_FOOTER],
]) {
  for (const status of ['busy', 'idle', 'shell']) {
    test(`--mode dialog refuses a background agent's dialog ${name} (record ${status})`, () => {
      seat({ status, screen });
      assert.equal(proofVerdict(WIN, { mode: 'dialog' }).kind, DIALOG);
      const r = spawnSync(process.execPath, [CLI, '--window', String(WIN), '--mode', 'dialog'], { encoding: 'utf-8', env: process.env });
      assert.equal(r.status, 3, r.stderr);
    });
  }
}
