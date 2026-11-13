#!/usr/bin/env node
// The store half of `claude-tab.sh --close <window> --after-loka`; the launcher
// calls it, nobody types it. Prints one JSON object on stdout and exits 0
// whenever it could answer, so the caller reads the verdict, not the exit code.
//
//   seat-finished.mjs check <session-id> <since-ms> <transcript-path>
//       {finished: true, id, ts}               the seat is shown to be finished
//       {finished: false, reason}              it is not; reason is one of
//         no-marker     no LOKA-DONE row from this session since <since-ms>
//                       (a withdrawn row does not count)
//         holds-role    the session holds a role in seat_roles
//         later-mail    a message row from or to the session is newer than the marker
//         later-turn    the transcript has a prompt newer than the marker
//         no-transcript the transcript cannot be read, so activity cannot be ruled out
//
// THE MARKER. The seat's /loka close-out reports its end with one message whose
// text is exactly
//
//     LOKA-DONE <session-id>
//
// and nothing else (no surrounding text, no quotes), sent by that same session.
// Free text such as "send loka done to me" is never proof: only the whole
// message matching ^LOKA-DONE <session-id>$ is, and the id in it must be the
// session's own. The sender key ("from") is self-asserted (it comes from
// CLAUDE_CODE_SESSION_ID), so the marker can be forged by a process that knows
// the id; the checks that remain are the role refusal, silence after the marker
// and the launcher's pid, session and idle guards. A missing store answers
// {finished: false}; it is never created here.
import fs from 'node:fs';
import { sanitizeSessionId } from '../lib/agent-mailbox.mjs';
import { readRolesDb, rolesForSession } from '../lib/seat-roles.mjs';

export const lokaMarker = (sessionId) => `LOKA-DONE ${sessionId}`;

const messages = (db, sinceIso) =>
  db.all("SELECT recipient_key, row_json FROM mailbox_rows WHERE kind = 'message' AND ts >= ? ORDER BY rowid", sinceIso)
    .map((r) => ({ ...JSON.parse(r.row_json), recipientKey: r.recipient_key }));

// A prompt in the transcript: a user row that is not a tool result.
const isPrompt = (row) => {
  if (row?.type !== 'user') return false;
  const c = row.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && !c.some((b) => b?.type === 'tool_result');
};

const promptAfter = (transcript, afterMs) => {
  const text = fs.readFileSync(transcript, 'utf8');
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (isPrompt(row) && Date.parse(row.timestamp) > afterMs) return true;
  }
  return false;
};

export const finishedVerdict = (db, { sessionId, sinceMs = 0, transcript = null }) => {
  if (rolesForSession(db, sessionId).length) return { finished: false, reason: 'holds-role' };
  const sid = sanitizeSessionId(sessionId);
  const suffix = `__${sid}`;
  const sinceIso = new Date(Number(sinceMs)).toISOString();
  const rows = messages(db, sinceIso);
  const withdrawn = new Set(db.all("SELECT msg_id FROM mailbox_rows WHERE kind = 'withdraw'").map((r) => r.msg_id));
  const marker = rows.filter((m) =>
    String(m.from ?? '').endsWith(suffix) && m.text === lokaMarker(sessionId) && !withdrawn.has(m.id) && Date.parse(m.ts) >= Number(sinceMs),
  ).at(-1);
  if (!marker) return { finished: false, reason: 'no-marker' };
  const markerMs = Date.parse(marker.ts);
  const later = rows.some((m) => m.id !== marker.id && !withdrawn.has(m.id) && Date.parse(m.ts) > markerMs
    && (String(m.from ?? '').endsWith(suffix) || m.recipientKey.endsWith(suffix)));
  if (later) return { finished: false, reason: 'later-mail' };
  if (!transcript) return { finished: false, reason: 'no-transcript' };
  try {
    if (promptAfter(transcript, markerMs)) return { finished: false, reason: 'later-turn' };
  } catch {
    return { finished: false, reason: 'no-transcript' };
  }
  return { finished: true, id: marker.id, ts: marker.ts };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'check' && a.length === 3) {
    try {
      const v = readRolesDb((db) => finishedVerdict(db, { sessionId: a[0], sinceMs: a[1], transcript: a[2] }), null);
      process.stdout.write(`${JSON.stringify(v ?? { finished: false, reason: 'no-marker' })}\n`);
    } catch (e) {
      process.stderr.write(`seat-finished: ${e.message}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write('usage: seat-finished.mjs check <session-id> <since-ms> <transcript-path>\n');
    process.exit(2);
  }
}
