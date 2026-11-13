#!/usr/bin/env node
// The store half of `claude-tab.sh --retire` and `--reseat`; the launcher calls
// it, nobody types it. Prints one JSON object on stdout and exits 0 whenever it
// could answer, so the caller reads the verdict, not the exit code.
//
//   seat-handover.mjs check  <window-id> <taker-session>
//       {ok: true, id, pid, displacedSession, role}  or  {ok: false, reason}
//       reason: no-handover | other-taker | already-retired
//   seat-handover.mjs retired <handover-id>
//       {ok: true}  (sets retired_at)
//   seat-handover.mjs holder <role>
//       {held: bool, session, window}  (who holds the role now)
//   seat-handover.mjs verify <role> <window-id> <taker-session>
//       {claimed: bool, retired: bool}
//
// A missing store answers as "nothing recorded"; it is never created here.
import { checkHandover, markRetired, readHandoverDb, reseatState } from '../lib/seat-handover.mjs';
import { roleHolder, withRolesDb } from '../lib/seat-roles.mjs';

const [cmd, ...a] = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
try {
  if (cmd === 'check' && a.length === 2) {
    const r = readHandoverDb((db) => checkHandover(db, { window: a[0], takerSession: a[1] }), { ok: false, reason: 'no-handover' });
    out(r.ok ? { ok: true, id: r.row.id, pid: r.row.displaced_pid, displacedSession: r.row.displaced_session, role: r.row.role } : r);
  } else if (cmd === 'retired' && a.length === 1) {
    out({ ok: withRolesDb((db) => markRetired(db, a[0])) });
  } else if (cmd === 'holder' && a.length === 1) {
    out(readHandoverDb((db) => {
      const h = roleHolder(db, a[0]);
      return h ? { held: true, session: h.session_id, window: h.window_id } : { held: false };
    }, { held: false }));
  } else if (cmd === 'verify' && a.length === 3) {
    out(readHandoverDb((db) => reseatState(db, { role: a[0], window: a[1], takerSession: a[2] }), { claimed: false, retired: false }));
  } else {
    process.stderr.write('usage: seat-handover.mjs check <window> <taker> | holder <role> | retired <id> | verify <role> <window> <taker>\n');
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`seat-handover: ${e.message}\n`);
  process.exit(1);
}
