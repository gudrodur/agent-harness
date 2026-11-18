#!/usr/bin/env node
// Copilot status-line command: publish this window as a kitty-send seat.
//
// Copilot CLI 1.0.114 has no prompt/turn hook, so this command deliberately
// does not claim mailbox consumption. A sender can therefore use the existing
// kitty typing fallback to wake the seat and deliver the next prompt.

import { recordPresence } from '../../lib/presence.mjs';
import { pathToFileURL } from 'node:url';

const readStdin = () =>
  new Promise((resolve) => {
    let input = '';
    process.stdin.on('data', (chunk) => (input += chunk));
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', () => resolve(input));
  });

const numberFrom = (...values) => {
  for (const value of values) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
};

export const presenceFromStatus = (input, env = process.env) => {
  let payload = {};
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    // Status-line input is advisory; the environment still provides the seat.
  }
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const windowId = numberFrom(payload.window_id, payload.windowId, env.KITTY_WINDOW_ID);
  if (windowId == null) return null;
  const sessionId =
    payload.session_id ??
    payload.sessionId ??
    env.COPILOT_SESSION_ID ??
    `copilot-${windowId}`;
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null;
  return { cwd, sessionId, windowId };
};

export const publishPresence = (input, env = process.env, record = recordPresence) => {
  const identity = presenceFromStatus(input, env);
  if (!identity) return false;
  record({ ...identity, mailbox: false, mailboxOnly: false });
  return true;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    publishPresence(await readStdin());
  } catch {
    // Presence is advisory and must never disrupt Copilot's status line.
  }
  process.exit(0);
}
