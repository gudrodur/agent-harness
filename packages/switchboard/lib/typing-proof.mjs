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
//   - the composer box, found by its top and bottom rule, must be empty of
//     everything but faint text (a prompt suggestion or a hint drawn faint is
//     not typed input; see "screen attributes" below). A hint at normal
//     intensity, or a paste or image chip however drawn, reads as text: not typed.
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
// (`───── example seat title ─`). That rule is rule characters, a label set off
// by a space, and usually more rule characters; a title that runs to the edge
// or is cut off has none after it, and a narrow split gives it as few as three
// leading ones. A bare top rule still needs five. Only the top rule is read this
// way; the bottom rule stays strict, so a draft line cannot widen what ends the box.
const TOP_RULE_RE = /^\s*(?:[─━]{5,}|[─━]{3,}\s\S.*)\s*$/;
const PROMPT_RE = /^[❯>](\s|$)/;

const verdict = (kind, reason = null) => ({ kind, reason });

// The ONE busy marker: a braille spinner (U+2800-28FF) or Claude Code's
// half-circle spinner (U+25D0-25D3) in the window title means a turn is in
// progress. Idle shows no spinner. bin/agent-send.mjs reuses this for its own
// idle and busy checks, so the definition lives only here.
export const BUSY_TITLE_RE = /[\u2800-\u28FF\u25D0-\u25D3]/;
export const titleShowsBusy = (title) => BUSY_TITLE_RE.test(title ?? '');

// The Claude Code process of a `kitty @ ls` window record, or undefined.
const claudeProcOf = (win) => (win.foreground_processes ?? []).find((p) => /(^|\/)claude$/.test(p.cmdline?.[0] ?? ''));
// Claude Code's own session record for that process, or null.
const sessionRecordOf = (proc) => {
  const sessionsDir = process.env.KITTY_SEND_CLAUDE_SESSIONS_DIR ?? process.env.CLAUDE_SESSIONS_DIR
    ?? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'sessions');
  try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, `${proc.pid}.json`), 'utf-8')); } catch { return null; }
};
// The busy decision for a window (`kitty @ ls` record), following the order of
// kitty-send.sh's target_busy for the two signals it shares with it (it also
// reads the tab-state script and the --idle-when screen proof, which this does
// not): Claude Code's session record first (busy is
// busy, idle and shell are idle), the title spinner only when there is no
// usable record. The title alone is not enough: a renamed Claude Code seat
// never shows a spinner while it works. A seat waiting on a dialog (record
// status waiting or blocked) is not "working" here: that is the DIALOG verdict,
// which refuses typing in every mode and carries its own reason.
// No staleness bound: a record that says busy is busy however old its
// statusUpdatedAt is, so a crashed seat's stale record keeps its window busy
// (the row then waits for its drain) until the record changes.
export const windowIsBusy = (win) => {
  const proc = claudeProcOf(win);
  const status = proc != null ? sessionRecordOf(proc)?.status : null;
  if (status === 'busy') return true;
  if (QUEUE_IDLE_STATUSES.has(status) || DIALOG_STATUSES.has(status)) return false;
  return titleShowsBusy(win.title);
};

// ---- screen attributes: faint text is not typed input -----------------------
//
// When a turn ends Claude Code puts a prompt suggestion in the composer, drawn
// faint (SGR 2). A plain `get-text` cannot tell it from a draft, so an idle seat
// showing one refused every typed delivery. The screen is therefore read with
// `--ansi`, and inside the composer box characters drawn faint are dropped.
// This is a guard (a false "empty" types into a human's draft), so it fails
// closed at every step:
//   - only SGR 2 makes text faint; colour, however grey, never does. SGR 0, 1
//     and 22 end it (1 too, although a terminal may draw bold and faint at
//     once: reading less as faint is the safe side);
//   - the state starts normal on every line, so a run left open at the end of
//     one line never covers the next;
//   - the arguments of an extended colour (`38;5;n`, `38;2;r;g;b`) are skipped,
//     so the 2 in `38;2;…` is never read as faint;
//   - any escape this parser does not know (a CSI other than SGR, a malformed or
//     unterminated sequence, a stray control character) marks the line
//     unparsed, and an unparsed line in the box makes the box unreadable;
//   - when kitty refuses the `--ansi` option the plain read is used, in which
//     nothing is faint: the behaviour before attributes were read, which refuses.
// Outside the box nothing is dropped: the rules, the prompt line and the dialog
// footers are matched on the full visible text, faint characters included.
const CSI_RE = /^\x1b\[([0-?]*)([ -/]*)([@-~])/;
// OSC (kitty emits OSC 8 hyperlinks), terminated by BEL or ST.
const OSC_RE = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
// A control character other than tab, C1 included: never part of a parsed line.
const CONTROL_RE = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/;
// Best effort for an unparsed line, used only to locate rules and footers.
const ANY_ESC_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b.?|[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

// The faint state after one SGR parameter list, or null when the list holds a
// parameter this parser does not read for certain.
const sgrFaint = (params, faint) => {
  const ps = params === '' ? ['0'] : params.split(';');
  for (let k = 0; k < ps.length; k += 1) {
    const p = ps[k];
    if (p.includes(':')) {
      // Sub-parameter form: extended colours and underline styles only.
      if (!/^(?:38|48|58|4)(?::\d*)+$/.test(p)) return null;
      continue;
    }
    if (!/^\d*$/.test(p)) return null;
    const n = p === '' ? 0 : Number(p);
    if (n === 2) faint = true;
    else if (n === 0 || n === 1 || n === 22) faint = false;
    else if (n === 38 || n === 48 || n === 58) {
      const args = ps[k + 1] === '5' ? 1 : ps[k + 1] === '2' ? 3 : -1;
      if (args < 0 || !ps.slice(k + 2, k + 2 + args).every((a) => /^\d+$/.test(a)) || ps.length < k + 2 + args) return null;
      k += 1 + args;
    }
  }
  return faint;
};

// One line of `get-text --ansi`: `text` its visible characters (faint ones
// included, right-trimmed) and `faint[i]` whether text[i] was drawn faint, or
// `faint: null` when the line holds an escape this parser does not read.
const parseScreenLine = (raw) => {
  const unparsed = () => ({ text: raw.replace(ANY_ESC_RE, '').trimEnd(), faint: null });
  let text = '';
  const faint = [];
  let on = false;
  for (let i = 0; i < raw.length;) {
    const c = raw[i];
    if (c === '\x1b') {
      const rest = raw.slice(i);
      const csi = CSI_RE.exec(rest);
      if (csi != null) {
        if (csi[3] !== 'm' || csi[2] !== '') return unparsed();
        const next = sgrFaint(csi[1], on);
        if (next == null) return unparsed();
        on = next;
        i += csi[0].length;
        continue;
      }
      const osc = OSC_RE.exec(rest);
      if (osc == null) return unparsed();
      i += osc[0].length;
      continue;
    }
    if (CONTROL_RE.test(c)) return unparsed();
    text += c;
    faint.push(on);
    i += 1;
  }
  return { text: text.trimEnd(), faint };
};

// A line of the plain read: nothing on it is faint.
const plainLine = (raw) => ({ text: raw.trimEnd(), faint: [] });

// A paste or image chip stands for typed input however it is drawn.
const CHIP_RE = /\[(?:Pasted text|Image) #\d+/;

// The characters of a parsed line from index `from` on that were not drawn
// faint. `faint` is indexed by UTF-16 unit, like `text`.
const solidText = (line, from = 0) => {
  let out = '';
  for (let i = from; i < line.text.length; i += 1) if (!line.faint[i]) out += line.text[i];
  return out;
};

// The composer box of a screen, found by BOTH rules (see below): `{ rows }` is
// the box content with the prompt mark stripped and faint characters dropped,
// `{ chip }` whether a paste or image chip sits in it, `{ error }` says why the
// box could not be found or read. Shared by the typing proof and by `--mode
// composer`, so the two never read a composer differently.
const composerBox = (lines) => {
  const text = lines.map((l) => l.text);
  const bottom = text.findLastIndex((l) => RULE_RE.test(l));
  if (bottom < 0) return { error: 'no composer box on the screen (no closing rule)' };
  const at = text.slice(0, bottom).findLastIndex((l) => PROMPT_RE.test(l));
  if (at < 1 || !TOP_RULE_RE.test(text[at - 1])) return { error: 'no composer box on the screen (no prompt line under a top rule)' };
  if (lines.slice(at - 1, bottom + 1).some((l) => l.faint == null)) return { error: 'composer could not be read (an escape sequence the proof does not parse)' };
  const box = lines.slice(at, bottom);
  // The prompt mark (`❯` or `>`, one UTF-16 unit) is skipped by position.
  return { rows: box.map((l, k) => solidText(l, k === 0 ? 1 : 0)), chip: box.some((l) => CHIP_RE.test(l.text)) };
};

// The visible screen as parsed lines (see parseScreenLine), or null when it
// cannot be read. `get-text --ansi` first. Only a refusal of `--ansi` itself
// (its error names the option: a kitty without it) falls back to the plain read
// as before, in which nothing counts as faint. Any other failure is "could not
// read", as it always was: a transient read error must never turn into a
// second, luckier read that types. `--ansi` goes last so the arguments before
// it keep the positions callers and test stand-ins match on.
const readScreen = (winId) => {
  const kitty = process.env.AGENT_MAILBOX_KITTY ?? 'kitty';
  const args = ['@', 'get-text', '--match', `id:${winId}`, '--extent', 'screen'];
  try {
    return execFileSync(kitty, [...args, '--ansi'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').map(parseScreenLine);
  } catch (e) {
    if (!/ansi/i.test(String(e?.stderr ?? ''))) return null;
  }
  try {
    return execFileSync(kitty, args, { encoding: 'utf-8', timeout: 5000 }).split('\n').map(plainLine);
  } catch { return null; }
};
const dialogOnScreen = (lines) => lines.slice(-DIALOG_ROWS).some((l) => DIALOG_RE.test(l.text));

// Does the composer still hold `text` (whitespace ignored)? true / false, or
// null when the box cannot be found, a dialog is open or the screen cannot be read: "could not
// tell" is never "empty". Used by kitty-send to re-press Enter on a slash
// command whose trailing \r the composer swallowed.
export const composerHolds = (winId, text) => {
  const lines = readScreen(winId);
  if (lines == null) return null;
  // A dialog on screen: the next Enter would answer it, so never "holds".
  if (dialogOnScreen(lines)) return null;
  const box = composerBox(lines);
  if (box.error != null) return null;
  const want = text.replace(/\s+/g, '');
  return want !== '' && box.rows.join('').replace(/\s+/g, '').includes(want);
};

export const proofVerdict = (winId, { mode = 'idle', text = null, otherTabs = false, composer = true } = {}) => {
  const idleMode = mode === 'idle';
  // `text`, when given, is the message about to be typed: one that starts with
  // `/` would run as a slash command in the seat (`/compact` compacts it)
  // instead of arriving as a message. Only an idle-claiming send refuses it:
  // an explicit --now keeps its slash-command use.
  const slashRefusal = idleMode && text != null && /^\s*\//.test(text) ? verdict(REFUSED, 'the text starts with "/", which would run as a command in the seat') : null;
  const lsOut = kittyLs();
  if (lsOut == null) return verdict(REFUSED, 'window list could not be read');
  const win = flattenWindows(lsOut).find((w) => w.id === Number(winId));
  if (win == null) return verdict(REFUSED, 'window not found');
  const proc = claudeProcOf(win);
  // otherTabs (kitty-send, which also delivers to pi and opencode tabs): a tab
  // with no Claude Code process has no composer this module can read, and the
  // old path typed into it under the dialog check alone. Keep that: dialog
  // verdict only. A Claude Code process with no record still gets the full proof.
  const dialogOnly = !idleMode || (otherTabs && proc == null);
  if (!dialogOnly && slashRefusal != null) return slashRefusal;
  const record = proc != null ? sessionRecordOf(proc) : null;
  if (DIALOG_STATUSES.has(record?.status)) return verdict(DIALOG, `session record status ${record.status}: a permission prompt, question or stuck turn is waiting on the human`);
  const lines = readScreen(winId);
  if (lines == null) return verdict(REFUSED, 'screen could not be read');
  if (dialogOnScreen(lines)) return verdict(DIALOG, 'a dialog is open on the screen');
  if (dialogOnly) return verdict(PROVEN);

  if (titleShowsBusy(win.title)) return verdict(REFUSED, 'title shows a turn in progress');
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
  const box = composerBox(lines);
  if (box.error != null) return verdict(REFUSED, box.error);
  if (box.chip || box.rows.some((l) => l.trim() !== '')) return verdict(REFUSED, 'composer holds text');
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
  if (mode === 'composer' && /^\d+$/.test(winId ?? '') && argv.includes('--stdin')) {
    // Exit 0: the composer does not hold the text; 2: it still holds it; 3: could not tell.
    const held = composerHolds(winId, fs.readFileSync(0, 'utf-8'));
    process.exit(held === null ? 3 : held ? 2 : 0);
  }
  if (!/^\d+$/.test(winId ?? '') || !['idle', 'dialog'].includes(mode)) {
    process.stderr.write('usage: typing-proof.mjs --window <id> --mode idle|dialog|composer [--stdin] [--other-tabs] [--no-composer]\n');
    process.exit(64);
  }
  const text = argv.includes('--stdin') ? fs.readFileSync(0, 'utf-8') : null;
  const v = proofVerdict(winId, { mode, text, otherTabs: argv.includes('--other-tabs'), composer: !argv.includes('--no-composer') });
  if (v.reason != null) process.stderr.write(`${v.reason}\n`);
  process.exit(EXIT[v.kind]);
}
