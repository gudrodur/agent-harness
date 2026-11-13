# Fleet drill

`bin/fleet-drill.mjs` is an end-to-end check, meant to run nightly, that a message sent with `agent-send.mjs` reaches a live Claude Code seat in every state a recipient can be in. It costs a few model turns on the cheapest model (haiku), so it is not part of the test suite; `tests/fleet-drill.test.mjs` runs the whole script against stub binaries instead.

```sh
node bin/fleet-drill.mjs --states all
node bin/fleet-drill.mjs --states idle,busy
```

`--help` prints the states and their limits.

## What it does

1. Starts one seat with `claude-tab.sh --seat --model haiku` in a throwaway folder. When `kitty @ ls` does not answer it starts a headless kitty (needs a display, for example xvfb) and stops it at the end.
2. For each state, sends a unique message with `agent-send.mjs` and asserts the store holds an `ack` row with a `deliveredAs` value for it within the state's time limit.
3. Prints one JSON line per state, then a summary line, and closes the seat.

The seat needs the mailbox hooks in its Claude Code config, and the throwaway folder must be one Claude Code trusts (`FLEET_DRILL_CWD_ROOT` points it at a folder under a trusted tree).

## States

| State | Limit | Setup | Assertion |
|---|---|---|---|
| `idle` | 30 s | seat at the prompt | an ack row with `deliveredAs` |
| `slash` | 30 s | seat at the prompt; the message is `/context` | the ack row, and the composer is empty and the seat idle afterwards (the command was submitted, not left typed) |
| `busy` | 90 s | the seat runs `sleep 45` in a tool call | the ack row is not `typed`, and the sleep's tool result is still in the transcript when the turn ends (nothing in flight was discarded) |
| `permission` | 60 s | the seat shows a permission prompt | an ack row; the prompt is then refused |
| `merge` | 300 s | the seat opens a PR in the sandbox repo | `gh pr view --json state` says `MERGED` after the merge command ran |
| `closed` | 30 s | the seat is closed with `claude-tab.sh --close` | the send exits 1 (no such window), and no ack row exists |

`all` runs the states in this order, leaving out `merge` unless it is configured; `closed` is always last because it removes the seat.

## Merge stage

Off unless `FLEET_DRILL_SANDBOX` (`owner/name` of a throwaway repo) is set. The seat clones it and opens a PR titled with a unique token. The script then runs `$FLEET_DRILL_MERGE_CMD <owner/name> <number>`, a merge-on-green wrapper you provide, and asserts the PR ends `MERGED` within the limit.

## Output and exit codes

One JSON line per state: `{state, ok, ms, deliveredAs, reason}`, then `{summary: true, ok, passed, failed}`.

| Code | Meaning |
|---|---|
| 0 | Every state passed. |
| 1 | A state failed; stderr prints `FAILED: <states>`. |
| 2 | Usage error, or the seat could not be started. |

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
| `FLEET_DRILL_STORE_DIR` | the ambient store | Sets `AGENT_SWITCHBOARD_DIR` for every child and drops `AGENT_SWITCHBOARD_DB`. |
| `FLEET_DRILL_CLAUDE_TAB`, `_AGENT_SEND`, `_KITTY_SEND`, `_TAB_STATE`, `_TYPING_PROOF`, `_EXPORT`, `_KITTY`, `_GH` | the sibling `bin/` and `lib/` files, `kitty`, `gh` | Replace a binary (the test seam). |
| `FLEET_DRILL_SANDBOX`, `FLEET_DRILL_MERGE_CMD` | unset | Enable the merge stage. |

## Expected result today

A seat on a build where a slash command is typed without confirming the submit, or where a send onto a busy seat is typed in, fails `slash` and `busy` respectively. The drill is the regression gate for those two fixes.
