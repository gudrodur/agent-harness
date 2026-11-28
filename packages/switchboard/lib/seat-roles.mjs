// Seat roles: a name that stays valid when the session behind it changes.
//
// A role maps to ONE holder session. A later claim takes the role over, so
// `--to role:lead` keeps working after the lead seat moves to a new window.
// Mail for a role with no live holder waits under the mailbox key
// `role:<name>` and is drained by whichever session holds the role next.
//
// These helpers take an open store (lib/store.mjs openStore) so callers
// control the transaction and the db path; withRolesDb opens the default one.

import fs from 'node:fs';
import { defaultStorePath, openStore } from './store.mjs';

export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROLE_PREFIX = 'role:';

export const validateRoleName = (role) => {
  if (typeof role !== 'string' || !ROLE_NAME_RE.test(role)) {
    throw new Error(`invalid role name '${role}': use [a-z0-9][a-z0-9-]{0,63}`);
  }
  return role;
};

// `role:lead` -> 'lead'; anything else -> null. Does not validate the name.
export const roleFromTarget = (target) =>
  typeof target === 'string' && target.startsWith(ROLE_PREFIX) ? target.slice(ROLE_PREFIX.length) : null;

// The mailbox key mail for a role is stored under.
export const roleMailboxKey = (role) => `${ROLE_PREFIX}${validateRoleName(role)}`;

export const claimRole = (db, { role, sessionId, cwd = null, windowId = null, now = Date.now() } = {}) => {
  validateRoleName(role);
  if (sessionId == null || sessionId === '') throw new Error('claimRole needs a session id');
  const closed = seatClosed(db, sessionId);
  if (closed) {
    const e = new Error(`session ${sessionId} sent its LOKA-DONE marker at ${new Date(closed.ts).toISOString()} and is finished; it cannot claim role ${role} again`);
    e.code = SEAT_CLOSED;
    e.closed = closed;
    throw e;
  }
  db.run(
    `INSERT INTO seat_roles (role, session_id, cwd, window_id, claimed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (role) DO UPDATE SET
       session_id = excluded.session_id, cwd = excluded.cwd,
       window_id = excluded.window_id, claimed_at = excluded.claimed_at`,
    role, String(sessionId), cwd, windowId == null ? null : String(windowId), now,
  );
  return roleHolder(db, role);
};

// Give up a role. Only its holder may: returns {released: true} when this
// session held it, {released: false} when nobody did, and {holder} without
// changing anything when another session does.
export const releaseRole = (db, { role, sessionId } = {}) => {
  validateRoleName(role);
  if (sessionId == null || sessionId === '') throw new Error('releaseRole needs a session id');
  const held = roleHolder(db, role);
  if (held == null) return { released: false };
  if (held.session_id !== String(sessionId)) return { released: false, holder: held };
  db.run('DELETE FROM seat_roles WHERE role = ? AND session_id = ?', role, String(sessionId));
  return { released: true };
};

// The holder row {role, session_id, cwd, window_id, claimed_at}, or null.
export const roleHolder = (db, role) => db.get('SELECT * FROM seat_roles WHERE role = ?', role) ?? null;

export const rolesForSession = (db, sessionId) =>
  sessionId == null
    ? []
    : db.all('SELECT role FROM seat_roles WHERE session_id = ? ORDER BY role', String(sessionId)).map((r) => r.role);

// The roles a session holds, with their claim times: a close needs to tell a
// claim made before the LOKA-DONE marker (ended by it) from one made after
// (the seat working again).
export const roleClaimsForSession = (db, sessionId) =>
  sessionId == null
    ? []
    : db.all('SELECT role, cwd, window_id, claimed_at FROM seat_roles WHERE session_id = ? ORDER BY claimed_at, role', String(sessionId));

// The marker's rule, in the store: a finished session holds no role and cannot
// take one back. Every role row for the session is deleted, whatever location
// it was claimed in, and the closure is recorded so claimRole refuses later.
// Returns what it ended.
export const closeSeat = (db, { sessionId, markerId = null, now = Date.now() } = {}) => {
  if (sessionId == null || sessionId === '') throw new Error('closeSeat needs a session id');
  const ended = rolesForSession(db, sessionId);
  db.run('DELETE FROM seat_roles WHERE session_id = ?', String(sessionId));
  db.run(
    'INSERT INTO seat_closed (session_id, ts, marker_id) VALUES (?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET ts = excluded.ts, marker_id = excluded.marker_id',
    String(sessionId), Number(now), markerId,
  );
  return { sessionId: String(sessionId), ended };
};

// The closure row {session_id, ts, marker_id}, or null.
export const seatClosed = (db, sessionId) =>
  sessionId == null ? null : db.get('SELECT * FROM seat_closed WHERE session_id = ?', String(sessionId)) ?? null;

export const SEAT_CLOSED = 'SEAT_CLOSED';

// Record a refused AGENT_SEAT_ROLE claim. True only for the first caller: the
// hook for one prompt runs more than once (and every later prompt runs it
// again), so INSERT OR IGNORE is what makes the notice once per session.
export const markClaimRefusal = (db, sessionId, { role, detail, now = Date.now() } = {}) =>
  Number(db.run(
    'INSERT OR IGNORE INTO seat_claim_refusals (session_id, role, ts, detail) VALUES (?, ?, ?, ?)',
    String(sessionId), String(role), Number(now), String(detail),
  ).changes ?? 0) === 1;

// The same, newest claim first (ties by name): the role a session took last is the one it runs as.
export const rolesForSessionLatest = (db, sessionId) =>
  sessionId == null
    ? []
    : db.all('SELECT role FROM seat_roles WHERE session_id = ? ORDER BY claimed_at DESC, role', String(sessionId)).map((r) => r.role);

// Record that this session was shown the claim-role nudge. True only for the
// first caller: INSERT OR IGNORE is atomic, so hooks racing on one prompt
// cannot both nudge.
export const markNudged = (db, sessionId, now = Date.now()) =>
  Number(db.run('INSERT OR IGNORE INTO seat_nudges (session_id, nudged_at) VALUES (?, ?)', String(sessionId), now).changes ?? 0) === 1;

export const allRoleHolders = (db) => db.all('SELECT * FROM seat_roles ORDER BY role');

// Open the default store, run fn(db), close.
export const withRolesDb = (fn, dbPath = defaultStorePath()) => {
  const db = openStore(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

// Read-only variant: a store that does not exist yet has no roles, and a
// read must not create it (a session that never uses roles leaves no file).
export const readRolesDb = (fn, fallback, dbPath = defaultStorePath()) =>
  fs.existsSync(dbPath) ? withRolesDb(fn, dbPath) : fallback;
