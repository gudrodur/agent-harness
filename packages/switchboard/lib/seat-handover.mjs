// Seat handovers: the record a role takeover leaves so the taker, and only the
// taker, may close the window it displaced.
//
// `agent-send --claim-role R --take-over` writes one row per displaced seat
// (recordHandover). `claude-tab.sh --retire <window>` asks checkHandover
// whether the caller may close that window, closes it, then markRetired. The
// helpers take an open store (lib/store.mjs openStore), like lib/seat-roles.mjs.

import fs from 'node:fs';
import { defaultStorePath } from './store.mjs';
import { withRolesDb } from './seat-roles.mjs';

export const recordHandover = (db, { role, displacedSession, displacedWindow, displacedPid = null, takerSession, now = Date.now() } = {}) => {
  if (!role || !displacedSession || displacedWindow == null || !takerSession) throw new Error('recordHandover needs role, displacedSession, displacedWindow and takerSession');
  db.run(
    `INSERT INTO seat_handovers (role, displaced_session, displaced_window, displaced_pid, taker_session, ts, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    String(role), String(displacedSession), Number(displacedWindow), displacedPid == null ? null : Number(displacedPid), String(takerSession), now,
  );
};

// May `takerSession` retire `window`? {ok: true, row} for the newest unretired
// row naming both; otherwise {ok: false, reason} where reason is
// `no-handover` (nothing names this window), `other-taker` (rows exist, all for
// other sessions) or `already-retired` (this taker's rows are all retired).
export const checkHandover = (db, { window, takerSession } = {}) => {
  const rows = db.all('SELECT * FROM seat_handovers WHERE displaced_window = ? ORDER BY id DESC', Number(window));
  if (rows.length === 0) return { ok: false, reason: 'no-handover' };
  const mine = rows.filter((r) => r.taker_session === String(takerSession));
  if (mine.length === 0) return { ok: false, reason: 'other-taker' };
  const open = mine.find((r) => r.retired_at == null);
  return open ? { ok: true, row: open } : { ok: false, reason: 'already-retired' };
};

export const markRetired = (db, id, now = Date.now()) =>
  Number(db.run('UPDATE seat_handovers SET retired_at = ? WHERE id = ? AND retired_at IS NULL', now, Number(id)).changes ?? 0) === 1;

// Has `takerSession` claimed `role`, and retired the handover for `window`?
// Both halves are reported so a caller can say which one is missing.
export const reseatState = (db, { role, window, takerSession }) => {
  const held = db.get('SELECT session_id FROM seat_roles WHERE role = ?', role);
  const row = db.get(
    'SELECT retired_at FROM seat_handovers WHERE displaced_window = ? AND taker_session = ? ORDER BY id DESC LIMIT 1',
    Number(window), String(takerSession),
  );
  return { claimed: held?.session_id === String(takerSession), retired: row?.retired_at != null };
};

// A store that does not exist has no handovers, and a read must not create it.
export const readHandoverDb = (fn, fallback, dbPath = defaultStorePath()) =>
  fs.existsSync(dbPath) ? withRolesDb(fn, dbPath) : fallback;
