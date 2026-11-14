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
  if (s.status === 'busy' && Date.now() >= s.busyUntil) s.status = 'idle';
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
    else if (s.status === 'waiting') save({ ...s, status: 'idle' });
  }
} else if (role === 'tab-state') {
  const s = seat();
  if (process.env.STUB_TABSTATE_GARBAGE && !s.open) {
    process.stderr.write('tab-state: boom\n');
    process.exit(2);
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
  const m = /DRILL-\$\(\(6\*7\)\)-(\w+)/.exec(text);
  if (m && process.env.STUB_NEVER_BUSY) {
    // typed, nothing happens
  } else if (m && process.env.STUB_PERMISSION_FIRST) {
    save({ ...s, status: 'waiting', approveTo: true, screen: process.env.STUB_SCREEN_MISMATCH ? 'rm -rf /' : `Bash(sleep 45 && echo DRILL-$((6*7))-${m[1]})` });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: `DRILL-42-${m[1]}` }] } })}\n`);
  } else if (m) {
    save({ ...s, status: 'busy', busyUntil: Date.now() + 4000 });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: `DRILL-42-${m[1]}` }] } })}\n`);
  } else if (text.includes('touch ')) {
    save({ ...s, status: 'waiting' });
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
