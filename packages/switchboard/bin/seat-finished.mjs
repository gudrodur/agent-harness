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
//         holds-role    the session claimed a role AFTER its marker (the marker
//                       itself ends the claims it held, and the close releases them)
//         holds-lease   the session holds a live resource lease, or waits in a resource queue
//                       (lib/resource-leases.mjs)
//         later-mail    a message row from or to the session is newer than the marker;
//                       role-store events (row.roleEvent, e.g. a takeover notice) are
//                       bookkeeping and are not counted
//         later-turn    the transcript has a prompt newer than the marker
//         no-transcript the transcript cannot be read, so activity cannot be ruled out
//
// A finished verdict also ends the seat's claims in the store: every role row
// it still holds is released and its session id is marked closed, so a seat
// whose marker was recorded before that rule existed is cleaned up here, and
// nothing can claim the role back (lib/seat-roles.mjs closeSeat).
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
import { isMainModule } from '../lib/cli-entry.mjs';
import { sanitizeSessionId } from '../lib/session-id.mjs';
import { lokaMarker } from '../lib/loka-marker.mjs';
import { closeSeat, readRolesDb, roleClaimsForSession } from '../lib/seat-roles.mjs';
import { heldBy, waitingFor } from '../lib/resource-leases.mjs';

export { lokaMarker };

const messages = (db, sinceIso) =>
  db.all("SELECT recipient_key, row_json FROM mailbox_rows WHERE kind = 'message' AND ts >= ? ORDER BY rowid", sinceIso)
    .map((r) => ({ ...JSON.parse(r.row_json), recipientKey: r.recipient_key }));

// A prompt in the transcript: a user row that is not a tool result, or a mid-turn steer.
const isPrompt = (row) => {
  // A message sent mid-turn is stored as a queued_command attachment.
  if (row?.type === 'attachment' && row.attachment?.type === 'queued_command') return true;
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
  // The marker ends the claims the seat held when it sent it; only a claim made
  // AFTER it is the seat working again. (A picky claim after the marker is
  // refused at the store, lib/seat-roles.mjs claimRole; this covers a row that
  // was written before that rule, or by hand.)
  if (roleClaimsForSession(db, sessionId).some((r) => Number(r.claimed_at ?? 0) > markerMs)) {
    return { finished: false, reason: 'holds-role' };
  }
  if (heldBy(db, { sessionId }).length || waitingFor(db, { sessionId }).length) return { finished: false, reason: 'holds-lease' };
  // Role-store events (a takeover notice, say) are delivered like mail but are
  // bookkeeping: they do not make the finished seat "working again".
  const later = rows.some((m) => m.id !== marker.id && !withdrawn.has(m.id) && m.roleEvent !== true && Date.parse(m.ts) > markerMs
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

if (isMainModule(import.meta.url)) {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'check' && a.length === 3) {
    try {
      const v = readRolesDb((db) => {
        const verdict = finishedVerdict(db, { sessionId: a[0], sinceMs: a[1], transcript: a[2] });
        if (verdict.finished) closeSeat(db, { sessionId: a[0], markerId: verdict.id, now: Date.parse(verdict.ts) });
        return verdict;
      }, null);
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
