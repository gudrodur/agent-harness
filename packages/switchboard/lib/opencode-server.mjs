// Prompt delivery into an OpenCode session, through its own server's HTTP API.
//
// A seat whose terminal cannot be typed into — a busy machine, a TUI that lost
// its window, a client showing "operation timed out" while its session keeps
// running — still has a session that lives on the server. The server is where
// a prompt belongs: `POST /api/session/<id>/prompt` puts the text in the
// session's inbox (delivered before the next model call as `steer`, or after
// the current work as `queue`), and the 200 answer is the inbox item it
// created. Reading that item back — `GET /api/session/<id>/inbox`, then the
// message log for an item a run already consumed — is the proof that it is
// there. This is the same call the phone client makes.
//
// Which server: a tab started with `--standalone` runs its own loopback server
// and holds the session there, while the shared service in the registry still
// has the session's record and would take the prompt into an inbox no client
// reads. The caller passes the tab's own servers first (see
// `discoverServerUrls`), the registry server last.
//
// Where the shared server is and how to authenticate come from the service
// registry that the client writes beside its config, a small JSON
// `{port, password}`: the config one first, then the state one — the order and
// the two files the launcher reads, so the sender and the client can never
// disagree. The password is read here and used here: it is never printed, never
// put in argv (a process's command line is world-readable), and never part of an
// error message. Errors name the registry file, not the value.
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
// from the first that carries it. That is the order the launcher reads, so the
// two can never disagree about which server is meant — but it does mean a
// stale config file can pair its old port with a password only the live state
// file carries. Keeping the launcher's order is deliberate (a mismatch would be
// worse than a stale port), and the caller sees the pairing fail as an
// `unreachable` answer rather than a wrong-server write.
// A missing password is not "no auth": the server requires one, so a call
// without it cannot succeed and saying so now is better than a 401 from a
// server the caller thought was reachable.
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

// ---- a tab that runs its own server ------------------------------------- //
//
// A client started with `--standalone` (the launcher's default for a private
// tab) serves its own session on a loopback port the shared registry does not
// name. That server is the one that owns the session, so it has to be asked
// first: the shared server still has the session's record and will happily take
// a prompt into an inbox no client reads. The port is found the way the tab
// launcher finds it — the sockets the window's process family listens on — so
// nothing has to be registered or guessed.

// Listening loopback sockets as inode -> port, from /proc/net/tcp's text. Only
// a local listener (0.0.0.0 or 127.0.0.1); an established connection is a
// client, not a server.
export const parseListeningSockets = (text) => {
  const out = new Map();
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [hexIp, hexPort] = String(f[1]).split(':');
    if (f[3] !== '0A') continue;
    if (hexIp !== '0100007F' && hexIp !== '00000000') continue;
    const port = Number.parseInt(hexPort, 16);
    const inode = Number(f[9]);
    if (Number.isInteger(port) && port > 0 && Number.isInteger(inode)) out.set(inode, port);
  }
  return out;
};

const listeningSockets = () => {
  const m = new Map();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const [inode, port] of parseListeningSockets(fs.readFileSync(f, 'utf8'))) m.set(inode, port);
    } catch {
      // No table on this kernel: nothing is discovered, and the registry is used.
    }
  }
  return m;
};

const childPids = (pid, procDir) => {
  const out = [];
  let tids = [];
  try {
    tids = fs.readdirSync(path.join(procDir, String(pid), 'task'));
  } catch {
    return out;
  }
  for (const tid of tids) {
    try {
      const text = fs.readFileSync(path.join(procDir, String(pid), 'task', tid, 'children'), 'utf8').trim();
      if (text) for (const c of text.split(/\s+/)) out.push(Number(c));
    } catch {
      // The thread exited between the listing and the read.
    }
  }
  return out.filter(Number.isInteger);
};

const socketInodes = (pid, procDir) => {
  const out = [];
  let fds = [];
  try {
    fds = fs.readdirSync(path.join(procDir, String(pid), 'fd'));
  } catch {
    return out;
  }
  for (const fd of fds) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(path.join(procDir, String(pid), 'fd', fd)));
      if (m) out.push(Number(m[1]));
    } catch {
      // The fd closed meanwhile.
    }
  }
  return out;
};

// The loopback URLs a process (or a descendant) listens on, ascending, so the
// candidate order does not depend on fd numbering. An unreadable /proc is "no
// server here", never a guess.
export const discoverServerUrls = (pid, { procDir = '/proc', listening = listeningSockets(), maxDepth = 4 } = {}) => {
  const seen = new Set();
  const walk = (p, depth) => {
    if (!Number.isInteger(p) || p <= 0 || depth < 0 || seen.has(p)) return;
    seen.add(p);
    for (const c of childPids(p, procDir)) walk(c, depth - 1);
  };
  walk(pid, maxDepth);
  const ports = new Set();
  for (const p of seen) {
    for (const inode of socketInodes(p, procDir)) {
      const port = listening.get(inode);
      if (port) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b).map((port) => `http://127.0.0.1:${port}`);
};

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
    if (e?.name === 'TimeoutError') {
      // A timeout is not a refusal: the server may have taken the request and
      // lost only the answer, so a caller trying several servers must stop here
      // rather than send the same prompt to the next one.
      return { ok: false, code: 'unreachable', timedOut: true, why: `the server at ${service.url} did not answer within ${timeoutMs} ms` };
    }
    return { ok: false, code: 'unreachable', why: `the server at ${service.url} could not be reached` };
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

// Read a prompt entry's stdout as a stream, because a caller may kill it: the
// final answer if one arrived, and the accepted marker the entry prints the
// moment the server took the prompt. The marker is what keeps a killed
// read-back from being read as "nothing was sent" and delivered again.
// A line that is not JSON (a stray warning, a truncated tail) is ignored.
export const parsePromptStream = (text) => {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  let final = null;
  let accepted = null;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.phase === 'accepted') {
      if (accepted == null && typeof obj.messageId === 'string' && obj.messageId !== '') accepted = obj;
    } else {
      final = obj;
    }
  }
  return { final, accepted };
};

// How many inbox items one read-back page asks for. A seat with a deep queue
// still has its newest prompt on the first page; the page is generous so a
// short queue cannot hide the item behind the default limit.
const INBOX_PAGE = 200;

const inboxPath = (sessionId) => `/api/session/${encodeURIComponent(sessionId)}/inbox`;
const inboxItemPath = (sessionId, itemId) => `${inboxPath(sessionId)}/${encodeURIComponent(itemId)}`;

// The candidate servers in order: the tab's own servers (`servers`), then the
// registry's. A caller's list is URLs from this machine, so the registry's
// password is the one they all use.
const candidateServices = (service, servers) => {
  const seen = new Set();
  const list = [];
  for (const url of [...(servers ?? []), service?.url]) {
    if (typeof url !== 'string' || url === '' || seen.has(url)) continue;
    seen.add(url);
    list.push({ url, password: service?.password, primary: url === service?.url });
  }
  return list;
};

// Prove an accepted prompt item is really in the session: its own id in the
// inbox first (where an unconsumed prompt lives), the message log second (where
// a consumed one went). The inbox page is asked generously so a busy seat's
// queue cannot push this item past the limit; an item not found on a full page
// is not called proven — a false "unproven" costs a look, a false "delivered"
// loses the text.
//
// Answers {ok: true, messageId, proof, message?} or the unproven failure.
const provePromptItem = async ({ service, sessionId, messageId, deadline, what = 'the prompt' }) => {
  const left = () => deadline - Date.now();
  if (left() < 100) {
    return { ok: false, code: 'unproven', messageId, why: `no time was left in the budget to read item ${messageId} back` };
  }
  const inboxBudget = Math.max(100, Math.min(left() - 100, Math.floor(left() * 0.5)));
  const inbox = await requestJson({
    service,
    apiPath: `${inboxPath(sessionId)}?limit=${INBOX_PAGE}`,
    timeoutMs: inboxBudget,
  });
  const items = inbox.ok && Array.isArray(inbox.data?.data) ? inbox.data.data : [];
  if (items.some((item) => item?.id === messageId)) return { ok: true, messageId, proof: 'inbox' };
  const backBudget = left();
  if (backBudget < 100) {
    return { ok: false, code: 'unproven', messageId, why: `no time was left in the budget to read item ${messageId} back` };
  }
  const back = await requestJson({
    service,
    apiPath: `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
    timeoutMs: backBudget,
  });
  if (back.ok && back.data?.data?.id === messageId) return { ok: true, messageId, proof: 'message', message: back.data.data };
  const logWhy = back.ok ? 'the message log answered with a different id' : back.why;
  return {
    ok: false,
    code: 'unproven',
    messageId,
    why: `${what}'s item ${messageId} is in neither the session's inbox (${inbox.ok ? 'not listed' : inbox.why}) nor its message log (${logWhy})`,
  };
};

// Put the text in the session's inbox and prove it is there. `delivery` is the
// server's own vocabulary: `steer` reaches the agent before its next model
// call (and starts a run when the session is idle), `queue` waits until the
// current work finishes.
//
// The 200 answer is a `Session.Inbox.User`: the prompt's home is the session's
// INBOX, and it only becomes a message once the agent consumes it. So the proof
// is the accepted item's own id in `GET /api/session/<id>/inbox`, with the
// message log read second, for the item a fast run has already consumed. A
// message-only read reported every delivery to an attached seat that had not
// started its turn as unproven.
//
// `servers` is the ordered candidate list: a tab that runs its own server (a
// `--standalone` client) holds the session there, and the shared server in the
// registry still has the session's record, where it accepts a prompt into an
// inbox no client reads. The tab's own server therefore comes first, and a
// server that answers "no such session" hands the text to the next candidate;
// the registry server is always last. The POST and the read-back both go to the
// server that took the prompt.
//
// `timeoutMs` is the TOTAL budget for the POST and the read-back, not one each:
// a caller that bounds this call (agent-send kills its helper at budget +
// margin) must have an answer inside it, or a prompt the server accepted would
// be called undelivered and sent a second time. Too little left is `unproven`.
//
// `onAccepted` is called with `{messageId}` the moment the POST answers and
// before the read-back starts: a caller whose process is killed mid-proof can
// then see that the text is already in, and record it as unproven instead of
// delivering it again.
//
// Answers: {ok: true, messageId, delivery, directory, server, proof} on proof;
// {ok: false, code: 'unproven', messageId, why} when the prompt was accepted
// but neither the inbox nor the message log has it (the caller must not resend
// blind); otherwise the requestJson failure of the registry server, untouched.
export const deliverPrompt = async ({
  sessionId,
  text,
  delivery = 'steer',
  directory = null,
  service = resolveService(),
  servers = [],
  timeoutMs = 5000,
  onAccepted = null,
} = {}) => {
  if (!isOpencodeSessionId(sessionId)) return { ok: false, code: 'not-opencode', why: 'not an OpenCode session id' };
  if (delivery !== 'steer' && delivery !== 'queue') return { ok: false, code: 'refused', why: `delivery must be steer or queue, got ${delivery}` };
  if (!service?.password) return { ok: false, code: 'unconfigured', why: service?.why ?? 'no password for the server' };
  const startedAt = Date.now();
  const postBudget = Math.max(500, Math.min(timeoutMs, Math.floor(timeoutMs * 0.6)));
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const promptPath = `/api/session/${encodeURIComponent(sessionId)}/prompt${query}`;

  // The candidates in order: the tab's own servers, then the registry's.
  const candidates = candidateServices(service, servers);
  if (candidates.length === 0) return { ok: false, code: 'unconfigured', why: service.why ?? 'no server configured' };

  let sent = null;
  let chosen = null;
  let primaryFailure = null;
  for (const candidate of candidates) {
    const left = timeoutMs - (Date.now() - startedAt);
    const share = Math.max(100, Math.min(left > 0 ? left : postBudget, postBudget));
    const r = await requestJson({ service: candidate, apiPath: promptPath, method: 'POST', body: { text, delivery }, timeoutMs: share });
    if (r.ok) {
      sent = r;
      chosen = candidate;
      break;
    }
    if (candidate.primary || r.code === 'unreachable') primaryFailure = primaryFailure ?? r;
    // A timeout ends the walk: the prompt may be in that server's inbox with
    // only the answer lost, and asking the next server would deliver it twice.
    if (r.timedOut) break;
    // "No such session" is this server saying the session is not its: the tab
    // moved to its own server, or away from it. A refused connection or an
    // unconfigured candidate cannot have taken it, so the next one is asked. A
    // refusal is final.
    if (r.code === 'refused') return r;
    if (!['not-found', 'unreachable', 'unconfigured', 'unauthorized'].includes(r.code)) return r;
  }
  if (sent == null) return primaryFailure ?? { ok: false, code: 'not-found', why: 'no server took the prompt' };

  const messageId = sent.data?.data?.id ?? null;
  if (typeof messageId !== 'string' || messageId === '') {
    return { ok: false, code: 'unproven', messageId: null, why: 'the server accepted the prompt but named no message id to read back' };
  }
  if (typeof onAccepted === 'function') {
    try {
      onAccepted({ messageId });
    } catch {
      // A caller's own reporting failure must not change the delivery verdict.
    }
  }

  const proof = await provePromptItem({ service: chosen, sessionId, messageId, deadline: startedAt + timeoutMs });
  if (!proof.ok) return proof;
  return { ok: true, messageId, delivery, directory, server: chosen.url, proof: proof.proof, ...(proof.message ? { message: proof.message } : {}) };
};

// Every item the session's inbox still holds, read from the first candidate
// server that answers. Reading is safe to repeat, so an unreachable candidate
// simply hands the read to the next one; the registry server is last.
export const readInboxItems = async ({ sessionId, service = resolveService(), servers = [], timeoutMs = 5000 } = {}) => {
  if (!isOpencodeSessionId(sessionId)) return { ok: false, code: 'not-opencode', why: 'not an OpenCode session id' };
  if (!service?.password) return { ok: false, code: 'unconfigured', why: service?.why ?? 'no password for the server' };
  const candidates = candidateServices(service, servers);
  if (candidates.length === 0) return { ok: false, code: 'unconfigured', why: service.why ?? 'no server configured' };
  const startedAt = Date.now();
  let last = null;
  for (const candidate of candidates) {
    const budget = Math.max(150, Math.min(timeoutMs - (Date.now() - startedAt), 2000));
    const r = await requestJson({ service: candidate, apiPath: `${inboxPath(sessionId)}?limit=${INBOX_PAGE}`, timeoutMs: budget });
    if (r.ok) {
      return { ok: true, server: candidate, items: Array.isArray(r.data?.data) ? r.data.data : [] };
    }
    if (r.code === 'refused' || r.code === 'unauthorized') return r;
    last = r;
    if (timeoutMs - (Date.now() - startedAt) < 150) break;
  }
  return last ?? { ok: false, code: 'unconfigured', why: service.why ?? 'no server configured' };
};

// One line of a coalesced note: the note's text and when it was queued, so the
// seat can tell a stale note from one that just arrived.
export const queuedNoteLine = (item) => {
  const created = Number(item?.time?.created);
  const at = Number.isFinite(created) ? new Date(created).toISOString() : 'unknown time';
  return `- [queued ${at}] ${String(item?.payload?.text ?? '').trim()}`;
};

// The queue a `queue` delivery leaves for a seat whose turn never ends: the
// server holds every item with `delivery: queue` until the current work
// finishes, which a seat looping inside one turn never does (window 3 held 18
// notes for this reason on 2026-11-28). A drain turns that backlog back into
// ONE steer item — delivered before the agent's next model call, mid-work —
// carrying every note's text and the time it was queued. The originals are
// deleted only once the combined item is accepted, so a crash loses nothing;
// a delete that fails is reported, and that note may then arrive again.
//
// Answers {ok: true, drained, messageId?, server, proof?, undeleted?, text?};
// `drained: 0` when the inbox holds nothing queued. Otherwise the requestJson
// failure, or {ok: false, code: 'unproven', ...} when the combined item could
// not be read back (do not resend: it is in the inbox).
export const drainQueuedPrompt = async ({ sessionId, service = resolveService(), servers = [], timeoutMs = 8000 } = {}) => {
  if (!isOpencodeSessionId(sessionId)) return { ok: false, code: 'not-opencode', why: 'not an OpenCode session id' };
  if (!service?.password) return { ok: false, code: 'unconfigured', why: service?.why ?? 'no password for the server' };
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const left = () => deadline - Date.now();
  const read = await readInboxItems({ sessionId, service, servers, timeoutMs: Math.max(200, Math.floor(timeoutMs * 0.3)) });
  if (!read.ok) return read;
  const queued = read.items.filter(
    (item) => item?.type === 'user' && item?.delivery === 'queue' && typeof item?.payload?.text === 'string' && item.payload.text.trim() !== '',
  );
  if (queued.length === 0) return { ok: true, drained: 0, sessionId, server: read.server.url };
  const header = `[switchboard] ${queued.length} note${queued.length === 1 ? '' : 's'} queued while your turn was running; one steer carries ${queued.length === 1 ? 'it' : 'them'} in the order they arrived:`;
  const text = [header, ...queued.map(queuedNoteLine)].join('\n');
  const postBudget = Math.max(300, Math.min(left() - 100, Math.floor(timeoutMs * 0.5)));
  const sent = await requestJson({
    service: read.server,
    apiPath: `/api/session/${encodeURIComponent(sessionId)}/prompt`,
    method: 'POST',
    body: { text, delivery: 'steer', metadata: { switchboardDrain: queued.map((i) => i.id) } },
    timeoutMs: postBudget,
  });
  // Nothing is deleted unless the server took the combined item: the backlog
  // stays intact and the caller can try again.
  if (!sent.ok) return sent;
  const messageId = sent.data?.data?.id ?? null;
  if (typeof messageId !== 'string' || messageId === '') {
    return { ok: false, code: 'unproven', messageId: null, drained: 0, why: 'the server accepted the combined note but named no item id; the queued notes are still in the inbox' };
  }
  const undeleted = [];
  for (const item of queued) {
    if (left() < 150) {
      undeleted.push(item.id);
      continue;
    }
    const del = await requestJson({
      service: read.server,
      apiPath: inboxItemPath(sessionId, item.id),
      method: 'DELETE',
      timeoutMs: Math.max(150, Math.min(1000, left() - 100)),
    });
    if (!del.ok) undeleted.push(item.id);
  }
  const proof = await provePromptItem({ service: read.server, sessionId, messageId, deadline, what: 'the drain' });
  if (!proof.ok) return { ...proof, drained: queued.length, undeleted };
  return {
    ok: true,
    drained: queued.length,
    messageId,
    delivery: 'steer',
    sessionId,
    server: read.server.url,
    proof: proof.proof,
    undeleted,
    text,
  };
};
