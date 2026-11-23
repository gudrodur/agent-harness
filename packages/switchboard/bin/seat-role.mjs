#!/usr/bin/env node
// Print the switchboard role the store holds, the one claimed last, for a session id, or nothing.
//
// Usage: seat-role.mjs <sessionId>
//
// A missing, unreadable or role-less store prints nothing and exits 0: callers
// (claude-resume-set.sh --snapshot) treat "no role" as a normal answer, never a failure.
import { readRolesDb } from '../lib/seat-roles.mjs';

try {
  const [role] = readRolesDb((db) => db.all('SELECT role FROM seat_roles WHERE session_id = ? ORDER BY claimed_at DESC, role', String(process.argv[2])).map((r) => r.role), []);
  if (role) process.stdout.write(`${role}\n`);
} catch {
  // unreadable store: no role
}
