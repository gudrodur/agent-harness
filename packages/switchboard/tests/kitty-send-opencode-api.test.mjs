// kitty-send.sh to an OpenCode tab: the server's API before the screen.
//
// kitty-send types into a window and then reads the screen back through kitty.
// An OpenCode seat is reached through its own server instead (the same route
// its phone client uses): the prompt enters the session's inbox, the server
// answers with the inbox item it created, and reading that item back — from the
// inbox, or the message log once a run consumed it — is the proof. No
// keystroke, no screen read, and nothing to swallow when a loaded machine's
// kitty stops answering. A tab running its own `--standalone` server is asked
// there first, before the shared registry's. A machine with no server, or one
// that does not answer, must fall back to typing exactly as before; a server
// that TOOK the prompt but could not be read back is exit 3 and is never
// retried blind.
//
// The stub server runs in this process and the script in a child, so the
// child's HTTP calls are answered while the test awaits it.
//
// Run: node --test tests/kitty-send-opencode-api.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { startStubServer, writeRegistry } from './helpers/opencode-stub.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../bin/kitty-send.sh', import.meta.url));
const WID = '991001';
const CWD = '/tmp/kitty-ocapi-cwd';
const SID = 'ses_kittyApi0000000000001';

let binDir, stateDir;

const ocDb = () => path.join(stateDir, 'opencode.db');

before(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-ocapi-bin-'));
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kitty-ocapi-state-'));
  // A live pid: the post-send liveness check requires the window's process.
  await fs.writeFile(path.join(stateDir, 'pid'), String(process.pid));
  const stub = [
    '#!/usr/bin/env bash',
    `state=${JSON.stringify(stateDir)}`,
    'case "$1/$2" in',
    '  @/ls)',
    '    pid=$(cat "$state/pid")',
    `    printf '%s\\n' '[{"tabs":[{"title":"mock","windows":[{"id":${WID},"title":"idle","pid":'$pid',"cwd":"${CWD}"}]}]}]'`,
    '    ;;',
    '  @/send-text)',
    '    touch "$state/sent"',
    '    ;;',
    '  @/get-text)',
    '    ext="all"; prev=""',
    '    for a in "$@"; do [ "$prev" = "--extent" ] && ext="$a"; prev="$a"; done',
    '    [ "$ext" = "screen" ] && exit 0',
    "    printf '%s\\n' 'idle prompt, composer empty'",
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  await fs.writeFile(path.join(binDir, 'kitty'), stub, { mode: 0o755 });
});

after(async () => {
  await fs.rm(binDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
});

// One OpenCode tab in the store: a session in this window's cwd, last row idle.
const writeStore = async () => {
  const db = new DatabaseSync(ocDb());
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, directory TEXT, model TEXT, parent_id TEXT,
    time_created INTEGER, time_updated INTEGER, time_idle INTEGER, idle_outcome TEXT)`);
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT)`);
  const now = Date.now();
  db.prepare('INSERT INTO session_v2 (id, directory, model, parent_id, time_created, time_updated, time_idle, idle_outcome) VALUES (?,?,?,?,?,?,?,?)')
    .run(SID, CWD, '{"id":"m","providerID":"opencode"}', null, now, now, now, 'succeeded');
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run('m-1', SID, 'idle', 12, now, now, JSON.stringify({ time: { created: now }, outcome: 'succeeded' }));
  db.close();
};

let n = 0;
beforeEach(async () => {
  n += 1;
  await fs.rm(path.join(stateDir, 'sent'), { force: true });
  await fs.rm(ocDb(), { force: true });
  await writeStore();
});

const send = async (args, extraEnv = {}) => {
  try {
    const r = await run(SCRIPT, args, {
      env: isolatedEnv({
        PATH: `${binDir}:${process.env.PATH}`,
        XDG_RUNTIME_DIR: stateDir,
        OPENCODE_TAB_DB: ocDb(),
        ...extraEnv,
      }),
      timeout: 40_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
};

const typed = () => fs.access(path.join(stateDir, 'sent')).then(() => true, () => false);
const registry = (stub, password = stub.password) => writeRegistry(stateDir, stub.port, password, { file: path.join(stateDir, `registry-${n}.json`) });

test('a plain send goes through the server and never types into the tab', async () => {
  const stub = await startStubServer({ password: 'kitty-api-secret' });
  const reg = registry(stub);
  try {
    const r = await send(['--to', WID, '--text', 'carry on with the render'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.err, /through its OpenCode server/);
    assert.match(r.err, new RegExp(stub.state.prompts[0].messageId));
    assert.equal(stub.state.prompts.length, 1);
    assert.equal(stub.state.prompts[0].sessionId, SID);
    assert.equal(stub.state.prompts[0].body.text, 'carry on with the render');
    assert.equal(stub.state.prompts[0].body.delivery, 'steer');
    assert.deepEqual(stub.state.reads, [{ sessionId: SID, messageId: stub.state.prompts[0].messageId }]);
    assert.equal(await typed(), false, 'nothing was typed into the window');
    assert.doesNotMatch(`${r.out}${r.err}`, /kitty-api-secret/);
  } finally {
    await stub.close();
  }
});

test('--queue hands the wait to the session and returns without a waiter', async () => {
  const stub = await startStubServer();
  const reg = registry(stub);
  try {
    const r = await send(['--to', WID, '--queue', '--text', 'when the render is done, report it'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(stub.state.prompts[0].body.delivery, 'queue');
    assert.equal(await typed(), false);
    // No detached waiter was left polling a screen.
    const files = await fs.readdir(stateDir).catch(() => []);
    assert.equal(files.filter((f) => /queue|waiter|pid$/i.test(f) && f !== 'pid').length, 0, files.join(','));
  } finally {
    await stub.close();
  }
});

test('no server: the old typed path runs, with its own proof', async () => {
  const r = await send(['--to', WID, '--text', 'typed instead', '--timeout', '4'], {
    AGENT_SWITCHBOARD_OPENCODE_SERVICE: path.join(stateDir, 'no-such-registry.json'),
  });
  // Typed, but the store gains no matching row: the same exit 3 as before,
  // which is what proves the fallback kept its own receipt instead of
  // reporting the API's.
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /typing it into window/);
  assert.match(r.err, /no new type:user row with this text/);
  assert.equal(await typed(), true);
});

test('a server that took the prompt but cannot prove it is exit 3, and nothing is typed', async () => {
  const stub = await startStubServer({ readBack: 'missing' });
  const reg = registry(stub);
  try {
    const r = await send(['--to', WID, '--text', 'one copy only'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 3, `${r.out}${r.err}`);
    assert.match(r.err, /could not be read back/);
    assert.match(r.err, /do NOT send it again blind/);
    assert.equal(await typed(), false, 'an unproven prompt is never retyped');
    assert.equal(stub.state.prompts.length, 1);
  } finally {
    await stub.close();
  }
});

test('a refused session is not an error: the typed path takes over', async () => {  const stub = await startStubServer({ promptStatus: 404 });
  const reg = registry(stub);
  try {
    const r = await send(['--to', WID, '--text', 'the session is gone', '--timeout', '4'], { AGENT_SWITCHBOARD_OPENCODE_SERVICE: reg });
    assert.equal(r.code, 3, `${r.out}${r.err}`);
    assert.match(r.err, /typing it into window/);
    assert.equal(await typed(), true);
  } finally {
    await stub.close();
  }
});

test('--cancel on an OpenCode tab says the server already took the prompt', async () => {
  // There is no waiter to kill: --queue was delivered to the session at send
  // time, so pretending to withdraw it would be the lie that loses the text.
  const r = await send(['--cancel', '--to', WID]);
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /handed to the session's server/);
  assert.match(r.err, /nothing can be withdrawn/);
});

test('the tab own process is handed to the entry, so its private server is asked', async () => {
  // A `--standalone` tab serves its own session on the loopback; the entry
  // finds that port from the tab's process, so the pid has to travel with the
  // send. The entry here records its argv and sends nothing, which makes
  // kitty-send fall through to its typed path exactly as before.
  const argvFile = path.join(stateDir, `argv-${n}.out`);
  const entry = path.join(stateDir, `entry-argv-${n}.mjs`);
  await fs.writeFile(entry, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n`);
  const r = await send(['--to', WID, '--text', 'name the tab server', '--timeout', '4'], { AGENT_SWITCHBOARD_OPENCODE_PROMPT: entry });
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /typing it into window/);
  const args = JSON.parse(await fs.readFile(argvFile, 'utf8'));
  assert.deepEqual(args.slice(0, 2), ['send', '--session']);
  assert.equal(args[args.indexOf('--pid') + 1], String(process.pid));
});

// ---- a helper killed mid-write must not become a second delivery -----------
//
// The entry prints an `accepted` line, then its final answer. A helper killed
// between them leaves a torn last line. jq without a tolerant read exits 5 on
// that line, and under `set -euo pipefail` the whole script would then exit 5:
// agent-send's KITTY_SENT_NOTHING set, so the text would be queued and
// delivered a second time. The read must yield "no accepted id" instead.
const writeEntry = async (text, code) => {
  const payload = path.join(stateDir, `entry-${n}.out`);
  const script = path.join(stateDir, `entry-${n}.mjs`);
  await fs.writeFile(payload, text);
  // Run by `node`, like the real entry: a bash stub would be a syntax error.
  await fs.writeFile(script, `import fs from 'node:fs';\nfs.writeSync(1, fs.readFileSync(${JSON.stringify(payload)}, 'utf8'));\nprocess.exit(${code});\n`);
  return script;
};

test('a torn stream after the accepted line is exit 3, not 5, and nothing is typed', async () => {
  // Exactly a killed helper: the accepted line is whole, the final line is not.
  const entry = await writeEntry(
    `${JSON.stringify({ ok: true, phase: 'accepted', messageId: 'msg_cut' })}\n{"ok":true,"message`,
    5,
  );
  const r = await send(['--to', WID, '--text', 'one copy only'], { AGENT_SWITCHBOARD_OPENCODE_PROMPT: entry });
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /could not be read back/);
  assert.match(r.err, /do NOT send it again blind/);
  assert.match(r.err, /msg_cut/);
  assert.equal(await typed(), false, 'a torn stream must never fall through to typing');
});

test('a torn accepted marker is not typed again', async () => {
  // The tear falls inside the accepted line, so the id is unreadable but the
  // marker is there: the server took the prompt. Typing it now would deliver
  // the text twice, so this is the same "do NOT resend" case as a whole marker.
  // What must never happen is this script exiting 5: that is jq's parse-error
  // status, and agent-send counts 5 as "nothing was sent" and queues the text,
  // which would deliver it twice. The read is tolerant, so a tear inside the
  // marker is simply "no id", never a fatal status.
  const entry = await writeEntry('{"ok":true,"phase":"accepted","messageI\n', 5);
  const r = await send(['--to', WID, '--text', 'nothing provable', '--timeout', '3'], { AGENT_SWITCHBOARD_OPENCODE_PROMPT: entry });
  assert.notEqual(r.code, 5, `a jq tear must not become the script's exit: ${r.out}${r.err}`);
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /torn and its item id is unreadable/);
  assert.match(r.err, /do NOT send it again blind/);
  assert.equal(await typed(), false, 'a torn accepted marker must never fall through to typing');
});

test('a stream with no accepted line is a genuine nothing-sent, and the typed path runs', async () => {
  // Nothing was accepted, so falling back is right: this pins that the
  // tolerance above did not turn every failure into "do not resend".
  const entry = await writeEntry('not json at all\n', 5);
  const r = await send(['--to', WID, '--text', 'typed after all', '--timeout', '4'], { AGENT_SWITCHBOARD_OPENCODE_PROMPT: entry });
  assert.equal(r.code, 3, `${r.out}${r.err}`);
  assert.match(r.err, /typing it into window/);
  assert.equal(await typed(), true);
});
