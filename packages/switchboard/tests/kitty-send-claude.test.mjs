// Tests for kitty-send.sh against a Claude Code tab (#38). Claude Code takes a
// long one-line send-text burst as a paste and swallows its trailing \r, so
// the text sits in the composer unsubmitted. kitty-send therefore sends a
// Claude tab the text alone and then a lone \r, with one more if needed. The proof is the tab's own transcript: a new user row carrying
// the text, found through <config>/sessions/<pid>.json (sessionId, cwd,
// status) and <config>/projects/<encoded cwd>/<sessionId>.jsonl.
//
// The PATH stub models the measured composer: a burst with its own \r
// swallows that \r and the next lone one; text alone is submitted by the
// next lone \r (mode "enter"). Mode "eat1" swallows the first lone \r anyway,
// "burst" submits on the text itself, "never" never submits.
//
// Run: node --test tests/kitty-send-claude.test.mjs  (or the full suite)
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
const WID = '991002';
const SID = '0000aaaa-1111-2222-3333-444455556666';
const CWD = '/tmp/cl.tab-cwd';
const ENC = '-tmp-cl-tab-cwd';

let binDir, stateDir, claudeDir, transcript;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-claude-bin-'));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-claude-state-'));
  claudeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-claude-cfg-'));
  await fs.mkdir(path.join(claudeDir, 'sessions'));
  await fs.mkdir(path.join(claudeDir, 'projects', ENC), { recursive: true });
  transcript = path.join(claudeDir, 'projects', ENC, `${SID}.jsonl`);
  // The window pid and the claude pid must be alive: the test process is.
  const pid = process.pid;
  const lsJson = JSON.stringify([
    {
      tabs: [
        {
          title: 'mock',
          windows: [
            {
              id: Number(WID),
              title: '✳ Claude Code',
              pid,
              cwd: CWD,
              foreground_processes: [{ pid, cmdline: ['claude'], cwd: CWD }],
            },
          ],
        },
      ],
    },
  ]);
  const stub = [
    '#!/usr/bin/env bash',
    `state=${JSON.stringify(stateDir)}`,
    `transcript=${JSON.stringify(transcript)}`,
    'row() { jq -cn --arg t "$1" \'{type:"user",message:{role:"user",content:$t}}\' >> "$transcript"; }',
    'case "$1/$2" in',
    `  @/ls) if [ -f "$state/nonclaude" ]; then printf '%s\\n' ${JSON.stringify(lsJson)} | sed 's/"cmdline":\\["claude"\\]/"cmdline":["pi"]/'; elif [ -f "$state/title" ]; then printf '%s\\n' ${JSON.stringify(lsJson)} | sed "s/✳ Claude Code/$(cat "$state/title")/"; else printf '%s\\n' ${JSON.stringify(lsJson)}; fi ;;`,
    '  @/send-text)',
    '    text="${@: -1}"',
    '    : > "$state/sent"',
    '    if [ "$text" = $\'\\r\' ]; then',
    '      echo enter >> "$state/calls"',
    '      if [ -f "$state/eat" ]; then rm -f "$state/eat"',
    '      elif [ "$(cat "$state/mode")" != never ] && [ -f "$state/composer" ]; then row "$(cat "$state/composer")"; rm -f "$state/composer"; fi',
    '    else',
    '      # the measured composer: a burst with its own \\r swallows that \\r and the next lone one',
    '      case "$text" in *$\'\\r\') echo burst >> "$state/calls"; touch "$state/eat" ;; *) echo text >> "$state/calls" ;; esac',
    '      [ "$(cat "$state/mode")" = eat1 ] && touch "$state/eat"',
    '      printf \'%s\' "${text%$\'\\r\'}" > "$state/composer"',
    '      # a tool result is a type:user row too; it must not count as the send',
    '      jq -cn \'{type:"user",message:{role:"user",content:[{type:"tool_result",content:"x"}]}}\' >> "$transcript"',
    '      if [ "$(cat "$state/mode")" = burst ]; then row "$(cat "$state/composer")"; rm -f "$state/composer"; fi',
    '    fi',
    '    ;;',
    '  @/send-key) echo send-key >> "$state/calls" ;;',
    '  @/get-text)',
    '    # screen: what the window shows; screen_late replaces it from the late_at-th read on',
    '    n=$(( $(cat "$state/reads" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$state/reads"',
    '    if [ -f "$state/screen_late" ] && [ "$n" -ge "$(cat "$state/late_at")" ]; then cat "$state/screen_late"',
    '    elif [ -f "$state/screen_dyn" ]; then',
    '      # a live composer: typed text sits in the box until a lone \\r submits it, then the command shows its effect',
    '      rule=$(cat "$state/rule")',
    '      if [ -f "$state/composer" ]; then printf \'%s\\n\' "● Done." "" "$rule" "❯ $(cat "$state/composer")" "$rule" "  ⏵⏵ bypass permissions on · 1 shell"',
    '      elif [ -f "$state/sent" ]; then printf \'%s\\n\' "● Done." "● Renamed." "" "$rule" "❯ " "$rule" "  ⏵⏵ bypass permissions on · 1 shell"',
    '      else printf \'%s\\n\' "● Done." "" "$rule" "❯ " "$rule" "  ⏵⏵ bypass permissions on · 1 shell"; fi',
    '    elif [ -f "$state/screen" ]; then cat "$state/screen"',
    "    else printf '%s\\n' 'claude composer'; fi ;;",
    'esac',
    'exit 0',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'kitty'), stub, { mode: 0o755 });
  // `date` that fails once KITTY_TEST_FAIL_DATE_AFTER names an existing file:
  // a command failing after the keystrokes are out, with no `|| true` to hide it.
  await fs.writeFile(path.join(binDir, 'date'), '#!/usr/bin/env bash\n[ -f "${KITTY_TEST_FAIL_DATE_AFTER:-/nonexistent}" ] && exit 1\nexec /usr/bin/date "$@"\n', { mode: 0o755 });
});

after(async () => {
  for (const d of [binDir, stateDir, claudeDir]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const reset = async (mode, status = 'idle') => {
  for (const f of ['calls', 'composer', 'eat', 'title', 'screen', 'screen_dyn', 'screen_late', 'late_at', 'reads', 'sent', 'nonclaude']) await fs.rm(path.join(stateDir, f), { force: true });
  await fs.writeFile(path.join(stateDir, 'mode'), mode);
  await fs.writeFile(transcript, '{"type":"user","message":{"role":"user","content":"an earlier prompt"}}\n');
  await fs.writeFile(
    path.join(claudeDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: SID, cwd: CWD, status }),
  );
};

const calls = async () => (await fs.readFile(path.join(stateDir, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);

const runScript = async (args, extraEnv = {}) => {
  try {
    const r = await run(SCRIPT, args, {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        XDG_RUNTIME_DIR: stateDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        KITTY_SEND_CLAUDE_ENTER_AFTER: '2',
        ...extraEnv,
      }),
      timeout: 30_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

const MSG = 'Note from the overseer: read /tmp/x/ready-1567.txt, a long one-line steer that Claude Code takes as a paste';

test('a Claude tab gets the text, then one lone \\r, and is proved by its transcript', async () => {
  await reset('enter');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /proved by transcript row/);
  assert.deepEqual(await calls(), ['text', 'enter'], 'the text without its \\r, then exactly one lone \\r; no send-key');
});

test('a composer that swallows the first lone \\r is submitted by a second, and no third is sent', async () => {
  await reset('eat1');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['text', 'enter', 'enter']);
});

test('a Claude tab that submits on the text alone gets no \\r', async () => {
  await reset('burst');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['text']);
});

test('a Claude tab that never submits is exit 3 after two lone \\r; a tool-result row does not count', async () => {
  await reset('never');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '5']);
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /Claude Code tab\) and pressed 2 lone Enter/);
  assert.match(r.err, /may still sit in its composer/);
  assert.deepEqual(await calls(), ['text', 'enter', 'enter'], 'two lone \\r at most, never a third');
});

test('a Claude tab whose session status is busy is refused (exit 7), nothing sent', async () => {
  await reset('burst', 'busy');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '4']);
  assert.equal(r.code, 7, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), []);
});

// `waiting` (a permission prompt, a question, a plan approval) and `blocked`
// are a DIALOG, not a busy turn: keystrokes are hotkeys in the widget and the
// \r selects the highlighted option. Refused with exit 4 in every mode, --now
// included (which does let a plain mid-turn seat through).
for (const status of ['waiting', 'blocked']) {
  for (const flags of [[], ['--now']]) {
    test(`a Claude tab whose session status is ${status} is refused (exit 4) with ${flags.join(' ') || 'no mode flag'}, nothing sent`, async () => {
      await reset('burst', status);
      const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '4', ...flags]);
      assert.equal(r.code, 4, `${r.out}${r.err}`);
      assert.match(r.err, new RegExp(`session record status ${status}`));
      assert.deepEqual(await calls(), []);
    });
  }
}

// `shell` is a finished turn with a background shell still running: the seat is
// at the prompt. The session record outranks a spinner left in the title.
test('a Claude tab whose session status is shell is sendable even with a spinner in the title', async () => {
  await reset('burst', 'shell');
  await fs.writeFile(path.join(stateDir, 'title'), '⠹ Claude Code');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['text']);
});

// ---- the chokepoint: the typing proof runs immediately before the first keystroke ----
//
// Every mode that claims the seat is idle (--wait-idle, --deadline, --queue and
// its detached waiter) gets the full proof AT TYPING TIME, whoever called: a
// stale early verdict, a gap between the last poll and this process, or a caller
// that skipped its own check cannot reach a keystroke. The empty composer is the
// shape read from live windows (top rule, `❯` + no-break space, bottom rule).
const RULE = '─'.repeat(40);
const EMPTY = ['● Done.', '', RULE, '❯\u00a0', RULE, '  ⏵⏵ bypass permissions on · 1 shell'].join('\n');
const DRAFT = ['● Done.', '', RULE, '❯ half a thought', RULE, '  ? for shortcuts'].join('\n');
const put = (name, text) => fs.writeFile(path.join(stateDir, name), text);

test('--wait-idle types into an idle seat with an empty composer', async () => {
  await reset('burst');
  await put('screen', EMPTY);
  const r = await runScript(['--to', WID, '--text', MSG, '--wait-idle', '4', '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['text']);
});

for (const [name, screen] of [
  ['a half-typed draft', DRAFT],
  ['a draft written under a rule-shaped line', ['● Done.', RULE, '❯\u00a0', RULE, 'typed after a rule', RULE, '  ? for shortcuts'].join('\n')],
  ['bash mode', ['● Done.', RULE, '! ls', RULE].join('\n')],
]) {
  test(`--wait-idle never types onto ${name}: exit 11, nothing sent`, async () => {
    await reset('burst');
    await put('screen', screen);
    const r = await runScript(['--to', WID, '--text', MSG, '--wait-idle', '4', '--timeout', '4']);
    assert.equal(r.code, 11, `${r.out}${r.err}`);
    assert.match(r.err, /typing proof did not pass \(nothing was sent\)/);
    assert.deepEqual(await calls(), []);
  });
}

// An explicit slash command (a /rename from a seat-rename tool) is the caller's
// choice and goes through to an idle Claude Code tab with an empty composer.
// The mailbox path in agent-send refuses a "/" text on its own.
test('--wait-idle types a "/rename" into an idle Claude Code tab with an empty composer', async () => {
  await reset('burst');
  await put('screen', EMPTY);
  const r = await runScript(['--to', WID, '--text', '/rename x', '--wait-idle', '4', '--timeout', '4']);
  assert.notEqual(r.code, 11, `${r.out}${r.err}`);
  assert.doesNotMatch(r.err, /starts with|typing proof did not pass/, r.err);
  assert.ok((await calls()).length > 0, 'the slash command must be typed');
});

test('--queue: a "/rename" waiter types into an idle Claude Code tab too', async () => {
  await reset('burst');
  await put('screen', EMPTY);
  const r = await runScript(['--to', WID, '--text', '/rename x', '--queue', '--timeout', '4']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const log = path.join(stateDir, 'kitty-send', `queue-${WID}.log`);
  for (let i = 0; i < 60 && !/queued waiter exit rc=/.test(await fs.readFile(log, 'utf8').catch(() => '')); i++) await new Promise((res) => setTimeout(res, 200));
  assert.ok((await calls()).length > 0, 'the slash command must be typed');
});

// The stranded-chip recovery presses Enter in the composer. That is a keystroke:
// it runs behind the idle verdict, so a seat that is not provably idle gets no Enter.
test('the stranded-chip Enter is not pressed when the idle proof refuses (no session record)', async () => {
  await reset('burst');
  await fs.rm(path.join(claudeDir, 'sessions', `${process.pid}.json`), { force: true });
  await put('screen', ['● Done.', RULE, '❯ [Pasted text #1 +1 lines]', RULE].join('\n'));
  await fs.mkdir(path.join(stateDir, 'kitty-send-stranded'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'kitty-send-stranded', `stranded-${WID}`), `pid=${process.pid}\ncreated=\ntime=${Math.floor(Date.now() / 1000)}\nchips=1 \n`);
  const r = await runScript(['--to', WID, '--text', MSG, '--wait-idle', '4', '--timeout', '4']);
  assert.equal(r.code, 11, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), [], 'no Enter and no text may be sent');
});

test('--queue: the detached waiter proves at typing time too (exit 11 in its log, nothing sent)', async () => {
  await reset('burst');
  await put('screen', DRAFT);
  const r = await runScript(['--to', WID, '--text', MSG, '--queue', '--deadline', '3', '--timeout', '4']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const log = path.join(stateDir, 'kitty-send', `queue-${WID}.log`);
  for (let i = 0; i < 60 && !/queued waiter exit rc=/.test(await fs.readFile(log, 'utf8').catch(() => '')); i++) await new Promise((res) => setTimeout(res, 200));
  const text = await fs.readFile(log, 'utf8');
  assert.match(text, /queued waiter exit rc=11/, text);
  assert.match(text, /composer holds text/);
  assert.deepEqual(await calls(), []);
});

test('--queue with no bound: a proof refusal is "not idle yet", the waiter keeps polling and delivers', async () => {
  // No --timeout/--deadline: the waiter is unbounded. The first proof reads show
  // a draft; from the 5th read on the composer is empty. The text must arrive,
  // not be dropped with exit 11 after the caller already got exit 0.
  await reset('burst');
  await put('screen', DRAFT);
  await put('screen_late', EMPTY);
  await put('late_at', '5');
  const r = await runScript(['--to', WID, '--text', MSG, '--queue']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const log = path.join(stateDir, 'kitty-send', `queue-${WID}.log`);
  for (let i = 0; i < 120 && !/queued waiter exit rc=/.test(await fs.readFile(log, 'utf8').catch(() => '')); i++) await new Promise((res) => setTimeout(res, 200));
  const text = await fs.readFile(log, 'utf8');
  assert.doesNotMatch(text, /queued waiter exit rc=11/, text);
  assert.match(text, /queued waiter exit rc=0/, text);
  assert.ok((await calls()).includes('text') || (await calls()).includes('burst'), `typed: ${await calls()}`);
});

test('the proof is read at typing time: a draft that appears after the idle poll is not typed over', async () => {
  // The screen reads in order: the wait loop's dialog check (1), the pre-send
  // dialog check (2), the chokepoint (3). The draft shows from the third read on,
  // so only a proof run at the chokepoint can see it.
  await reset('burst');
  await put('screen', EMPTY);
  await put('screen_late', DRAFT);
  await put('late_at', '3');
  const r = await runScript(['--to', WID, '--text', MSG, '--wait-idle', '4', '--timeout', '4']);
  assert.equal(r.code, 11, `${r.out}${r.err}`);
  assert.match(r.err, /composer holds text/);
  assert.deepEqual(await calls(), []);
});

test('--now needs no empty-composer proof: it types onto a seat with a draft (documented in exit-codes.md)', async () => {
  await reset('burst');
  await put('screen', DRAFT);
  const r = await runScript(['--to', WID, '--text', MSG, '--now', '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['text']);
});

test('a missing typing proof (node or the module) refuses: exit 11 for an idle-claiming send and a plain one, nothing sent', async () => {
  for (const args of [['--wait-idle', '4'], []]) {
    await reset('burst');
    await put('screen', EMPTY);
    const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '4', ...args], { KITTY_SEND_TYPING_PROOF: '/nonexistent/typing-proof.mjs' });
    assert.equal(r.code, 11, `${args}: ${r.out}${r.err}`);
    assert.match(r.err, /typing proof .* is not available/);
    assert.deepEqual(await calls(), []);
  }
});

// ---- after the keystrokes are out, only 0, 3, 8 and 10 are possible exits ----
//
// A command that fails after the send would exit 1 under set -e, which
// agent-send reads as "nothing was sent" and re-queues: a double delivery. The
// stub `date` fails once the send-text stub has recorded a send.
test('a command failing after the send exits 3, never 1', async () => {
  await reset('burst');
  await put('screen', EMPTY);
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '4'], { KITTY_TEST_FAIL_DATE_AFTER: path.join(stateDir, 'sent') });
  assert.deepEqual(await calls(), ['text'], 'the keystrokes did go out');
  assert.equal(r.code, 3, `${r.out}${r.err}`);
});

// ---- kitty-send also delivers to pi and opencode tabs ----
//
// A tab with no Claude Code process has no composer the proof can read. The path
// before the chokepoint typed into it under the dialog check alone, and that is
// kept: --wait-idle and --queue must not refuse it as "not a Claude Code tab".
// (A Claude Code tab keeps the full proof; the tests above pin that.)
test('--wait-idle still types into a non-Claude-Code tab (the proof is dialog-only there)', async () => {
  await reset('burst');
  await put('nonclaude', '');
  const r = await runScript(['--to', WID, '--text', MSG, '--wait-idle', '4', '--timeout', '8']);
  assert.doesNotMatch(r.err, /typing proof did not pass|not a Claude Code tab/, `${r.out}${r.err}`);
  assert.notEqual(r.code, 11, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['burst'], 'the text must be typed in one burst, as before');
});

test('--queue still types into a non-Claude-Code tab once it is idle', async () => {
  await reset('burst');
  await put('nonclaude', '');
  const r = await runScript(['--to', WID, '--text', MSG, '--queue', '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const log = path.join(stateDir, 'kitty-send', `queue-${WID}.log`);
  for (let i = 0; i < 60 && !/queued waiter exit rc=/.test(await fs.readFile(log, 'utf8').catch(() => '')); i++) await new Promise((res) => setTimeout(res, 200));
  const text = await fs.readFile(log, 'utf8');
  assert.doesNotMatch(text, /typing proof did not pass|not a Claude Code tab/, text);
  assert.deepEqual(await calls(), ['burst'], text);
});

test('a non-Claude-Code tab with a dialog on screen is still not typed into (exit 5)', async () => {
  await reset('burst');
  await put('nonclaude', '');
  await put('screen', 'Which one?\n  Enter to select · ↑/↓ to navigate · Esc to cancel');
  const r = await runScript(['--to', WID, '--text', MSG, '--wait-idle', '2', '--timeout', '4']);
  assert.equal(r.code, 5, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), []);
});

// A slash command is typed with its \r in one call; the composer can swallow that
// \r and leave the command text in the box. The screen then changes (the echo),
// which used to be taken as proof. kitty-send now re-reads the composer and
// presses Enter again, a bounded number of times.
const live = async (mode) => {
  await reset(mode);
  await put('screen_dyn', '');
  await put('rule', RULE);
};

test('a slash command left in the composer by a swallowed \\r is submitted by another Enter', async () => {
  await live('enter');
  const r = await runScript(['--to', WID, '--text', '/rename x', '--wait-idle', '4', '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['burst', 'enter', 'enter'], 'the first extra Enter is swallowed, the second submits, no third');
  assert.equal(await fs.access(path.join(stateDir, 'composer')).then(() => true, () => false), false, 'the composer is empty');
});

test('a slash command no Enter can submit exits 16 after the bounded tries, never 0', async () => {
  await live('never');
  const r = await runScript(['--to', WID, '--text', '/rename x', '--wait-idle', '4', '--timeout', '8']);
  assert.equal(r.code, 16, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['burst', 'enter', 'enter', 'enter'], 'three extra Enters at most');
  assert.match(r.err, /typed, not proven submitted/);
});
