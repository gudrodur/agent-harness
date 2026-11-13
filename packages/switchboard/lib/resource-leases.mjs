// Resource leases: exclusive, queued, expiring holds on a shared resource.
//
// A seat role (lib/seat-roles.mjs) is an address, so the latest claim takes it
// over. A lease is the opposite: while one session holds a resource, every
// other session is refused and may wait in a first-come-first-served line.
// The resource is any string the caller picks, for example `phone:<serial>`.
//
// A lease ends when its holder releases it, when no heartbeat arrives within
// ttl_ms, or when the injected isLive(sessionId) says the holder's session is
// gone. A human hold (mode 'human') is the person at the device saying "mine
// now": it outranks any session, refuses every one including the previous
// holder, ends only by an explicit release or its TTL, and puts the session it
// displaced at the head of the line so that session gets the resource back
// first.
//
// authorize() is the gate a hook or wrapper calls before acting. It refreshes
// the holder's heartbeat, and when the resource is free and nobody is waiting
// it grants an IMPLICIT lease with a short TTL, so a session working alone
// never has to know leases exist; refusals happen only under real contention.
//
// Every function takes an open store (lib/store.mjs openStore) and runs in one
// BEGIN IMMEDIATE transaction, so two sessions cannot both win a free
// resource. `now` and `isLive` are injectable for tests.

export const LEASE_TTL_MS = 10 * 60 * 1000;
export const IMPLICIT_TTL_MS = 90 * 1000;
export const HUMAN_TTL_MS = 15 * 60 * 1000;
export const QUEUE_STALE_MS = 60 * 1000;
export const HUMAN = 'human';

const RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export const validateResource = (resource) => {
  if (typeof resource !== 'string' || !RESOURCE_RE.test(resource)) {
    throw new Error(`invalid resource '${resource}': use [A-Za-z0-9][A-Za-z0-9:._-]{0,127}`);
  }
  return resource;
};

const needSession = (sessionId, fn) => {
  if (sessionId == null || sessionId === '') throw new Error(`${fn} needs a session id`);
  return String(sessionId);
};

const fmtLease = (row, now) =>
  row && {
    resource: row.resource,
    holder: row.holder_session,
    window: row.holder_window ?? null,
    purpose: row.purpose ?? null,
    mode: row.mode,
    scope: row.scope_json ? JSON.parse(row.scope_json) : null,
    implicit: !!row.implicit,
    heldForMs: now - row.acquired_at,
    idleMs: now - row.heartbeat_at,
    expiresInMs: row.heartbeat_at + row.ttl_ms - now,
  };

const fmtQueue = (rows) => rows.map((r, i) => ({ position: i + 1, session: r.session_id, window: r.window_id ?? null, purpose: r.purpose ?? null }));

// Drop an expired or orphaned lease and stale or dead waiters. Returns the live lease row or null.
// While a human hold is on, nobody can be served, so waiters do not age out (only a dead session leaves);
// when the hold ends, by release or TTL, every waiter's clock restarts so the line survives the hold.
const prune = (db, resource, now, isLive) => {
  let row = db.get('SELECT * FROM resource_leases WHERE resource = ?', resource);
  if (row) {
    const expired = now - row.heartbeat_at > row.ttl_ms;
    const dead = row.mode !== HUMAN && isLive && isLive(row.holder_session) === false;
    if (expired || dead) {
      db.run('DELETE FROM resource_leases WHERE resource = ?', resource);
      if (row.mode === HUMAN) freshenWaiters(db, resource, now);
      row = null;
    }
  }
  const humanHold = row?.mode === HUMAN;
  for (const w of db.all('SELECT session_id, seen_at FROM resource_queue WHERE resource = ?', resource)) {
    if ((!humanHold && now - w.seen_at > QUEUE_STALE_MS) || (isLive && isLive(w.session_id) === false)) {
      db.run('DELETE FROM resource_queue WHERE resource = ? AND session_id = ?', resource, w.session_id);
    }
  }
  return row;
};

const freshenWaiters = (db, resource, now) => db.run('UPDATE resource_queue SET seen_at = ? WHERE resource = ?', now, resource);

const queueRows = (db, resource) =>
  db.all('SELECT * FROM resource_queue WHERE resource = ? ORDER BY enqueued_at, rowid', resource);

const enqueue = (db, { resource, sessionId, windowId, purpose, now, at = now }) => {
  db.run(
    `INSERT INTO resource_queue (resource, session_id, window_id, purpose, enqueued_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (resource, session_id) DO UPDATE SET seen_at = excluded.seen_at,
       window_id = COALESCE(excluded.window_id, window_id), purpose = COALESCE(excluded.purpose, purpose)`,
    resource, sessionId, windowId, purpose, at, now,
  );
  const q = queueRows(db, resource);
  return { position: q.findIndex((r) => r.session_id === sessionId) + 1, queue: fmtQueue(q) };
};

const grant = (db, { resource, sessionId, windowId, purpose, scope, implicit, ttlMs, now }) => {
  db.run('DELETE FROM resource_queue WHERE resource = ? AND session_id = ?', resource, sessionId);
  db.run(
    `INSERT INTO resource_leases (resource, holder_session, holder_window, purpose, mode, scope_json, implicit, acquired_at, heartbeat_at, ttl_ms)
     VALUES (?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?)`,
    resource, sessionId, windowId, purpose, scope == null ? null : JSON.stringify(scope), implicit ? 1 : 0, now, now, ttlMs,
  );
};

/**
 * Take the resource, or join the line for it.
 * Returns {granted: true, renewed, lease} or {granted: false, holder, position, queue}.
 * A holder calling again renews: the heartbeat, purpose, scope and TTL update and an implicit lease becomes explicit.
 */
export const acquire = (db, { resource, sessionId, windowId = null, purpose = null, scope = null, ttlMs = LEASE_TTL_MS, now = Date.now(), isLive = null } = {}) => {
  validateResource(resource);
  const sid = needSession(sessionId, 'acquire');
  const win = windowId == null ? null : String(windowId);
  return db.transaction(() => {
    const held = prune(db, resource, now, isLive);
    if (held && held.mode !== HUMAN && held.holder_session === sid) {
      db.run(
        `UPDATE resource_leases SET heartbeat_at = ?, ttl_ms = ?, implicit = 0, purpose = COALESCE(?, purpose),
           scope_json = COALESCE(?, scope_json), holder_window = COALESCE(?, holder_window) WHERE resource = ?`,
        now, ttlMs, purpose, scope == null ? null : JSON.stringify(scope), win, resource,
      );
      return { granted: true, renewed: true, lease: fmtLease(db.get('SELECT * FROM resource_leases WHERE resource = ?', resource), now) };
    }
    if (!held) {
      const head = queueRows(db, resource)[0];
      if (!head || head.session_id === sid) {
        grant(db, { resource, sessionId: sid, windowId: win, purpose, scope, implicit: false, ttlMs, now });
        return { granted: true, renewed: false, lease: fmtLease(db.get('SELECT * FROM resource_leases WHERE resource = ?', resource), now) };
      }
    }
    const { position, queue } = enqueue(db, { resource, sessionId: sid, windowId: win, purpose, now });
    return { granted: false, holder: fmtLease(held, now), position, queue };
  });
};

/**
 * The gate. {allowed: true, lease} when this session holds the resource (its heartbeat is refreshed) or when
 * the resource is free and nobody waits (an implicit lease is granted). Otherwise {allowed: false, reason, holder, queue}
 * with reason 'human' (a human hold), 'held' (another session) or 'queued' (free, but others are first in line).
 * Never enqueues: refusing a stray call must not put its session in line.
 */
export const authorize = (db, { resource, sessionId, windowId = null, purpose = null, implicitTtlMs = IMPLICIT_TTL_MS, now = Date.now(), isLive = null } = {}) => {
  validateResource(resource);
  const sid = needSession(sessionId, 'authorize');
  return db.transaction(() => {
    const held = prune(db, resource, now, isLive);
    // A refusal is how a waiting session polls: it keeps its place fresh (never joins the line here).
    db.run('UPDATE resource_queue SET seen_at = ? WHERE resource = ? AND session_id = ?', now, resource, sid);
    const queue = fmtQueue(queueRows(db, resource));
    if (held?.mode === HUMAN) return { allowed: false, reason: 'human', holder: fmtLease(held, now), queue };
    if (held && held.holder_session === sid) {
      db.run('UPDATE resource_leases SET heartbeat_at = ? WHERE resource = ?', now, resource);
      return { allowed: true, lease: fmtLease({ ...held, heartbeat_at: now }, now) };
    }
    if (held) return { allowed: false, reason: 'held', holder: fmtLease(held, now), queue };
    if (queue.length && queue[0].session !== sid) return { allowed: false, reason: 'queued', holder: null, queue };
    grant(db, { resource, sessionId: sid, windowId: windowId == null ? null : String(windowId), purpose, scope: null, implicit: true, ttlMs: implicitTtlMs, now });
    return { allowed: true, implicit: true, lease: fmtLease(db.get('SELECT * FROM resource_leases WHERE resource = ?', resource), now) };
  });
};

/** Refresh the holder's heartbeat. {ok: true} for the holder, {ok: false, holder} otherwise. */
export const heartbeat = (db, { resource, sessionId, now = Date.now(), isLive = null } = {}) => {
  validateResource(resource);
  const sid = needSession(sessionId, 'heartbeat');
  return db.transaction(() => {
    const held = prune(db, resource, now, isLive);
    if (held && held.mode !== HUMAN && held.holder_session === sid) {
      db.run('UPDATE resource_leases SET heartbeat_at = ? WHERE resource = ?', now, resource);
      return { ok: true };
    }
    return { ok: false, holder: fmtLease(held, now) };
  });
};

/**
 * Give the resource up. A session releases only its own lease ({released: false, holder} otherwise);
 * `human: true` ends a human hold, which any caller may do on the person's word. Leaving the line counts too.
 */
export const release = (db, { resource, sessionId = null, human = false, now = Date.now() } = {}) => {
  validateResource(resource);
  return db.transaction(() => {
    const held = db.get('SELECT * FROM resource_leases WHERE resource = ?', resource);
    if (sessionId != null) db.run('DELETE FROM resource_queue WHERE resource = ? AND session_id = ?', resource, String(sessionId));
    if (!held) return { released: false };
    const mine = human ? held.mode === HUMAN : held.mode !== HUMAN && held.holder_session === String(sessionId);
    if (!mine) return { released: false, holder: fmtLease(held, now) };
    db.run('DELETE FROM resource_leases WHERE resource = ?', resource);
    if (held.mode === HUMAN) freshenWaiters(db, resource, now);
    return { released: true };
  });
};

/**
 * The person at the device takes it. Any agent lease is displaced, and its holder goes to the head of the line.
 * `by` records which session set the hold on the person's behalf (informational).
 */
export const holdHuman = (db, { resource, purpose = null, by = null, ttlMs = HUMAN_TTL_MS, now = Date.now() } = {}) => {
  validateResource(resource);
  return db.transaction(() => {
    const held = db.get('SELECT * FROM resource_leases WHERE resource = ?', resource);
    let displaced = null;
    if (held && held.mode !== HUMAN) {
      displaced = held.holder_session;
      const first = queueRows(db, resource)[0];
      enqueue(db, { resource, sessionId: displaced, windowId: held.holder_window, purpose: held.purpose, now, at: first ? Math.min(first.enqueued_at, now) - 1 : now });
    }
    db.run('DELETE FROM resource_leases WHERE resource = ?', resource);
    db.run(
      `INSERT INTO resource_leases (resource, holder_session, holder_window, purpose, mode, scope_json, implicit, acquired_at, heartbeat_at, ttl_ms)
       VALUES (?, ?, NULL, ?, 'human', ?, 0, ?, ?, ?)`,
      resource, HUMAN, purpose, by == null ? null : JSON.stringify({ by: String(by) }), now, now, ttlMs,
    );
    return { held: true, displaced, lease: fmtLease(db.get('SELECT * FROM resource_leases WHERE resource = ?', resource), now) };
  });
};

/** The live lease (or null) and the line, after pruning. */
export const status = (db, { resource, now = Date.now(), isLive = null } = {}) => {
  validateResource(resource);
  return db.transaction(() => {
    const held = prune(db, resource, now, isLive);
    return { resource, lease: fmtLease(held, now), queue: fmtQueue(queueRows(db, resource)) };
  });
};

/** The live leases a session holds (not human holds), by the same expiry rule as status(). */
export const heldBy = (db, { sessionId, now = Date.now(), isLive = null } = {}) =>
  db.all("SELECT resource FROM resource_leases WHERE holder_session = ? AND mode != ?", String(sessionId), HUMAN)
    .map((r) => status(db, { resource: r.resource, now, isLive }).lease)
    .filter((l) => l && l.holder === String(sessionId));
