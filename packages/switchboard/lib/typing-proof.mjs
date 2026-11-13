// Fail-closed proof for typing a queued message into a kitty window. Reads
// only (`kitty @ ls`, `kitty @ get-text`, the session record); it never types.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Fail-closed proof for typing a queued row into a window: null when the
// seat is PROVEN idle with an empty composer, else a short reason. Anything
// short of proof, including "could not tell", is a reason, so the row stays
// queued for the seat's own drain.
//   - a Claude Code tab only: the composer of any other kind of tab cannot be
//     read reliably from its screen, so those are never typed into;
//   - the session record status must be on the idle whitelist (`idle`, `shell`; `waiting` is a
//     permission prompt or question, `blocked` a stuck turn, and an unknown
//     or missing status proves nothing);
//   - the screen must be readable and carry no dialog;
//   - the prompt line (the last line starting with the prompt mark) must be
//     empty. A fresh session's placeholder hint reads as text: not typed.
// `shell`: the turn ended and background shells or monitors still run (seen on live
// screens with an empty composer and the title idle).
const QUEUE_IDLE_STATUSES = new Set(['idle', 'shell']);
const DIALOG_RE = /Enter to select|Esc to cancel|to navigate|Do you want to|Would you like to proceed|Ready to code\?|Enter select|↑\/↓ move|✎ note/;
export const typingVerdict = (winId) => {
  const kitty = process.env.AGENT_MAILBOX_KITTY ?? 'kitty';
  let win;
  try {
    const ls = execFileSync(kitty, ['@', 'ls'], { encoding: 'utf-8', timeout: 5000 });
    win = JSON.parse(ls).flatMap((t) => (t.tabs ?? []).flatMap((tab) => tab.windows ?? [])).find((w) => w.id === Number(winId));
  } catch { return 'window list could not be read'; }
  if (win == null) return 'window not found';
  if (/[\u2800-\u28FF\u25D0-\u25D3]/.test(win.title ?? '')) return 'title shows a turn in progress';
  const proc = (win.foreground_processes ?? []).find((p) => /(^|\/)claude$/.test(p.cmdline?.[0] ?? ''));
  if (proc == null) return 'not a Claude Code tab, whose composer cannot be read reliably';
  const sessionsDir = process.env.KITTY_SEND_CLAUDE_SESSIONS_DIR ?? process.env.CLAUDE_SESSIONS_DIR
    ?? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'sessions');
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${proc.pid}.json`), 'utf-8')); } catch { return 'no session record'; }
  if (!QUEUE_IDLE_STATUSES.has(record?.status)) return `session record status ${record?.status ?? 'missing'}, not idle`;
  let screen;
  try { screen = execFileSync(kitty, ['@', 'get-text', '--match', `id:${winId}`, '--extent', 'screen'], { encoding: 'utf-8', timeout: 5000 }); } catch { return 'screen could not be read'; }
  const lines = screen.split('\n').map((l) => l.trimEnd());
  // Bottom rows only: an answered dialog stays in the scrollback in full.
  if (lines.slice(-15).some((l) => DIALOG_RE.test(l))) return 'a dialog is open on the screen';
  const at = lines.findLastIndex((l) => /^\s*[❯>](\s|$)/.test(l));
  if (at < 0) return 'no prompt line on the screen';
  if (lines[at].replace(/^\s*[❯>]/, '').trim() !== '') return 'composer holds text';
  return null;
};
