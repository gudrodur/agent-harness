// The one definition of a seat's end-of-work marker, shared by the close
// (`claude-tab.sh --close --after-loka`, through bin/seat-finished.mjs) and the
// sender that records it (lib/agent-mailbox.mjs appendMessage).
//
// The marker is ONE message whose whole text is `LOKA-DONE <session id>`, sent
// by that same session. Free text ("loka done", "send LOKA-DONE …") is never a
// marker, and a row whose sender key does not end in that session id is not
// this session's marker. The sender key is self-asserted, so the marker can be
// forged by a process that knows the id; the close's remaining guards (silence
// after it, an idle seat, no later claim) bound that, they do not remove it.
import { sanitizeSessionId } from './session-id.mjs';

export const lokaMarker = (sessionId) => `LOKA-DONE ${sessionId}`;

// The session id a mailbox row is the marker for, or null. The id comes from
// the text (that is what the marker asserts); the row must come from that
// session's own mailbox key, which is `…__<sanitized session id>`.
export const markerSessionFor = (row) => {
  const match = /^LOKA-DONE (\S+)$/.exec(String(row?.text ?? ''));
  if (!match) return null;
  const sessionId = match[1];
  return String(row?.from ?? '').endsWith(`__${sanitizeSessionId(sessionId)}`) ? sessionId : null;
};
