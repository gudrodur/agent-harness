// The main-module check at the foot of lib/kitty-ls.mjs and lib/typing-proof.mjs
// must be total. `bun -e ... serve` sets argv[1] to the word `serve`, and a
// bun-compiled binary sets it to `/$bunfs/root/<name>`; neither is a file, so a
// bare realpathSync threw ENOENT when a consumer imported the module.
//
// Run: node --import ./tests/helpers/isolate-setup.mjs --test tests/main-module-guard.test.mjs
import './helpers/isolate-setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './helpers/isolate-env.mjs';

const MODULES = ['kitty-ls.mjs', 'typing-proof.mjs'];
const href = (name) => new URL(`../lib/${name}`, import.meta.url).href;

const importWithArgv1 = (name, argv1) => spawnSync(process.execPath, [
  '--input-type=module', '-e',
  `process.argv[1] = ${JSON.stringify(argv1)}; await import(${JSON.stringify(href(name))}); console.log('imported');`,
], { encoding: 'utf-8', env: isolatedEnv(), timeout: 15000 });

for (const name of MODULES) {
  for (const [label, argv1] of [['a non-path word', 'serve'], ['a bunfs path', '/$bunfs/root/x']]) {
    test(`${name}: importing with argv[1] as ${label} does not throw and does not run the CLI`, () => {
      const r = importWithArgv1(name, argv1);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'imported');
    });
  }
}

test('kitty-ls.mjs: run as the main module it still runs the CLI', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(href('kitty-ls.mjs')), '--bogus'],
    { encoding: 'utf-8', env: isolatedEnv(), timeout: 15000 });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /usage: kitty-ls\.mjs/);
});

test('typing-proof.mjs: run as the main module it still runs the CLI', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(href('typing-proof.mjs'))],
    { encoding: 'utf-8', env: isolatedEnv(), timeout: 15000, input: '' });
  assert.notEqual(r.status, null);
  assert.ok(r.stderr.length > 0 || r.stdout.length > 0, 'the CLI printed nothing, so it did not run');
});
