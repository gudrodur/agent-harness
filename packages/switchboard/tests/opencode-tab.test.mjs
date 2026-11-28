// Tests for opencode-tab.sh: the argument gate, the kitty gate, and the
// three-part start proof (beacon, a new session row in --cwd, its model).
//
// A PATH stub for `kitty` records launch and
// close-window and serves one live window, `sleep` is a no-op, and the
// opencode store is a temp SQLite file whose `session` table has the columns
// the script reads. The presence command is a stub that prints a fixture.
//
// Run: node --test tests/opencode-tab.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/opencode-tab.sh', import.meta.url));
const WID = 992001;
const MODEL = 'opencode/muse-spark-1.3-contributor-free';

let binDir, stateDir, cwd, brief, db, launcher;

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octab-bin-'));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octab-state-'));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'octab-cwd-'));
  brief = path.join(stateDir, 'brief.md');
  await fs.writeFile(brief, '# Brief\n');
  db = path.join(stateDir, 'opencode.db');
  launcher = path.join(stateDir, 'opencode-launch.sh');
  // The launcher stub. `run` is the pre-launch probe: it answers OK unless the
  // model is listed in $state/probe-fail (rc 1, a 402 line, as a drained
  // provider does) or $state/probe-hang (sleeps past the probe timeout via
  // /bin/sleep, bypassing the no-op sleep stub), and records its arguments and
  // cwd. `output-402` makes it print the 402 line yet exit 0. `session` records
  // its arguments in $state/session-calls. Anything else is the tab's own
  // command and exits 0.
  await fs.writeFile(
    launcher,
    [
      '#!/usr/bin/env bash',
      `state=${JSON.stringify(stateDir)}`,
      'if [ "$1" = run ]; then',
      '  printf \'%s | cwd=%s\\n\' "$*" "$PWD" >> "$state/probe-calls"',
      // Like opencode, the run writes a session row for its cwd, before it answers or hangs.
      '  node -e \'const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(process.env.OPENCODE_TAB_DB); d.prepare("INSERT INTO session VALUES (?, ?, ?, NULL, ?)").run(process.argv[1], process.cwd(), "{}", Date.now() - 5000);\' "ses_probe_$$"',
      '  printf \'%s\\n\' "ses_probe_$$" > "$state/probe-session"',
      '  m=""; while [ $# -gt 0 ]; do case "$1" in -m|--model) m="$2"; shift 2 ;; *) shift ;; esac; done',
      '  if [ -f "$state/probe-fail" ] && grep -qxF -- "$m" "$state/probe-fail"; then',
      '    printf \'%s\\n\' "402 Payment Required" >&2; exit 1',
      '  fi',
      '  if [ -f "$state/probe-hang" ] && grep -qxF -- "$m" "$state/probe-hang"; then exec /bin/sleep 30; fi',
      '  if [ -f "$state/probe-402-rc0" ]; then printf \'%s\\n\' "Error: 402 insufficient credit"; exit 0; fi',
      '  printf \'OK\\n\'; exit 0',
      'fi',
      // `session delete` removes the row, as opencode does, unless $state/session-keep says this delete
      // reports success and leaves the row (as a delete that misses a store table does).
      'if [ "$1" = session ]; then',
      '  printf \'%s\\n\' "$*" >> "$state/session-calls"',
      '  [ -f "$state/session-keep" ] || node -e \'const { DatabaseSync } = require("node:sqlite"); new DatabaseSync(process.env.OPENCODE_TAB_DB).prepare("DELETE FROM session WHERE id = ?").run(process.argv[1]);\' "${@: -1}"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const lsJson = `[{"tabs":[{"windows":[{"id":${WID},"pid":${process.pid}}]}]}]`;
  await fs.writeFile(
    path.join(binDir, 'kitty'),
    [
      '#!/usr/bin/env bash',
      `state=${JSON.stringify(stateDir)}`,
      'case "$1/$2" in',
      '  @/ls) [ -f "$state/nokitty" ] && exit 1',
      '        if [ -f "$state/ls-fail" ]; then echo "Error: dial unix ${KITTY_LISTEN_ON#unix:}: connect: no such file or directory" >&2; exit 1; fi',
      // ls-fail-after N: the first N reads answer, every later one gets no answer.
      '        if [ -f "$state/ls-fail-after" ]; then n=$(cat "$state/ls-count" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$state/ls-count"; [ "$n" -gt "$(cat "$state/ls-fail-after")" ] && { echo "Error: Failed to connect: Connection refused" >&2; exit 1; }; fi',
      // ls-fail-after-launch: every read after the launch gets no answer.
      '        if [ -f "$state/ls-fail-after-launch" ] && [ -f "$state/launched" ]; then echo "Error: Failed to connect: Connection refused" >&2; exit 1; fi',
      '        if [ -f "$state/gone" ]; then echo "[]"; else printf \'%s\\n\' ' + JSON.stringify(lsJson) + '; fi ;;',
      '  @/launch) printf \'%s\\n\' "$@" > "$state/launch-args"; : > "$state/launched"; echo ' + WID + ' ;;',
      '  @/close-window) printf \'%s\\n\' "$*" > "$state/closed" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(
    path.join(binDir, 'presence'),
    `#!/usr/bin/env bash\ncat ${JSON.stringify(path.join(stateDir, 'presence.json'))} 2>/dev/null\n`,
    { mode: 0o755 },
  );
});

after(async () => {
  for (const d of [binDir, stateDir, cwd]) await fs.rm(d, { recursive: true, force: true });
});

// Fresh store and state for each test; `session` rows are what opencode
// writes when the TUI starts in a directory.
beforeEach(async () => {
  for (const f of ['launch-args', 'probe-calls', 'probe-session', 'session-calls', 'session-keep', 'probe-fail', 'probe-hang', 'probe-402-rc0', 'closed', 'nokitty', 'gone', 'ls-fail', 'ls-fail-after', 'ls-count', 'claim-calls', 'claim-rc', 'presence.json', 'ls-fail-after-launch', 'launched', 'opencode-tab-launched.' + os.userInfo().uid]) {
    await fs.rm(path.join(stateDir, f), { force: true });
  }
  await fs.rm(db, { force: true });
  const d = new DatabaseSync(db);
  d.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, parent_id TEXT, time_created INTEGER)');
  d.close();
});

const addSession = (id, model, { dir = cwd, parent = null, at = Date.now() + 60_000, variant } = {}) => {
  const [providerID, mid] = model.split('/');
  const d = new DatabaseSync(db);
  d.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(id, dir, JSON.stringify({ id: mid, providerID, ...(variant ? { variant } : {}) }), parent, at);
  d.close();
};
const beacon = (windowId) =>
  fs.writeFile(path.join(stateDir, 'presence.json'), JSON.stringify({ beacons: [{ sessionId: 'x', windowId }] }));

const tabEnv = (extraEnv = {}) => isolatedEnv({
  PATH: `${binDir}:${process.env.PATH}`,
  XDG_RUNTIME_DIR: stateDir,
  CLAUDE_SESSION_ID: 'test-launcher',
  OPENCODE_TAB_LAUNCH: launcher,
  OPENCODE_TAB_DB: db,
  OPENCODE_TAB_PRESENCE: path.join(binDir, 'presence'),
  SWITCHBOARD_TASK_CLAIM: path.join(stateDir, 'no-claim-cli.mjs'),
  ...extraEnv,
});
const tab = async (args, extraEnv = {}) => {
  try {
    const r = await run('bash', [SCRIPT, ...args], { env: tabEnv(extraEnv) });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout, err: e.stderr };
  }
};
const exists = (f) => fs.access(path.join(stateDir, f)).then(() => true, () => false);
const full = () => ['--title', 'opencode: test', '--brief', brief, '--model', MODEL, '--cwd', cwd];

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

test('a relative --brief is refused', async () => {
  const r = await tab(['--title', 't', '--brief', 'brief.md', '--model', MODEL, '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--brief must be absolute/);
});

test('the brief lint runs here too: a trailer or a bare #N placeholder refuses before any launch', async () => {
  const trailer = path.join(stateDir, 'brief-trailer.md');
  await fs.writeFile(trailer, '# Brief\n- End each body with `Co-Authored-By: opencode <noreply@opencode.ai>`.\n');
  const r = await tab(['--title', 't', '--brief', trailer, '--model', MODEL, '--cwd', cwd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /brief line\(s\) 2 ask for a Co-Authored-By trailer/);
  assert.equal(await exists('launch-args'), false);

  const ph = path.join(stateDir, 'brief-ph.md');
  await fs.writeFile(ph, '# Brief\n- Commit as "fix: retry once (#N)".\n');
  const r2 = await tab(['--title', 't', '--brief', ph, '--model', MODEL, '--cwd', cwd]);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /brief line\(s\) 2 carry a bare #N placeholder/);
  assert.equal(await exists('launch-args'), false);
});

test('no kitty remote control exits 2', async () => {
  await fs.writeFile(path.join(stateDir, 'nokitty'), '');
  const r = await tab(full());
  assert.equal(r.code, 2);
  assert.equal(await exists('launch-args'), false);
});

test('beacon + a new session on the asked model: exit 0, SESSION printed, state row written', async () => {
  await beacon(WID);
  addSession('ses_other_dir', MODEL, { dir: '/elsewhere' });
  addSession('ses_child', MODEL, { parent: 'ses_new' });
  addSession('ses_new', MODEL);
  const r = await tab(full());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^WINDOW_ID=${WID}$`, 'm'));
  assert.match(r.out, /^SESSION=ses_new$/m);
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /^mini\n--standalone\n--model\nopencode\/muse-spark-1\.3-contributor-free$/m);
  assert.match(args, new RegExp(`^Read ${brief} and carry it out`, 'm'));
  const row = await fs.readFile(path.join(stateDir, 'opencode-tab-launched.' + os.userInfo().uid), 'utf8');
  assert.equal(row, `${WID} ${process.pid} @test-launcher opencode: test\n`);
  assert.equal(await exists('closed'), false);
});

// The tab's dispatcher must be readable from outside its process: the watchdog reads the kitty
// window's launch env. Same numeric gate as claude-tab.sh: a non-numeric id names no window.
test("the launcher's numeric KITTY_WINDOW_ID goes in as AGENT_DISPATCHED_BY", async () => {
  await beacon(WID);
  addSession('ses_new', MODEL);
  const r = await tab(full(), { KITTY_WINDOW_ID: '25' });
  assert.equal(r.code, 0, r.err);
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /^--env\nAGENT_DISPATCHED_BY=25$/m);
});

test('no AGENT_DISPATCHED_BY when the launcher has no numeric KITTY_WINDOW_ID', async () => {
  await beacon(WID);
  addSession('ses_new', MODEL);
  for (const env of [{}, { KITTY_WINDOW_ID: 'x1' }]) {
    await fs.rm(path.join(stateDir, 'launch-args'), { force: true });
    const r = await tab(full(), env);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), /AGENT_DISPATCHED_BY/);
  }
});

test('reads session_v2 when present (opencode v2.0.29+, #47) and falls back to session when absent', async () => {
  await beacon(WID);
  const d = new DatabaseSync(db);
  d.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, model TEXT, parent_id TEXT, time_created INTEGER)');
  const [providerID, mid] = MODEL.split('/');
  d.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)').run('ses_v2_new', cwd, JSON.stringify({ id: mid, providerID }), null, Date.now() + 60_000);
  d.close();
  const r = await tab(full());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^SESSION=ses_v2_new$/m);
});

test('a session on another model closes the window and exits 3', async () => {
  await beacon(WID);
  addSession('ses_wrong', 'opencode/some-other-model');
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /is on model opencode\/some-other-model but was launched as/);
  assert.match(await fs.readFile(path.join(stateDir, 'closed'), 'utf8'), new RegExp(`id:${WID}`));
  const rows = await fs.readFile(path.join(stateDir, 'opencode-tab-launched.' + os.userInfo().uid), 'utf8');
  assert.equal(rows, '');
});

test('--model PROVIDER/NAME#VARIANT is proven against the stored variant and passed to opencode whole', async () => {
  await beacon(WID);
  addSession('ses_var', MODEL, { variant: 'medium' });
  const r = await tab(['--title', 'opencode: test', '--brief', brief, '--model', `${MODEL}#medium`, '--cwd', cwd]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^SESSION=ses_var$/m);
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.ok(args.split('\n').includes(`${MODEL}#medium`), args);
});

test('a stored variant of default equals no variant, and #default asked equals none stored', async () => {
  await beacon(WID);
  addSession('ses_def', MODEL, { variant: 'default' });
  const r = await tab(full());
  assert.equal(r.code, 0, r.err);
  const r2 = await tab(['--title', 'opencode: test', '--brief', brief, '--model', `${MODEL}#default`, '--cwd', cwd]);
  assert.equal(r2.code, 0, r2.err);
});

test('a variant mismatch still closes the window and exits 3', async () => {
  await beacon(WID);
  addSession('ses_badvar', MODEL, { variant: 'high' });
  const r = await tab(['--title', 'opencode: test', '--brief', brief, '--model', `${MODEL}#medium`, '--cwd', cwd]);
  assert.equal(r.code, 3);
  assert.match(r.err, /is on model .*#high but was launched as/);
  assert.match(await fs.readFile(path.join(stateDir, 'closed'), 'utf8'), new RegExp(`id:${WID}`));
});

test('no beacon for the window: exit 3, window left open for a look', async () => {
  await beacon(WID + 1);
  addSession('ses_new', MODEL);
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /not proven within 90 s \(beacon=0 session=ses_new\)/);
  assert.equal(await exists('closed'), false);
});

test('a session older than the launch is not taken as proof', async () => {
  await beacon(WID);
  addSession('ses_old', MODEL, { at: Date.now() - 600_000 });
  const r = await tab(full());
  assert.equal(r.code, 3);
  assert.match(r.err, /session=none/);
});

test('a model whose provider answers 402 is refused before any tab opens', async () => {
  await beacon(WID);
  addSession('ses_new', MODEL);
  await fs.writeFile(path.join(stateDir, 'probe-fail'), `${MODEL}\n`);
  const r = await tab(full());
  assert.equal(r.code, 1);
  assert.match(r.err, /probe of .* failed: opencode exited 1: 402 Payment Required/);
  assert.equal(await exists('launch-args'), false);
});

test('a 402 line in the probe output fails the probe even at exit 0', async () => {
  await fs.writeFile(path.join(stateDir, 'probe-402-rc0'), '');
  const r = await tab(full());
  assert.equal(r.code, 1);
  assert.match(r.err, /402/);
  assert.equal(await exists('launch-args'), false);
});

test('a hung probe exits 1 with a hang message and launches nothing', async () => {
  await fs.writeFile(path.join(stateDir, 'probe-hang'), `${MODEL}\n`);
  const r = await tab(full(), { OPENCODE_TAB_PROBE_TIMEOUT: '1' });
  assert.equal(r.code, 1);
  assert.match(r.err, /probe of .* hung for 1 s/);
  assert.equal(await exists('launch-args'), false);
});

test('an answering probe lets the launch proceed; it runs the asked model in a throwaway cwd', async () => {
  await beacon(WID);
  addSession('ses_new', MODEL);
  const r = await tab(full());
  assert.equal(r.code, 0, r.err);
  const calls = await fs.readFile(path.join(stateDir, 'probe-calls'), 'utf8');
  assert.match(calls, /^run --standalone -m opencode\/muse-spark-1\.3-contributor-free /);
  assert.doesNotMatch(calls, new RegExp(`cwd=${cwd}$`, 'm'));
  assert.equal(await exists('launch-args'), true);
});

// A probe left its session row behind on every launch, so the store collected
// dozens of one-word "OK" sessions that every session picker then listed. Each
// outcome, the failures included, deletes the probe's own session and no other.
for (const [outcome, setup, env] of [
  ['an answering probe', async () => { await beacon(WID); addSession('ses_new', MODEL); }, {}],
  ['a 402 probe', () => fs.writeFile(path.join(stateDir, 'probe-fail'), `${MODEL}\n`), {}],
  ['a 402 line at exit 0', () => fs.writeFile(path.join(stateDir, 'probe-402-rc0'), ''), {}],
  ['a hung probe', () => fs.writeFile(path.join(stateDir, 'probe-hang'), `${MODEL}\n`), { OPENCODE_TAB_PROBE_TIMEOUT: '1' }],
]) {
  test(`${outcome} deletes the session it created`, async () => {
    await setup();
    await tab(full(), env);
    const id = (await fs.readFile(path.join(stateDir, 'probe-session'), 'utf8')).trim();
    const calls = await fs.readFile(path.join(stateDir, 'session-calls'), 'utf8').catch(() => '');
    assert.equal(calls, `session delete --standalone ${id}\n`);
    const d = new DatabaseSync(db);
    assert.equal(d.prepare('SELECT id FROM session WHERE id = ?').get(id), undefined, 'the row is gone');
    d.close();
  });
}

// A delete is read back: a row still in the store after a delete that exited 0 is named, not hidden.
test('a probe session that outlives its delete is reported, and the launch goes on', async () => {
  await beacon(WID);
  addSession('ses_new', MODEL);
  await fs.writeFile(path.join(stateDir, 'session-keep'), '');
  const r = await tab(full());
  assert.equal(r.code, 0, r.err);
  const id = (await fs.readFile(path.join(stateDir, 'probe-session'), 'utf8')).trim();
  assert.match(r.err, new RegExp(`probe's session ${id} is still in the store`));
  assert.equal(await exists('launch-args'), true);
});

test('--no-probe skips the probe', async () => {
  await beacon(WID);
  addSession('ses_new', MODEL);
  await fs.writeFile(path.join(stateDir, 'probe-fail'), `${MODEL}\n`);
  const r = await tab([...full(), '--no-probe']);
  assert.equal(r.code, 0, r.err);
  assert.equal(await exists('probe-calls'), false);
  assert.equal(await exists('launch-args'), true);
});

test('--server URL launches on that server and not --standalone; the default launch stays --standalone', async () => {
  await beacon(WID);
  addSession('ses_new', MODEL);
  const r = await tab([...full(), '--server', 'http://127.0.0.1:49374']);
  assert.equal(r.code, 0, r.err);
  const args = await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8');
  assert.match(args, /^mini\n--server\nhttp:\/\/127\.0\.0\.1:49374\n--model\n/m);
  assert.doesNotMatch(args, /--standalone/);
  await fs.rm(path.join(stateDir, 'launch-args'));
  const r2 = await tab(full());
  assert.equal(r2.code, 0, r2.err);
  assert.match(await fs.readFile(path.join(stateDir, 'launch-args'), 'utf8'), /^--standalone$/m);
});

test('--server takes a http(s) URL: a bare word is refused', async () => {
  const r = await tab([...full(), '--server', 'shared']);
  assert.equal(r.code, 1);
  assert.match(r.err, /--server takes a http\(s\) URL/);
  assert.equal(await exists('launch-args'), false);
});

// The one-slot gate reads kitty fresh and treats "no answer" as a refusal.
const holdSlot = () =>
  fs.writeFile(path.join(stateDir, 'opencode-tab-launched.' + os.userInfo().uid), `${WID} ? @other-seat opencode: other\n`);

test('a package tab is refused while another seat holds the slot', async () => {
  await holdSlot();
  const r = await tab(full());
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /holds the package-tab slot/);
  assert.equal(await exists('launch-args'), false);
});

// The probe answers (read 1); the slot's own fresh read (read 2) gets no answer.
// An empty answer must stop the launch, not come back as "the slot is free".
test('a slot read that gets no answer stops the launch (exit 2), rather than freeing the slot', async () => {
  await holdSlot();
  await fs.writeFile(path.join(stateDir, 'ls-fail-after'), '1');
  const r = await tab(full());
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /cannot tell who holds the slot/);
  assert.equal(await exists('launch-args'), false);
});

test('--close closes a launched window and drops the beacons naming it', async () => {
  const sbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octab-sb-'));
  const env = isolatedEnv({ AGENT_SWITCHBOARD_DIR: sbDir });
  const lib = fileURLToPath(new URL('../lib/presence.mjs', import.meta.url));
  const node = (code) => run(process.execPath, ['--input-type=module', '-e', code, lib], { env });
  await node(`const p = await import(process.argv[1]);
    p.recordPresence({ cwd: '/a', sessionId: 'ses_tab', windowId: ${WID} });
    p.recordPresence({ cwd: '/b', sessionId: 'ses_other', windowId: ${WID + 5} });`);
  await fs.writeFile(path.join(stateDir, 'opencode-tab-launched.' + os.userInfo().uid), `${WID} ${process.pid} @test-launcher opencode: test\n`);
  let r;
  try {
    r = await run('bash', [SCRIPT, '--close', String(WID)], {
      env: { ...env, PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir, CLAUDE_SESSION_ID: 'test-launcher' },
    });
  } catch (e) {
    assert.fail(`--close failed: ${e.stderr}`);
  }
  assert.match(await fs.readFile(path.join(stateDir, 'closed'), 'utf8'), new RegExp(`id:${WID}`));
  const left = await node(`const p = await import(process.argv[1]);
    console.log(p.readAllPresence().map((b) => b.sessionId).join(','));`);
  assert.equal(left.stdout.trim(), 'ses_other');
  await fs.rm(sbDir, { recursive: true, force: true });
});

test('--close of a window it did not launch is refused and drops nothing', async () => {
  const sbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octab-sb-'));
  const env = isolatedEnv({ AGENT_SWITCHBOARD_DIR: sbDir });
  const lib = fileURLToPath(new URL('../lib/presence.mjs', import.meta.url));
  const node = (code) => run(process.execPath, ['--input-type=module', '-e', code, lib], { env });
  await node(`const p = await import(process.argv[1]); p.recordPresence({ cwd: '/a', sessionId: 'ses_tab', windowId: ${WID} });`);
  const r = await run('bash', [SCRIPT, '--close', String(WID)], {
    env: { ...env, PATH: `${binDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: stateDir },
  }).then(() => ({ code: 0 }), (e) => ({ code: e.code }));
  assert.notEqual(r.code, 0);
  assert.equal(await exists('closed'), false);
  const left = await node(`const p = await import(process.argv[1]); console.log(p.readAllPresence().length);`);
  assert.equal(left.stdout.trim(), '1');
  await fs.rm(sbDir, { recursive: true, force: true });
});

// ---- the shared tab ledger: --list, --close, the diagnostics and the rename ----
//
// lib/tab-ledger.sh serves both launchers, so these cases run through
// opencode-tab.sh and claude-tab.sh has its own ledger cases in its test file.
// A row is `WID PID @LAUNCHER TITLE`; the kitty stub serves window WID with
// this process's pid, so a row carrying process.pid is live and any other
// window id is gone.

const ledgerFile = () => path.join(stateDir, `opencode-tab-launched.${process.getuid()}`);
const writeRows = async (...rows) => {
  await fs.writeFile(ledgerFile(), rows.length ? `${rows.join('\n')}\n` : '');
};
const GONE = '424242';

test('--list shows which session launched each live row and prunes gone rows', async () => {
  await writeRows(`${WID} ${process.pid} @sess-A opencode: live work`, `${GONE} 99999 @sess-B opencode: gone work`);
  const r = await tab(['--list']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, new RegExp(`${WID}\\s+live\\s+sess-A\\s+state=unknown tool=- age=-\\s+opencode: live work`));
  assert.doesNotMatch(r.out, new RegExp(GONE), 'the gone row is listed nowhere');
  assert.match(r.err, /pruned 1 gone row/);
  const kept = await fs.readFile(ledgerFile(), 'utf8');
  assert.match(kept, new RegExp(`^${WID} ${process.pid} @sess-A opencode: live work`, 'm'));
  assert.doesNotMatch(kept, new RegExp(GONE), 'the gone row is deleted from the ledger');
});

test('--list reads a pre-launcher row as unknown and keeps its full title', async () => {
  await writeRows(`${WID} ${process.pid} opencode: legacy title words here`);
  const r = await tab(['--list']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, new RegExp(`${WID}\\s+live\\s+unknown\\s+state=unknown tool=- age=-\\s+opencode: legacy title words here`));
});

// Claim release: a window closed by hand never reaches --close,
// so every place the script learns a window is gone
// releases its claims. The claim CLI is stubbed through SWITCHBOARD_TASK_CLAIM.
const claimStub = async () => {
  const p = path.join(binDir, 'task-claim-stub.mjs');
  await fs.writeFile(
    p,
    [
      "import fs from 'node:fs';",
      `const state = ${JSON.stringify(stateDir)};`,
      "fs.appendFileSync(`${state}/claim-calls`, `${process.argv.slice(2).join(' ')}\\n`);",
      '',
    ].join('\n'),
  );
  return p;
};
const claimCalls = async () =>
  (await fs.readFile(path.join(stateDir, 'claim-calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);

test('--close releases the closed window’s claims', async () => {
  await writeRows(`${WID} ${process.pid} @seatA opencode: mine`);
  const r = await tab(['--close', String(WID)], { SWITCHBOARD_TASK_CLAIM: await claimStub() });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await claimCalls(), [`--release-owner kitty:${WID}`]);
  assert.equal(await exists('closed'), true, 'the window was closed');
});

test('a window closed by hand: --close on its gone id releases its claims', async () => {
  await writeRows(`${GONE} 99999 @seatA opencode: closed by hand`);
  const r = await tab(['--close', GONE], { SWITCHBOARD_TASK_CLAIM: await claimStub() });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /already gone .*claims released/);
  assert.deepEqual(await claimCalls(), [`--release-owner kitty:${GONE}`]);
});

test('a window closed by hand whose row --list already pruned: --close still releases its claims', async () => {
  await writeRows(`${WID} ${process.pid} @seatA opencode: mine`);
  const r = await tab(['--close', GONE], { SWITCHBOARD_TASK_CLAIM: await claimStub() });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.err, /gone and has no state row .*released its kitty:424242 claims/);
  assert.deepEqual(await claimCalls(), [`--release-owner kitty:${GONE}`]);
});

test('a live window with no row is still refused, and its claims are left alone', async () => {
  await writeRows();
  const r = await tab(['--close', String(WID)], { SWITCHBOARD_TASK_CLAIM: await claimStub() });
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /not launched by this script|another session/i);
  assert.deepEqual(await claimCalls(), []);
  assert.equal(await exists('closed'), false, 'the foreign window was not closed');
});

test('the --list prune of a gone row releases that window’s claims', async () => {
  await writeRows(`${WID} ${process.pid} @seatA opencode: live`, `${GONE} 99999 @seatB opencode: closed by hand`);
  const r = await tab(['--list'], { SWITCHBOARD_TASK_CLAIM: await claimStub() });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.deepEqual(await claimCalls(), [`--release-owner kitty:${GONE}`]);
});

// --list prunes rows and releases claims, so it reads kitty fresh: a list
// cached before the window opened would prune a live seat. The suite runs with
// the cache off (TTL 0); this test turns it on.
test('--list reads fresh: a cached list from before the window opened prunes nothing and releases nothing', async () => {
  const ttl = { AGENT_KITTY_LS_TTL_MS: '60000' };
  await fs.writeFile(path.join(stateDir, 'gone'), '');
  const KITTY_LS = fileURLToPath(new URL('../lib/kitty-ls.mjs', import.meta.url));
  const primed = await run('node', [KITTY_LS, '--fresh'], { env: tabEnv(ttl) });
  assert.equal(primed.stdout.trim(), '[]', 'the cache holds a list without the window');
  await fs.rm(path.join(stateDir, 'gone'));
  await writeRows(`${WID} ${process.pid} @seatA opencode: just launched`);
  const r = await tab(['--list'], { ...ttl, SWITCHBOARD_TASK_CLAIM: await claimStub() });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, new RegExp(`${WID}\\s+live`));
  assert.deepEqual(await claimCalls(), [], 'no claim released');
  assert.match(await fs.readFile(ledgerFile(), 'utf8'), new RegExp(`^${WID} `, 'm'));
});

// A row written while kitty did not answer the pid read has pid `?`; the
// next --list that sees the window live records its pid.
test('--list adopts the live pid into a row written with an unknown pid', async () => {
  await writeRows(`${WID} ? @seatA opencode: unproven`);
  const r = await tab(['--list'], { SWITCHBOARD_TASK_CLAIM: await claimStub() });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, new RegExp(`${WID}\\s+live`));
  assert.match(await fs.readFile(ledgerFile(), 'utf8'), new RegExp(`^${WID} ${process.pid} @seatA opencode: unproven$`, 'm'));
  assert.deepEqual(await claimCalls(), []);
});

test('kitty that stops answering after the launch: never exit 2; the row and the claim are written and the exit is 3', async () => {
  await fs.writeFile(path.join(stateDir, 'ls-fail-after-launch'), '');
  const r = await tab([...full(), '--no-probe'], { SWITCHBOARD_TASK_CLAIM: await claimStub() });
  assert.notEqual(r.code, 2, `exit 2 sends the caller to a headless rerun: ${r.err}`);
  assert.equal(r.code, 3, r.err);
  assert.match(r.out, new RegExp(`^WINDOW_ID=${WID}$`, 'm'));
  assert.match(await fs.readFile(ledgerFile(), 'utf8'), new RegExp(`^${WID} \\? @test-launcher opencode: test$`, 'm'));
  assert.ok((await claimCalls()).some((c) => c.startsWith(`--claim ${cwd} brief:brief.md --owner kitty:${WID}`)), (await claimCalls()).join('\n'));
  assert.equal(await exists('closed'), false, 'the tab is left open');
});

test('a missing claim CLI is a loud skip, never a refusal', async () => {
  const r = await tab(full(), { SWITCHBOARD_TASK_CLAIM: path.join(stateDir, 'no-such-cli.mjs') });
  assert.match(r.err, /task-claim CLI not found at .*no-such-cli\.mjs/);
  assert.doesNotMatch(r.err, /refus/i);
});

// ---- a dead kitty socket is diagnosed, not just reported ----
// 2026-10-02: a /tmp sweep deleted kitty's live socket and every caller got
// only "kitty remote control unavailable", with kitty's own error discarded.
// The refusal carries that error, $KITTY_LISTEN_ON, and whether the socket
// path still exists.
for (const [name, args] of [
  ['--list', () => ['--list']],
  ['--close', () => ['--close', String(WID)]],
  ['a launch', () => full()],
]) {
  test(`${name} with a deleted kitty socket names the error, the socket and the restart`, async () => {
    await fs.writeFile(path.join(stateDir, 'ls-fail'), '');
    const sock = path.join(stateDir, 'kitty-socket-7028');
    const r = await tab(args(), { KITTY_LISTEN_ON: `unix:${sock}` });
    assert.equal(r.code, 2, `${r.out}${r.err}`);
    assert.match(r.err, /kitty remote control unavailable/, 'agent-send greps this phrase');
    assert.match(r.err, /dial unix .*kitty-socket-7028: connect: no such file or directory/);
    assert.match(r.err, new RegExp(`KITTY_LISTEN_ON=unix:${sock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(r.err, /socket path does not exist/);
    assert.match(r.err, /restart kitty/);
    assert.equal(await exists('launch-args'), false);
  });
}

test('a kitty failure with the socket present does not claim it was deleted', async () => {
  await fs.writeFile(path.join(stateDir, 'ls-fail'), '');
  const sock = path.join(stateDir, 'kitty-socket-present');
  await fs.writeFile(sock, '');
  try {
    const r = await tab(['--list'], { KITTY_LISTEN_ON: `unix:${sock}` });
    assert.equal(r.code, 2, `${r.out}${r.err}`);
    assert.match(r.err, /dial unix/);
    assert.doesNotMatch(r.err, /does not exist/);
  } finally {
    await fs.rm(sock, { force: true });
  }
});

// ---- the ledger moved from omp-tab-launched.<uid> to opencode-tab-launched.<uid> ----

const legacyLedger = () => path.join(stateDir, `omp-tab-launched.${process.getuid()}`);

test('a ledger under the former name is moved to the new name, rows kept', async () => {
  const rows = `${WID} ${process.pid} @seatA opencode: carried over\n`;
  await fs.rm(ledgerFile(), { force: true });
  await fs.writeFile(legacyLedger(), rows);
  try {
    const r = await tab(['--list']);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /opencode: carried over/);
    assert.equal(await fs.readFile(ledgerFile(), 'utf8'), rows);
    assert.equal(await exists(path.basename(legacyLedger())), false, 'the former file is gone');
  } finally {
    await fs.rm(legacyLedger(), { force: true });
  }
});

test('an existing new ledger is never overwritten by a leftover former one', async () => {
  const keep = `${WID} ${process.pid} @seatA opencode: current\n`;
  await fs.writeFile(ledgerFile(), keep);
  await fs.writeFile(legacyLedger(), `${WID} ${process.pid} @old omp: stale\n`);
  try {
    const r = await tab(['--list']);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(await fs.readFile(ledgerFile(), 'utf8'), keep);
  } finally {
    await fs.rm(legacyLedger(), { force: true });
  }
});
