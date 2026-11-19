// A seat whose consumer is a poller with no composer (its presence beacon says
// mailboxOnly) is never typed into: a send that gets no prompt ack leaves the
// row queued and exits 3, on the live, stale and idle-beacon paths alike.
//
// Run: node --test tests/mailbox-only.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { readUnacked, recipientKey, resolveRecipient, readPresenceBeacons } from '../lib/agent-mailbox.mjs';
import { recordPresence } from '../lib/presence.mjs';

const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));
const KEY = recipientKey({ cwd: '/repo/poller', sessionId: 'p1' });

let dir, mboxDir, presFile, kittyStub, typedLog, typeStub;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-only-'));
  mboxDir = path.join(dir, 'mbox');
  fs.mkdirSync(mboxDir);
  presFile = path.join(dir, 'presence.json');
  typedLog = path.join(dir, 'typed.log');
  const ls = path.join(dir, 'ls.json');
  fs.writeFileSync(ls, JSON.stringify([{ tabs: [{ title: 't', windows: [{ id: 771001, title: 'plain shell', pid: 1, cwd: '/repo/poller' }] }] }]));
  kittyStub = path.join(dir, 'kitty');
  fs.writeFileSync(kittyStub, `#!/usr/bin/env bash\nif [ "$2" = "ls" ]; then cat ${JSON.stringify(ls)}; fi\nexit 0\n`, { mode: 0o755 });
  // Stands in for kitty-send.sh: any call is a typed send.
  typeStub = path.join(dir, 'kitty-send-stub.sh');
  fs.writeFileSync(typeStub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(typedLog)}\nexit 10\n`, { mode: 0o755 });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const beacon = (extra = {}) => {
  const now = new Date().toISOString();
  fs.writeFileSync(presFile, JSON.stringify({ beacons: [{ sessionId: 'p1', cwd: '/repo/poller', mailbox: true, windowId: 771001, pid: process.pid, firstTick: now, lastTick: now, ...extra }] }));
};
const send = (args) => new Promise((resolve) => {
  const env = isolatedEnv({
    AGENT_MAILBOX_DIR: mboxDir, AGENT_MAILBOX_PRESENCE_FILE: presFile, AGENT_MAILBOX_KITTY: kittyStub,
    AGENT_SEND_KITTY_SEND: typeStub, CLAUDE_CODE_SESSION_ID: 'sender',
  });
  const child = spawn('node', [SEND, ...args], { env });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => resolve({ code, stderr }));
});
const typed = () => (fs.existsSync(typedLog) ? fs.readFileSync(typedLog, 'utf-8') : '');
const reset = () => {
  fs.rmSync(typedLog, { force: true });
  for (const f of fs.readdirSync(mboxDir)) fs.rmSync(path.join(mboxDir, f), { force: true });
};

test('resolveRecipient carries mailboxOnly from the beacon', () => {
  beacon({ mailboxOnly: true });
  assert.equal(resolveRecipient(KEY, { presenceFile: presFile }).mailboxOnly, true);
  beacon();
  assert.equal(resolveRecipient(KEY, { presenceFile: presFile }).mailboxOnly, false);
});

test('recordPresence stores mailboxOnly in the file backend and keeps it on a later tick', () => {
  const file = path.join(dir, 'rec-presence.json');
  recordPresence({ file, cwd: '/repo/poller', sessionId: 'p1', mailbox: true, mailboxOnly: true, pid: process.pid });
  recordPresence({ file, cwd: '/repo/poller', sessionId: 'p1', mailbox: true, pid: process.pid });
  const [b] = readPresenceBeacons({ presenceFile: file });
  assert.equal(b.mailboxOnly, true);
});

test('recordPresence stores mailboxOnly in the SQLite backend', () => {
  const prev = process.env.AGENT_SWITCHBOARD_DB;
  process.env.AGENT_SWITCHBOARD_DB = path.join(dir, 'state.db');
  try {
    recordPresence({ cwd: '/repo/poller', sessionId: 'p1', mailbox: true, mailboxOnly: true, pid: process.pid });
    const [b] = readPresenceBeacons({}).filter((x) => x.sessionId === 'p1');
    assert.equal(b.mailboxOnly, true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_SWITCHBOARD_DB; else process.env.AGENT_SWITCHBOARD_DB = prev;
  }
});

test('a live mailbox-only seat that does not ack is never typed into: the row stays queued, exit 3', async () => {
  reset();
  beacon({ mailboxOnly: true });
  const { code, stderr } = await send(['--to', KEY, '--text', 'while busy', '--deadline', '1']);
  assert.equal(code, 3, stderr);
  assert.equal(typed(), '', 'nothing was typed');
  assert.equal(readUnacked(KEY, { dir: mboxDir }).length, 1);
});

test('control: the same seat without the flag is typed into after the ack wait', async () => {
  reset();
  beacon();
  const { stderr } = await send(['--to', KEY, '--text', 'while busy', '--deadline', '1']);
  assert.notEqual(typed(), '', stderr);
});

test('--queue to a mailbox-only seat does not wait for an idle window to type into', async () => {
  reset();
  beacon({ mailboxOnly: true });
  const { code, stderr } = await send(['--to', KEY, '--queue', '--text', 'queued']);
  assert.equal(code, 3, stderr);
  assert.equal(typed(), '');
  assert.equal(readUnacked(KEY, { dir: mboxDir }).length, 1);
});

test('a stale mailbox-only beacon addressed by window id queues instead of typing', async () => {
  reset();
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  beacon({ mailboxOnly: true, pid: 999999999, firstTick: old, lastTick: old });
  const { code, stderr } = await send(['--to', '771001', '--text', 'stale']);
  assert.equal(code, 3, stderr);
  assert.equal(typed(), '');
  assert.equal(readUnacked(KEY, { dir: mboxDir }).length, 1);
});
