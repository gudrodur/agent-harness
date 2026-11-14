# Fleet drill

`bin/fleet-drill.mjs` is an end-to-end check, meant to run nightly, that a message sent with `agent-send.mjs` reaches a live Claude Code seat in every state a recipient can be in. It costs a few model turns on the cheapest model (haiku), so it is not part of the test suite; `tests/fleet-drill.test.mjs` runs the whole script against stub binaries instead.

```sh
export FLEET_DRILL_STORE_DIR=$(mktemp -d)
node bin/fleet-drill.mjs --states all
node bin/fleet-drill.mjs --states idle,busy
```

`--help` prints the states and their limits.

## What it does

1. Starts one seat with `claude-tab.sh --seat --model haiku` in a throwaway folder. When `kitty @ ls` does not answer it starts a headless kitty (needs a display, for example xvfb) and stops it at the end.
2. For each state, sends a unique message with `agent-send.mjs` and asserts the store holds an `ack` row with a `deliveredAs` value for it within the state's time limit.
3. Prints one JSON line per state, then a summary line, and closes the seat.

A state passes on an ack row with a `deliveredAs` value; when `agent-send` exited non-zero it passes only if a consumer (`prompt`, `tool`, `stop`, `mcp`) wrote the label, not the `typed` fallback.

The seat is started with a short confining brief: one action per message, and never approve a permission itself. The `busy` setup approves only a prompt whose screen shows its own timer command; the `permission` state approves only its own `touch` prompt, after the send, and only when the dialog (below the echo of its setup prompt) proposes exactly that command: the whole command block, so a multi-line proposal that merely starts with it is refused. Two dialog layouts are read, a ruled one (the command between dashed `╌` rules, recorded from a real seat in `tests/fixtures/permission-dialog-ruled.txt`) and an unruled one (`tests/fixtures/permission-dialog-unruled.txt`). A dialog that is on screen but does not match (a command wrapped on a narrow window, another proposal) fails with "dialog was on screen but its command did not match". Any failed state presses Escape afterwards, so an open dialog cannot cascade. `FLEET_DRILL_DUMP_DIR` keeps every dialog screen the drill sees, to record a new layout. Refusing the prompt with Escape is no way to test delivery: the seat goes idle and the queued message stays unacked until the seat's next prompt (a gap in agent-send's dialog queue, deliberately not asserted here). The seat window is always closed at the end, on a pass, a failure or a signal.

The seat starts with the drill's private store pinned (`AGENT_SWITCHBOARD_DIR` and `AGENT_SWITCHBOARD_DB`): `claude-tab.sh` passes any such pin on to the seat with kitty's `--env`, because kitty starts the tab from its own environment, not the launcher's.

The first turn of the seat reads its brief, and that turn counts against `FLEET_DRILL_READY_S` (180 s by default, ample for a haiku greeting; raise it on a slow machine).

The `merge` state needs the seat's tools pre-allowed, as the drill approves nothing there: it writes `Bash(git:*)` and `Bash(gh:*)` into the seat's folder settings when `merge` runs (a push is a `git` command). Any other tool call prompts and leaves the state waiting until the limit.

The drill writes `.claude/settings.local.json` into the throwaway folder, pinning `defaultMode: default` and `ask` rules for its own `touch fleet-drill-*` command and for the busy timer's `node -e` command (so that prompt is certain, and the drill approves it itself), and nothing allowed, and, only when the `merge` state runs, `Bash(git:*)` and `Bash(gh:*)`: a seat otherwise inherits the user's mode, and in bypass mode no permission prompt can ever appear.

The seat needs the mailbox hooks in its Claude Code config, and the throwaway folder must be one Claude Code trusts (`FLEET_DRILL_CWD_ROOT` points it at a folder under a trusted tree).

## States

| State | Limit | Setup | Assertion |
|---|---|---|---|
| `idle` | 30 s | seat at the prompt | an ack row with `deliveredAs` |
| `slash` | 30 s | seat at the prompt; the message is `/context` | the ack row, and the composer is empty and the seat idle afterwards (the command was submitted, not left typed) |
| `busy` | 90 s | the seat runs a 45 s `node -e setTimeout` tool call (not `sleep`: Claude Code refuses a foreground sleep) | the ack row is not `typed`, and the timer's tool result is still in the transcript when the turn ends (nothing in flight was discarded) |
| `permission` | 60 s | the seat shows a permission prompt for the drill's own `touch fleet-drill-*` | the send is queued (exit 3, not typed into the prompt); after the drill approves its own prompt the ack row arrives within the limit |
| `merge` | 300 s | the seat opens a PR in the sandbox repo | `gh pr view --json state` says `MERGED` after the merge command ran |
| `closed` | 30 s | the seat window is closed with `kitty @ close-window` (`claude-tab.sh --close` refuses a `--seat` window) | the send exits 1 with "no kitty window with id", and no ack row exists |

`all` runs the states in this order, leaving out `merge` unless it is configured; `closed` is always last because it removes the seat.

## Merge stage

Off unless `FLEET_DRILL_SANDBOX` (`owner/name` of a throwaway repo) is set. The seat clones it and opens a PR titled with a unique token. The script then runs `$FLEET_DRILL_MERGE_CMD <owner/name> <number>`, a merge-on-green wrapper you provide, and asserts the PR ends `MERGED` within the limit.

## Output and exit codes

One JSON line per state: `{state, ok, ms, deliveredAs, reason}`, then `{summary: true, ok, passed, failed}`.

| Code | Meaning |
|---|---|
| 0 | Every state passed. |
| 1 | A state failed; stderr prints `FAILED: <states>`. |
| 2 | Usage error (no state named, an unknown state, no `FLEET_DRILL_STORE_DIR`), or the seat could not be started. |

## Environment

Every variable is optional.

| Variable | Default | Meaning |
|---|---|---|
| `FLEET_DRILL_LIMIT_<STATE>_S` | table above | Time limit from the send to the ack. |
| `FLEET_DRILL_READY_S` | `180` | Seat start to idle. |
| `FLEET_DRILL_SETUP_S` | `90` | Time to reach the busy or permission state. |
| `FLEET_DRILL_SETTLE_S` | `180` | Busy turn to its end. |
| `FLEET_DRILL_POLL_MS` | `1000` | Poll interval. |
| `FLEET_DRILL_MODEL` | `haiku` | Seat model. |
| `FLEET_DRILL_CWD_ROOT` | the temp dir | Parent of the throwaway folder. |
| `FLEET_DRILL_STORE_DIR` | none: required | The drill's own store folder; sets `AGENT_SWITCHBOARD_DIR` for every child and drops `AGENT_SWITCHBOARD_DB`. Refused (exit 2) when unset, because a headless kitty numbers windows from 1 and a shared store could hold a live seat's beacon under the same id. |
| `FLEET_DRILL_CLAUDE_TAB`, `_AGENT_SEND`, `_KITTY_SEND`, `_TAB_STATE`, `_TYPING_PROOF`, `_EXPORT`, `_KITTY`, `_GH` | the sibling `bin/` and `lib/` files, `kitty`, `gh` | Replace a binary (the test seam). |
| `FLEET_DRILL_SANDBOX`, `FLEET_DRILL_MERGE_CMD` | unset | Enable the merge stage. |

## Expected result today

A seat on a build where a slash command is typed without confirming the submit, or where a send onto a busy seat is typed in, fails `slash` and `busy` respectively. The drill is the regression gate for those two fixes.
