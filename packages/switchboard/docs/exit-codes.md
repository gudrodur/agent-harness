# Exit codes

## agent-send.mjs

| Code | Meaning |
|---|---|
| 0 | Acked, or proven by the terminal fallback. |
| 3 | Not delivered yet (queued, or no proof): do not resend. Queued for a role with no live holder also exits 3. |
| 10 | Typed but not proven submitted: look at the window before resending. |
| 11 | `--claim-role`: a live seat holds the role; the claim changed nothing (`--take-over` takes it). |
| 12 | `--release-role`: another session holds the role. |
| 13 | `--cancel`: the row was already delivered or withdrawn. |
| 14 | `--cancel`: no such row. |
| 15 | `--topic`: the topic was already delivered to the recipient within `--topic-window`; this message was suppressed and nothing was sent (`--force-topic` sends anyway). |
| other | `bin/kitty-send.sh`'s code, below. |

## kitty-send.sh

| Code | Meaning |
|---|---|
| 0 | Sent and proven (a new user row in the tab's session record). Under `--queue` it means only that the background waiter started; the verdict lands in the queue log. |
| 1 | Usage or precondition error (no kitty remote control, no such window). |
| 3 | Sent, but could not prove it landed: do not resend. Any failure after the keystrokes went out (a screen read, say) also exits 3, never 1 or 11. |
| 4 | The target shows a selection dialog, or its session record status is `waiting` or `blocked`: nothing sent, in every mode (`--now` included); under `--wait-idle`, `--deadline` or `--queue` the wait loop keeps waiting for it to clear and exits 5 if it does not. |
| 5 | `--wait-idle` or `--deadline` ran out before the target went idle: nothing sent. |
| 6 | `--queue`: a send is already queued for that window: nothing sent. |
| 7 | The target is mid-turn and none of `--wait-idle`, `--queue`, `--now` was given: nothing sent. |
| 8 | Sent with `--now` mid-turn and still mid-turn: pending in the steering queue until the tool boundary. Do not resend. |
| 9 | The composer already holds an unsubmitted paste chip that is not kitty-send's own: nothing sent. |
| 10 | Typed, not proven submitted (no session record to read): look at the window before resending. |
| 11 | Nothing sent, safe to put the message back: the screen could not be read before the send, the composer was still not clear after the recovery Enter, or the typing proof (`lib/typing-proof.mjs`, run immediately before the first keystroke by `--queue`, `--wait-idle` and `--deadline`) did not pass (not a Claude Code tab, not idle, a draft in the composer, or node or the module missing). A tab with no Claude Code process (a shell, REPL, pi or OpenCode tab) is checked for a dialog only. A `/` text is not refused here, so an explicit `/rename` goes through. `--now` and a bare send run only the dialog check, so they still type onto a draft. agent-send re-queues on it, or reports it as 1 on the direct fallback. |

The comment block at the top of `bin/kitty-send.sh` is the authority.

Launchers (`opencode-tab.sh`, `claude-tab.sh`): exit 2 means no terminal remote control (fall back to headless and say so); exit 3 means the session started on another model and the tab was closed.
