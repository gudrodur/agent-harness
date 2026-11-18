// Copilot status-line presence and fallback routing tests.
import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presenceFromStatus, publishPresence } from '../hooks/copilot/presence.mjs';
import { readAllPresence } from '../lib/presence.mjs';

const FILE = process.env.AGENT_SWITCHBOARD_PRESENCE_FILE;

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
  assert.notEqual(beacon.mailbox, true);
  assert.notEqual(beacon.mailboxOnly, true);
});

test('missing kitty window does not publish an anonymous seat', () => {
  assert.equal(publishPresence('', {}), false);
  assert.equal(readAllPresence({ file: FILE }).some((entry) => entry.windowId == null), false);
});
