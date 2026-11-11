// Shared SQLite store for agent-switchboard runtime state.
//
// One database file (WAL mode) holds the coordination state that used to live
// in JSON files: the mailbox, presence beacons, and later steps' claims and
// measurements. Versioned config (providers, lean overlay, issue areas) stays
// JSON in git; this file lives outside git under the switchboard dir.
//
// Path: AGENT_SWITCHBOARD_DB, default $AGENT_SWITCHBOARD_DIR/state.db. No
// personal path literal anywhere in this file.
//
// Runtime: node scripts use the built-in `node:sqlite`, a Bun hook may use
// `bun:sqlite`. Both speak SQLite 3.53 here, one file, so a bun writer and a
// node reader share the database. The pick is synchronous (createRequire), so
// every caller keeps its sync API.
//
// Retention (written rule, enforced by pruneRetention):
// - Acked or cancelled (withdrawn) message rows are deleted 14 days after the
//   ack/withdraw marker, markers included.
// - Unacked rows are NEVER deleted by retention: a closed session's rows
//   survive it, so a probe's evidence outlives its session. Presence-absence
//   deletes nothing; only an explicit ack, cancel, or a later overseer step
//   removes an unacked row.
// - seat_nudges rows are deleted 14 days after the nudge: a session still
//   alive after that may see the claim-role nudge once more.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const isBun = typeof process !== 'undefined' && !!process.versions?.bun;
const sqlite = isBun ? require('bun:sqlite') : require('node:sqlite');

export const runtimeName = () => (isBun ? 'bun:sqlite' : 'node:sqlite');

export const switchboardDir = () =>
  process.env.AGENT_SWITCHBOARD_DIR ??
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'agent-switchboard');

export const defaultStorePath = () =>
  process.env.AGENT_SWITCHBOARD_DB ?? path.join(switchboardDir(), 'state.db');

// Acked/cancelled rows die this long after their marker; unacked rows live.
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mailbox_rows (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  row_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mailbox_recipient ON mailbox_rows (recipient_key, kind, msg_id);
CREATE TABLE IF NOT EXISTS presence_beacons (
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  home_cwd TEXT,
  branch TEXT,
  repo TEXT,
  mailbox INTEGER,
  window_id INTEGER,
  pid INTEGER,
  last_work_tick TEXT,
  last_work_cwd TEXT,
  first_tick TEXT NOT NULL,
  last_tick TEXT NOT NULL,
  PRIMARY KEY (session_id, cwd)
);
-- A seat role is a stable address that outlives the session holding it: the
-- latest claim wins, and mail addressed to role:<name> follows the holder.
-- CREATE IF NOT EXISTS is also the migration: an older store gains the table
-- on its next open.
CREATE TABLE IF NOT EXISTS seat_roles (
  role TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cwd TEXT,
  window_id TEXT,
  claimed_at INTEGER
);
-- One row per session that has been shown the claim-role nudge, so the nudge
-- fires once however many hooks write presence for the same prompt.
CREATE TABLE IF NOT EXISTS seat_nudges (
  session_id TEXT PRIMARY KEY,
  nudged_at INTEGER NOT NULL
);
-- An exclusive lease on a shared resource (a device, a port): one holder at a
-- time, no takeover, released explicitly or by missing heartbeats. mode
-- 'human' means the person at the device holds it and no session may act.
CREATE TABLE IF NOT EXISTS resource_leases (
  resource TEXT PRIMARY KEY,
  holder_session TEXT NOT NULL,
  holder_window TEXT,
  purpose TEXT,
  mode TEXT NOT NULL DEFAULT 'agent',
  scope_json TEXT,
  implicit INTEGER NOT NULL DEFAULT 0,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  ttl_ms INTEGER NOT NULL
);
-- Sessions waiting for a resource, served first come first served. A waiter
-- that stops polling (seen_at goes stale) drops out of the line.
CREATE TABLE IF NOT EXISTS resource_queue (
  resource TEXT NOT NULL,
  session_id TEXT NOT NULL,
  window_id TEXT,
  purpose TEXT,
  enqueued_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (resource, session_id)
);
`;

// One-time import marker: which legacy file set has been absorbed into this db.
export const importMarkerFor = ({ mailboxDir, presenceFile }) => `import_legacy_v1:${mailboxDir ?? ''}:${presenceFile ?? ''}`;

const readJsonlRows = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn final line from a concurrent O_APPEND — skip, don't fail.
    }
  }
  return rows;
};

const classifyRow = (row) => {
  if (row && typeof row.ack === 'string') return { kind: 'ack', msgId: row.ack };
  if (row && typeof row.withdraw === 'string') return { kind: 'withdraw', msgId: row.withdraw };
  if (row && typeof row.id === 'string') return { kind: 'message', msgId: row.id };
  return null;
};

// SQLite busy_timeout per open: how long one statement waits on a lock.
// AGENT_SWITCHBOARD_BUSY_TIMEOUT_MS overrides it (hot-path hooks that must not
// stall a seat: the PostToolUse drain sets 250). Unset, empty, negative,
// fractional or non-numeric values fall back to the default.
export const STORE_BUSY_TIMEOUT_MS = 5000;
export const busyTimeoutMs = (raw = process.env.AGENT_SWITCHBOARD_BUSY_TIMEOUT_MS) => {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return STORE_BUSY_TIMEOUT_MS;
  return Math.min(Number(raw.trim()), 2 ** 31 - 1);
};

export const openStore = (dbPath = defaultStorePath()) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const Database = sqlite.DatabaseSync ?? sqlite.Database;
  const db = isBun ? new Database(dbPath, { create: true }) : new Database(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs()};`);
    // journal_mode change needs an exclusive lock, which a concurrent writer
    // may hold; unlike DML it does not wait on busy_timeout. WAL persists in
    // the file once any opener sets it, so skipping under contention is safe
    // (busy_timeout still serializes our own writes).
    const getMode = (sql) => (typeof db.prepare === 'function' ? db.prepare(sql).get() : db.query(sql).get());
    let mode = null;
    try {
      mode = getMode('PRAGMA journal_mode').journal_mode;
      if (typeof mode === 'string' && mode.toLowerCase() !== 'wal') db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // A concurrent opener holds the lock (the mode read or the change
      // itself does not wait on busy_timeout). WAL persists in the file once
      // any opener sets it, and busy_timeout still serializes our own writes.
    }
    db.exec(SCHEMA);
    // Columns added after a store was first created (CREATE TABLE IF NOT
    // EXISTS leaves an old table as it was). A concurrent opener may add the
    // same column first; the duplicate-column error is that race, not a fault.
    const cols = new Set(
      (typeof db.prepare === 'function' ? db.prepare('PRAGMA table_info(presence_beacons)').all() : db.query('PRAGMA table_info(presence_beacons)').all()).map(
        (c) => c.name,
      ),
    );
    for (const [col, type] of [['pid', 'INTEGER'], ['last_work_tick', 'TEXT'], ['last_work_cwd', 'TEXT']]) {
      if (cols.has(col)) continue;
      try {
        db.exec(`ALTER TABLE presence_beacons ADD COLUMN ${col} ${type};`);
      } catch (e) {
        if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
      }
    }
  } catch (e) {
    try {
      db.close();
    } catch {
      // Ignore close errors when open already failed.
    }
    throw e;
  }
  const prepare = (sql) => (typeof db.prepare === 'function' ? db.prepare(sql) : db.query(sql));
  const run = (sql, ...params) => prepare(sql).run(...params);
  const get = (sql, ...params) => prepare(sql).get(...params);
  const all = (sql, ...params) => prepare(sql).all(...params);
  const transaction = (fn) => {
    // bun:sqlite: .immediate() so the write lock is taken at BEGIN like the
    // node path below; a DEFERRED read-then-write fails SQLITE_BUSY_SNAPSHOT
    // when another connection commits in between.
    if (typeof db.transaction === 'function') return db.transaction(fn).immediate();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const out = fn();
      db.exec('COMMIT;');
      return out;
    } catch (e) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Rollback of a failed begin is best-effort.
      }
      throw e;
    }
  };
  const close = () => db.close();
  return { path: dbPath, run, get, all, transaction, close };
};

// ---- a busy store is waited out, never failed on first contact ---------------
// openStore waits busy_timeout (5 s, AGENT_SWITCHBOARD_BUSY_TIMEOUT_MS) for a lock and then throws SQLITE_BUSY
// ("database is locked"). Under load a mailbox or presence call can outlast
// that, so withRetriedStore re-runs the whole open + import + fn on a busy
// error until STORE_BUSY_DEADLINE_MS has passed, then throws. // the companion repo's coordination store.
export const STORE_BUSY_DEADLINE_MS = 20_000;
// AGENT_SWITCHBOARD_BUSY_DEADLINE_MS overrides it (tests, a slow disk).
const busyDeadlineMs = () => {
  const n = Number(process.env.AGENT_SWITCHBOARD_BUSY_DEADLINE_MS);
  return Number.isFinite(n) && n >= 0 && process.env.AGENT_SWITCHBOARD_BUSY_DEADLINE_MS ? n : STORE_BUSY_DEADLINE_MS;
};

// SQLITE_BUSY and its extended codes (BUSY_RECOVERY 261, BUSY_SNAPSHOT 517,
// BUSY_TIMEOUT 773) share primary code 5. node:sqlite reports it as
// { code: 'ERR_SQLITE_ERROR', errcode }, bun:sqlite as { code: 'SQLITE_BUSY*',
// errno }; both say "database is locked".
export const isStoreBusy = (e) => {
  if (!e || typeof e !== 'object') return false;
  if (typeof e.code === 'string' && e.code.startsWith('SQLITE_BUSY')) return true;
  if (e.code === 'ERR_SQLITE_ERROR' && Number.isInteger(e.errcode) && (e.errcode & 0xff) === 5) return true;
  return /\bdatabase is locked\b/i.test(String(e.message ?? ''));
};

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Run fn, again on every busy error, until deadlineMs has passed since the
// first attempt; the last busy error is thrown. Any other error is thrown at
// once. Backoff is 25 ms doubling to 400 ms, with jitter so waiters do not
// wake in step. fn must be safe to re-run: every write sits in one statement
// or transaction, which a busy error leaves unapplied.
export const retryBusy = (fn, { deadlineMs = busyDeadlineMs(), now = Date.now, sleep = sleepSync } = {}) => {
  const start = now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fn();
    } catch (e) {
      if (!isStoreBusy(e) || now() - start >= deadlineMs) throw e;
      const step = Math.min(400, 25 * 2 ** attempt);
      sleep(step / 2 + Math.random() * step);
    }
  }
};

// Open the default store, import the legacy files once, run fn(store), close.
// importOptions is a thunk: legacy sources resolve at call time, never at
// import time, so a temp HOME in tests never reads the live files.
export const withRetriedStore = (importOptions, fn, retry = {}) =>
  retryBusy(() => {
    const store = openStore(defaultStorePath());
    try {
      importLegacy(store, importOptions());
      return fn(store);
    } finally {
      store.close();
    }
  }, retry);

// Absorb an existing mailbox dir (*.jsonl) and presence file ({beacons: [...]})
// into the open store. Idempotent per (db, mailboxDir, presenceFile): the
// marker in meta records it, so a second open imports nothing. The old files
// are left in place; deleting them is a separate overseer step.
export const importLegacy = (store, { mailboxDir = null, presenceFile = null } = {}) => {
  const marker = importMarkerFor({ mailboxDir, presenceFile });
  // Every open lands here: a plain read of the marker first keeps an
  // already-imported store from taking the write lock on every open, so a
  // read no longer queues behind writers. The marker is never deleted, so a
  // present one settles it; an absent one still goes through the INSERT OR
  // IGNORE election below.
  if (store.get('SELECT 1 AS one FROM meta WHERE k = ?', marker)) return { imported: false };
  // The claim lives INSIDE the transaction: two processes opening one fresh
  // db both see the marker absent, so a check-then-insert outside would
  // double-import (UNIQUE constraint failed: meta.k). INSERT OR IGNORE
  // elects one winner; the loser rolls back an empty transaction.
  let outcome = { imported: false };
  store.transaction(() => {
    const claim = store.run('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)', marker, new Date().toISOString());
    if (Number(claim.changes ?? 0) === 0) return;
    let messages = 0;
    let beacons = 0;
    if (mailboxDir) {
      let files = [];
      try {
        files = fs.readdirSync(mailboxDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        files = [];
      }
      for (const f of files) {
        const key = f.slice(0, -'.jsonl'.length);
        for (const row of readJsonlRows(path.join(mailboxDir, f))) {
          const c = classifyRow(row);
          if (!c) continue;
          store.run(
            'INSERT INTO mailbox_rows (recipient_key, kind, msg_id, ts, row_json) VALUES (?, ?, ?, ?, ?)',
            key,
            c.kind,
            c.msgId,
            typeof row.ts === 'string' ? row.ts : new Date(0).toISOString(),
            JSON.stringify(row),
          );
          messages += 1;
        }
      }
    }
    if (presenceFile) {
      let beaconsRaw = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(presenceFile, 'utf-8'));
        if (parsed && Array.isArray(parsed.beacons)) beaconsRaw = parsed.beacons;
      } catch {
        beaconsRaw = [];
      }
      for (const b of beaconsRaw) {
        if (!b || typeof b.cwd !== 'string') continue;
        store.run(
          `INSERT INTO presence_beacons
             (session_id, cwd, home_cwd, branch, repo, mailbox, window_id, first_tick, last_tick)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (session_id, cwd) DO NOTHING`,
          b.sessionId ?? 'anon',
          b.cwd,
          b.homeCwd ?? null,
          b.branch ?? null,
          b.repo ?? null,
          b.mailbox == null ? null : b.mailbox ? 1 : 0,
          b.windowId == null ? null : Number(b.windowId),
          b.firstTick ?? b.lastTick ?? new Date(0).toISOString(),
          b.lastTick ?? b.firstTick ?? new Date(0).toISOString(),
        );
        beacons += 1;
      }
    }
    outcome = { imported: true, messages, beacons };
  });
  return outcome;
};

// Enforce the retention rule written at the top of this file. Returns the
// deleted message count. Unacked rows are never touched.
export const pruneRetention = (store, { now = Date.now() } = {}) => {
  const cutoff = new Date(now - RETENTION_MS).toISOString();
  let deleted = 0;
  store.transaction(() => {
    const staleMarkers = store.all(
      `SELECT DISTINCT msg_id FROM mailbox_rows
        WHERE kind IN ('ack', 'withdraw') AND ts < ?`,
      cutoff,
    );
    for (const { msg_id: id } of staleMarkers) {
      const r = store.run('DELETE FROM mailbox_rows WHERE msg_id = ?', id);
      deleted += Number(r.changes ?? 0);
    }
    store.run('DELETE FROM seat_nudges WHERE nudged_at < ?', now - RETENTION_MS);
  });
  return { deleted };
};
