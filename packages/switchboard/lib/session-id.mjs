// The session-id half of a mailbox key, kept in one place because two libs
// need it and neither may import the other (agent-mailbox imports the seat
// close, so a seat helper that imported agent-mailbox would be a cycle).
//
// A session id is used as a filesystem name and as a key suffix, so unsafe
// characters collapse to '_' the same way in every caller. `anon` when there
// is nothing to keep, so a key is never empty.
export const sanitizeSessionId = (sessionId) =>
  String(sessionId ?? 'anon').replace(/[^A-Za-z0-9._-]+/g, '_') || 'anon';
