// Every CLI entry point must still run as main when reached through a symlinked
// file, a symlinked directory, or a real path holding a space. The check at the
// foot of bin/seat-finished.mjs and hooks/copilot/presence.mjs used to compare
// URL strings, which differ in the first two cases (and, for seat-finished, in
// the third: it did not percent-encode the path).
//
// Run: node --import ./tests/helpers/isolate-setup.mjs --test tests/entry-point-paths.test.mjs
import './helpers/isolate-setup.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const PKG = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-paths-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SCRIPTS = ['bin/seat-finished.mjs', 'hooks/copilot/presence.mjs'];

// One path per form, each isolating a single property:
//   symlinked file       a symlink to the script, no space
//   symlinked directory  a symlinked parent directory, no space
//   path with a space    a real copy of the tree under a directory with a space, no symlink
const FILE_LINKS = path.join(tmp, 'file-links');
fs.mkdirSync(FILE_LINKS);
const DIR_LINK = path.join(tmp, 'pkglink');
fs.symlinkSync(PKG, DIR_LINK);
const SPACE_DIR = path.join(tmp, 'a b');
fs.mkdirSync(SPACE_DIR);
for (const d of ['bin', 'lib', 'hooks/copilot']) {
  fs.cpSync(path.join(PKG, d), path.join(SPACE_DIR, d), { recursive: true });
}
fs.copyFileSync(path.join(PKG, 'package.json'), path.join(SPACE_DIR, 'package.json'));

const FORMS = {
  'a symlinked file': (rel) => {
    const link = path.join(FILE_LINKS, `${rel.replaceAll('/', '_')}`);
    fs.symlinkSync(path.join(PKG, rel), link);
    return link;
  },
  'a symlinked directory': (rel) => path.join(DIR_LINK, rel),
  'a real path with a space': (rel) => path.join(SPACE_DIR, rel),
};

const run = (script, extra = {}) => spawnSync(process.execPath, [script],
  { encoding: 'utf-8', env: isolatedEnv(extra), timeout: 15000, input: '' });

let n = 0;
for (const [label, make] of Object.entries(FORMS)) {
  test(`bin/seat-finished.mjs runs as main through ${label}`, () => {
    const r = run(make('bin/seat-finished.mjs'));
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /usage: seat-finished\.mjs/);
  });

  test(`hooks/copilot/presence.mjs runs as main through ${label}`, () => {
    n += 1;
    const presenceFile = path.join(tmp, `presence-${n}.json`);
    const r = run(make('hooks/copilot/presence.mjs'),
      { KITTY_WINDOW_ID: String(700 + n), AGENT_SWITCHBOARD_PRESENCE_FILE: presenceFile });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(presenceFile), 'no presence written, so the hook did not run as main');
    assert.match(fs.readFileSync(presenceFile, 'utf-8'), new RegExp(`copilot-${700 + n}`));
  });
}

test('importing either entry point still does not run it', () => {
  for (const rel of SCRIPTS) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(path.join(PKG, rel))}); console.log('imported');`],
    { encoding: 'utf-8', env: isolatedEnv({ KITTY_WINDOW_ID: '799' }), timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'imported', rel);
  }
});
