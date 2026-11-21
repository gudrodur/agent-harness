// Every CLI entry point must still run as main when reached through a symlinked
// bin path, a symlinked directory, or a path holding a space. The check at the
// foot of bin/seat-finished.mjs and hooks/copilot/presence.mjs used to compare
// URL strings, which differ in all three cases.
//
// Run: node --import ./tests/helpers/isolate-setup.mjs --test tests/entry-point-paths.test.mjs
import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const PKG = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entry paths-'));

// The three ways to reach a script: a symlink to the file, a symlinked parent
// directory, and a copy of the package tree under a directory with a space.
const reach = (rel) => {
  const real = path.join(PKG, rel);
  const fileLink = path.join(tmp, `link-${path.basename(rel)}`);
  fs.symlinkSync(real, fileLink);
  const dirLink = path.join(tmp, 'pkg link');
  if (!fs.existsSync(dirLink)) fs.symlinkSync(PKG, dirLink);
  return {
    'a symlinked file': fileLink,
    'a symlinked directory': path.join(dirLink, rel),
    'a path with a space': path.join(dirLink, rel),
  };
};

const SPACE_DIR = path.join(tmp, 'a b');
fs.mkdirSync(SPACE_DIR);
for (const d of ['bin', 'lib', 'hooks/copilot']) {
  fs.cpSync(path.join(PKG, d), path.join(SPACE_DIR, d), { recursive: true });
}
fs.copyFileSync(path.join(PKG, 'package.json'), path.join(SPACE_DIR, 'package.json'));

const run = (script, extra = {}, input = '') => spawnSync(process.execPath, [script],
  { encoding: 'utf-8', env: isolatedEnv(extra), timeout: 15000, input });

test('bin/seat-finished.mjs runs as main through every path form', () => {
  const paths = { ...reach('bin/seat-finished.mjs'), 'a real path with a space': path.join(SPACE_DIR, 'bin/seat-finished.mjs') };
  for (const [label, script] of Object.entries(paths)) {
    const r = run(script);
    assert.equal(r.status, 2, `${label}: ${r.stderr}`);
    assert.match(r.stderr, /usage: seat-finished\.mjs/, label);
  }
});

test('hooks/copilot/presence.mjs runs as main through every path form', () => {
  const paths = { ...reach('hooks/copilot/presence.mjs'), 'a real path with a space': path.join(SPACE_DIR, 'hooks/copilot/presence.mjs') };
  let n = 0;
  for (const [label, script] of Object.entries(paths)) {
    n += 1;
    const presenceFile = path.join(tmp, `presence-${n}.json`);
    const r = run(script, { KITTY_WINDOW_ID: String(700 + n), AGENT_SWITCHBOARD_PRESENCE_FILE: presenceFile });
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.ok(fs.existsSync(presenceFile), `${label}: no presence written, so the hook did not run as main`);
    assert.match(fs.readFileSync(presenceFile, 'utf-8'), new RegExp(`copilot-${700 + n}`), label);
  }
});

test('importing either entry point still does not run it', () => {
  for (const rel of ['bin/seat-finished.mjs', 'hooks/copilot/presence.mjs']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(path.join(PKG, rel))}); console.log('imported');`],
    { encoding: 'utf-8', env: isolatedEnv({ KITTY_WINDOW_ID: '799' }), timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'imported', rel);
  }
});
