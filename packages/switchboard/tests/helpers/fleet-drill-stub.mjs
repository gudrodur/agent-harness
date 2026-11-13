// One stub standing in for every binary fleet-drill.mjs drives: the launcher,
// the sender, the typing sender, tab-state, the typing proof, the store export,
// kitty, gh and the merge wrapper. The test writes a tiny shell wrapper per
// role (`exec node this-file <role> "$@"`). All state is files under STUB_DIR.
//
// STUB_BROKEN is a comma list of states the seat gets wrong on purpose:
//   slash  the carriage return of a slash command is swallowed (composer keeps it)
//   busy   a send onto a busy seat is typed in and discards the tool result
//   merge  the merge wrapper leaves the PR open
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

if (role === 'claude-tab') {
  if (args[0] === '--close') {
    save({ ...seat(), open: false });
    process.exit(0);
  }
  fs.writeFileSync(transcript, '');
  save({ open: true, status: 'idle' });
  console.log(`WINDOW_ID=${WID}`);
} else if (role === 'kitty') {
  if (args[0] === '@' && args[1] === 'ls') console.log('[]');
  if (args[0] === '@' && args[1] === 'send-text') {
    const s = seat();
    if (s.status === 'waiting') save({ ...s, status: 'idle' });
  }
} else if (role === 'tab-state') {
  const s = seat();
  if (!s.open) {
    console.log(JSON.stringify({ window: WID, state: 'gone', reason: 'no-such-window' }));
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
  const text = flag('--text') ?? '';
  const s = seat();
  const m = /DRILL-\$\(\(6\*7\)\)-(\w+)/.exec(text);
  if (m) {
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
    process.stderr.write('agent-send: no such window\n');
    process.exit(1);
  }
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
