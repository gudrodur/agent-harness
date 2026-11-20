# Configuration

Every variable, its default, and what reads it — taken from the code, not from memory.

| Variable | Default | Used by |
|---|---|---|
| `AGENT_SWITCHBOARD_DIR` | `${XDG_STATE_HOME:-$HOME/.local/state}/agent-switchboard` | `lib/presence.mjs`: root for presence and mailbox |
| `AGENT_SWITCHBOARD_PRESENCE_FILE` | `$AGENT_SWITCHBOARD_DIR/presence.json` | `lib/presence.mjs`: legacy live-beacon file, imported once into the store; beacons live in `state.db` (`presence_beacons`) unless this pin is set |
| `AGENT_SWITCHBOARD_DB` | `$AGENT_SWITCHBOARD_DIR/state.db` | `lib/store.mjs`: the SQLite store (WAL mode) holding the mailbox and presence when no legacy file override below is set |
| `AGENT_SWITCHBOARD_BUSY_TIMEOUT_MS` | `5000` | `lib/store.mjs`: the SQLite `busy_timeout` of each store open; a hot-path hook sets a small value (with `AGENT_SWITCHBOARD_BUSY_DEADLINE_MS=0`) so a held lock costs it milliseconds, not 5 s. Invalid values fall back to the default |
| `AGENT_SWITCHBOARD_BUSY_DEADLINE_MS` | `20000` | `lib/store.mjs`: how long a mailbox or presence call retries a busy store (after the 5 s `busy_timeout`) before throwing |
| `AGENT_SWITCHBOARD_MAILBOX_DIR` | `$AGENT_SWITCHBOARD_DIR/mailbox` | `lib/agent-mailbox.mjs`: legacy JSONL mailbox, one file per recipient (`AGENT_MAILBOX_DIR` still honoured as the older name); used while set or while a `{dir}` override is passed |
| `AGENT_SWITCHBOARD_SENDER` | `another agent session` | `bin/agent-send.mjs`, `bin/kitty-send.sh`: the sender label on terminal-delivered notes |
| `AGENT_SEND_IDLE_WAIT_S` | `5` (seconds) | `bin/agent-send.mjs`: the ack wait for a recipient whose window title shows it idle (a busy one waits `AGENT_SEND_BUSY_WAIT_S` inside `AGENT_SEND_BUDGET_S`; `--deadline` wins); under `--queue`, how long the window must show idle (and pass the proof in the README) with the row undrained before the row is typed in |
| `AGENT_SEND_VERBOSE` | unset | `bin/agent-send.mjs`: `1` prints every step on stderr (the row written, the ack wait, the withdraw, the kitty-send fallback and its own stderr), the same as `--verbose`. Unset, a send prints one line, the final verdict; errors always print |
| `AGENT_SEND_NOTICE_ROLE` | unset (no notice) | `bin/agent-send.mjs`: a seat role (for example the one that oversees the others). When a send to `role:<name>` finds no live holder, the row is queued for the next claimant as before and this role also gets one short notice that mail for `<name>` has no reader, so the unread mail is noticed. One notice per unread role (a topic collapses repeats, and one the role already read is not raised again inside `AGENT_SEND_NOTICE_WINDOW_MIN`); sent from `switchboard`, with the original sender in the text; none when `<name>` is this role itself |
| `AGENT_SEND_NOTICE_WINDOW_MIN` | `60` | `bin/agent-send.mjs`: minutes after the notice role read a no-reader notice for a role during which no new notice for that role is raised. `0` raises one on every send |
| `AGENT_SEND_BUDGET_S` | `30` (seconds) | `bin/agent-send.mjs`: the end-to-end budget, process start to exit, of a send to a busy recipient with no `--deadline`; kitty-send gets what is left as `--timeout`, and with none left the row stays queued and the send exits 3 |
| `AGENT_SEND_BUSY_WAIT_S` | `15` (seconds) | `bin/agent-send.mjs`: the ack wait for a busy recipient, clamped to the budget; the rest of the budget is kitty-send's proof wait |
| `AGENT_SWITCHBOARD_SEND` | `bin/kitty-send.sh` beside `agent-send.mjs` | `bin/agent-send.mjs`: the fallback sender (`AGENT_SEND_KITTY_SEND` wins when set) |
| `OPENCODE_TAB_LAUNCH` | `$AGENT_CONFIG_HOME/scripts/opencode-launch.sh` | `bin/opencode-tab.sh`: the command the tab execs (exports the Cloudflare MCP tokens, then runs opencode) |
| `OPENCODE_TAB_PROBE_TIMEOUT` | `60` | `bin/opencode-tab.sh`: seconds the pre-launch model probe may take before it counts as a hang |
| `OPENCODE_TAB_DB` | `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db` | `bin/opencode-tab.sh`: opencode's store, read-only, for the session row that proves the start and its model |
| `OPENCODE_TAB_PRESENCE` | unset: `lib/presence.mjs` on the caller's store | `bin/opencode-tab.sh`: a command printing `{"beacons":[...]}` for the start proof, in place of the lib |
| `CLAUDE_TAB_BIN` | `claude` | `bin/claude-tab.sh`: the command the tab execs |
| `CLAUDE_TAB_PROJECTS` | `$CLAUDE_CONFIG_DIR/projects` (default: `.claude` under the home directory) | `bin/claude-tab.sh`: Claude Code's transcripts, read-only, for the new session file that proves the start, its model and (with `--rc`) its `bridge-session` row |
| `CLAUDE_RESUME_SET_DIR` | `${XDG_STATE_HOME:-$HOME/.local/state}/claude-resume-set` | `bin/claude-resume-set.sh`: where `--snapshot` writes `latest.json`, its `.md` and a timestamped copy, and what `--replay` reads by default |
| `CLAUDE_RESUME_SET_TAB` | `bin/claude-tab.sh` beside it | `bin/claude-resume-set.sh`: the launcher each replayed row runs |
| `CLAUDE_TAB_CONFIG` | `.claude.json` in `$CLAUDE_CONFIG_DIR`, else in the home directory | `bin/claude-tab.sh`: Claude Code's user config, read-only, for folder trust (the cwd or an ancestor must be trusted, or nothing is launched) |
| `AGENT_CONFIG_HOME` | the `.claude` directory under the home directory | `bin/opencode-tab.sh`, `bin/claude-tab.sh`: where `scripts/task-claim.mjs` lives |
| `SWITCHBOARD_TASK_CLAIM` | `$AGENT_CONFIG_HOME/scripts/task-claim.mjs` | `lib/tab-ledger.sh` (both launchers): the brief-claim CLI; a missing one is a loud skip |
| `CLAUDE_SESSION_ID` | unset, then `KITTY_WINDOW_ID` | both launchers: the launcher id written into each state row |
| `CLAUDE_SESSIONS_DIR`, `CLAUDE_PROJECTS_DIR` | `$CLAUDE_CONFIG_DIR/sessions` (default: `.claude` under the home directory), `.../projects` | `lib/claude-session.sh` (`bin/tab-state.sh`, `bin/kitty-send.sh`, `bin/claude-tab.sh --resume`, `bin/claude-resume-set.sh`): Claude Code's per-pid session records and transcripts, read-only; `KITTY_SEND_CLAUDE_SESSIONS_DIR` and `KITTY_SEND_CLAUDE_PROJECTS_DIR` still win |
| `CLAUDE_CODE_SESSION_ID` | null (address by cwd only) | `hooks/claude/mailbox-inject.mjs`, `bin/agent-send.mjs`: host-agent session identity |
| `AGENT_KITTY_LS_TTL_MS` | `2000` | `lib/kitty-ls.mjs` (every window read, shell scripts included through `lib/kitty-ls.sh`): how long a `kitty @ ls` answer is reused by a read that allows a cached answer. A fresh read (every read whose answer types, closes, launches, prunes a row, releases a claim or grants the slot) never takes one older than its own request; `0` turns the cache off |
| `AGENT_KITTY_LS_TIMEOUT_MS` | `5000` | `lib/kitty-ls.mjs`: the bound on one `kitty @ ls`. A read that runs past it is killed and opens the breaker |
| `AGENT_KITTY_LS_BREAKER_BASE_MS`, `AGENT_KITTY_LS_BREAKER_CAP_MS` | `5000`, `60000` | `lib/kitty-ls.mjs`: how long the breaker stays open after a timed-out read, doubling (+/-20%, never past the cap) with each timeout in a row up to the cap. While it is open no process asks kitty; each read returns "unavailable" with the time it may retry |
| `AGENT_KITTY_LS_DIR` | `$XDG_RUNTIME_DIR/agent-switchboard/kitty-ls` (else a per-user directory under the temp dir) | `lib/kitty-ls.mjs`: the shared cache, lock and breaker files, one set per kitty instance (`KITTY_LISTEN_ON` with the socket's inode and change time, or with `KITTY_PID` for a socket without a path; else `KITTY_PID`) and binary. A full read and a narrow read of each window id have their own lock, so a fan-out to many windows is not queued behind one read; a waiter past the read timeout plus 1 s reads kitty itself rather than fail |
| `AGENT_LAUNCH_PID_TRIES` | `6` | `lib/tab-ledger.sh` (both launchers): how many fresh reads of a just-launched window's pid are made, on the backoff curve, while kitty does not answer. When none answers the tab stays open, recorded with pid `?` and claimed, and the launcher exits 3, never 2 |
| `AGENT_SEND_QUEUE_POLL_MS`, `AGENT_SEND_QUEUE_POLL_CAP_MS` | `2000`, `10000` | `bin/agent-send.mjs --queue`: the gap between window reads while the row waits, doubling from the first to the second while the reason it waits stays the same, and starting over when it changes |
| `KITTY_SEND_POLL_MS`, `KITTY_SEND_POLL_CAP_MS` | `2000`, `10000` | `bin/kitty-send.sh --wait-idle`, `--deadline`, `--queue`: the same curve for the wait loop, starting over when the title or kitty's availability changes; never past a bounded wait's end, and while kitty backs off never shorter than the breaker's retry time |
| `KITTY_WINDOW_ID` | null (cwd join only) | the Claude Code hook, `lib/agent-mailbox.mjs`: exact window-to-session routing (the Codex hook records no window id) |

The ledger of launched tabs is `$XDG_RUNTIME_DIR/opencode-tab-launched.<uid>`; a ledger left under its former name `omp-tab-launched.<uid>` is moved to the new name on first use.

Timers, for orientation: presence beacons go stale after 20 minutes (`PRESENCE_STALE_MS`, never restated), or at once when the beacon carries a writer pid that is dead (`isLiveBeacon` in `lib/presence.mjs`, which the mailbox readers import); the sender waits at most `AGENT_SEND_BUSY_WAIT_S` (15 s, inside a 30 s `AGENT_SEND_BUDGET_S` for the whole send) for an ack from a busy recipient and 5 s from one whose window title shows it idle (`AGENT_SEND_IDLE_WAIT_S`; `--deadline N` always wins; unbounded for `--queue`, whose sender reads the recipient's window title every 2 s, the gap growing to 10 s while nothing changes, and types the row in once the window has shown idle for `AGENT_SEND_IDLE_WAIT_S` without the row being taken; a busy target acks only at its next tool boundary, and a kitty fallback under `--now` would discard the tool result it was waiting for); the queued terminal waiter heartbeats every 5 min and never times out unless `--deadline` caps it; a `kitty @ ls` is bounded at 5 s, and one that times out stops every process from asking kitty for 5 s, doubling to 60 s while timeouts continue (`AGENT_KITTY_LS_*`).
## Copilot CLI

Copilot CLI 1.0.114 does not provide a hook that runs between prompts or when
an external mailbox row arrives. Install the status-line beacon with:

```sh
bash <checkout>/bin/copilot-install.sh
```

The installer points at `$AGENT_SWITCHBOARD_HOME/hooks/copilot/presence.mjs`,
defaulting to `~/Development/projects/agent-harness/packages/switchboard`, not
the checkout used to run the installer. Copilot's documented
`statusLine: { type: "command", command, refreshInterval }` shape is accepted,
but the setting is read at session startup; restart existing Copilot sessions
after installation.

The beacon keeps the Copilot kitty window addressable, but intentionally does
not mark it as a mailbox consumer. `agent-send.mjs` therefore uses the
existing kitty-send typing fallback; an idle Copilot session receives the
message as its next prompt. Copilot cannot acknowledge mailbox rows itself
until it gains a prompt/turn hook.

The hook also binds the kitty window as a Copilot seat in
`$XDG_RUNTIME_DIR/kitty-send/copilot-window-<window id>` (the window's own
pid, one line); kitty-send writes the same binding whenever it finds a live
Copilot in a window. A send to a bound window is delivered only while its
foreground processes, as `kitty @ ls` reports them, include a live Copilot;
otherwise it exits 17 and types nothing, because the shell left behind would
run the message as a command. Unlike the presence beacon, the binding is never
pruned, and a window id reused by a later kitty instance (a different pid)
does not match it.
