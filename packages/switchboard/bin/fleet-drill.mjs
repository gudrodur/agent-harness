#!/usr/bin/env node
// Nightly end-to-end drill: does a message sent with agent-send reach a live
// Claude Code seat in every state a recipient can be in?
//
// --help prints everything between HELP-BEGIN and HELP-END below.
// HELP-BEGIN
// Usage: fleet-drill.mjs --states <idle,busy,permission,slash,closed[,merge]|all> [--help]
//
// Needs FLEET_DRILL_STORE_DIR (a folder for this drill's own store): a
// headless kitty numbers its windows from 1, so a shared store could hold a
// live seat's beacon under the same window id. Refused without it (exit 2).
//
// Starts ONE Claude Code seat on the cheapest model (haiku) through
// claude-tab.sh, in a throwaway folder, then for each state sends a unique
// message with agent-send.mjs and asserts the store holds an `ack` row with a
// `deliveredAs` value for it within the state's time limit. Without a kitty
// that answers `kitty @ ls`, a headless kitty is started (needs a display,
// e.g. xvfb) and stopped at the end. The seat needs the mailbox hooks
// installed in its Claude Code config, and the throwaway folder must be one
// Claude Code trusts (set FLEET_DRILL_CWD_ROOT to a folder under a trusted tree).
//
// States, run in this order, with the time limit to the ack (seconds):
//   idle        <LIMIT_IDLE> s   seat at the prompt
//   slash       <LIMIT_SLASH> s   a harmless slash command; the composer must be
//                          empty afterwards (it was submitted, not left typed)
//   busy        <LIMIT_BUSY> s   seat mid-turn in a `sleep 45` tool call; the ack must
//                          not be `typed`, and the tool result must still be in
//                          the transcript (nothing in flight was discarded)
//   permission  <LIMIT_PERMISSION> s   seat showing a permission prompt
//   merge       <LIMIT_MERGE> s  OFF unless FLEET_DRILL_SANDBOX=owner/name is set: the seat
//                          opens a PR there, FLEET_DRILL_MERGE_CMD <owner/name> <number>
//                          merges it, and `gh pr view` must say MERGED
//   closed      <LIMIT_CLOSED> s   seat window closed with `kitty @ close-window`; the send must
//                          fail with exit 1 and "no kitty window with id", and leave no
//                          ack row
//
// A state passes only on an ack row with a `deliveredAs` value, and a send that
// exits non-zero passes only when a consumer (a hook, not the typed fallback)
// wrote it.
//
// Output: one JSON line per state {state, ok, ms, deliveredAs, reason}, then
// {summary: true, ok, passed, failed}. Exit 0 all passed; 1 a state failed
// (stderr names each); 2 usage or the seat could not be started.
//
// Env (limits and timers, seconds unless noted): FLEET_DRILL_LIMIT_<STATE>_S,
// FLEET_DRILL_READY_S (seat start to idle, 180), FLEET_DRILL_SETUP_S (reach the
// busy or permission state, 90), FLEET_DRILL_SETTLE_S (busy turn to end, 180),
// FLEET_DRILL_POLL_MS (1000), FLEET_DRILL_MODEL (haiku), FLEET_DRILL_CWD_ROOT,
// FLEET_DRILL_STORE_DIR (required: AGENT_SWITCHBOARD_DIR for every child).
// Binaries: FLEET_DRILL_CLAUDE_TAB, _AGENT_SEND, _KITTY_SEND, _TAB_STATE,
// _TYPING_PROOF, _EXPORT, _KITTY, _GH. Merge stage: FLEET_DRILL_SANDBOX,
// FLEET_DRILL_MERGE_CMD.
// HELP-END

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

// Time limit from the send to the ack row, per state (seconds).
const DEFAULT_LIMITS_S = { idle: 30, slash: 30, busy: 90, permission: 60, merge: 300, closed: 30 };
const STATES = Object.keys(DEFAULT_LIMITS_S); // run order
const limitS = (state) => num(`FLEET_DRILL_LIMIT_${state.toUpperCase()}_S`, DEFAULT_LIMITS_S[state]);
const READY_S = () => num('FLEET_DRILL_READY_S', 180);
const SETUP_S = () => num('FLEET_DRILL_SETUP_S', 90);
const SETTLE_S = () => num('FLEET_DRILL_SETTLE_S', 180);
const POLL_MS = () => num('FLEET_DRILL_POLL_MS', 1000);
const SLEEP_SECONDS = 45;
const SLASH_TEXT = '/context';
// Labels the mailbox hooks write; `typed` is the sender's own terminal fallback.
const CONSUMER_LABELS = ['prompt', 'tool', 'stop', 'mcp'];
// What agent-send prints for a window that is gone.
const CLOSED_TEXT = /no kitty window with id/;
// The standing orders of the drill seat: it never approves anything itself.
const SEAT_BRIEF = `You are a throwaway test seat for a delivery drill. Rules:
- Do only the single action a message asks for, and nothing else.
- Reply with one short word or sentence.
- Never grant, request or work around a permission: if a tool call needs approval, wait for the human or the harness to decide.
- Never edit files outside the current folder, never touch the network except where a message names a repository.
`;
// agent-send exit code for a window that no longer exists.
const CLOSED_EXIT = 1;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const body = src.split('// HELP-BEGIN\n')[1].split('// HELP-END')[0];
  let out = body.split('\n').map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
  for (const s of STATES) out = out.replace(`<LIMIT_${s.toUpperCase()}>`, String(DEFAULT_LIMITS_S[s]));
  process.stdout.write(out);
  process.exit(0);
}

const usage = (msg) => {
  process.stderr.write(`fleet-drill: ${msg}\nusage: fleet-drill.mjs --states <list|all>   (--help lists the states)\n`);
  process.exit(2);
};
const bin = (envName, dflt) => process.env[envName] || dflt;
const B = {
  claudeTab: bin('FLEET_DRILL_CLAUDE_TAB', path.join(HERE, 'claude-tab.sh')),
  agentSend: bin('FLEET_DRILL_AGENT_SEND', path.join(HERE, 'agent-send.mjs')),
  kittySend: bin('FLEET_DRILL_KITTY_SEND', path.join(HERE, 'kitty-send.sh')),
  tabState: bin('FLEET_DRILL_TAB_STATE', path.join(HERE, 'tab-state.sh')),
  typingProof: bin('FLEET_DRILL_TYPING_PROOF', null),
  exportBin: bin('FLEET_DRILL_EXPORT', path.join(HERE, 'switchboard-export.mjs')),
  kitty: bin('FLEET_DRILL_KITTY', 'kitty'),
  gh: bin('FLEET_DRILL_GH', 'gh'),
};
const SANDBOX = process.env.FLEET_DRILL_SANDBOX || null;
const MERGE_CMD = process.env.FLEET_DRILL_MERGE_CMD || null;

const argAt = process.argv.indexOf('--states');
if (argAt < 0 || !process.argv[argAt + 1]) usage('--states is required');
const wanted = process.argv[argAt + 1] === 'all'
  ? STATES.filter((s) => s !== 'merge' || SANDBOX)
  : process.argv[argAt + 1].split(',').map((s) => s.trim()).filter(Boolean);
for (const s of wanted) if (!STATES.includes(s)) usage(`unknown state '${s}' (known: ${STATES.join(', ')})`);
if (wanted.length === 0) usage('--states names no state');
if (!process.env.FLEET_DRILL_STORE_DIR) usage('FLEET_DRILL_STORE_DIR is required: a folder for the drill\'s own store, so a headless kitty\'s window ids cannot collide with a live seat\'s');
if (wanted.includes('merge') && !(SANDBOX && MERGE_CMD)) usage('the merge state needs FLEET_DRILL_SANDBOX and FLEET_DRILL_MERGE_CMD');
const states = STATES.filter((s) => wanted.includes(s));

// Children see the injected store dir; the ambient store pin would win over it.
// Both pins, because the db pin outranks the dir. claude-tab.sh passes them on
// to the seat with kitty's --env, since kitty starts the tab from its own env.
const childEnv = {
  ...process.env,
  AGENT_SWITCHBOARD_DIR: process.env.FLEET_DRILL_STORE_DIR,
  AGENT_SWITCHBOARD_DB: path.join(process.env.FLEET_DRILL_STORE_DIR, 'state.db'),
};
fs.mkdirSync(childEnv.AGENT_SWITCHBOARD_DIR, { recursive: true });
const run = (cmd, args, { timeoutS = 120, input } = {}) =>
  spawnSync(cmd, args, { env: childEnv, encoding: 'utf8', timeout: timeoutS * 1000, input });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (m) => process.stderr.write(`fleet-drill: ${m}\n`);

const waitFor = async (fn, seconds) => {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(POLL_MS());
  }
};

// ---- seat plumbing -------------------------------------------------------
let wid = null;
let headless = null;
let cwd = null;

const ensureKitty = async () => {
  if (run(B.kitty, ['@', 'ls'], { timeoutS: 10 }).status === 0) return true;
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-drill-kitty-')), 'k.sock');
  note('no kitty answers `kitty @ ls`: starting a headless one');
  headless = spawn(B.kitty, ['-o', 'allow_remote_control=yes', '--listen-on', `unix:${sock}`], { stdio: 'ignore', env: childEnv });
  headless.on('error', () => {});
  childEnv.KITTY_LISTEN_ON = `unix:${sock}`;
  process.env.KITTY_LISTEN_ON = childEnv.KITTY_LISTEN_ON;
  return Boolean(await waitFor(() => run(B.kitty, ['@', 'ls'], { timeoutS: 5 }).status === 0, 30));
};

// tab-state prints JSON for a window it can read. For one that is gone it prints
// nothing on stdout and `tab-state: no such window: N ...` on stderr, exit 1
// (only --watch prints a `state=gone` line, which this drill never uses).
// Anything else is a crash, or kitty not answering: an error, never "gone".
const seatState = () => {
  const r = run(B.tabState, [String(wid), '--json'], { timeoutS: 20 });
  try { return JSON.parse(r.stdout); } catch { /* not JSON */ }
  if (r.status === 1 && /^tab-state: no such window: \d+/m.test(r.stderr ?? '')) return { state: 'gone' };
  return { state: 'error', reason: `tab-state exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}` };
};
const isIdle = () => seatState().state === 'idle';
const isWaiting = () => { const s = seatState(); return s.state === 'unknown' && /waiting/.test(s.reason ?? ''); };
const isBusy = () => seatState().state === 'busy';
const composerEmptyAndIdle = () => {
  if (B.typingProof) return run(B.typingProof, ['--window', String(wid), '--mode', 'idle'], { timeoutS: 20 }).status === 0;
  return run(process.execPath, [path.join(HERE, '..', 'lib', 'typing-proof.mjs'), '--window', String(wid), '--mode', 'idle'], { timeoutS: 20 }).status === 0;
};
const sendKeys = (keys) => run(B.kitty, ['@', 'send-text', '--match', `id:${wid}`, keys], { timeoutS: 10 });
// Types a setup prompt into an idle seat (not part of what is measured).
const prompt = (text) => run(B.kittySend, ['--to', String(wid), '--text', text, '--wait-idle', String(SETUP_S())], { timeoutS: SETUP_S() + 60 });
const screenText = () => run(B.kitty, ['@', 'get-text', '--match', `id:${wid}`], { timeoutS: 10 }).stdout ?? '';
// Approves the prompt on screen only when it shows `marker`, this drill's own command.
const approveIfShowing = (marker) => {
  if (screenText().includes(marker)) sendKeys('\\r');
};
const token = () => randomBytes(4).toString('hex');

const startSeat = async () => {
  if (!(await ensureKitty())) return 'no kitty remote control and a headless kitty did not come up';
  cwd = fs.mkdtempSync(path.join(process.env.FLEET_DRILL_CWD_ROOT || os.tmpdir(), 'fleet-drill-'));
  const brief = path.join(cwd, '.fleet-drill-brief.md');
  fs.writeFileSync(brief, SEAT_BRIEF);
  const r = run(B.claudeTab, ['--seat', '--title', 'fleet-drill', '--model', process.env.FLEET_DRILL_MODEL || 'haiku', '--cwd', cwd, '--brief', brief], { timeoutS: 200 });
  const m = /^WINDOW_ID=(\d+)/m.exec(r.stdout ?? '');
  if (m) wid = Number(m[1]);
  if (r.status !== 0) return `claude-tab exit ${r.status}: ${(r.stderr ?? '').trim().split('\n').pop()}`;
  if (wid == null) return 'claude-tab printed no WINDOW_ID';
  if (!(await waitFor(isIdle, READY_S()))) return `seat did not reach idle in ${READY_S()} s`;
  return null;
};

// claude-tab --close refuses a --seat window (no launcher state row), so the
// window is closed through kitty itself.
const closeSeat = () => {
  if (wid == null) return true;
  const r = run(B.kitty, ['@', 'close-window', '--match', `id:${wid}`], { timeoutS: 30 });
  if (r.status !== 0) note(`kitty close-window for window ${wid} exited ${r.status}: the seat may still be open`);
  wid = null;
  return r.status === 0;
};

// ---- the store -----------------------------------------------------------
const storeRows = () => {
  const r = run(B.exportBin, ['mailbox'], { timeoutS: 30 });
  try { return JSON.parse(r.stdout); } catch { return []; }
};
// The ack for the newest message with exactly this text sent at or after sinceMs.
const findAck = (text, sinceMs) => {
  const rows = storeRows();
  const msgs = rows.filter((r) => r.text === text && r.id && Date.parse(r.ts) >= sinceMs - 2000);
  for (const msg of msgs.reverse()) {
    const a = rows.find((r) => r.ack === msg.id);
    if (a) return a;
  }
  return null;
};

// Pass: an ack row with deliveredAs, and either a clean send or a consumer's label.
const accepted = (sent, ack) => Boolean(ack?.deliveredAs) && (sent.status === 0 || CONSUMER_LABELS.includes(ack.deliveredAs));
const rejectReason = (state, sent, ack) =>
  ack?.deliveredAs
    ? fail(`ack deliveredAs=${ack.deliveredAs} but agent-send exited ${sent.status}: only a consumer label (${CONSUMER_LABELS.join(', ')}) counts then`, ack.deliveredAs)
    : noAck(state, sent);

// Sends `text` and waits for its ack within the state's limit.
const sendAndAck = async (state, text) => {
  const since = Date.now();
  const lim = limitS(state);
  const sent = run(B.agentSend, ['--to', String(wid), '--text', text], { timeoutS: lim });
  const a = await waitFor(() => findAck(text, since), Math.max(0, lim - (Date.now() - since) / 1000));
  return { sent, ack: a };
};

// ---- the states ----------------------------------------------------------
const fail = (reason, deliveredAs = null) => ({ ok: false, reason, deliveredAs });
const pass = (deliveredAs, reason = '') => ({ ok: true, reason, deliveredAs });
const noAck = (state, sent) => fail(`no ack row with deliveredAs within ${limitS(state)} s (agent-send exit ${sent.status}${sent.stderr ? `: ${sent.stderr.trim().split('\n').pop()}` : ''})`);

const checks = {
  async idle() {
    if (!(await waitFor(isIdle, SETUP_S()))) return fail('seat not idle before the send');
    const { sent, ack } = await sendAndAck('idle', `fleet-drill idle ${token()}: reply with the single word ok.`);
    return accepted(sent, ack) ? pass(ack.deliveredAs) : rejectReason('idle', sent, ack);
  },

  async slash() {
    if (!(await waitFor(isIdle, SETUP_S()))) return fail('seat not idle before the send');
    const t0 = Date.now();
    const { sent, ack } = await sendAndAck('slash', SLASH_TEXT);
    if (!accepted(sent, ack)) return rejectReason('slash', sent, ack);
    const left = Math.max(1, limitS('slash') - (Date.now() - t0) / 1000);
    if (!(await waitFor(composerEmptyAndIdle, left))) {
      return fail(`acked as ${ack.deliveredAs} but the composer did not empty: the slash command was typed and never submitted`, ack.deliveredAs);
    }
    return pass(ack.deliveredAs);
  },

  async busy() {
    if (!(await waitFor(isIdle, SETUP_S()))) return fail('seat not idle before the setup');
    const tok = token();
    prompt(`Use the Bash tool to run exactly this command, then reply done: sleep ${SLEEP_SECONDS} && echo DRILL-$((6*7))-${tok}`);
    const reached = await waitFor(() => {
      if (isWaiting()) approveIfShowing(`DRILL-$((6*7))-${tok}`); // only this drill's own command
      return isBusy();
    }, SETUP_S());
    if (!reached) return fail('seat never went busy for the sleep tool call');
    const session = seatState().session;
    const { sent, ack } = await sendAndAck('busy', `fleet-drill busy ${token()}: reply with the single word ok.`);
    if (!accepted(sent, ack)) return rejectReason('busy', sent, ack);
    if (ack.deliveredAs === 'typed') {
      return fail('delivered by typing onto a busy seat: that interrupts the turn and discards the tool result in flight', 'typed');
    }
    if (!(await waitFor(isIdle, SETTLE_S()))) return fail(`seat did not finish its turn in ${SETTLE_S()} s`, ack.deliveredAs);
    const result = `DRILL-42-${tok}`;
    const lost = !transcriptHasToolResult(session, result);
    return lost ? fail(`tool result ${result} is missing from the transcript: the in-flight tool call was discarded`, ack.deliveredAs) : pass(ack.deliveredAs);
  },

  async permission() {
    if (!(await waitFor(isIdle, SETUP_S()))) return fail('seat not idle before the setup');
    const tok = token();
    prompt(`Use the Bash tool to run exactly this command, then reply done: touch fleet-drill-${tok}`);
    if (!(await waitFor(isWaiting, SETUP_S()))) return fail('seat never showed a permission prompt');
    const { sent, ack } = await sendAndAck('permission', `fleet-drill permission ${token()}: reply with the single word ok.`);
    sendKeys('\\x1b'); // refuse the tool call, whatever happened
    await waitFor(isIdle, SETTLE_S());
    return accepted(sent, ack) ? pass(ack.deliveredAs) : rejectReason('permission', sent, ack);
  },

  async merge() {
    if (!(await waitFor(isIdle, SETUP_S()))) return fail('seat not idle before the setup');
    const tok = `fleet-drill-${token()}`;
    prompt(`Clone ${SANDBOX} with gh, create a branch, add an empty file named ${tok}.txt, commit it, push it, and run gh pr create with the title "${tok}". Then reply done.`);
    const pr = await waitFor(() => {
      const r = run(B.gh, ['pr', 'list', '-R', SANDBOX, '--search', tok, '--state', 'all', '--json', 'number,title'], { timeoutS: 30 });
      try { return JSON.parse(r.stdout).find((p) => p.title.includes(tok)) ?? null; } catch { return null; }
    }, limitS('merge'));
    if (!pr) return fail(`the seat opened no PR titled ${tok} in ${SANDBOX}`);
    const m = run('sh', ['-c', `${MERGE_CMD} "$@"`, 'sh', SANDBOX, String(pr.number)], { timeoutS: limitS('merge') });
    let state = null;
    await waitFor(() => {
      const r = run(B.gh, ['pr', 'view', String(pr.number), '-R', SANDBOX, '--json', 'state'], { timeoutS: 30 });
      try { state = JSON.parse(r.stdout).state; } catch { state = null; }
      return state === 'MERGED';
    }, limitS('merge'));
    return state === 'MERGED' ? pass(null) : fail(`PR #${pr.number} ended ${state ?? 'unreadable'}, not MERGED (merge command exit ${m.status})`);
  },

  async closed() {
    const closedWid = wid;
    const r = run(B.kitty, ['@', 'close-window', '--match', `id:${closedWid}`], { timeoutS: 30 });
    if (r.status !== 0) return fail(`could not close the seat window: kitty close-window exit ${r.status}`);
    wid = null;
    if (!(await waitFor(() => seatState().state === 'gone', 30))) return fail('the seat window is still listed after close-window');
    const text = `fleet-drill closed ${token()}: nobody is listening.`;
    const since = Date.now();
    const sent = run(B.agentSend, ['--to', String(closedWid), '--text', text], { timeoutS: limitS('closed') });
    const a = findAck(text, since);
    if (a) return fail(`a message to a closed seat was acked (${a.deliveredAs})`, a.deliveredAs ?? null);
    if (sent.status === 0) return fail('agent-send exited 0 for a closed seat: a silent success');
    if (sent.status !== CLOSED_EXIT) return fail(`agent-send exit ${sent.status}, documented exit for a missing window is ${CLOSED_EXIT}`);
    if (!CLOSED_TEXT.test(sent.stderr ?? '')) return fail(`exit ${CLOSED_EXIT} but not the missing-window message (expected "no kitty window with id"): ${(sent.stderr ?? '').trim().split('\n').pop()}`);
    return pass(null, `exit ${sent.status}, nothing delivered`);
  },
};

const transcriptHasToolResult = (file, marker) => {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes(marker)) continue;
      const row = JSON.parse(line);
      const content = JSON.stringify(row?.message?.content ?? '');
      if (content.includes('"tool_result"') && content.includes(marker)) return true;
    }
  } catch { /* unreadable transcript counts as lost */ }
  return false;
};

// ---- main ----------------------------------------------------------------
const results = [];
const cleanup = () => {
  if (!closeSeat() && !process.exitCode) process.exitCode = 1;
  if (headless) headless.kill();
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let failed = [];
try {
  const seatErr = await startSeat();
  if (seatErr) {
    note(`seat did not start: ${seatErr}`);
    process.exitCode = 2;
  } else {
    for (const state of states) {
      const t0 = Date.now();
      let res;
      try { res = await checks[state](); } catch (e) { res = fail(`drill error: ${e?.message ?? e}`); }
      const line = { state, ok: res.ok, ms: Date.now() - t0, deliveredAs: res.deliveredAs ?? null, reason: res.reason };
      results.push(line);
      process.stdout.write(`${JSON.stringify(line)}\n`);
    }
    failed = results.filter((r) => !r.ok).map((r) => r.state);
    process.stdout.write(`${JSON.stringify({ summary: true, ok: failed.length === 0, passed: results.filter((r) => r.ok).map((r) => r.state), failed })}\n`);
    if (failed.length) {
      note(`FAILED: ${failed.join(', ')}`);
      process.exitCode = 1;
    }
  }
} finally {
  cleanup();
}
