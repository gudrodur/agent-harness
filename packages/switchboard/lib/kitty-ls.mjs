// The one `kitty @ ls` call. Every reader of the window list (the window
// resolver, the typing proof, agent-send's idle checks) goes through
// `kittyLs`, so the 5 s bound lives in one place and the process learns once
// that remote control does not answer: `kittyKnownDown()` then says so without
// asking kitty again (a second ask costs another timeout).
import { execFileSync } from 'node:child_process';

const KITTY_LS_TIMEOUT_MS = 5000;
// AGENT_KITTY_LS_TIMEOUT_MS shortens the bound (test seam: a hanging stub).
const timeoutMs = () => {
  const v = Number(process.env.AGENT_KITTY_LS_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : KITTY_LS_TIMEOUT_MS;
};

export const kittyBin = () => process.env.AGENT_MAILBOX_KITTY ?? 'kitty';

// null until the first call; true after a call that failed or timed out, false
// after one that answered. The latest call wins: a kitty that recovered is up.
let down = null;

// The parsed `kitty @ ls` array, or null when remote control did not answer
// (timeout, dead socket, non-JSON output).
export const kittyLs = () => {
  try {
    const out = execFileSync(kittyBin(), ['@', 'ls'], { encoding: 'utf-8', timeout: timeoutMs(), stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = JSON.parse(out);
    // Anything but an array (an error object) is not an answer to `ls`.
    if (!Array.isArray(parsed)) { down = true; return null; }
    down = false;
    return parsed;
  } catch (e) {
    // A missing binary (mailbox-only setup) is not an outage: there is no
    // remote control to wait for, so no SendMessage hint either.
    down = e?.code !== 'ENOENT';
    return null;
  }
};

export const kittyKnownDown = () => down === true;

// Every window of the list, flattened.
export const flattenWindows = (ls) => (ls ?? []).flatMap((t) => (t.tabs ?? []).flatMap((tab) => tab.windows ?? []));

