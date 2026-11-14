// One stub standing in for every binary fleet-drill.mjs drives: the launcher,
// the sender, the typing sender, tab-state, the typing proof, the store export,
// kitty, gh and the merge wrapper. The test writes a tiny shell wrapper per
// role (`exec node this-file <role> "$@"`). All state is files under STUB_DIR.
//
// STUB_BROKEN is a comma list of states the seat gets wrong on purpose:
//   slash  the carriage return of a slash command is swallowed (composer keeps it)
//   busy   a send onto a busy seat is typed in and discards the tool result
//   merge  the merge wrapper leaves the PR open
// Other knobs: STUB_PERMISSION_FIRST=1 (a tool call asks permission first, the
// screen shows the command), STUB_SCREEN_MISMATCH=1 (the screen shows another
// command), STUB_NEVER_BUSY=1, STUB_SEND_EXIT=<n> (agent-send exits n after
// writing its rows), STUB_CLOSED_MSG (agent-send's text for a missing window).
// The stubs refuse what the real scripts refuse: a flag that needs a value and
// has none, and `claude-tab --close` on a --seat window.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const [role, ...args] = process.argv.slice(2);
const dir = process.env.STUB_DIR;
const broken = new Set((process.env.STUB_BROKEN ?? '').split(',').filter(Boolean));
const P = (f) => path.join(dir, f);
const readJson = (f, d) => (fs.existsSync(P(f)) ? JSON.parse(fs.readFileSync(P(f), 'utf8')) : d);
const writeJson = (f, v) => fs.writeFileSync(P(f), JSON.stringify(v));
const WID = 7001;
const transcript = P('transcript.jsonl');
const seat = () => {
  const s = readJson('seat.json', { open: false, status: 'idle' });
  if (s.status === 'busy' && Date.now() >= s.busyUntil) {
    // The model composing a tool call reads busy, then the dialog appears.
    if (s.thenDialog) Object.assign(s, { status: 'waiting', approveTo: true, screen: s.thenDialog, thenDialog: null });
    else s.status = 'idle';
  }
  return s;
};
const save = (s) => writeJson('seat.json', s);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const needValue = (...names) => {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i >= 0 && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) {
      process.stderr.write(`${role}: ${n} needs a value\n`);
      process.exit(1);
    }
  }
};

if (role === 'claude-tab') {
  if (args[0] === '--close') {
    if (seat().seat) {
      process.stderr.write(`claude-tab: window ${args[1]} was not launched by this script - refusing to close it.\n`);
      process.exit(1);
    }
    save({ ...seat(), open: false });
    process.exit(0);
  }
  writeJson('launch-env.json', { dir: process.env.AGENT_SWITCHBOARD_DIR, db: process.env.AGENT_SWITCHBOARD_DB });
  // What the real seat would read from its folder before its first turn.
  const settings = path.join(flag('--cwd') ?? '', '.claude', 'settings.local.json');
  if (fs.existsSync(settings)) fs.copyFileSync(settings, P('launch-settings.json'));
  needValue('--title', '--model', '--cwd', '--brief');
  if (args.includes('--brief') && !fs.existsSync(flag('--brief'))) process.exit(1);
  fs.writeFileSync(transcript, '');
  save({ open: true, status: 'idle', seat: args.includes('--seat') });
  console.log(`WINDOW_ID=${WID}`);
} else if (role === 'kitty') {
  if (args[0] === '@' && args[1] === 'ls') console.log('[]');
  if (args[0] === '@' && args[1] === 'close-window') {
    needValue('--match');
    if (process.env.STUB_CLOSE_FAIL) process.exit(3);
    save({ ...seat(), open: false });
  }
  if (args[0] === '@' && args[1] === 'get-text') {
    const s = seat();
    console.log(s.screen ?? '');
  }
  if (args[0] === '@' && args[1] === 'send-text') {
    needValue('--match');
    const s = seat();
    const keys = args[args.length - 1];
    if (s.status === 'waiting' && keys === '\\r' && s.approveTo) save({ ...s, status: 'busy', busyUntil: Date.now() + 4000, screen: '' });
    else if (s.status === 'waiting') {
      save({ ...s, status: 'idle', screen: '' });
      // The real agent-send queues a message while a selection dialog is open. A
      // hook delivers it when the turn goes on (the prompt was approved); after an
      // Escape the seat sits idle and the queued row is never delivered (measured).
      if (keys !== '\\r') process.exit(0);
      const rows = readJson('store.json', []);
      const pending = rows.filter((r) => r.id && r.queuedForDialog && !rows.some((a) => a.ack === r.id));
      for (const m of pending) rows.push({ recipient: 'k', ack: m.id, ts: new Date().toISOString(), deliveredAs: process.env.STUB_QUEUED_ACK ?? 'tool' });
      writeJson('store.json', rows);
    }
  }
} else if (role === 'tab-state') {
  const s = seat();
  // The real script takes a numeric window id: anything else is a usage error
  // (exit 1, "usage" on stderr), and an id kitty does not list is "no such window".
  if (!/^\d+$/.test(args[0] ?? '')) {
    process.stderr.write('tab-state: usage: tab-state.sh <window-id> [--json] [--watch [--interval=S]]\n');
    process.exit(1);
  }
  if (Number(args[0]) !== WID && s.open) {
    process.stderr.write(`tab-state: no such window: ${args[0]} (try opencode-tab.sh --list)\n`);
    process.exit(1);
  }
  if (process.env.STUB_TABSTATE_GARBAGE && !s.open) {
    process.stderr.write('tab-state: boom\n');
    process.exit(2);
  }
  if (process.env.STUB_TABSTATE_UNAVAILABLE && !s.open) {
    process.stderr.write('tab-state: kitty remote control unavailable (is this a kitty terminal with allow_remote_control on?)\n');
    process.exit(1);
  }
  if (!s.open) {
    // Without --watch the real tab-state.sh prints only this on stderr, nothing
    // on stdout, exit 1 (tests/fleet-drill.test.mjs compares it with the real script).
    process.stderr.write(`tab-state: no such window: ${WID} (try opencode-tab.sh --list)\n`);
    process.exit(1);
  }
  const waiting = s.status === 'waiting';
  console.log(JSON.stringify({
    window: WID,
    state: waiting ? 'unknown' : s.status,
    reason: waiting ? 'claude-status-waiting' : '',
    session: transcript,
  }));
} else if (role === 'kitty-send') {
  needValue('--to', '--text', '--wait-idle');
  const text = flag('--text') ?? '';
  const s = seat();
  const m = /DRILL-'\+6\*7\+'-(\w+)/.exec(text);
  // What Claude Code draws: the echo of the typed prompt (it names the command
  // whatever the model then proposes), then the dialog with its own command.
  const echo = `❯ ${text}`;
  // The dialog screens are fixtures: ruled is a real seat's screen (captured by a live
  // drill run, command and echo replaced by placeholders); unruled is the other recorded
  // layout, without dashed rules. STUB_LAYOUT picks one.
  const fixture = fs.readFileSync(new URL(`../fixtures/permission-dialog-${process.env.STUB_LAYOUT || 'ruled'}.txt`, import.meta.url), 'utf8');
  // STUB_WRAP: a narrow window wraps the command over two lines inside the dialog.
  const wrap = (c) => (process.env.STUB_WRAP ? `${c.slice(0, 20)}\n ${c.slice(20)}` : c);
  const dialog = (proposed) => fixture
    .replace(/^ \{\{CMD\}\}$/m, () => ` ${wrap(proposed)}`)
    .replaceAll('{{ECHO}}', () => echo)
    .replaceAll('{{RULE}}', () => (proposed.startsWith('touch') ? 'Bash(touch fleet-drill-*)' : 'Bash(node -e:*)'))
    .replaceAll('{{CMD}}', () => proposed);
  const other = process.env.STUB_DIALOG_OTHER; // a different dialog under the same echo
  if (m && process.env.STUB_NEVER_BUSY) {
    // typed, nothing happens
  } else if (m) {
    // Default permission mode: the timer prompts, approval (Enter) starts it.
    const nodeCmd = /node -e .*/.exec(text)[0];
    const screen = process.env.STUB_SCREEN_MISMATCH ? dialog('rm -rf /')
      : process.env.STUB_SCREEN_MULTI ? dialog(`${nodeCmd}\n  rm -rf x`) : dialog(nodeCmd);
    if (process.env.STUB_AUTORUN) {
      // No dialog: the tool_use row is in the transcript, the call has no result yet.
      save({ ...s, status: 'busy', busyUntil: Date.now() + 1500, screen: '' });
      fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: `DRILL-${m[1]}` } }] } })}\n`);
      process.exit(0);
    }
    if (process.env.STUB_THINK) save({ ...s, status: 'busy', busyUntil: Date.now() + 1500, thenDialog: screen, screen: '' });
    else save({ ...s, status: 'waiting', approveTo: true, screen });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: `DRILL-42-${m[1]}` }] } })}\n`);
  } else if (text.includes('touch ')) {
    const cmd = /touch \S+/.exec(text)[0];
    const screen = other === 'write' ? `${echo}\n● Write(notes.txt)\n Create file\n  notes.txt\n Do you want to create notes.txt?\n ❯ 1. Yes\n   2. No\n`
      : dialog(other === 'bash' ? `${cmd} && rm -rf x` : other === 'multi' ? `${cmd}\n  rm -rf x` : cmd);
    save({ ...s, status: 'waiting', approveTo: false, screen });
  } else if (text.includes('gh pr create')) {
    writeJson('pr.json', { open: true });
  }
} else if (role === 'agent-send') {
  const s = seat();
  const text = flag('--text') ?? '';
  if (!s.open) {
    process.stderr.write(`agent-send: ${process.env.STUB_CLOSED_MSG ?? `no kitty window with id ${WID}`}\n`);
    process.exit(1);
  }
  needValue('--to', '--text');
  let deliveredAs = 'prompt';
  if (s.status === 'waiting') {
    // Not typed into the dialog: queued, exit 3 (pending), acked after the dialog clears.
    const id = randomUUID();
    const rows = readJson('store.json', []);
    rows.push({ recipient: 'k', id, ts: new Date().toISOString(), from: 'x', to: 'k', priority: 'now', text, queuedForDialog: true });
    writeJson('store.json', rows);
    process.stderr.write(`agent-send: queued for ${WID} (not typed: selection dialog open), delivered only after the seat clears its selection dialog (id ${id}; exit 3: pending, do not resend)\n`);
    process.exit(3);
  }
  if (s.status === 'busy') {
    deliveredAs = broken.has('busy') ? 'typed' : 'tool';
    if (broken.has('busy')) fs.writeFileSync(transcript, '');
  } else if (s.status === 'waiting') {
    deliveredAs = 'tool';
  } else if (text.startsWith('/')) {
    deliveredAs = 'typed';
    if (broken.has('slash')) save({ ...s, composerStuck: true });
  }
  const id = randomUUID();
  const ts = new Date().toISOString();
  const rows = readJson('store.json', []);
  rows.push({ recipient: 'k', id, ts, from: 'x', to: 'k', priority: 'now', text });
  rows.push({ recipient: 'k', ack: id, ts, deliveredAs });
  writeJson('store.json', rows);
  if (process.env.STUB_SEND_EXIT) process.exit(Number(process.env.STUB_SEND_EXIT));
} else if (role === 'typing-proof') {
  const s = seat();
  process.exit(s.composerStuck || s.status !== 'idle' ? 2 : 0);
} else if (role === 'export') {
  console.log(JSON.stringify(readJson('store.json', [])));
} else if (role === 'gh') {
  if (args[0] === 'pr' && args[1] === 'list') {
    const tok = flag('--search') ?? '';
    console.log(JSON.stringify(readJson('pr.json', null) ? [{ number: 42, title: tok }] : []));
  } else if (args[0] === 'pr' && args[1] === 'view') {
    console.log(JSON.stringify({ state: readJson('pr.json', {}).merged ? 'MERGED' : 'OPEN' }));
  }
} else if (role === 'merge') {
  if (!broken.has('merge')) writeJson('pr.json', { open: false, merged: true });
  writeJson('merge-args.json', { args, env: process.env.FLEET_DRILL_SANDBOX });
} else {
  process.stderr.write(`stub: unknown role ${role}\n`);
  process.exit(99);
}
