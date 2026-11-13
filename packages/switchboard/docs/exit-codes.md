# Exit codes

## agent-send.mjs

| Code | Meaning |
|---|---|
| 0 | Acked, or proven by the terminal fallback. |
| 3 | Not delivered yet (queued, or no proof): do not resend. Queued for a role with no live holder also exits 3. |
| 10 | Typed but not proven submitted: look at the window before resending. |
| 11 | The screen could not be read before the send, or the composer was still not clear after the recovery Enter: nothing sent, safe to put the message back. |
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
| 3 | Sent, but could not prove it landed: do not resend. |
| 4 | The target shows a selection dialog: nothing sent. |
| 5 | `--wait-idle` or `--deadline` ran out before the target went idle: nothing sent. |
| 6 | `--queue`: a send is already queued for that window: nothing sent. |
| 7 | The target is mid-turn and none of `--wait-idle`, `--queue`, `--now` was given: nothing sent. |
| 8 | Sent with `--now` mid-turn and still mid-turn: pending in the steering queue until the tool boundary. Do not resend. |
| 9 | The composer already holds an unsubmitted paste chip that is not kitty-send's own: nothing sent. |
| 10 | Typed, not proven submitted (no session record to read): look at the window before resending. |

The comment block at the top of `bin/kitty-send.sh` is the authority.

Launchers (`opencode-tab.sh`, `claude-tab.sh`): exit 2 means no terminal remote control (fall back to headless and say so); exit 3 means the session started on another model and the tab was closed.
