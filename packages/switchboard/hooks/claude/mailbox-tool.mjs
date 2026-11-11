#!/usr/bin/env node
// PostToolUse hook: mailbox drain at a tool boundary.
//
// mailbox-inject.mjs drains only at the next UserPromptSubmit and
// mailbox-stop.mjs only when the turn ends, so a seat in a long autonomous
// turn (dozens of tool calls) could not receive a correction until the turn
// was over. This hook reads the session's unacked rows (by session id, as the
// other two do), acks each with deliveredAs "tool" BEFORE printing, and
// prints {"hookSpecificOutput":{"hookEventName":"PostToolUse",
// "additionalContext":...}} with the rows whose ack landed, so the model sees
// them right after the tool result.
//
// It runs after every tool call, so the empty path is the hot path: no
// presence refresh, no role claim, no output, one inbox read. Only a row
// whose ack landed is shown; a row that could not be acked waits for the
// next prompt or Stop rather than being shown twice.
// A subagent call (payload.agent_id set) exits 0 untouched: only the main thread drains.
// Every error path exits 0 with no stdout.

import { mailboxFileDir, readInbox, formatInboxLines, ack } from '../../lib/agent-mailbox.mjs';

const readStdin = (timeoutMs = 500) =>
  new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(buf), timeoutMs);
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(buf);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(buf);
    });
  });

try {
  const raw = await readStdin(500);
  let sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;
  try {
    const payload = JSON.parse(raw);
    if (typeof payload.session_id === 'string') sessionId = payload.session_id;
    // A subagent's tool call fires this hook with the PARENT's session_id plus
    // a non-empty agent_id. Draining there would show (and ack) mail meant for
    // the main thread inside the subagent. Only the main thread drains.
    if (typeof payload.agent_id === 'string' && payload.agent_id !== '') process.exit(0);
  } catch {
    // No / malformed payload: fall back to the env session id.
  }
  const dir = mailboxFileDir();
  const opts = dir ? { dir } : {};
  const found = readInbox(sessionId, opts);
  const acked = (found ?? []).filter(({ key, row }) => {
    try {
      ack({ key, id: row.id, deliveredAs: 'tool', ...opts });
      return true;
    } catch {
      return false;
    }
  });
  if (acked.length) {
    const additionalContext = ['[mailbox] These messages arrived while you were working:', ...formatInboxLines(acked)].join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }));
  }
} catch {
  // Never let the drain disrupt the session.
}
process.exit(0);
