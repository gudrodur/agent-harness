// Codex hook lifecycle and mailbox delivery tests.
import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendMessage, readUnacked, recipientKey } from '../lib/agent-mailbox.mjs';
import { readAllPresence } from '../lib/presence.mjs';
import { defaultStorePath, openStore } from '../lib/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks/codex/mailbox.mjs');
const SID = 'codex-session-test-24d2';
const CWD = '/example/codex-project';

const runHook = (input) => spawnSync(process.execPath, [HOOK], {
  cwd: ROOT,
  input: JSON.stringify(input),
  encoding: 'utf8',
  env: process.env,
});

test('SessionStart registers a stable Codex session as a mailbox consumer', () => {
  const result = runHook({ hook_event_name: 'SessionStart', session_id: SID, cwd: CWD });
  assert.equal(result.status, 0);
  const beacon = readAllPresence().find((b) => b.sessionId === SID && b.cwd === CWD);
  assert.ok(beacon);
  assert.equal(beacon.mailbox, true);
});

test('UserPromptSubmit injects and acknowledges a reply addressed to the Codex session', () => {
  const key = recipientKey({ cwd: CWD, sessionId: SID });
  const message = appendMessage({
    to: key, from: 'opencode-session', priority: 'queue', text: 'Reply from the embedded session',
  });
  const result = runHook({ hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: CWD, prompt: 'Continue' });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /Reply from the embedded session/);
  assert.deepEqual(readUnacked(key), []);
  const store = openStore(defaultStorePath());
  try {
    const row = store.get('SELECT row_json FROM mailbox_rows WHERE recipient_key = ? AND msg_id = ?', key, message.id);
    assert.match(row.row_json, /"deliveredAs":"prompt"/);
    assert.match(row.row_json, new RegExp(`"ack":"${message.id}"`));
  } finally {
    store.close();
  }
});

test('a missing or malformed session id cannot register an anonymous consumer or ack mail', () => {
  const key = recipientKey({ cwd: CWD, sessionId: null });
  const message = appendMessage({ to: key, from: 'opencode-session', priority: 'now', text: 'Do not lose me' });
  for (const input of [
    { hook_event_name: 'SessionStart', cwd: CWD },
    { hook_event_name: 'UserPromptSubmit', session_id: '', cwd: CWD },
    { hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: 'relative/path' },
  ]) {
    const result = runHook(input);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  }
  assert.equal(readAllPresence().some((b) => b.sessionId == null || b.sessionId === 'anon'), false);
  assert.equal(readUnacked(key).some((row) => row.id === message.id), true);
});

test('SessionEnd releases the Codex session beacon', () => {
  const result = runHook({ hook_event_name: 'SessionEnd', session_id: SID, cwd: CWD, reason: 'other' });
  assert.equal(result.status, 0);
  assert.equal(readAllPresence().some((b) => b.sessionId === SID), false);
});

// The hook binds the Codex process that runs it as the session's host. The
// test runs the hook under a process whose command name is `codex` (or, for
// the negative case, `opencode`): a symlink to bash, since the kernel takes the
// name from the executed path. It reads the stored row itself, because by then
// the fake host has exited and every reader drops a dead host's row.
const underFakeAgent = (name, sid) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fake-${name}-`));
  const bin = path.join(dir, name);
  fs.symlinkSync('/bin/bash', bin);
  const runner = path.join(dir, 'runner.sh');
  fs.writeFileSync(runner, ['#!/bin/bash', 'node "$FAKE_HOOK" <<< "$FAKE_PAYLOAD" > /dev/null', 'echo "$$"', ''].join('\n'));
  const res = spawnSync(bin, [runner], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      AGENT_SWITCHBOARD_HOST_PROBE: 'on',
      FAKE_HOOK: HOOK,
      FAKE_PAYLOAD: JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid, cwd: CWD }),
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const agentPid = Number(res.stdout.trim());
  assert.ok(Number.isInteger(agentPid) && agentPid > 1, `runner printed a pid: ${res.stdout} ${res.stderr}`);
  const store = openStore(defaultStorePath());
  try {
    return { agentPid, row: store.get('SELECT host_pid, host_proof FROM presence_beacons WHERE session_id = ? AND cwd = ?', sid, CWD) };
  } finally {
    store.close();
  }
};

const hasProc = fs.existsSync('/proc/self/cmdline');

test('the hook binds the codex process it runs under as the session host', { skip: !hasProc }, () => {
  const { agentPid, row } = underFakeAgent('codex', 'codex-host-bound');
  assert.ok(row, 'the hook wrote a beacon');
  assert.equal(row.host_pid, agentPid);
  assert.equal(row.host_proof, 'self');
});

test('the hook never binds an ancestor agent of another kind: that one runs another session', { skip: !hasProc }, () => {
  const { row } = underFakeAgent('opencode', 'codex-under-opencode');
  assert.ok(row, 'the hook wrote a beacon');
  assert.equal(row.host_pid, null);
});

test('UserPromptSubmit delivers mail queued for a role the Codex session holds (#69)', async () => {
  const sid = 'codex-role-holder-69';
  const message = appendMessage({
    to: 'role:codex-drain-probe', from: 'opencode-session', priority: 'queue', text: 'Queued for the role',
  });
  const { claimRole } = await import('../lib/seat-roles.mjs');
  const store = openStore(defaultStorePath());
  try {
    claimRole(store, { role: 'codex-drain-probe', sessionId: sid, cwd: CWD, windowId: null });
  } finally {
    store.close();
  }
  const result = runHook({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: CWD, prompt: 'Go' });
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Queued for the role/);
  assert.equal(readUnacked('role:codex-drain-probe').some((r) => r.id === message.id), false);
});
