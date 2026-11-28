#!/usr/bin/env node
// Send a prompt to an OpenCode session through its server's HTTP API, and read
// the message back as proof. One command, one JSON answer on stdout, one
// verdict line on stderr, and an exit code a shell caller can branch on. The
// server's password is read from its service registry inside lib/opencode-server.mjs
// and never leaves this process.
//
// Usage:
//   opencode-prompt.mjs send --session <id> [--directory <dir>]
//                            [--delivery steer|queue] [--drain] [--text <line>]
//                            [--server <url>]... [--pid <pid>]
//                            [--timeout <ms>]        (text may come on stdin)
//   opencode-prompt.mjs drain --session <id> [--server <url>]... [--pid <pid>]
//                            [--timeout <ms>]
//   opencode-prompt.mjs active [--timeout <ms>]
//   opencode-prompt.mjs sessions [--timeout <ms>]
//   opencode-prompt.mjs --help
//
// A tab started with `--standalone` runs its own server and holds the session
// there, while the shared registry's server only has the session's record.
// `--server` names such a server (repeatable, tried in order) and `--pid` names
// the tab's process, whose loopback listeners are tried first. Both are tried
// before the registry, and the server that takes the prompt also answers the
// read-back. A server that answers "no such session" hands the text to the
// next one, so a stale candidate is not a failed delivery.
//
// `--drain` and the `drain` command: a prompt delivered with `delivery: queue`
// waits until the agent finishes its current work, which a seat looping inside
// one turn never does. A drain reads everything the session's inbox still holds
// with that delivery and posts ONE steer item carrying every note and the time
// it was queued (delivered before the agent's next model call, mid-work), then
// deletes the originals. `send --drain` drains first and then sends its own
// text as a steer.
//
// Exit codes:
//   0   send/drain: delivered (and drained, if asked) and read back; or the
//       inbox held nothing to drain. active/sessions: the answer is on stdout.
//   3   send/drain: the server accepted the item but the read-back did not
//       prove it (do not resend; look at the session).
//   1   send/drain: refused (not an OpenCode session, 404, 401, 400/409).
//   12  no server configured, or it did not answer.
//   2   usage error.
//
// Output on stdout is one JSON object per line:
//   send      {"ok":true,"phase":"drained","drained":N,"messageId":"..."}
//             only with --drain and N > 0: the backlog went as one steer;
//             {"ok":true,"phase":"accepted","messageId":"...","delivery":"steer"}
//             printed the moment the server takes the prompt, before the
//             read-back starts, so a caller that kills this process mid-proof
//             can still see the text is in and must not send it again;
//             then the final line:
//             {"ok":true,"messageId":"...","delivery":"steer","session":"...",
//              "server":"http://127.0.0.1:<port>","proof":"inbox"|"message"}
//             {"ok":false,"code":"unproven","messageId":"...","why":"..."}
//             {"ok":false,"code":"not-found","why":"..."}
//   drain     {"ok":true,"drained":N,"messageId":...,"server":...,"proof":...,
//              "undeleted":[...]}
//   active    {"ok":true,"running":["ses_..."]}
//   sessions  {"ok":true,"sessions":[{"id":"...","directory":"..."}]}
//
// Tests pin a registry with AGENT_SWITCHBOARD_OPENCODE_SERVICE (see
// lib/opencode-server.mjs).

import fs from 'node:fs';
import { deliverPrompt, activeSessionIds, listSessions, isOpencodeSessionId, discoverServerUrls, drainQueuedPrompt } from '../lib/opencode-server.mjs';

const USAGE = `Usage:
  opencode-prompt.mjs send --session <id> [--directory <dir>]
                           [--delivery steer|queue] [--drain] [--text <line>]
                           [--server <url>]... [--pid <pid>]
                           [--timeout <ms>]
  opencode-prompt.mjs drain --session <id> [--server <url>]... [--pid <pid>]
                           [--timeout <ms>]
  opencode-prompt.mjs active [--timeout <ms>]
  opencode-prompt.mjs sessions [--timeout <ms>]
  opencode-prompt.mjs --help`;

const die = (msg, code = 2) => {
  process.stderr.write(`opencode-prompt: ${msg}\n`);
  process.exit(code);
};

// Synchronous on purpose: the accepted marker must be on the pipe before the
// read-back starts, or a caller's timeout can lose it and resend the text.
const out = (obj) => fs.writeSync(1, `${JSON.stringify(obj)}\n`);
const readStdin = () => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

// The reason codes that mean "this is not a seat I can reach, stop asking":
// no server, no such session, refusing credentials. The caller falls back to
// the mailbox, which is where those deliveries belong.
const REQUEST_FAILURE_EXIT = { unconfigured: 12, unreachable: 12, 'not-found': 1, unauthorized: 1, refused: 1, 'not-opencode': 1 };

const main = async (argv) => {
  const [cmd, ...rest] = argv;
  if (cmd == null || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(cmd == null ? 2 : 0);
  }
  let session = null;
  let directory = null;
  let delivery = 'steer';
  let text = null;
  let timeoutMs = 5000;
  let drainFirst = false;
  const servers = [];
  let tabPid = null;
  while (rest.length > 0) {
    const a = rest.shift();
    const need = (name) => {
      const v = rest.shift();
      if (v === undefined) die(`${name} needs a value`);
      return v;
    };
    if (a === '--session') session = need('--session');
    else if (a === '--directory') directory = need('--directory');
    else if (a === '--delivery') delivery = need('--delivery');
    else if (a === '--text') text = need('--text');
    else if (a === '--timeout') timeoutMs = Number(need('--timeout'));
    else if (a === '--drain') drainFirst = true;
    else if (a === '--server') {
      const url = need('--server').replace(/\/$/, '');
      if (!/^https?:\/\/[^/]/.test(url)) die(`--server takes an http(s) URL, got: ${url}`);
      servers.push(url);
    } else if (a === '--pid') {
      const pid = Number(need('--pid'));
      if (!Number.isInteger(pid) || pid <= 0) die('--pid takes a positive process id');
      tabPid = pid;
    } else die(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) die('--timeout must be a positive number of milliseconds');

  if (cmd === 'active') {
    const r = await activeSessionIds({ timeoutMs });
    if (!r.ok) die(r.why, REQUEST_FAILURE_EXIT[r.code] ?? 12);
    out({ ok: true, running: [...r.ids].sort() });
    return;
  }
  if (cmd === 'sessions') {
    const r = await listSessions({ timeoutMs });
    if (!r.ok) die(r.why, REQUEST_FAILURE_EXIT[r.code] ?? 12);
    out({ ok: true, sessions: r.sessions });
    return;
  }
  if (cmd !== 'send' && cmd !== 'drain') die(`unknown command: ${cmd}\n${USAGE}`);

  if (session == null || session === '') die(`${cmd} needs --session <id>`);
  if (!isOpencodeSessionId(session)) die(`not an OpenCode session id: ${session}`, 1);
  if (cmd === 'send' && delivery !== 'steer' && delivery !== 'queue') die(`--delivery must be steer or queue, got ${delivery}`);
  const body = cmd === 'send' ? (text ?? readStdin()) : '';
  if (cmd === 'send' && body === '') die('send needs --text or text on stdin');

  // The tab's own server first: it is the one that holds a standalone client's
  // session. `--server` names are tried in the order given, after the ones
  // found from the process tree (an explicit name is the caller's own belief,
  // the loopback listener is what the tab actually holds). Discovery never
  // throws: an unreadable /proc is simply no candidate, and the registry is
  // used as before.
  const candidates = [...servers];
  if (tabPid != null) {
    let found = [];
    try {
      found = discoverServerUrls(tabPid);
    } catch {
      found = [];
    }
    for (const url of found) if (!candidates.includes(url)) candidates.push(url);
  }

  if (cmd === 'drain') {
    const r = await drainQueuedPrompt({ sessionId: session, timeoutMs, servers: candidates });
    if (r.ok) {
      out({ ok: true, drained: r.drained, messageId: r.messageId ?? null, server: r.server ?? null, proof: r.proof ?? null, undeleted: r.undeleted ?? [] });
      process.stderr.write(
        `opencode-prompt: drained ${r.drained} queued note(s) into one steer for ${session}` +
          `${r.messageId ? ` (item ${r.messageId})` : ''}` +
          `${r.undeleted?.length ? `; could not delete ${r.undeleted.join(', ')}: those may arrive again` : ''}\n`,
      );
      return;
    }
    if (r.code === 'unproven') {
      out({ ok: false, code: 'unproven', messageId: r.messageId ?? null, drained: r.drained ?? 0, why: r.why });
      process.stderr.write(`opencode-prompt: the combined note reached ${session} but could not be read back (${r.why}); do not resend, look at the session\n`);
      process.exit(3);
    }
    out({ ok: false, code: r.code ?? 'refused', why: r.why ?? 'the drain was refused' });
    die(`${r.why ?? 'the drain was refused'}`, REQUEST_FAILURE_EXIT[r.code] ?? 1);
  }

  // A note of delivery `queue` waits for the end of the turn, which a seat
  // looping inside one turn never reaches: drain that backlog into one steer
  // before adding this text, so a long-running seat reads both mid-work.
  if (drainFirst) {
    const d = await drainQueuedPrompt({ sessionId: session, timeoutMs: Math.max(1000, timeoutMs), servers: candidates });
    if (!d.ok) {
      out({ ok: false, phase: 'drain', code: d.code ?? 'refused', why: d.why ?? 'the drain was refused' });
      if (d.code === 'unproven') {
        process.stderr.write(`opencode-prompt: the queued notes reached ${session} but could not be read back (${d.why}); the new text was NOT sent: look at the session first\n`);
        process.exit(3);
      }
      die(`${d.why ?? 'the drain was refused'}`, REQUEST_FAILURE_EXIT[d.code] ?? 1);
    }
    if (d.drained > 0) out({ ok: true, phase: 'drained', drained: d.drained, messageId: d.messageId, server: d.server ?? null });
  }

  const r = await deliverPrompt({
    sessionId: session, text: body, delivery, directory, timeoutMs, servers: candidates,
    onAccepted: ({ messageId }) => out({ ok: true, phase: 'accepted', messageId, delivery, session }),
  });
  if (r.ok) {
    out({ ok: true, messageId: r.messageId, delivery: r.delivery, session, server: r.server ?? null, proof: r.proof ?? null });
    process.stderr.write(`opencode-prompt: delivered to ${session} (item ${r.messageId}, ${r.delivery}, ${r.proof === 'inbox' ? 'in its inbox' : 'in its message log'}, ${r.server ?? 'the registry server'})\n`);
    return;
  }
  if (r.code === 'unproven') {
    out({ ok: false, code: 'unproven', messageId: r.messageId ?? null, why: r.why });
    process.stderr.write(`opencode-prompt: the prompt reached ${session} but it could not be read back from the inbox or message log (${r.why}); do not resend, look at the session\n`);
    process.exit(3);
  }
  out({ ok: false, code: r.code ?? 'refused', why: r.why ?? 'the server refused the prompt' });
  die(`${r.why ?? 'the prompt was refused'}`, REQUEST_FAILURE_EXIT[r.code] ?? 1);
};

main(process.argv.slice(2));
