// Tests for hooks/claude/mailbox-tool.mjs (the PostToolUse mailbox drain).
// Run as a subprocess like mailbox-stop.test.mjs: stdin carries the hook
// payload, AGENT_MAILBOX_DIR points the store at a temp dir.
import './helpers/isolate-setup.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { appendMessage, readUnacked } from '../lib/agent-mailbox.mjs';

const HOOK = fileURLToPath(new URL('../hooks/claude/mailbox-tool.mjs', import.meta.url));
const CWD = '/repo/t';

let root, mboxDir, homeDir, switchDir;

const runHook = (env = {}, payload = { cwd: CWD, session_id: 'tool1', hook_event_name: 'PostToolUse', tool_name: 'Bash' }) =>
  spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: isolatedEnv({ HOME: homeDir, AGENT_SWITCHBOARD_DIR: switchDir, AGENT_MAILBOX_DIR: mboxDir, AGENT_SWITCHBOARD_PRESENCE_FILE: path.join(switchDir, 'presence.json'), ...env }),
  });

before(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mbox-tool-'));
  mboxDir = path.join(root, 'mbox');
  homeDir = path.join(root, 'home');
  switchDir = path.join(root, 'switchboard');
  for (const d of [mboxDir, homeDir, switchDir]) fs.mkdirSync(d, { recursive: true });
});

test('empty inbox prints nothing and exits 0', () => {
  const res = runHook();
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('a queued row is returned as PostToolUse additionalContext and acked as tool', () => {
  appendMessage({ to: '-repo-t__tool1', from: 'agent-send:/other', priority: 'queue', text: 'change course', dir: mboxDir });
  const res = runHook();
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /arrived while you were working/);
  assert.match(out.hookSpecificOutput.additionalContext, /\[mailbox\] from agent-send:\/other \(queue, .*?\): change course/);
  assert.deepEqual(readUnacked('-repo-t__tool1', { dir: mboxDir }), []);
  const raw = fs.readFileSync(path.join(mboxDir, '-repo-t__tool1.jsonl'), 'utf-8');
  assert.equal(raw.split('\n').filter((l) => l.includes('"deliveredAs":"tool"')).length, 1);
});

test('the next tool call right after prints nothing', () => {
  const res = runHook();
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('a row under a pre-move key (cwd changed) is found by session id', () => {
  appendMessage({ to: '-old-cwd__tool3', from: 'x', priority: 'now', text: 'moved', dir: mboxDir });
  const res = runHook({}, { cwd: '/new/cwd', session_id: 'tool3' });
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /moved/);
});

test("another session's row is left alone", () => {
  appendMessage({ to: '-repo-t__other', from: 'x', priority: 'now', text: 'not yours', dir: mboxDir });
  const res = runHook({}, { cwd: CWD, session_id: 'tool4' });
  assert.equal(res.stdout, '');
  assert.equal(readUnacked('-repo-t__other', { dir: mboxDir }).length, 1);
});

test('a row whose ack cannot be written is not shown, and stays queued', () => {
  const key = '-repo-t__tool2';
  appendMessage({ to: key, from: 'x', priority: 'now', text: 'stuck', dir: mboxDir });
  const file = path.join(mboxDir, `${key}.jsonl`);
  fs.chmodSync(file, 0o444);
  try {
    const res = runHook({}, { cwd: CWD, session_id: 'tool2' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.equal(readUnacked(key, { dir: mboxDir }).length, 1);
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

test('a broken store exits 0 with empty stdout', () => {
  const notADir = path.join(root, 'not-a-dir');
  fs.writeFileSync(notADir, 'x');
  const res = runHook({ AGENT_MAILBOX_DIR: notADir });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('an empty-mailbox run on the store backend adds no context and is fast', () => {
  const db = path.join(root, 'tool.db');
  const env = { AGENT_SWITCHBOARD_DB: db, AGENT_MAILBOX_DIR: '' };
  delete env.AGENT_MAILBOX_DIR;
  const run = () => spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 'tool5' }),
    encoding: 'utf-8',
    env: isolatedEnv({ HOME: homeDir, AGENT_SWITCHBOARD_DIR: switchDir, ...env }),
  });
  run(); // creates the store
  const t0 = process.hrtime.bigint();
  const res = run();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.ok(ms < 1000, `empty run took ${ms} ms`); // loose bound; the measured figure is in the PR
});

const readUnackedFrom = (db, key) => {
  const prev = process.env.AGENT_SWITCHBOARD_DB;
  process.env.AGENT_SWITCHBOARD_DB = db;
  try {
    return readUnacked(key).length;
  } finally {
    if (prev === undefined) delete process.env.AGENT_SWITCHBOARD_DB;
    else process.env.AGENT_SWITCHBOARD_DB = prev;
  }
};

test('a held write lock costs the hook ~250 ms with AGENT_SWITCHBOARD_BUSY_TIMEOUT_MS, and it still exits 0 silently', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = path.join(root, 'locked.db');
  const env = { AGENT_SWITCHBOARD_DB: db };
  const run = (extra = {}) => {
    const t0 = process.hrtime.bigint();
    const res = spawnSync('node', [HOOK], {
      input: JSON.stringify({ session_id: 'tool6' }),
      encoding: 'utf-8',
      env: isolatedEnv({ HOME: homeDir, AGENT_SWITCHBOARD_DIR: switchDir, ...env, ...extra }),
    });
    return { res, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  };
  run(); // creates the store
  // Seed a pending row so the hook has a write (the ack) to attempt.
  const prev = process.env.AGENT_SWITCHBOARD_DB;
  process.env.AGENT_SWITCHBOARD_DB = db;
  try {
    appendMessage({ to: '-repo-t__tool6', from: 'x', priority: 'now', text: 'pending' });
  } finally {
    if (prev === undefined) delete process.env.AGENT_SWITCHBOARD_DB;
    else process.env.AGENT_SWITCHBOARD_DB = prev;
  }
  const holder = new DatabaseSync(db);
  try {
    holder.exec('BEGIN IMMEDIATE;');
    const { res, ms } = run({ AGENT_SWITCHBOARD_BUSY_TIMEOUT_MS: '250', AGENT_SWITCHBOARD_BUSY_DEADLINE_MS: '0' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.ok(ms < 1000, `locked run took ${ms} ms`);
    console.log(`locked-store hook run: ${Math.round(ms)} ms`);
  } finally {
    holder.exec('ROLLBACK;');
    holder.close();
  }
  assert.equal(readUnackedFrom(db, '-repo-t__tool6'), 1); // not shown, not lost
});

test('a subagent tool call (agent_id set) neither shows nor acks the parent mail; the main thread still drains it', () => {
  appendMessage({ to: '-repo-t__sub1', from: 'agent-send:/other', priority: 'queue', text: 'for the parent', dir: mboxDir });
  const base = { cwd: CWD, session_id: 'sub1', hook_event_name: 'PostToolUse', tool_name: 'Bash' };
  const sub = runHook({}, { ...base, agent_id: 'aef3e2ef547502095', agent_type: 'general-purpose' });
  assert.equal(sub.status, 0);
  assert.equal(sub.stdout, '');
  assert.equal(readUnacked('-repo-t__sub1', { dir: mboxDir }).length, 1);
  const main = runHook({}, base);
  assert.match(JSON.parse(main.stdout).hookSpecificOutput.additionalContext, /for the parent/);
  assert.deepEqual(readUnacked('-repo-t__sub1', { dir: mboxDir }), []);
});
