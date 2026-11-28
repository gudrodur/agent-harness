// Prompt delivery into an OpenCode session, through its own server's HTTP API.
//
// A seat whose terminal cannot be typed into — a busy machine, a TUI that lost
// its window, a client showing "operation timed out" while its session keeps
// running — still has a session that lives on the server. The server is where
// a prompt belongs: `POST /api/session/<id>/prompt` puts the text in the
// session's inbox (delivered before the next model call as `steer`, or after
// the current work as `queue`), and the 200 answer carries the id of the user
// message it created. Reading that message back with
// `GET /api/session/<id>/message/<messageId>` is the proof that it is there.
// This is the same call the phone client makes.
//
// Where the server is and how to authenticate come from the service registry
// that the client writes beside its config, a small JSON `{port, password}`:
// the config one first, then the state one — the order and the two files the
// launcher reads, so the sender and the client can never disagree. The
// password is read here and used here: it is never printed, never put in argv
// (a process's command line is world-readable), and never part of an error
// message. Errors name the registry file, not the value.
//
// Node >= 24 (global fetch). Every call has a bound; a server that does not
// answer is a fact the caller acts on (fall back to the mailbox), never a hang.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The registry files, in the order a password is looked for. Both carry
// `port`; either may carry `password` (the config one is installed with the
// service, the state one is written by the running client).
export const serviceRegistryFiles = () => {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  return [
    path.join(configHome, 'opencode', 'service.json'),
    path.join(stateHome, 'opencode', 'service.json'),
  ];
};

// Test seam: one registry file replaces both, so a stub server is reached
// without touching the machine's live settings. A path that does not exist is
// simply "no server configured".
const pinnedRegistry = () => process.env.AGENT_SWITCHBOARD_OPENCODE_SERVICE ?? null;

const readJson = (file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

// {url, password, source} for the local server, or {url: null, why}.
// The port comes from the first registry that names a usable one; the password
// from the first that carries it. A missing password is not "no auth": the
// server requires one, so a call without it cannot succeed and saying so now
// is better than a 401 from a server the caller thought was reachable.
export const resolveService = ({ files = null } = {}) => {
  const candidates = files ?? (pinnedRegistry() != null ? [pinnedRegistry()] : serviceRegistryFiles());
  let port = null;
  let password = null;
  let source = null;
  const seen = [];
  for (const file of candidates) {
    const j = readJson(file);
    if (!j) continue;
    seen.push(file);
    if (port == null && Number.isInteger(j.port) && j.port > 0) port = j.port;
    if (password == null && typeof j.password === 'string' && j.password !== '') {
      password = j.password;
      source = file;
    }
  }
  if (port == null) return { url: null, password: null, source: null, files: seen, why: 'no service registry names a port' };
  if (password == null) return { url: `http://127.0.0.1:${port}`, password: null, source: null, files: seen, why: `the service registry ${seen.length ? seen.join(' / ') : '(none found)'} carries no password` };
  return { url: `http://127.0.0.1:${port}`, password, source, files: seen, why: null };
};

// An OpenCode session id: the `ses_` prefix plus a suffix of id characters.
// Claude Code session ids are UUIDs and never match; the server itself is the
// final authority (a 404 falls back to the mailbox), so this only decides
// whether asking is worth a round trip.
export const isOpencodeSessionId = (sessionId) =>
  typeof sessionId === 'string' && /^ses_[A-Za-z0-9]{4,}$/.test(sessionId);

const authHeader = (password) => `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;

// One JSON request. Never throws: a timeout, a refused connection, a body that
// is not JSON — each is an answer the caller acts on. `data` is the parsed
// body when it parsed, whatever the status.
export const requestJson = async ({ service = resolveService(), apiPath, method = 'GET', body = null, timeoutMs = 5000 } = {}) => {
  if (!service?.url) return { ok: false, code: 'unconfigured', why: service?.why ?? 'no server configured' };
  if (!service.password) return { ok: false, code: 'unconfigured', why: service.why ?? 'no password for the server' };
  let res;
  try {
    res = await fetch(`${service.url}${apiPath}`, {
      method,
      headers: {
        authorization: authHeader(service.password),
        ...(body != null ? { 'content-type': 'application/json' } : {}),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? `the server at ${service.url} did not answer within ${timeoutMs} ms` : `the server at ${service.url} could not be reached`;
    return { ok: false, code: 'unreachable', why };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized', status: res.status, data, why: 'the server refused the credentials in the service registry' };
  if (res.status === 404) return { ok: false, code: 'not-found', status: res.status, data, why: 'the server has no such session' };
  if (!res.ok) {
    const detail = data?.message ?? data?._tag ?? null;
    return { ok: false, code: 'refused', status: res.status, data, why: `the server answered ${res.status}${detail ? ` (${detail})` : ''}` };
  }
  return { ok: true, status: res.status, data };
};

// Every session the server knows, as {id, directory}. A session's directory is
// what the prompt call's `directory` query names.
export const listSessions = async ({ service = resolveService(), timeoutMs = 5000 } = {}) => {
  const r = await requestJson({ service, apiPath: '/api/session', timeoutMs });
  if (!r.ok) return r;
  const rows = Array.isArray(r.data?.data) ? r.data.data : [];
  return {
    ok: true,
    sessions: rows
      .filter((s) => typeof s?.id === 'string')
      .map((s) => ({ id: s.id, directory: s?.location?.directory ?? null })),
  };
};

// The sessions whose agent is running right now, as a Set of ids. This is the
// server's own word on liveness: a seat whose session is here is alive, even
// when its window and its beacon say otherwise.
export const activeSessionIds = async ({ service = resolveService(), timeoutMs = 5000 } = {}) => {
  const r = await requestJson({ service, apiPath: '/api/session/active', timeoutMs });
  if (!r.ok) return r;
  const map = r.data?.data && typeof r.data.data === 'object' ? r.data.data : {};
  return { ok: true, ids: new Set(Object.keys(map)) };
};

// Put the text in the session's inbox and prove it by reading the message
// back. `delivery` is the server's own vocabulary: `steer` reaches the agent
// before its next model call (and starts a run when the session is idle),
// `queue` waits until the current work finishes.
//
// Answers: {ok: true, messageId, delivery, directory} on proof;
// {ok: false, code: 'unproven', messageId, why} when the prompt was accepted
// but the read-back did not find it (the caller must not resend blind);
// otherwise the requestJson failure, untouched.
export const deliverPrompt = async ({
  sessionId,
  text,
  delivery = 'steer',
  directory = null,
  service = resolveService(),
  timeoutMs = 5000,
} = {}) => {
  if (!isOpencodeSessionId(sessionId)) return { ok: false, code: 'not-opencode', why: 'not an OpenCode session id' };
  if (delivery !== 'steer' && delivery !== 'queue') return { ok: false, code: 'refused', why: `delivery must be steer or queue, got ${delivery}` };
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const sent = await requestJson({
    service,
    apiPath: `/api/session/${encodeURIComponent(sessionId)}/prompt${query}`,
    method: 'POST',
    body: { text, delivery },
    timeoutMs,
  });
  if (!sent.ok) return sent;
  const messageId = sent.data?.data?.id ?? null;
  if (typeof messageId !== 'string' || messageId === '') {
    return { ok: false, code: 'unproven', messageId: null, why: 'the server accepted the prompt but named no message id to read back' };
  }
  const back = await requestJson({
    service,
    apiPath: `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
    timeoutMs,
  });
  if (!back.ok) {
    return { ok: false, code: 'unproven', messageId, why: `the prompt's message ${messageId} could not be read back: ${back.why}` };
  }
  if (back.data?.data?.id !== messageId) {
    return { ok: false, code: 'unproven', messageId, why: `reading message ${messageId} back answered with a different id` };
  }
  return { ok: true, messageId, delivery, directory, message: back.data.data };
};
