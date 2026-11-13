// Tests for bin/fleet-drill.mjs against stub binaries: no kitty, no Claude
// Code, no network. One stub (tests/helpers/fleet-drill-stub.mjs) plays the
// seat; STUB_BROKEN picks the states it gets wrong.
//
// Run: node --import ./tests/helpers/isolate-setup.mjs --test tests/fleet-drill.test.mjs
import './helpers/isolate-setup.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const SCRIPT = fileURLToPath(new URL('../bin/fleet-drill.mjs', import.meta.url));
const STUB = fileURLToPath(new URL('./helpers/fleet-drill-stub.mjs', import.meta.url));
const ROLES = {
  FLEET_DRILL_CLAUDE_TAB: 'claude-tab',
  FLEET_DRILL_KITTY: 'kitty',
  FLEET_DRILL_TAB_STATE: 'tab-state',
  FLEET_DRILL_KITTY_SEND: 'kitty-send',
  FLEET_DRILL_AGENT_SEND: 'agent-send',
  FLEET_DRILL_TYPING_PROOF: 'typing-proof',
  FLEET_DRILL_EXPORT: 'export',
  FLEET_DRILL_GH: 'gh',
  FLEET_DRILL_MERGE_CMD: 'merge',
};

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-drill-test-'));
  fs.mkdirSync(path.join(root, 'bin'));
  for (const role of Object.values(ROLES)) {
    const f = path.join(root, 'bin', role);
    fs.writeFileSync(f, `#!/bin/sh\nexec node ${STUB} ${role} "$@"\n`, { mode: 0o755 });
  }
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const drill = (argv, { broken = '', extra = {} } = {}) => {
  const state = fs.mkdtempSync(path.join(root, 'state-'));
  const env = isolatedEnv({
    STUB_DIR: state,
    STUB_BROKEN: broken,
    FLEET_DRILL_POLL_MS: '20',
    FLEET_DRILL_LIMIT_SLASH_S: '2',
    FLEET_DRILL_READY_S: '5',
    FLEET_DRILL_SETUP_S: '5',
    FLEET_DRILL_SETTLE_S: '5',
    FLEET_DRILL_CWD_ROOT: root,
    ...Object.fromEntries(Object.entries(ROLES).filter(([k]) => k !== 'FLEET_DRILL_MERGE_CMD').map(([k, r]) => [k, path.join(root, 'bin', r)])),
    ...extra,
  });
  const r = spawnSync('node', [SCRIPT, ...argv], { env, encoding: 'utf8', timeout: 60000 });
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...r, lines, state, byState: Object.fromEntries(lines.filter((l) => l.state).map((l) => [l.state, l])), summary: lines.find((l) => l.summary) };
};

test('a broken seat fails exactly slash and busy, and the exit code and summary name them', () => {
  const r = drill(['--states', 'all'], { broken: 'slash,busy' });
  assert.notEqual(r.status, 0, r.stderr);
  const failed = Object.values(r.byState).filter((l) => !l.ok).map((l) => l.state).sort();
  assert.deepEqual(failed, ['busy', 'slash']);
  assert.deepEqual(r.summary.failed.sort(), ['busy', 'slash']);
  assert.match(r.stderr, /FAILED: busy, slash|FAILED: slash, busy/);
  for (const s of ['idle', 'permission', 'closed']) assert.equal(r.byState[s].ok, true, JSON.stringify(r.byState[s]));
  assert.equal(r.byState.busy.deliveredAs, 'typed');
  assert.match(r.byState.busy.reason, /typing onto a busy seat/);
  assert.match(r.byState.slash.reason, /composer/);
});

test('a correct seat passes every state and exits 0', () => {
  const r = drill(['--states', 'all']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.byState).sort(), ['busy', 'closed', 'idle', 'permission', 'slash']);
  for (const l of Object.values(r.byState)) {
    assert.equal(l.ok, true, JSON.stringify(l));
    assert.equal(typeof l.ms, 'number');
  }
  assert.ok(r.byState.idle.deliveredAs);
  assert.equal(r.byState.closed.deliveredAs, null);
  assert.equal(r.summary.ok, true);
});

test('a state list runs only the named states', () => {
  const r = drill(['--states', 'idle,closed']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.byState), ['idle', 'closed']);
});

test('the busy check fails when the tool result is missing even though the ack came', () => {
  // A seat that acks via the tool boundary but whose transcript lost the result.
  const r = drill(['--states', 'busy'], { broken: 'busy' });
  assert.equal(r.status, 1);
  assert.equal(r.byState.busy.ok, false);
});

test('an unknown state is a usage error, exit 2', () => {
  const r = drill(['--states', 'idle,nap']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown state/);
});

test('--help states every limit', () => {
  const r = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(r.status, 0);
  for (const s of ['idle', 'busy', 'permission', 'slash', 'closed', 'merge']) assert.match(r.stdout, new RegExp(`${s}\\s+\\d+ s`));
  assert.match(r.stdout, /FLEET_DRILL_SANDBOX/);
});

test('the merge stage is off unless FLEET_DRILL_SANDBOX is set, and asserts the PR ends MERGED', () => {
  const off = drill(['--states', 'all']);
  assert.equal(off.byState.merge, undefined);

  const mergeCmd = path.join(root, 'bin', 'merge');
  const on = drill(['--states', 'idle,merge'], { extra: { FLEET_DRILL_SANDBOX: 'o/sandbox', FLEET_DRILL_MERGE_CMD: mergeCmd } });
  assert.equal(on.status, 0, on.stderr);
  assert.equal(on.byState.merge.ok, true, JSON.stringify(on.byState.merge));
  const got = JSON.parse(fs.readFileSync(path.join(on.state, 'merge-args.json'), 'utf8'));
  assert.deepEqual(got.args, ['o/sandbox', '42']);

  const bad = drill(['--states', 'merge'], { broken: 'merge', extra: { FLEET_DRILL_SANDBOX: 'o/sandbox', FLEET_DRILL_MERGE_CMD: mergeCmd, FLEET_DRILL_LIMIT_MERGE_S: '1' } });
  assert.equal(bad.status, 1);
  assert.match(bad.byState.merge.reason, /OPEN/);
});
