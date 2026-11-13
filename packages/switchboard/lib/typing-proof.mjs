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
//   - the composer box (the last line starting with the prompt mark and every
//     line under it up to the closing rule) must be empty. A fresh session's placeholder hint reads as text: not typed.
// `shell`: the turn ended and background shells or monitors still run (seen on live
// screens with an empty composer and the title idle).
const QUEUE_IDLE_STATUSES = new Set(['idle', 'shell']);
// Footer strings only (the set kitty-send.sh's DIALOG_MARKERS holds): prose such as
// "Do you want to ..." also appears in a seat's own reply. A permission prompt or a
// question is otherwise refused through the record status `waiting`.
const DIALOG_RE = /Enter to select|Esc to cancel|↑\/↓ to navigate|Enter select|Esc cancel|↑\/↓ move|✎ note/;
// `text`, when given, is the message about to be typed: one that starts with `/` would run as a
// slash command in the seat (`/compact` compacts it) instead of arriving as a message.
export const typingVerdict = (winId, { text = null } = {}) => {
  if (text != null && /^\s*\//.test(text)) return 'the text starts with "/", which would run as a command in the seat';
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
  // The whole composer box: the prompt line and every line under it up to the
  // closing rule (a draft may start with an empty line). Without a closing rule
  // everything below counts, so a screen that cannot be read as a box is refused.
  const rest = lines.slice(at + 1);
  const close = rest.findIndex((l) => /^\s*[─━]{5,}\s*$/.test(l));
  const box = [lines[at].replace(/^\s*[❯>]/, ''), ...(close < 0 ? rest : rest.slice(0, close))];
  if (box.some((l) => l.trim() !== '')) return 'composer holds text';
  return null;
};
