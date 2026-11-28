// node --import entry: scrub ambient switchboard/mailbox pins before any
// test file (and therefore any lib import) captures them. See isolate-env.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubProcessEnv } from './isolate-env.mjs';

scrubProcessEnv();
// See isolatedEnv: tests do not record the suite runner's ancestors as hosts.
process.env.AGENT_SWITCHBOARD_HOST_PROBE = 'off';

// Point the store's DEFAULT path at a fresh per-process temp dir: the default
// store path (lib/store.mjs defaultStorePath, via AGENT_SWITCHBOARD_DIR or
// XDG_STATE_HOME) otherwise lands in the real home, so a store-mode test with
// no pin of its own writes the live state.db. A test that sets its own pin
// later (in its body, which runs after these imports) still wins by overwrite.
const isolateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-isolate-'));
process.env.AGENT_SWITCHBOARD_DIR = path.join(isolateDir, 'switchboard');
process.env.XDG_STATE_HOME = path.join(isolateDir, 'xdg');
// The kitty ls cache, lock and breaker files go to the same temp dir, and the
// cache is off: tests rewrite their stub's listing between spawns and expect
// the next read to see it. A test of the cache sets its own TTL.
process.env.AGENT_KITTY_LS_DIR = path.join(isolateDir, 'kitty-ls');
process.env.AGENT_KITTY_LS_TTL_MS = '0';
// The OpenCode server registry is pinned at a path that does not exist, so no
// test can reach the machine's live server through its real config registry: a
// test of the API route points this at its own registry beside its stub server.
process.env.AGENT_SWITCHBOARD_OPENCODE_SERVICE = path.join(isolateDir, 'no-opencode-service.json');
