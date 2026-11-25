#!/usr/bin/env node
// Copilot status-line command: publish this window as a kitty-send seat.
//
// Copilot CLI 1.0.114 has no prompt/turn hook, so this command deliberately
// does not claim mailbox consumption. A sender can therefore use the existing
// kitty typing fallback to wake the seat and deliver the next prompt.

import { isMainModule } from '../../lib/cli-entry.mjs';
import { procStat, recordPresence } from '../../lib/presence.mjs';
import fs from 'node:fs';
import path from 'node:path';

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
  // The status-line command's parent is the Copilot process itself, so it is
  // the host; no command-name filter, since the name is whatever Copilot runs
  // as. The bare pid stays for hosts without /proc, where no identity can be read.
  record({ ...identity, pid: process.ppid, host: { pid: process.ppid }, mailbox: false, mailboxOnly: false });
  return true;
};

// The parent pid from /proc/<pid>/stat (the shared parser in lib/presence.mjs).
const parentOf = (pid) => procStat(pid)?.ppid ?? null;

// The kitty window's own pid: the ancestor of this hook whose parent is kitty
// (KITTY_PID, which kitty puts in every window's environment). It is the pid
// `kitty @ ls` reports for the window, whatever runs in it.
export const windowPidFor = (env = process.env, pid = process.pid, parent = parentOf) => {
  const kittyPid = Number(env.KITTY_PID);
  if (!Number.isInteger(kittyPid) || kittyPid <= 1) return null;
  for (let cur = pid, hops = 0; Number.isInteger(cur) && cur > 1 && hops < 64; hops += 1) {
    const up = parent(cur);
    if (up === kittyPid) return cur;
    cur = up;
  }
  return null;
};

// Bind the window as a Copilot seat for kitty-send (its "COPILOT SEAT
// BINDING"; same path and one-line format): once bound, a send to the
// window with no live Copilot in its foreground is refused instead of typed
// into the shell left behind. Unlike the presence beacon, nothing prunes it.
export const bindCopilotWindow = (env = process.env, pid = process.pid, parent = parentOf) => {
  const windowId = numberFrom(env.KITTY_WINDOW_ID);
  const windowPid = windowPidFor(env, pid, parent);
  if (windowId == null || windowPid == null) return null;
  const dir = path.join(env.XDG_RUNTIME_DIR || env.TMPDIR || '/tmp', 'kitty-send');
  const file = path.join(dir, `copilot-window-${windowId}`);
  const body = `${windowPid}\n`;
  try {
    if (fs.readFileSync(file, 'utf8') === body) return file;
  } catch {
    // Not bound yet.
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return file;
};

if (isMainModule(import.meta.url)) {
  try {
    bindCopilotWindow();
  } catch {
    // The binding is a guard for senders; a failed write must not stop presence.
  }
  try {
    publishPresence(await readStdin());
  } catch {
    // Presence is advisory and must never disrupt Copilot's status line.
  }
  process.exit(0);
}
