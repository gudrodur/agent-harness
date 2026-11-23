#!/usr/bin/env node
// Print the switchboard role the store holds, the one claimed last, for a session id, or nothing.
//
// Usage: seat-role.mjs <sessionId>
//
// A missing, unreadable or role-less store prints nothing and exits 0: callers
// (claude-resume-set.sh --snapshot) treat "no role" as a normal answer, never a failure.
import { readRolesDb, rolesForSessionLatest } from '../lib/seat-roles.mjs';

try {
  const [role] = readRolesDb((db) => rolesForSessionLatest(db, process.argv[2]), []);
  if (role) process.stdout.write(`${role}\n`);
} catch {
  // unreadable store: no role
}
