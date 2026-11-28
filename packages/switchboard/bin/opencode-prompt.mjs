#!/usr/bin/env node
// Send a prompt to an OpenCode session through its server's HTTP API, and read
// the message back as proof. One command, one JSON answer on stdout, one
// verdict line on stderr, and an exit code a shell caller can branch on. The
// server's password is read from its service registry inside lib/opencode-server.mjs
// and never leaves this process.
//
// Usage:
//   opencode-prompt.mjs send --session <id> [--directory <dir>]
//                            [--delivery steer|queue] [--text <line>]
//                            [--timeout <ms>]        (text may come on stdin)
//   opencode-prompt.mjs active [--timeout <ms>]
//   opencode-prompt.mjs sessions [--timeout <ms>]
//   opencode-prompt.mjs --help
//
// Exit codes:
//   0   send: delivered and read back. active/sessions: the answer is on stdout.
//   3   send: the server accepted the prompt but the read-back did not prove it
//       (do not resend; look at the session).
//   1   send: refused (not an OpenCode session, 404, 401, 400/409).
//   12  no server configured, or it did not answer.
//   2   usage error.
//
// Output on stdout is a single JSON object:
//   send      {"ok":true,"messageId":"...","delivery":"steer","session":"..."}
//             {"ok":false,"code":"unproven","messageId":"...","why":"..."}
//             {"ok":false,"code":"not-found","why":"..."}
//   active    {"ok":true,"running":["ses_..."]}
//   sessions  {"ok":true,"sessions":[{"id":"...","directory":"..."}]}
//
// Tests pin a registry with AGENT_SWITCHBOARD_OPENCODE_SERVICE (see
// lib/opencode-server.mjs).

import fs from 'node:fs';
import { deliverPrompt, activeSessionIds, listSessions, isOpencodeSessionId } from '../lib/opencode-server.mjs';

const USAGE = `Usage:
  opencode-prompt.mjs send --session <id> [--directory <dir>]
                           [--delivery steer|queue] [--text <line>]
                           [--timeout <ms>]
  opencode-prompt.mjs active [--timeout <ms>]
  opencode-prompt.mjs sessions [--timeout <ms>]
  opencode-prompt.mjs --help`;

const die = (msg, code = 2) => {
  process.stderr.write(`opencode-prompt: ${msg}\n`);
  process.exit(code);
};

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
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
    else die(`unknown argument: ${a}`);
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
  if (cmd !== 'send') die(`unknown command: ${cmd}\n${USAGE}`);

  if (session == null || session === '') die('send needs --session <id>');
  if (!isOpencodeSessionId(session)) die(`not an OpenCode session id: ${session}`, 1);
  if (delivery !== 'steer' && delivery !== 'queue') die(`--delivery must be steer or queue, got ${delivery}`);
  const body = text ?? readStdin();
  if (body === '') die('send needs --text or text on stdin');

  const r = await deliverPrompt({ sessionId: session, text: body, delivery, directory, timeoutMs });
  if (r.ok) {
    out({ ok: true, messageId: r.messageId, delivery: r.delivery, session });
    process.stderr.write(`opencode-prompt: delivered to ${session} (message ${r.messageId}, ${r.delivery})\n`);
    return;
  }
  if (r.code === 'unproven') {
    out({ ok: false, code: 'unproven', messageId: r.messageId ?? null, why: r.why });
    process.stderr.write(`opencode-prompt: the prompt reached ${session} but its message could not be read back (${r.why}); do not resend, look at the session\n`);
    process.exit(3);
  }
  out({ ok: false, code: r.code ?? 'refused', why: r.why ?? 'the server refused the prompt' });
  die(`${r.why ?? 'the prompt was refused'}`, REQUEST_FAILURE_EXIT[r.code] ?? 1);
};

main(process.argv.slice(2));
