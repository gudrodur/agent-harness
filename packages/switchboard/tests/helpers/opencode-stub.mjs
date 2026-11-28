// A stub OpenCode server and its service registry, for the API-delivery tests.
//
// The sender and the prompt entry talk to a real HTTP API, so the tests run a
// real (tiny) HTTP server on the loopback: that is what proves the request
// shape — the path, the `directory` query, the JSON body, the basic-auth
// header — and the read-back, instead of a stubbed function agreeing with
// itself. It records every request so a test can assert on it, and its password
// is known to the test so it can assert the value never appears in output.
//
// Usage:
//   const stub = await startStubServer({ password: 'stub-secret' });
//   const reg = writeRegistry(dir, stub.port, 'stub-secret');
//   ... run the sender with AGENT_SWITCHBOARD_OPENCODE_SERVICE=reg ...
//   await stub.close();

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const startStubServer = async ({
  password = 'stub-password',
  promptStatus = 200,
  readBack = 'ok', // ok | missing | different
  active = [],
  sessions = null,
  delayMs = 0,
  readBackDelayMs = 0,
} = {}) => {
  const state = {
    requests: [],
    prompts: [],
    reads: [],
    authFailures: 0,
    // Set by a test that wants the next prompt refused after one success.
    promptStatus,
    readBack,
  };
  const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
  let created = 0;

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    state.requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if ((req.headers.authorization ?? '') !== expectedAuth) {
      state.authFailures += 1;
      json(res, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } })() : null;
      if (delayMs) {
        setTimeout(() => respond(method, url, body, res), delayMs);
        return;
      }
      respond(method, url, body, res);
    });
  });

  const respond = (method, url, body, res) => {
    const p = url.pathname;
    if (p === '/api/session/active') {
      json(res, 200, { data: Object.fromEntries(active.map((id) => [id, { type: 'running' }])) });
      return;
    }
    if (p === '/api/session') {
      const rows = sessions ?? [{ id: 'ses_stubStubStub0', location: { directory: '/repo/a' } }];
      json(res, 200, { data: rows });
      return;
    }
    const prompt = /^\/api\/session\/([^/]+)\/prompt$/.exec(p);
    if (prompt && method === 'POST') {
      if (state.promptStatus !== 200) {
        json(res, state.promptStatus, state.promptStatus === 404 ? { _tag: 'SessionNotFoundError', message: 'no such session' } : { message: 'refused' });
        return;
      }
      created += 1;
      const id = `msg_stub${String(created).padStart(6, '0')}`;
      state.prompts.push({ sessionId: prompt[1], body, query: Object.fromEntries(url.searchParams), messageId: id });
      json(res, 200, { data: { id, sessionID: prompt[1], type: 'user', delivery: body?.delivery ?? 'steer', payload: { text: body?.text ?? '' } } });
      return;
    }
    const read = /^\/api\/session\/([^/]+)\/message\/([^/]+)$/.exec(p);
    if (read) {
      state.reads.push({ sessionId: read[1], messageId: read[2] });
      const answer = () => {
        if (state.readBack === 'missing') {
          json(res, 404, { _tag: 'NotFoundError', message: 'no such message' });
          return;
        }
        const id = state.readBack === 'different' ? `${read[2]}-other` : read[2];
        json(res, 200, { data: { id, sessionID: read[1], type: 'user' } });
      };
      if (readBackDelayMs) setTimeout(answer, readBackDelayMs);
      else answer();
      return;
    }
    json(res, 404, { _tag: 'NotFoundError', message: `no route ${p}` });
  };

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    state,
    password,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

// The service registry the client would write: {port, password}. The sender
// reads it from the path AGENT_SWITCHBOARD_OPENCODE_SERVICE names.
export const writeRegistry = (dir, port, password, { file = null } = {}) => {
  const target = file ?? path.join(dir, 'service.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ port, password }));
  return target;
};
