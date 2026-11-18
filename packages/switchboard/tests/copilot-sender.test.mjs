// Copilot sender attribution through an ancestor inuse lock.
import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isolatedEnv } from './helpers/isolate-env.mjs';
import { fileURLToPath } from 'node:url';

const SEND = fileURLToPath(new URL('../bin/agent-send.mjs', import.meta.url));

test('Copilot sender rows use its short session and kitty window', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-sender-'));
  const mailbox = path.join(root, 'mailbox');
  const presence = path.join(root, 'presence.json');
  const copilotState = path.join(root, 'session-state', 'abcdef123456');
  await fs.mkdir(copilotState, { recursive: true });
  await fs.writeFile(path.join(copilotState, `inuse.${process.pid}.lock`), '');
  const tick = new Date().toISOString();
  await fs.writeFile(presence, JSON.stringify({
    beacons: [{ sessionId: 'peer', cwd: '/repo-peer', mailbox: true, lastTick: tick, firstTick: tick }],
  }));
  const key = '-repo-peer__peer';
  try {
    const result = spawnSync(process.execPath, [SEND, '--to', key, '--text', 'hello', '--no-wait'], {
      env: isolatedEnv({
        AGENT_MAILBOX_DIR: mailbox,
        AGENT_MAILBOX_PRESENCE_FILE: presence,
        COPILOT_STATE_DIR: path.join(root, 'session-state'),
        KITTY_WINDOW_ID: '66',
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 3, result.stderr);
    const rows = (await fs.readFile(path.join(mailbox, `${key}.jsonl`), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows[0].from, 'copilot:abcdef12 w66');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
