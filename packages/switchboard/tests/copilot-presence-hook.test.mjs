// Copilot status-line presence and fallback routing tests.
import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { presenceFromStatus, publishPresence } from '../hooks/copilot/presence.mjs';
import { readAllPresence } from '../lib/presence.mjs';

const FILE = process.env.AGENT_SWITCHBOARD_PRESENCE_FILE;
const INSTALLER = path.resolve('bin/copilot-install.sh');

test('status-line input identifies a Copilot seat from its kitty window', () => {
  assert.deepEqual(
    presenceFromStatus('{"cwd":"/repo/copilot","sessionId":"copilot-session","windowId":65}', {}),
    { cwd: '/repo/copilot', sessionId: 'copilot-session', windowId: 65 },
  );
});

test('publishing presence leaves the seat on kitty fallback, not mailbox delivery', () => {
  assert.equal(publishPresence('', { KITTY_WINDOW_ID: '65' }), true);
  const beacon = readAllPresence({ file: FILE }).find((entry) => entry.sessionId === 'copilot-65');
  assert.ok(beacon);
  assert.equal(beacon.windowId, 65);
  assert.equal(beacon.pid, process.ppid);
  assert.notEqual(beacon.mailbox, true);
  assert.notEqual(beacon.mailboxOnly, true);
});

test('missing kitty window does not publish an anonymous seat', () => {
  assert.equal(publishPresence('', {}), false);
  assert.equal(readAllPresence({ file: FILE }).some((entry) => entry.windowId == null), false);
});

test('installer writes a stable switchboard hook path and is idempotent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-install-home-'));
  const stable = path.join(home, 'stable-switchboard');
  fs.mkdirSync(path.join(stable, 'hooks', 'copilot'), { recursive: true });
  fs.writeFileSync(path.join(stable, 'hooks', 'copilot', 'presence.mjs'), '');
  const env = {
    ...process.env,
    HOME: home,
    AGENT_SWITCHBOARD_HOME: stable,
    COPILOT_CONFIG_DIR: path.join(home, '.copilot'),
  };
  try {
    execFileSync('bash', [INSTALLER], { env, encoding: 'utf8' });
    const settingsPath = path.join(home, '.copilot', 'settings.json');
    const first = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(first);
    assert.equal(settings.statusLine.command, `node '${stable}/hooks/copilot/presence.mjs'`);
    execFileSync('bash', [INSTALLER], { env, encoding: 'utf8' });
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), first);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('installer refuses a missing hook instead of writing a broken setting', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-install-missing-'));
  const env = {
    ...process.env,
    HOME: home,
    AGENT_SWITCHBOARD_HOME: path.join(home, 'missing-switchboard'),
    COPILOT_CONFIG_DIR: path.join(home, '.copilot'),
  };
  try {
    assert.throws(() => execFileSync('bash', [INSTALLER], { env, encoding: 'utf8' }), /no hook/);
    assert.equal(fs.existsSync(path.join(home, '.copilot', 'settings.json')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
