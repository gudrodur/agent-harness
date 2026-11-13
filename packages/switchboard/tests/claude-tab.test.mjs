// Tests for claude-tab.sh: the argument gate, the kitty gate, and the start
// proof (a new Claude Code transcript in --cwd's projects dir, its model, and
// with --rc its bridge-session row).
//
// Same method as opencode-tab.test.mjs: a PATH stub for `kitty` records launch
// and close-window and serves one live window, `sleep` is a no-op. The stub's
// launch copies $state/session.jsonl into the transcripts dir, the way Claude
// Code writes its first rows after the tab starts.
//
// Run: node --test tests/claude-tab.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/claude-tab.sh', import.meta.url));
const WID = 992101;
// A second live window another seat launched: its pid is a real process that
// is not this script's ancestor, so the slot gate counts it.
const OTHER_WID = 992102;

let binDir, stateDir, cwd, brief, projects, tdir, config, other;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cltab-bin-'));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cltab-state-'));
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cltab-cwd-')));
  brief = path.join(stateDir, 'brief.md');
  await fs.writeFile(brief, '# Brief\n');
  projects = path.join(stateDir, 'projects');
  tdir = path.join(projects, cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  config = path.join(stateDir, 'claude.json');
  other = spawn('/usr/bin/sleep', ['600'], { stdio: 'ignore' });
  const lsJson = `[{"tabs":[{"windows":[{"id":${WID},"pid":${process.pid}},{"id":${OTHER_WID},"pid":${other.pid}}]}]}]`;
  await fs.writeFile(
    path.join(binDir, 'kitty'),
    [
      '#!/usr/bin/env bash',
      `state=${JSON.stringify(stateDir)}`,
      `tdir=${JSON.stringify(tdir)}`,
      'case "$1/$2" in',
      '  @/ls) [ -f "$state/nokitty" ] && exit 1',
      '        [ -f "$state/ls.json" ] && { cat "$state/ls.json"; exit 0; }',
      '        if [ -f "$state/gone" ]; then echo "[]"; else printf \'%s\\n\' ' + JSON.stringify(lsJson) + '; fi ;;',
      '  @/launch) printf \'%s\\n\' "$@" > "$state/launch-args"',
      '            [ -f "$state/session.jsonl" ] && mkdir -p "$tdir" && cp "$state/session.jsonl" "$tdir/new-session.jsonl"',
      '            [ -x "$state/on-launch" ] && "$state/on-launch"',
      '            echo ' + WID + ' ;;',
      '  @/close-window) printf \'%s\\n\' "$*" > "$state/closed" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(binDir, 'claude'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
});

after(async () => {
  other.kill();
  for (const d of [binDir, stateDir, cwd]) await fs.rm(d, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const f of ['launch-args', 'closed', 'ls.json', 'switchboard.db', 'switchboard.db-wal', 'switchboard.db-shm', 'nokitty', 'gone', 'session.jsonl', 'on-launch', 'sessions', 'opencode-tab-launched.' + os.userInfo().uid]) {
    await fs.rm(path.join(stateDir, f), { recursive: true, force: true });
  }
  await fs.rm(projects, { recursive: true, force: true });
  await trust(path.dirname(cwd));
});

// Folder trust as Claude Code keeps it; set on the parent, so the test also
// covers inheritance.
const trust = (dir, accepted = true) =>
  fs.writeFile(config, JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: accepted } } }));

// The rows Claude Code writes: a notice on "<synthetic>", then the first real
// assistant turn; `bridge` adds the Remote Control row.
const session = (model, { bridge = false } = {}) => {
  const rows = [
    { type: 'user', cwd, message: { role: 'user', content: 'Read the brief' } },
    { type: 'assistant', cwd, message: { model: '<synthetic>', content: [] } },
    { type: 'assistant', cwd, message: { model, content: [] } },
  ];
  if (bridge) rows.push({ type: 'bridge-session', cwd });
  return fs.writeFile(path.join(stateDir, 'session.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

const tab = async (args, extraEnv = {}) => {
  try {
    const r = await run('bash', [SCRIPT, ...args], {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        XDG_RUNTIME_DIR: stateDir,
        CLAUDE_SESSION_ID: 'test-launcher',
        CLAUDE_TAB_PROJECTS: projects,
        CLAUDE_TAB_CONFIG: config,
        CLAUDE_SESSIONS_DIR: path.join(stateDir, 'sessions'),
        SWITCHBOARD_TASK_CLAIM: path.join(stateDir, 'no-claim-cli.mjs'),
        OPENCODE_TAB_DB: path.join(stateDir, 'no-opencode.db'),
        AGENT_SWITCHBOARD_DB: path.join(stateDir, 'switchboard.db'),
        AGENT_MAILBOX_KITTY: path.join(binDir, 'kitty'),
        ...extraEnv,
      }),
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout, err: e.stderr };
  }
};
const exists = (f) => fs.access(path.join(stateDir, f)).then(() => true, () => false);
const full = (...extra) => ['--title', 'claude: test', '--brief', brief, '--model', 'opus', '--cwd', cwd, ...extra];
const stateRows = () => fs.readFile(path.join(stateDir, 'opencode-tab-launched.' + os.userInfo().uid), 'utf8');

test('--help prints the usage block and nothing else', async () => {
  const r = await tab(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage:/);
  assert.doesNotMatch(r.out, /HELP-(BEGIN|END)/);
});

test('--model is required, and nothing is launched without it', async () => {
  const r = await tab(['--title', 't', '--brief', brief, '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--model is required/);
  assert.equal(await exists('launch-args'), false);
});

test('a model that is not a Claude alias or id is refused', async () => {
  const r = await tab(['--title', 't', '--brief', brief, '--model', 'gpt-5', '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--model takes opus/);
});

test('a relative --brief is refused', async () => {
  const r = await tab(['--title', 't', '--brief', 'brief.md', '--model', 'opus', '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--brief must be absolute/);
});

test('the brief lint runs here too: a trailer or a bare #N placeholder refuses before any launch', async () => {
  const trailer = path.join(stateDir, 'brief-trailer.md');
  await fs.writeFile(trailer, '# Brief\n- End each body with `Co-Authored-By: Claude <noreply@anthropic.com>`.\n');
  const r = await tab(['--title', 't', '--brief', trailer, '--model', 'opus', '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /brief line\(s\) 2 ask for a Co-Authored-By trailer/);
  assert.equal(await exists('launch-args'), false);

  const ph = path.join(stateDir, 'brief-ph.md');
  await fs.writeFile(ph, '# Brief\n- Commit as "fix: retry once (#N)".\n');
  const r2 = await tab(['--title', 't', '--brief', ph, '--model', 'opus', '--cwd', cwd]);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /brief line\(s\) 2 carry a bare #N placeholder/);
  assert.equal(await exists('launch-args'), false);
});

test('an untrusted folder is refused before launch', async () => {
  await trust(cwd, false);
  const r = await tab(full());
  assert.equal(r.code, 1);
  assert.match(r.err, /has not trusted .* nothing launched/s);
  assert.equal(await exists('launch-args'), false);
});

test('no kitty remote control exits 2', async () => {
  await fs.writeFile(path.join(stateDir, 'nokitty'), '');
  const r = await tab(full());
  assert.equal(r.code, 2);
  assert.equal(await exists('launch-args'), false);
});

test('a new session on the asked family: exit 0, SESSION printed, state row written', async () => {
  await session('claude-opus-5-5');
  const r = await tab(full());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^WINDOW_ID=${WID}$`, 'm'));
  assert.match(r.out, new RegExp(`^SESSION=${tdir}/new-session\\.jsonl$`, 'm'));
  assert.match(r.err, /on claude-opus-5-5/);
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /^claude\n--model\nopus\n/m);
  assert.doesNotMatch(args, /--remote-control/);
  assert.match(args, new RegExp(`^Read ${brief} and carry it out`, 'm'));
  assert.equal(await stateRows(), `${WID} ${process.pid} @test-launcher claude: test\n`);
  assert.equal(await exists('closed'), false);
});

test('a full model id must match exactly, context suffix aside', async () => {
  await session('claude-opus-5-5');
  const ok = await tab(['--title', 't', '--brief', brief, '--model', 'claude-opus-5-5[1m]', '--cwd', cwd]);
  assert.equal(ok.code, 0, ok.err);
  await fs.rm(projects, { recursive: true, force: true });
  const bad = await tab(['--title', 't', '--brief', brief, '--model', 'claude-opus-5', '--cwd', cwd]);
  assert.equal(bad.code, 3);
});

// Claude Code 2.1.309 writes api-request rows before the first assistant turn,
// and their tool list names the advisor's model (measured 2026-10-23): a haiku
// tab was closed as "on claude-opus-5-5". Only an assistant row's model counts.
test('a model named in an api-request row is not the session\'s model', async () => {
  const rows = [
    { type: 'user', cwd, message: { role: 'user', content: 'Read the brief' } },
    { type: 'api-request-blob', tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5-5' }] },
    { type: 'api-request', params: { model: 'claude-haiku-5-5' } },
    { type: 'assistant', cwd, message: { model: 'claude-haiku-5-5', content: [] } },
  ];
  await fs.writeFile(path.join(stateDir, 'session.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = await tab(['--title', 't', '--brief', brief, '--model', 'haiku', '--cwd', cwd]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /on claude-haiku-5-5/);
});

test('a session on another model closes the window and exits 3', async () => {
  await session('claude-sonnet-5-5');
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /is on model claude-sonnet-5-5 but was launched as opus/);
  assert.match(await fs.readFile(path.join(stateDir, 'closed'), 'utf8'), new RegExp(`id:${WID}`));
  assert.equal(await stateRows(), '');
});

test('--rc passes --remote-control and needs the bridge-session row', async () => {
  await session('claude-opus-5-5', { bridge: true });
  const r = await tab(full('--rc', 'xj 1567'));
  assert.equal(r.code, 0, r.err);
  assert.match(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), /^--remote-control\nxj 1567$/m);
  assert.match(r.err, /Remote Control "xj 1567"/);
});

test('--rc with no name uses the title', async () => {
  await session('claude-opus-5-5', { bridge: true });
  const r = await tab(full('--rc'));
  assert.equal(r.code, 0, r.err);
  assert.match(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), /^--remote-control\nclaude: test$/m);
});

test('--rc without a bridge-session row is not proven: exit 3, window left open', async () => {
  await session('claude-opus-5-5');
  const r = await tab(full('--rc', 'x'));
  assert.equal(r.code, 3);
  assert.match(r.err, /not proven within 90 s .*bridge=0/);
  assert.equal(await exists('closed'), false);
});

test('a transcript that was there before the launch is not taken as proof', async () => {
  await fs.mkdir(tdir, { recursive: true });
  await session('claude-opus-5-5');
  await fs.copyFile(path.join(stateDir, 'session.jsonl'), path.join(tdir, 'old.jsonl'));
  await fs.rm(path.join(stateDir, 'session.jsonl'));
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /session=none/);
});

test('a window that dies at launch exits 3 and writes no state row', async () => {
  await fs.writeFile(path.join(stateDir, 'gone'), '');
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /exited immediately after launch/);
  assert.equal(await exists('opencode-tab-launched.' + os.userInfo().uid), false);
});

test('--brief is required for a package tab', async () => {
  const r = await tab(['--title', 't', '--model', 'opus', '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--brief is required/);
  assert.equal(await exists('launch-args'), false);
});

const holdSlot = () =>
  fs.writeFile(path.join(stateDir, 'opencode-tab-launched.' + os.userInfo().uid), `${OTHER_WID} ${other.pid} @other-seat opencode: other\n`);

test('a package tab is refused while another seat holds the slot', async () => {
  await holdSlot();
  await session('claude-opus-5-5');
  const r = await tab(full());
  assert.equal(r.code, 1);
  assert.match(r.err, /holds the package-tab slot/);
  assert.equal(await exists('launch-args'), false);
});

const seat = (...extra) => ['--seat', '--title', 'claude: fedora', '--model', 'opus', '--cwd', cwd, ...extra];

test('--seat needs no brief: it sends the fixed greeting and proves the start', async () => {
  await session('claude-opus-5-5', { bridge: true });
  const r = await tab(seat('--rc', 'fedora'));
  assert.equal(r.code, 0, r.err);
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /^--remote-control\nfedora$/m);
  assert.match(args, /opened as an overseer seat/);
  assert.doesNotMatch(args, /^Read .* and carry it out/m);
  assert.match(r.err, /Remote Control "fedora"/);
  assert.match(r.out, new RegExp(`^CLOSE_WITH=kitty @ close-window --match id:${WID}$`, 'm'));
});

test('--seat writes no state row, so the seat never holds the package-tab slot', async () => {
  await session('claude-opus-5-5');
  const r = await tab(seat('--brief', brief));
  assert.equal(r.code, 0, r.err);
  assert.match(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), new RegExp(`^Read ${brief} and carry it out`, 'm'));
  assert.equal(await exists('opencode-tab-launched.' + os.userInfo().uid), false);
});

test('--seat launches while another seat holds the package-tab slot', async () => {
  await holdSlot();
  await session('claude-opus-5-5');
  const r = await tab(seat());
  assert.equal(r.code, 0, r.err);
  assert.equal(await stateRows(), `${OTHER_WID} ${other.pid} @other-seat opencode: other\n`);
});

// --resume: the transcript is there before the launch, so the proof reads only
// rows written after it; liveness is the registry's pid plus procStart.
const SID = '0b5e1c2a-7d4f-4e9a-9c3b-1f2e3d4c5b6a';
const sessionsDir = () => path.join(stateDir, 'sessions');
const procStart = async (pid) => {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
};
// The old transcript, ending on an assistant turn on `model`.
const oldTranscript = (model = 'claude-opus-5-5') =>
  fs.mkdir(tdir, { recursive: true }).then(() =>
    fs.writeFile(
      path.join(tdir, `${SID}.jsonl`),
      [
        { type: 'user', cwd, sessionId: SID, message: { role: 'user', content: 'old' } },
        { type: 'assistant', cwd, sessionId: SID, message: { model, content: [] } },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    ),
  );
// A registry row for SID: a live pid (the `other` sleep) with its real or a
// wrong procStart, optionally holding a bridge id.
const registryRow = async ({ start, bridge } = {}) => ({
  pid: other.pid,
  sessionId: SID,
  cwd,
  procStart: start ?? (await procStart(other.pid)),
  kind: 'interactive',
  ...(bridge ? { bridgeSessionId: 'session_01Test' } : {}),
});
const writeRegistry = async (row) => {
  await fs.mkdir(sessionsDir(), { recursive: true });
  await fs.writeFile(path.join(sessionsDir(), `${row.pid}.json`), JSON.stringify(row));
};
// What the resumed process writes after the launch: rows appended to the same
// transcript, and (with `registry`) its own registry record.
const onLaunch = async ({ model, registry } = {}) => {
  const lines = ['#!/usr/bin/env bash'];
  if (model) {
    const row = JSON.stringify({ type: 'assistant', cwd, sessionId: SID, message: { model, content: [] } });
    lines.push(`printf '%s\\n' ${JSON.stringify(row)} >> ${JSON.stringify(path.join(tdir, `${SID}.jsonl`))}`);
  }
  if (registry) {
    const f = path.join(sessionsDir(), `${registry.pid}.json`);
    lines.push(`mkdir -p ${JSON.stringify(sessionsDir())}`, `printf '%s' ${JSON.stringify(JSON.stringify(registry))} > ${JSON.stringify(f)}`);
  }
  await fs.writeFile(path.join(stateDir, 'on-launch'), lines.join('\n') + '\n', { mode: 0o755 });
};
const resume = (...extra) => ['--resume', SID, '--title', 'claude: resumed', '--model', 'opus', ...extra];

test('--resume of an id with no transcript is refused before launch', async () => {
  const r = await tab(resume());
  assert.equal(r.code, 1);
  assert.match(r.err, /no transcript for session/);
  assert.equal(await exists('launch-args'), false);
});

test('--resume refuses an id that is not a session id', async () => {
  const r = await tab(['--resume', '../x', '--title', 't', '--model', 'opus']);
  assert.equal(r.code, 1);
  assert.match(r.err, /--resume takes a session id/);
});

test('--resume refuses a session that is live in another process', async () => {
  await oldTranscript();
  await writeRegistry(await registryRow());
  const r = await tab(resume());
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`is live in pid ${other.pid}`));
  assert.equal(await exists('launch-args'), false);
});

test('--resume takes the cwd from the transcript and launches claude --resume with the greeting', async () => {
  await oldTranscript();
  // A recycled pid: same pid, another start time, so the session is not live.
  await writeRegistry(await registryRow({ start: '1' }));
  await onLaunch({ model: 'claude-opus-5-5' });
  const r = await tab(resume());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^SESSION=${tdir}/${SID}\\.jsonl$`, 'm'));
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, new RegExp(`^--cwd\n${cwd}$`, 'm'));
  assert.match(args, new RegExp(`^--resume\n${SID}$`, 'm'));
  assert.match(args, /resumed by claude-tab.sh --resume/);
  // A resumed session is a seat: no state row, no slot held.
  assert.equal(await exists('opencode-tab-launched.' + os.userInfo().uid), false);
});

test('--resume with a --cwd that is not the session\'s is refused', async () => {
  await oldTranscript();
  const r = await tab(resume('--cwd', path.dirname(cwd)));
  assert.equal(r.code, 1);
  assert.match(r.err, /ran in .* not in/);
});

test('--resume ignores the rows that were there before the launch', async () => {
  await oldTranscript();
  const r = await tab(resume());
  assert.equal(r.code, 3);
  assert.match(r.err, /not proven within 90 s .*model=none/);
});

test('--resume that comes back on another model closes the window and exits 3', async () => {
  await oldTranscript();
  await onLaunch({ model: 'claude-sonnet-5-5' });
  const r = await tab(resume());
  assert.equal(r.code, 3);
  assert.match(r.err, /is on model claude-sonnet-5-5 but was launched as opus/);
  assert.match(await fs.readFile(path.join(stateDir, 'closed'), 'utf8'), new RegExp(`id:${WID}`));
});

test('--resume --rc is proven by the live registry record holding a bridge id', async () => {
  await oldTranscript();
  await onLaunch({ model: 'claude-opus-5-5', registry: await registryRow({ bridge: true }) });
  const r = await tab(resume('--rc', 'fedora'));
  assert.equal(r.code, 0, r.err);
  assert.match(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), /^--remote-control\nfedora$/m);
  assert.match(r.err, /Remote Control "fedora"/);
});

test('--resume --rc without a bridge id in the registry is not proven', async () => {
  await oldTranscript();
  await onLaunch({ model: 'claude-opus-5-5', registry: await registryRow() });
  const r = await tab(resume('--rc', 'fedora'));
  assert.equal(r.code, 3);
  assert.match(r.err, /bridge=0/);
});

test('--resume with --brief sends the brief instead of the greeting', async () => {
  await oldTranscript();
  await onLaunch({ model: 'claude-opus-5-5' });
  const r = await tab(resume('--brief', brief));
  assert.equal(r.code, 0, r.err);
  assert.match(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), new RegExp(`^Read ${brief} and carry it out`, 'm'));
});

test('the session is named after the tab title, so the window title is not the first prompt', async () => {
  await session('claude-opus-5-5');
  const r = await tab(full());
  assert.equal(r.code, 0, r.err);
  assert.match(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), /^--name\nclaude: test$/m);
});

test('--role puts AGENT_SEAT_ROLE in the launched window environment', async () => {
  await session('claude-opus-5-5');
  const r = await tab(full('--role', 'lead'));
  assert.equal(r.code, 0, r.err);
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /^--env\nAGENT_SEAT_ROLE=lead$/m);
});

test('the launcher\'s numeric KITTY_WINDOW_ID goes in as AGENT_DISPATCHED_BY, for a package tab and a seat', async () => {
  await session('claude-opus-5-5');
  let r = await tab(full('--role', 'lead'), { KITTY_WINDOW_ID: '4' });
  assert.equal(r.code, 0, r.err);
  let args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /^--env\nAGENT_DISPATCHED_BY=4$/m);
  assert.match(args, /^--env\nAGENT_SEAT_ROLE=lead$/m);
  await fs.rm(path.join(stateDir, 'launch-args'));
  await fs.rm(path.join(stateDir, 'opencode-tab-launched.' + os.userInfo().uid), { force: true });
  await fs.rm(tdir, { recursive: true, force: true });
  await session('claude-opus-5-5');
  r = await tab(['--seat', '--title', 'claude: seat', '--model', 'opus', '--cwd', cwd], { KITTY_WINDOW_ID: '4' });
  assert.equal(r.code, 0, r.err);
  args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /^AGENT_DISPATCHED_BY=4$/m);
});

test('no AGENT_DISPATCHED_BY when the launcher has no numeric KITTY_WINDOW_ID', async () => {
  await session('claude-opus-5-5');
  const r = await tab(full(), { KITTY_WINDOW_ID: 'x1' });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), /AGENT_DISPATCHED_BY/);
});

test('a role name outside [a-z0-9][a-z0-9-]{0,63} is refused and nothing is launched', async () => {
  const r = await tab(full('--role', 'Lead Seat'));
  assert.equal(r.code, 1);
  assert.match(r.err, /--role must match/);
  assert.equal(await exists('launch-args'), false);
});

// --retire and --reseat: closing the window a takeover displaced.
//
// The displaced seat is OTHER_WID (pid: the `other` sleep). `ls.json` replaces
// the stub's window table so that window can look like a Claude Code tab
// (foreground `claude`, a session record whose status is the test's choice).
const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));
const OLD_SESSION = 'old-seat-session';
const NEW_SESSION = 'new-session';
const dbFile = () => path.join(stateDir, 'switchboard.db');
const withStore = async (fn) => {
  const { openStore } = await import('../lib/store.mjs');
  const db = openStore(dbFile());
  try { return await fn(db); } finally { db.close(); }
};
const handoverRows = () => withStore((db) => db.all('SELECT * FROM seat_handovers ORDER BY id'));
// A handover row as agent-send --take-over writes it.
const handover = async (over = {}) => {
  const { recordHandover } = await import('../lib/seat-handover.mjs');
  return withStore((db) => recordHandover(db, {
    role: 'lead', displacedSession: OLD_SESSION, displacedWindow: OTHER_WID, displacedPid: other.pid, takerSession: NEW_SESSION, ...over,
  }));
};
// The window table: the caller's window plus the displaced one running `claude`.
const windows = async ({ status = 'idle', pid = other.pid } = {}) => {
  await fs.mkdir(sessionsDir(), { recursive: true });
  if (status) {
    await fs.writeFile(path.join(sessionsDir(), `${pid}.json`), JSON.stringify({
      pid, sessionId: OLD_SESSION, cwd, startedAt: Date.now() - 60_000, statusUpdatedAt: Date.now() - 30_000, status,
    }));
  }
  const fg = JSON.stringify([{ pid, cmdline: ['/usr/bin/claude'] }]);
  await fs.writeFile(path.join(stateDir, 'ls.json'), `[{"tabs":[{"windows":[{"id":${WID},"pid":${process.pid}},{"id":${OTHER_WID},"pid":${pid},"foreground_processes":${fg}}]}]}]`);
};
const retire = (id = OTHER_WID, env = {}) => tab(['--retire', String(id)], { CLAUDE_CODE_SESSION_ID: NEW_SESSION, KITTY_WINDOW_ID: String(WID), ...env });

test('--help documents --retire, --reseat and the retire exit codes', async () => {
  const r = await tab(['--help']);
  assert.match(r.out, /--retire <window-id>/);
  assert.match(r.out, /--reseat <window-id>/);
  for (const code of ['20', '21', '22', '23']) assert.match(r.out, new RegExp(`^#?\\s*${code}  `, 'm'));
});

test('--retire closes a displaced idle seat, marks the row retired and releases its claims', async () => {
  await windows();
  const claims = path.join(stateDir, 'claim-calls');
  await fs.writeFile(path.join(stateDir, 'fake-claim.mjs'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(claims)}, process.argv.slice(2).join(' ') + '\\n');\n`);
  await handover();
  const r = await retire(OTHER_WID, { SWITCHBOARD_TASK_CLAIM: path.join(stateDir, 'fake-claim.mjs') });
  assert.equal(r.code, 0, r.err);
  assert.match(await fs.readFile(path.join(stateDir, 'closed'), 'utf8'), new RegExp(`id:${OTHER_WID}`));
  assert.match(await fs.readFile(claims, 'utf8'), new RegExp(`--release-owner kitty:${OTHER_WID}`));
  const [row] = await handoverRows();
  assert.ok(Number(row.retired_at) > 0, 'retired_at is set');
  // A second retire has nothing left to retire.
  await fs.rm(path.join(stateDir, 'closed'));
  const again = await retire();
  assert.equal(again.code, 20, again.err);
  assert.equal(await exists('closed'), false);
});

test('--retire with no handover row refuses with exit 20 and closes nothing', async () => {
  await windows();
  const r = await retire();
  assert.equal(r.code, 20);
  assert.match(r.err, /no handover/);
  assert.equal(await exists('closed'), false);
});

test('--retire refuses when the handover names a different taker', async () => {
  await windows();
  await handover({ takerSession: 'someone-else' });
  const r = await retire();
  assert.equal(r.code, 20);
  assert.match(r.err, /different session/);
  assert.equal(await exists('closed'), false);
});

test('--retire refuses a window whose pid is not the one recorded (id reuse) with exit 21', async () => {
  await windows();
  await handover({ displacedPid: process.pid });
  const r = await retire();
  assert.equal(r.code, 21);
  assert.match(r.err, /id reused|recycled/i);
  assert.equal(await exists('closed'), false);
  assert.equal((await handoverRows())[0].retired_at, null);
});

test('--retire refuses the caller\'s own window with exit 22, even with a valid row', async () => {
  await windows();
  await handover({ displacedWindow: WID, displacedPid: process.pid });
  const r = await retire(WID);
  assert.equal(r.code, 22);
  assert.match(r.err, /own window/);
  assert.equal(await exists('closed'), false);
});

test('--retire refuses a busy seat with exit 23, and a seat whose state is unknown', async () => {
  await handover();
  await windows({ status: 'busy' });
  let r = await retire();
  assert.equal(r.code, 23);
  assert.match(r.err, /state=busy/);
  await windows({ status: '' });
  r = await retire();
  assert.equal(r.code, 23);
  assert.equal(await exists('closed'), false);
  assert.equal((await handoverRows())[0].retired_at, null);
});

test('--retire needs a numeric window id and a calling session', async () => {
  await windows();
  await handover();
  let r = await tab(['--retire', 'abc'], { CLAUDE_CODE_SESSION_ID: NEW_SESSION });
  assert.equal(r.code, 1);
  r = await tab(['--retire', String(OTHER_WID)], { CLAUDE_CODE_SESSION_ID: '' });
  assert.equal(r.code, 1);
  assert.match(r.err, /session id/);
  assert.equal(await exists('closed'), false);
});

test('--retire of a displaced window that is already gone marks the row retired and exits 0', async () => {
  await handover({ displacedWindow: 999999 });
  await windows();
  const r = await retire(999999);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /already gone/);
  assert.equal(await exists('closed'), false);
  assert.ok(Number((await handoverRows())[0].retired_at) > 0);
});

test('--reseat needs --role and a numeric window id, and nothing is launched without them', async () => {
  let r = await tab(['--seat', '--title', 't', '--model', 'opus', '--cwd', cwd, '--reseat', String(OTHER_WID)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--reseat needs --role/);
  r = await tab(['--seat', '--title', 't', '--model', 'opus', '--cwd', cwd, '--role', 'lead', '--reseat', 'x1']);
  assert.equal(r.code, 1);
  assert.match(r.err, /--reseat takes a numeric window id/);
  assert.equal(await exists('launch-args'), false);
});

// What the new seat's first prompt makes it do: claim the role with --take-over, then --retire the old window.
const seatActs = async ({ claim = true, retireIt = true } = {}) => {
  const lines = [
    '#!/usr/bin/env bash',
    `export CLAUDE_CODE_SESSION_ID=${NEW_SESSION} KITTY_WINDOW_ID=${WID}`,
    claim ? `node ${JSON.stringify(SEND)} --claim-role lead --take-over >/dev/null 2>&1` : ':',
    retireIt ? `bash ${JSON.stringify(SCRIPT)} --retire ${OTHER_WID} >/dev/null 2>&1` : ':',
  ];
  await fs.writeFile(path.join(stateDir, 'on-launch'), lines.join('\n') + '\n', { mode: 0o755 });
};
const oldHolder = async () => {
  const { recordPresence } = await import('../lib/presence.mjs');
  const { claimRole } = await import('../lib/seat-roles.mjs');
  process.env.AGENT_SWITCHBOARD_DB = dbFile();
  try {
    recordPresence({ sessionId: OLD_SESSION, cwd, windowId: OTHER_WID, mailbox: true });
    await withStore((db) => claimRole(db, { role: 'lead', sessionId: OLD_SESSION, cwd, windowId: OTHER_WID }));
  } finally {
    delete process.env.AGENT_SWITCHBOARD_DB;
  }
};
const reseatArgs = () => ['--seat', '--title', 'claude: new lead', '--model', 'opus', '--cwd', cwd, '--role', 'lead', '--reseat', String(OTHER_WID)];
// The transcript file name is the new seat's session id.
const newSeatTranscript = async () => {
  await session('claude-opus-5-5');
  await fs.mkdir(tdir, { recursive: true });
};

test('--reseat end to end: the prompt claims then retires, the launcher verifies both', async () => {
  await windows();
  await oldHolder();
  await newSeatTranscript();
  await seatActs();
  const r = await tab(reseatArgs());
  assert.equal(r.code, 0, r.err);
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /--claim-role lead --take-over/);
  assert.match(args, new RegExp(`--retire ${OTHER_WID}`));
  assert.doesNotMatch(args, /AGENT_SEAT_ROLE/, 'the explicit takeover replaces the env claim');
  assert.match(r.err, /reseat verified: role lead claimed, window \d+ retired/);
  assert.match(await fs.readFile(path.join(stateDir, 'closed'), 'utf8'), new RegExp(`id:${OTHER_WID}`));
  const [row] = await handoverRows();
  assert.equal(row.taker_session, NEW_SESSION);
});

test('--reseat exits 3 when the new seat never claims the role', async () => {
  await windows();
  await oldHolder();
  await newSeatTranscript();
  await seatActs({ claim: false, retireIt: false });
  const r = await tab(reseatArgs());
  assert.equal(r.code, 3);
  assert.match(r.err, /reseat not proven.*not claimed/);
  assert.equal(await exists('closed'), false);
});

test('--reseat exits 3 when the role is claimed but the old window is not retired', async () => {
  await windows({ status: 'busy' });
  await oldHolder();
  await newSeatTranscript();
  await seatActs();
  const r = await tab(reseatArgs());
  assert.equal(r.code, 3);
  assert.match(r.err, /reseat not proven.*not retired/);
  assert.equal(await exists('closed'), false);
});
