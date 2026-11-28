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
import * as BG from './fixtures/claude-background-screens.mjs';

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
    // title_after_send: the title the live window shows once keystrokes have
    // gone out (a turn starts), so a read after `sent` must not be served the
    // title the window had before the send.
    `  @/ls) if [ -f "$state/nonclaude" ]; then printf '%s\\n' ${JSON.stringify(lsJson)} | sed 's/"cmdline":\\["claude"\\]/"cmdline":["pi"]/'; elif [ -f "$state/title_after_send" ] && [ -f "$state/sent" ]; then printf '%s\\n' ${JSON.stringify(lsJson)} | sed "s/✳ Claude Code/$(cat "$state/title_after_send")/"; elif [ -f "$state/title" ]; then printf '%s\\n' ${JSON.stringify(lsJson)} | sed "s/✳ Claude Code/$(cat "$state/title")/"; else printf '%s\\n' ${JSON.stringify(lsJson)}; fi ;;`,
    '  @/send-text)',
    '    text="${@: -1}"',
    '    [ -f "$state/sent" ] || cat "$state/reads" > "$state/sent_at" 2>/dev/null',
    '    : > "$state/sent"',
    '    if [ -f "$state/waiting_at" ]; then',
    '      if [ "$(cat "$state/waiting_at")" = text ] || [ "$text" = $\'\\r\' ]; then cp "$state/waiting_record" "$(cat "$state/record_path")"; fi',
    '    fi',
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
    '    if [ -f "$state/after_enter" ] && grep -q enter "$state/calls" 2>/dev/null; then cat "$state/after_enter"',
    '    elif [ -f "$state/after_text" ] && [ -f "$state/sent" ]; then cat "$state/after_text"',
    '    elif [ -f "$state/screen_late" ] && [ "$n" -ge "$(cat "$state/late_at")" ]; then cat "$state/screen_late"',
    '    elif [ -f "$state/screen_dyn" ]; then',
    '      # a live composer: typed text sits in the box until a lone \\r submits it, then the command shows its effect',
    '      rule=$(cat "$state/rule")',
    '      if [ -f "$state/composer" ]; then printf \'%s\\n\' "● Done." "" "$rule" "❯ $(cat "$state/composer")" "$rule" "  ⏵⏵ bypass permissions on · 1 shell"; [ -f "$state/dialog_after_send" ] && echo "  Enter to select · Esc to cancel"',
    '      elif [ -f "$state/sent" ]; then printf \'%s\\n\' "● Done." "● Renamed." "" "$rule" "❯ " "$rule" "  ⏵⏵ bypass permissions on · 1 shell"',
    '      else printf \'%s\\n\' "● Done." "" "$rule" "❯ " "$rule" "  ⏵⏵ bypass permissions on · 1 shell"; fi',
    '    elif [ -f "$state/screen" ]; then cat "$state/screen"',
    "    else printf '%s\\n' '● Done.' '' '────────────' '❯\u00a0' '────────────' '  ? for shortcuts'; fi ;;",
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
  for (const f of ['calls', 'composer', 'eat', 'title', 'title_after_send', 'screen', 'screen_dyn', 'dialog_after_send', 'screen_late', 'late_at', 'reads', 'sent', 'nonclaude', 'after_text', 'after_enter', 'waiting_at']) await fs.rm(path.join(stateDir, f), { force: true });
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

test('a busy Claude tab accepts --now and still gets the submission Enter', async () => {
  await reset('enter', 'busy');
  const r = await runScript(['--to', WID, '--text', MSG, '--now', '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /proved by transcript row/);
  assert.deepEqual(await calls(), ['text', 'enter']);
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

// `busy` also covers a finished turn while background agents still work: the
// seat waits at an empty prompt (fixtures/claude-background-screens.mjs). Its
// screen says so, and that seat is sendable; its own turn is not, and a dialog
// raised meanwhile is refused in every mode.
for (const flags of [[], ['--wait-idle', '4']]) {
  const how = flags[0] ?? 'no mode flag';
  test(`(a) a busy-record Claude tab at its prompt with only background agents is sent to with ${how}`, async () => {
    await reset('burst', 'busy');
    await fs.writeFile(path.join(stateDir, 'screen'), BG.BACKGROUND_AT_PROMPT);
    const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '8', ...flags]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.deepEqual(await calls(), ['text']);
  });
  test(`(b) a busy-record Claude tab in its own turn with background agents is not sent to with ${how}`, async () => {
    await reset('burst', 'busy');
    await fs.writeFile(path.join(stateDir, 'screen'), BG.OWN_TURN_WITH_BACKGROUND);
    const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '4', ...flags.map((f) => (f === '4' ? '2' : f))]);
    assert.notEqual(r.code, 0, `${r.out}${r.err}`);
    if (flags.length === 0) assert.equal(r.code, 7, `${r.out}${r.err}`);
    else assert.match(r.err, /still busy/);
    assert.deepEqual(await calls(), []);
  });
}
for (const flags of [[], ['--now'], ['--wait-idle', '2']]) {
  test(`(c) a Claude tab showing a question while background agents run is refused with ${flags.join(' ') || 'no mode flag'}, nothing sent`, async () => {
    await reset('burst', 'waiting');
    await fs.writeFile(path.join(stateDir, 'screen'), BG.QUESTION_WITH_BACKGROUND);
    const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '4', ...flags]);
    assert.notEqual(r.code, 0, `${r.out}${r.err}`);
    assert.deepEqual(await calls(), []);
  });
}

// A background agent's permission prompt over an idle main prompt: the record
// can read busy, idle or shell, and the answer to a dialog is a key press made
// in the window, never typed text: exit 4, nothing sent, "1" included.
for (const screen of ['SUBAGENT_DIALOG_AT_IDLE_PROMPT', 'SUBAGENT_DIALOG_LONG_PANEL', 'SUBAGENT_DIALOG_NBSP_FOOTER']) {
  for (const status of ['busy', 'idle']) {
    test(`(c) --now "1" into a background agent's dialog (${screen}, record ${status}) is refused, nothing sent`, async () => {
      await reset('burst', status);
      await fs.writeFile(path.join(stateDir, 'screen'), BG[screen]);
      const r = await runScript(['--to', WID, '--text', '1', '--timeout', '4', '--now']);
      assert.equal(r.code, 4, `${r.out}${r.err}`);
      assert.deepEqual(await calls(), []);
    });
  }
}

// ---- a command that ends the conversation never reaches a seat with background work ----
// /exit and /quit would end that work, /clear and /new (and their alias /reset)
// wipe the conversation waiting on it. Exit 23, as --retire and --close give.
const QUEUE_LOG = () => path.join(stateDir, 'kitty-send', `queue-${WID}.log`);
const queueLog = () => fs.readFile(QUEUE_LOG(), 'utf8').catch(() => '');
const waiterEnded = async () => {
  for (let i = 0; i < 100; i += 1) {
    if (/queued waiter exit rc=/.test(await queueLog())) return;
    await new Promise((res) => setTimeout(res, 100));
  }
};
const FAST_POLL = { KITTY_SEND_POLL_MS: '100', KITTY_SEND_POLL_CAP_MS: '100' };
const sendText = async (text, flags, env = {}) => {
  await fs.rm(QUEUE_LOG(), { force: true });
  const r = await runScript(['--to', WID, '--text', text, '--timeout', '2', ...flags], { ...FAST_POLL, ...env });
  if (flags.includes('--queue') && r.code === 0) await waiterEnded();
  return r;
};
const onBackground = async (status = 'busy', screen = BG.BACKGROUND_AT_PROMPT) => {
  await reset('burst', status);
  await fs.writeFile(path.join(stateDir, 'screen'), screen);
  await fs.writeFile(path.join(stateDir, 'after_text'), BG.BACKGROUND_AT_PROMPT_TITLED); // a screen change proves a slash send
};
const refused23 = async (r) => {
  assert.deepEqual(await calls(), [], `${r.out}${r.err}`);
  assert.equal(r.code, 23, `${r.out}${r.err}`);
  assert.match(r.err, /background/);
};
const SEND_PATHS = [['bare', []], ['--queue', ['--queue', '--deadline', '4']], ['--queue with no bound', ['--queue']], ['--now', ['--now']], ['--wait-idle', ['--wait-idle', '4']], ['--idle-when', ['--idle-when', 'bypass permissions']]];

for (const command of ['/exit', '/quit', '/clear', '/new']) {
  for (const [how, flags] of SEND_PATHS) {
    test(`(d) ${command} (${how}) to a seat idle only by background work exits 23, nothing typed`, async () => {
      await onBackground();
      await refused23(await sendText(command, flags));
    });
  }
}
for (const text of [
  '/exit now', '/quit please', '/clear my notes', '/new topic', '  /exit  ', '\t/clear\t', ' /quit ', '/Exit', '/reset',
  'exit', 'quit', ':q', ':q!', ':wq', ':wq!', ' exit ', // Claude Code runs these bare words as /exit
]) {
  test(`(d) ${JSON.stringify(text)} to a seat idle only by background work exits 23, nothing typed`, async () => {
    await onBackground();
    await refused23(await sendText(text, []));
  });
}
for (const [how, flags] of SEND_PATHS) {
  test(`(d) /exit (${how}) to a seat whose background shell runs (status shell) exits 23, nothing typed`, async () => {
    await reset('burst', 'shell');
    await refused23(await sendText('/exit', flags));
  });
}
test('(d) --expect does not get /exit past the refusal', async () => {
  await onBackground();
  await refused23(await sendText('/exit', ['--expect', 'Bye']));
});
test('(d) --now /exit into its own turn with background work exits 23: the steering queue would run it later', async () => {
  await onBackground('busy', BG.OWN_TURN_WITH_BACKGROUND);
  await refused23(await sendText('/exit', ['--now']));
});
test('(d) a bounded --queue waiter does not fire /exit into a seat that became idle by background work', async () => {
  await onBackground('busy', BG.OWN_TURN_WITH_BACKGROUND);
  await fs.rm(QUEUE_LOG(), { force: true });
  const r = await runScript(['--to', WID, '--text', '/exit', '--timeout', '2', '--queue', '--deadline', '8'], FAST_POLL);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  await fs.writeFile(path.join(stateDir, 'screen'), BG.BACKGROUND_AT_PROMPT);
  await waiterEnded();
  assert.deepEqual(await calls(), [], await queueLog());
  assert.match(await queueLog(), /queued waiter exit rc=23/);
});
test('(d) an unbounded --queue waiter holds /exit through background work and sends it once truly idle', async () => {
  await onBackground('busy', BG.OWN_TURN_WITH_BACKGROUND);
  await fs.rm(QUEUE_LOG(), { force: true });
  const r = await runScript(['--to', WID, '--text', '/exit', '--timeout', '2', '--queue'], FAST_POLL);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  await fs.writeFile(path.join(stateDir, 'screen'), BG.BACKGROUND_AT_PROMPT);
  await new Promise((res) => setTimeout(res, 3000));
  const early = await calls();
  const running = !/queued waiter exit rc=/.test(await queueLog());
  await fs.writeFile(path.join(claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SID, cwd: CWD, status: 'idle' }));
  await fs.rm(path.join(stateDir, 'screen'));
  await waiterEnded();
  assert.deepEqual(early, [], 'nothing typed while only background work ran');
  assert.ok(running, 'the waiter held the command rather than dropping it');
  assert.deepEqual(await calls(), ['burst'], await queueLog());
});
// Controls: everything else keeps the delivery.
for (const text of [MSG, '/rename x']) {
  for (const [how, flags] of SEND_PATHS) {
    test(`(d) control: ${JSON.stringify(text.slice(0, 20))} (${how}) still reaches a seat idle only by background work`, async () => {
      await onBackground();
      const r = await sendText(text, flags);
      assert.equal(r.code, 0, `${r.out}${r.err}`);
      assert.ok((await calls()).length > 0, `${r.err}${await queueLog()}`);
    });
  }
}
for (const text of ['/newer', '/clear-cache', '/exit-plan', 'exit the loop when the tests pass', 'please run /exit later']) {
  test(`(d) control: ${JSON.stringify(text)} is no ending command and is delivered`, async () => {
    await onBackground();
    const r = await sendText(text, []);
    assert.notEqual(r.code, 23, `${r.out}${r.err}`);
    assert.ok((await calls()).length > 0, r.err);
  });
}
for (const [how, flags] of SEND_PATHS) {
  test(`(d) control: /exit (${how}) still works on a truly idle seat`, async () => {
    await reset('burst');
    await fs.writeFile(path.join(stateDir, 'screen_dyn'), '');
    await fs.writeFile(path.join(stateDir, 'rule'), '─'.repeat(60));
    const r = await sendText('/exit', flags);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.deepEqual(await calls(), ['burst'], await queueLog());
  });
}
test('(d) control: --now /exit into its own turn with no background work is sent, as before', async () => {
  const rule = '─'.repeat(60);
  await onBackground('busy', ['✢ Working… (8s)', '', rule, BG.EMPTY_PROMPT, rule, '  esc to interrupt'].join('\n'));
  const r = await sendText('/exit', ['--now']);
  assert.notEqual(r.code, 23, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['burst'], r.err);
});

// ---- a compacting, mid-turn or drafted seat is never read as at its prompt ----
for (const flags of [[], ['--wait-idle', '2']]) {
  const how = flags[0] ?? 'no mode flag';
  for (const [name, screen] of [
    ['screen A, compacting with a draft', BG.COMPACTING_WITH_DRAFT],
    ['screen B, compacting with a clipped footer', BG.COMPACTING_CLIPPED],
    ['screen C, a spinner above a task list with a draft', BG.SPINNER_ABOVE_TASKS_WITH_DRAFT],
    ['a draft under the waiting line', BG.WAITING_WITH_DRAFT],
    ['only the esc hint', BG.ONLY_ESC_HINT['esc on the first line']],
    ['only a spinner line', BG.ONLY_SPINNER['a multi-word label']],
    ['only a clipped footer', BG.ONLY_FOOTER_UNPROVEN['clipped after the task count']],
    ['only a draft', BG.ONLY_DRAFT['a draft']],
  ]) {
    test(`(b) ${name}: ${how} types nothing`, async () => {
      await reset('burst', 'busy');
      await fs.writeFile(path.join(stateDir, 'screen'), screen);
      const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '3', ...flags]);
      assert.equal(r.code, flags.length === 0 ? 7 : 5, `${r.out}${r.err}`);
      assert.deepEqual(await calls(), []);
    });
  }
}

for (const [name, flags] of [['--now', ['--now']], ['--idle-when', ['--idle-when', 'bypass permissions']]]) {
  for (const [what, screen] of [
    ['a draft under the waiting line', BG.WAITING_WITH_DRAFT],
    ['a draft in a compacting seat', BG.COMPACTING_WITH_DRAFT],
    ['a composer that cannot be parsed', BG.ONLY_DRAFT['a composer row that cannot be parsed']],
  ]) {
    test(`(b) ${name} never submits ${what}: exit 11, nothing sent`, async () => {
      await reset('burst', 'busy');
      await fs.writeFile(path.join(stateDir, 'screen'), screen);
      const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '3', ...flags]);
      assert.equal(r.code, 11, `${r.out}${r.err}`);
      assert.deepEqual(await calls(), []);
    });
  }
}

test('(b) a draft typed after the busy check is not submitted by a bare send', async () => {
  // The draft appears at the n-th screen read; one n is the chokepoint's own read.
  let refused = false;
  for (let at = 2; at <= 8 && !refused; at += 1) {
    await reset('burst', 'busy');
    await fs.writeFile(path.join(stateDir, 'screen'), BG.BACKGROUND_AT_PROMPT);
    await fs.writeFile(path.join(stateDir, 'screen_late'), BG.ONLY_DRAFT['a draft']);
    await fs.writeFile(path.join(stateDir, 'late_at'), String(at));
    const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '2']);
    if (r.code !== 11) continue;
    assert.match(r.err, /composer holds text/);
    assert.deepEqual(await calls(), []);
    refused = true;
  }
  assert.ok(refused, 'no read refused the late draft');
});

test('(b) an unbounded waiter with --idle-when waits a draft out instead of dropping the send', async () => {
  await reset('burst', 'busy');
  await fs.writeFile(path.join(stateDir, 'screen'), BG.ONLY_DRAFT['a draft']);
  await fs.writeFile(path.join(stateDir, 'screen_late'), BG.BACKGROUND_AT_PROMPT);
  await fs.writeFile(path.join(stateDir, 'late_at'), '14');
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '3', '--idle-when', 'bypass permissions'], { KITTY_SEND_WAIT_UNBOUNDED: '1', KITTY_SEND_POLL_MS: '100', KITTY_SEND_POLL_CAP_MS: '100' });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['text']);
  const typedAt = Number(await fs.readFile(path.join(stateDir, 'sent_at'), 'utf8'));
  assert.ok(typedAt >= 14, `typed at screen read ${typedAt}, while the draft was there`);
});

// ---- a message never approves a prompt that opened after it was typed --------
const promptAfter = async (when, { screen, waiting = false } = {}) => {
  await fs.writeFile(path.join(stateDir, 'screen'), BG.BACKGROUND_AT_PROMPT);
  if (screen != null) await fs.writeFile(path.join(stateDir, `after_${when}`), screen);
  if (waiting) {
    await fs.writeFile(path.join(stateDir, 'record_path'), path.join(claudeDir, 'sessions', `${process.pid}.json`));
    await fs.writeFile(path.join(stateDir, 'waiting_record'), JSON.stringify({ pid: process.pid, sessionId: SID, cwd: CWD, status: 'waiting' }));
    await fs.writeFile(path.join(stateDir, 'waiting_at'), when);
  }
};
const PROMPTS = [
  ['a permission prompt with the record still busy', { screen: BG.PERMISSION_PROMPT }],
  ['a permission prompt without its footer', { screen: BG.PERMISSION_PROMPT_NO_FOOTER }],
  ['a waiting record over a screen not yet redrawn', { waiting: true }],
];
for (const [name, opts] of PROMPTS) {
  for (const flags of [[], ['--now'], ['--wait-idle', '4']]) {
    test(`(c) ${name}, opened after the text, gets no Enter (${flags[0] ?? 'no mode flag'})`, async () => {
      await reset('enter', 'busy');
      await promptAfter('text', opts);
      const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '4', ...flags]);
      assert.deepEqual(await calls(), ['text'], 'an Enter would have selected Yes');
      assert.equal(r.code, 3, `${r.out}${r.err}`);
      assert.match(r.err, /Enter withheld/);
    });
  }
  test(`(c) ${name}, opened after the first Enter, gets no second one`, async () => {
    await reset('eat1', 'busy');
    await promptAfter('enter', opts);
    const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '5']);
    assert.deepEqual(await calls(), ['text', 'enter'], 'the retry would have selected Yes');
    assert.equal(r.code, 3, `${r.out}${r.err}`);
    assert.match(r.err, /Enter withheld/);
  });
}

test('(c) a chip gets no Enter under a prompt, in a window with no session record', async () => {
  await reset('never');
  await fs.writeFile(path.join(stateDir, 'nonclaude'), '');
  await fs.writeFile(path.join(stateDir, 'after_text'), `[Pasted text #1 +2 lines]\n${BG.PERMISSION_PROMPT}`);
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '3']);
  assert.deepEqual(await calls(), ['burst'], 'the chip Enter would have selected Yes');
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /Enter withheld/);
});

test('(c) the stranded-chip recovery presses no Enter without a composer on the screen', async () => {
  await reset('never');
  await fs.rm(path.join(claudeDir, 'sessions', `${process.pid}.json`));
  await fs.writeFile(path.join(stateDir, 'screen'), `[Pasted text #1 +2 lines]\n${BG.PERMISSION_PROMPT_NO_FOOTER}`);
  const record = path.join(stateDir, 'kitty-send-stranded', `stranded-${WID}`);
  await fs.mkdir(path.dirname(record), { recursive: true });
  await fs.writeFile(record, `pid=${process.pid}\ncreated=\ntime=1\nchips=1 \n`);
  try {
    const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '2']);
    assert.deepEqual(await calls(), []);
    assert.equal(r.code, 11, `${r.out}${r.err}`);
    assert.match(r.err, /Enter withheld/);
  } finally {
    await fs.rm(record, { force: true });
  }
});

test('(a) the Enter still follows text typed to a background-idle seat', async () => {
  await reset('enter', 'busy');
  await fs.writeFile(path.join(stateDir, 'screen'), BG.BACKGROUND_AT_PROMPT);
  await fs.writeFile(path.join(stateDir, 'after_text'), BG.typedInto(MSG));
  const r = await runScript(['--to', WID, '--text', MSG, '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['text', 'enter']);
});

for (const [status, flags] of [['idle', []], ['busy', ['--now']]]) {
  test(`(c) a slash command, whose Enter goes with its text, needs a composer on the screen (${status}${flags.length ? ' --now' : ''})`, async () => {
    await reset('burst', status);
    await fs.writeFile(path.join(stateDir, 'screen'), BG.PERMISSION_PROMPT_NO_FOOTER);
    const r = await runScript(['--to', WID, '--text', '/rename x', ...flags, '--timeout', '2']);
    assert.deepEqual(await calls(), [], 'its Enter would have selected Yes');
    assert.equal(r.code, 11, `${r.out}${r.err}`);
  });
}

test('(c) the slash retry gets no Enter once the record says waiting', async () => {
  await reset('never');
  await fs.writeFile(path.join(stateDir, 'screen_dyn'), '');
  await fs.writeFile(path.join(stateDir, 'rule'), '─'.repeat(40));
  await fs.writeFile(path.join(stateDir, 'record_path'), path.join(claudeDir, 'sessions', `${process.pid}.json`));
  await fs.writeFile(path.join(stateDir, 'waiting_record'), JSON.stringify({ pid: process.pid, sessionId: SID, cwd: CWD, status: 'waiting' }));
  await fs.writeFile(path.join(stateDir, 'waiting_at'), 'text');
  const r = await runScript(['--to', WID, '--text', '/rename x', '--timeout', '4']);
  assert.deepEqual(await calls(), ['burst'], 'no extra Enter');
  assert.equal(r.code, 16, `${r.out}${r.err}`);
});

test('a busy Claude tab parked by --idle-when remains pending, not falsely delivered', async () => {
  await reset('never', 'busy');
  await fs.writeFile(path.join(stateDir, 'screen'), 'Bíð eftir næsta skilaboði.\n');
  const r = await runScript([
    '--to', WID, '--text', MSG, '--idle-when', 'Bíð eftir næsta', '--timeout', '2',
  ]);
  assert.equal(r.code, 8, `${r.out}${r.err}`);
  assert.match(r.err, /pending in its steering queue/);
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

// A bad KITTY_SEND_SLASH_ENTER_TRIES must not turn the bounded loop into an
// unbounded one (a non-numeric value makes the numeric comparison always false):
// anything but a non-negative integer falls back to the default of 3.
for (const bad of ['abc', '-1', '2x', '']) {
  test(`KITTY_SEND_SLASH_ENTER_TRIES="${bad}" falls back to 3 tries, then exit 16`, async () => {
    await live('never');
    const r = await runScript(['--to', WID, '--text', '/rename x', '--wait-idle', '4', '--timeout', '8'], { KITTY_SEND_SLASH_ENTER_TRIES: bad });
    assert.equal(r.code, 16, `${r.out}${r.err}`);
    assert.deepEqual(await calls(), ['burst', 'enter', 'enter', 'enter']);
  });
}

// The retry presses Enter only when it is safe and needed.
test('a slash command whose first \\r submits gets no extra Enter', async () => {
  await live('burst');
  const r = await runScript(['--to', WID, '--text', '/rename x', '--wait-idle', '4', '--timeout', '8']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['burst']);
});

test('no extra Enter while a dialog footer is on the screen (an Enter would answer it)', async () => {
  await live('never');
  await put('dialog_after_send', '');
  const r = await runScript(['--to', WID, '--text', '/rename x', '--now', '--timeout', '3']);
  assert.notEqual(r.code, 16, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['burst']);
});

test('no extra Enter once the title shows a running turn (the command was submitted)', async () => {
  await live('never');
  await put('title', '⠋ Claude Code');
  const r = await runScript(['--to', WID, '--text', '/rename x', '--now', '--timeout', '3']);
  assert.notEqual(r.code, 16, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['burst']);
});

// The spinner read decides whether a second Enter is sent, so it reads fresh:
// with the cache on, a title cached before the send shows no spinner and the
// second Enter must still be withheld. Reverting `fresh` on that read passes
// every other test and fails this one.
test('the spinner read is fresh: a title cached before the send does not hide the running turn', async () => {
  const ttl = { AGENT_KITTY_LS_TTL_MS: '60000' };
  const KITTY_LS = fileURLToPath(new URL('../lib/kitty-ls.mjs', import.meta.url));
  const primeEnv = isolatedEnv({ ...ttl, PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir, KITTY_WINDOW_ID: WID });
  await live('never');
  // --fresh: replace any entry an earlier test in this file left cached.
  const primed = await run(process.execPath, [KITTY_LS, '--match', `id:${WID}`, '--fresh'], { env: primeEnv });
  assert.doesNotMatch(primed.stdout, /⠋/, 'the cache holds the idle title');
  await put('title_after_send', '⠋ Claude Code');
  // The cache still answers the idle title: the fresh read after the send is
  // what must see the spinner, not the cache.
  const cached = await run(process.execPath, [KITTY_LS, '--match', `id:${WID}`], { env: primeEnv });
  assert.match(cached.stdout, /✳ Claude Code/, 'a non-fresh read is served from the cache');
  const r = await runScript(['--to', WID, '--text', '/rename x', '--now', '--timeout', '3'], ttl);
  assert.notEqual(r.code, 16, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['burst'], `no extra Enter: the fresh title shows the turn already runs. ${r.out}${r.err}`);
});

test('a tab that is not Claude Code gets no extra Enter', async () => {
  await live('never');
  await put('nonclaude', '');
  const r = await runScript(['--to', WID, '--text', '/rename x', '--now', '--timeout', '3']);
  assert.notEqual(r.code, 16, `${r.out}${r.err}`);
  assert.deepEqual(await calls(), ['burst']);
});
