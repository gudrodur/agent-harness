#!/usr/bin/env node
// The store half of `claude-tab.sh --close <window> --after-loka`; the launcher
// calls it, nobody types it. Prints one JSON object on stdout and exits 0
// whenever it could answer, so the caller reads the verdict, not the exit code.
//
//   seat-finished.mjs check <session-id> <since-ms>
//       {finished: true, id, ts}  when the session sent a "loka done" message
//       at or after <since-ms> (the session's own start), else {finished: false}
//
// A seat reports the end of its close-out as a message whose text says
// "loka done"; the sender key of that row ends in the seat's session id. A
// missing store answers {finished: false}; it is never created here.
import { sanitizeSessionId } from '../lib/agent-mailbox.mjs';
import { readRolesDb } from '../lib/seat-roles.mjs';

const LOKA_DONE = /\bloka done\b/i;

export const lokaDoneRow = (db, { sessionId, sinceMs = 0 }) => {
  const suffix = `__${sanitizeSessionId(sessionId)}`;
  const rows = db.all("SELECT row_json FROM mailbox_rows WHERE kind = 'message' ORDER BY rowid DESC").map((r) => JSON.parse(r.row_json));
  return rows.find((m) => String(m.from ?? '').endsWith(suffix) && LOKA_DONE.test(String(m.text ?? '')) && Date.parse(m.ts) >= Number(sinceMs)) ?? null;
};

const [cmd, ...a] = process.argv.slice(2);
if (cmd === 'check' && a.length === 2) {
  try {
    const m = readRolesDb((db) => lokaDoneRow(db, { sessionId: a[0], sinceMs: a[1] }), null);
    process.stdout.write(`${JSON.stringify(m ? { finished: true, id: m.id, ts: m.ts } : { finished: false })}\n`);
  } catch (e) {
    process.stderr.write(`seat-finished: ${e.message}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write('usage: seat-finished.mjs check <session-id> <since-ms>\n');
  process.exit(2);
}
