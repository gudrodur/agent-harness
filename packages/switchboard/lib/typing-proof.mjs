// Fail-closed proof for typing a message into a kitty window. Reads only
// (`kitty @ ls`, `kitty @ get-text`, the session record); it never types.
//
// One module, two callers, one marker list:
//   - bin/kitty-send.sh runs the CLI below immediately before its first
//     `send-text` (the chokepoint, so no path to a keystroke skips it);
//   - bin/agent-send.mjs imports `typingVerdict` / `proofVerdict` for an early verdict only
//     (it decides whether to withdraw a queued row, never whether to type).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kittyLs, flattenWindows } from './kitty-ls.mjs';

// Verdict kinds. `dialog` is its own kind, never folded into "busy": a seat
// that waits on a permission prompt or a question must not be typed into in
// ANY mode (--now and --stop included), because the keystrokes are hotkeys in
// that widget and the \r selects the highlighted option.
export const PROVEN = 'proven';
export const REFUSED = 'refused';
export const DIALOG = 'dialog';

// Typing proof, mode `idle` (--queue, --wait-idle, --deadline, a detached
// waiter, an idle-claiming send): null-reason PROVEN when the seat is PROVEN
// idle with an empty composer, else a reason. Anything short of proof,
// including "could not tell", is a refusal, so the row stays queued for the
// seat's own drain.
//   - a Claude Code tab only: the composer of any other kind of tab cannot be
//     read reliably from its screen, so those are never typed into;
//   - the session record status must be on the idle whitelist (`idle`, `shell`;
//     `waiting` is a permission prompt or question and `blocked` a stuck turn,
//     both the DIALOG kind; an unknown or missing status proves nothing);
//   - the screen must be readable and carry no dialog footer;
//   - the composer box, found by its top and bottom rule, must be empty. A fresh
//     session's placeholder hint reads as text: not typed.
// Mode `dialog` (--now, --stop and every send that does not claim idleness)
// asks only the dialog question; a busy mid-turn seat stays allowed there, and
// the composer is not read (--now needs no empty-composer proof).
// `shell`: the turn ended and background shells or monitors still run (seen on
// live screens with an empty composer and the title idle).
const QUEUE_IDLE_STATUSES = new Set(['idle', 'shell']);
const DIALOG_STATUSES = new Set(['waiting', 'blocked']);
// The ONE list of dialog footer strings. Footer strings only: prose such as
// "Do you want to ..." also appears in a seat's own reply. A permission prompt
// or a question is otherwise caught through the record status `waiting`.
export const DIALOG_RE = /Enter to select|Esc to cancel|↑\/↓ to navigate|Enter select|Esc cancel|↑\/↓ move|✎ note/;
// Bottom rows only: an answered dialog stays in the scrollback in full.
const DIALOG_ROWS = 15;
const RULE_RE = /^\s*[─━]{5,}\s*$/;
// Claude Code prints a session's custom title inside the composer's TOP rule
// (`───── example seat title ─`). That rule starts with five or more rule
// characters, then a label set off by spaces, and ends in rule characters. Only
// the top rule is read this way; the bottom rule stays strict, so a draft line
// cannot widen what ends the box.
const TOP_RULE_RE = /^\s*[─━]{5,}(?:\s.*\s[─━]+)?\s*$/;
const PROMPT_RE = /^[❯>](\s|$)/;

const verdict = (kind, reason = null) => ({ kind, reason });

export const proofVerdict = (winId, { mode = 'idle', text = null, otherTabs = false, composer = true } = {}) => {
  const idleMode = mode === 'idle';
  // `text`, when given, is the message about to be typed: one that starts with
  // `/` would run as a slash command in the seat (`/compact` compacts it)
  // instead of arriving as a message. Only an idle-claiming send refuses it:
  // an explicit --now keeps its slash-command use.
  const slashRefusal = idleMode && text != null && /^\s*\//.test(text) ? verdict(REFUSED, 'the text starts with "/", which would run as a command in the seat') : null;
  const kitty = process.env.AGENT_MAILBOX_KITTY ?? 'kitty';
  const lsOut = kittyLs();
  if (lsOut == null) return verdict(REFUSED, 'window list could not be read');
  const win = flattenWindows(lsOut).find((w) => w.id === Number(winId));
  if (win == null) return verdict(REFUSED, 'window not found');
  const proc = (win.foreground_processes ?? []).find((p) => /(^|\/)claude$/.test(p.cmdline?.[0] ?? ''));
  // otherTabs (kitty-send, which also delivers to pi and opencode tabs): a tab
  // with no Claude Code process has no composer this module can read, and the
  // old path typed into it under the dialog check alone. Keep that: dialog
  // verdict only. A Claude Code process with no record still gets the full proof.
  const dialogOnly = !idleMode || (otherTabs && proc == null);
  if (!dialogOnly && slashRefusal != null) return slashRefusal;
  let record = null;
  if (proc != null) {
    const sessionsDir = process.env.KITTY_SEND_CLAUDE_SESSIONS_DIR ?? process.env.CLAUDE_SESSIONS_DIR
      ?? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'sessions');
    try { record = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${proc.pid}.json`), 'utf-8')); } catch { record = null; }
    if (DIALOG_STATUSES.has(record?.status)) return verdict(DIALOG, `session record status ${record.status}: a permission prompt, question or stuck turn is waiting on the human`);
  }
  let screen;
  try { screen = execFileSync(kitty, ['@', 'get-text', '--match', `id:${winId}`, '--extent', 'screen'], { encoding: 'utf-8', timeout: 5000 }); } catch { return verdict(REFUSED, 'screen could not be read'); }
  const lines = screen.split('\n').map((l) => l.trimEnd());
  if (lines.slice(-DIALOG_ROWS).some((l) => DIALOG_RE.test(l))) return verdict(DIALOG, 'a dialog is open on the screen');
  if (dialogOnly) return verdict(PROVEN);

  if (/[⠀-⣿◐-◓]/.test(win.title ?? '')) return verdict(REFUSED, 'title shows a turn in progress');
  if (proc == null) return verdict(REFUSED, 'not a Claude Code tab, whose composer cannot be read reliably');
  if (record == null) return verdict(REFUSED, 'no session record');
  if (!QUEUE_IDLE_STATUSES.has(record.status)) return verdict(REFUSED, `session record status ${record.status ?? 'missing'}, not idle`);

  // The composer box is found by BOTH rules, not by the first rule after the
  // prompt: a draft line of box-drawing characters is itself rule-shaped, and
  // ending the box at it would let the draft below it pass. The bottom rule
  // is the last rule on the screen; the prompt line is the last line at
  // column 0 starting with the prompt mark above it; the line above the prompt
  // must be the top rule. Anything else (bash `!` mode, a panel in the way, a
  // screen scrolled mid-box) is a shape this does not know: refused.
  if (!composer) return verdict(PROVEN);
  const bottom = lines.findLastIndex((l) => RULE_RE.test(l));
  if (bottom < 0) return verdict(REFUSED, 'no composer box on the screen (no closing rule)');
  const at = lines.slice(0, bottom).findLastIndex((l) => PROMPT_RE.test(l));
  if (at < 1 || !TOP_RULE_RE.test(lines[at - 1])) return verdict(REFUSED, 'no composer box on the screen (no prompt line under a top rule)');
  const box = [lines[at].replace(/^[❯>]/, ''), ...lines.slice(at + 1, bottom)];
  if (box.some((l) => l.trim() !== '')) return verdict(REFUSED, 'composer holds text');
  return verdict(PROVEN);
};

// The reason string or null, for a caller that wants only "may I type": any
// verdict but PROVEN is a reason.
export const typingVerdict = (winId, opts = {}) => {
  const v = proofVerdict(winId, { mode: 'idle', ...opts });
  return v.kind === PROVEN ? null : v.reason;
};

// CLI, run by bin/kitty-send.sh: `typing-proof.mjs --window N --mode idle|dialog
// [--stdin] [--other-tabs] [--no-composer]` (the message text on stdin with --stdin). Exit 0 proven, 2 refused,
// 3 a dialog is open, 64 usage. The reason goes to stderr.
const EXIT = { [PROVEN]: 0, [REFUSED]: 2, [DIALOG]: 3 };
if (process.argv[1] != null && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const winId = opt('--window');
  const mode = opt('--mode') ?? 'idle';
  if (!/^\d+$/.test(winId ?? '') || !['idle', 'dialog'].includes(mode)) {
    process.stderr.write('usage: typing-proof.mjs --window <id> --mode idle|dialog [--stdin] [--other-tabs] [--no-composer]\n');
    process.exit(64);
  }
  const text = argv.includes('--stdin') ? fs.readFileSync(0, 'utf-8') : null;
  const v = proofVerdict(winId, { mode, text, otherTabs: argv.includes('--other-tabs'), composer: !argv.includes('--no-composer') });
  if (v.reason != null) process.stderr.write(`${v.reason}\n`);
  process.exit(EXIT[v.kind]);
}
