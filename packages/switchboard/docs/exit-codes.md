# Exit codes

## agent-send.mjs

| Code | Meaning |
|---|---|
| 0 | Acked, or proven by the terminal fallback. |
| 2 | A refused flag pair: `--no-wait` with `--now`, `--stop`, `--idle-when` or `--deadline`. Nothing was written or sent. |
| 3 | Not delivered yet (queued, or no proof): do not resend; `--status --id <id>` asks later (when an ack wait ended without an ack the sender prints that command). `--status` itself exits 3 for a pending row. Queued for a role with no live holder also exits 3, and `--no-wait` exits 3 as soon as the row is written. |
| 10 | Typed but not proven submitted: look at the window before resending. `--status` also exits 10 for a typed send whose delivery was unproven (kitty-send exit 3, or killed by a signal). |
| 11 | `--claim-role`: a live seat holds the role; the claim changed nothing (`--take-over` takes it). |
| 12 | `--release-role`: another session holds the role. |
| 13 | `--cancel`: the row was already delivered or withdrawn. `--status`: the row was withdrawn. |
| 14 | `--cancel` or `--status`: no such row. |
| 15 | `--topic`: the topic was already delivered to the recipient within `--topic-window`; this message was suppressed and nothing was sent (`--force-topic` sends anyway). |
| 16 | Typed, not proven submitted: kitty-send's code 16, passed through (never re-queued). |
| other | `bin/kitty-send.sh`'s code, below, except its 11 and 12, which agent-send reports as 1 because its own 11 and 12 mean a refused role claim or release. |

## kitty-send.sh

| Code | Meaning |
|---|---|
| 0 | Sent and proven (a new user row in the tab's session record). Under `--queue` it means only that the background waiter started; the verdict lands in the queue log. |
| 1 | Usage or precondition error (no such window, a refused flag pair). |
| 12 | Kitty remote control unavailable (`kitty @ ls` timed out or the socket is unreachable): nothing sent. agent-send reports it as 1, keeps any queued row, and prints one stderr line telling the calling Claude Code session to deliver with `ListAgents` plus `SendMessage` and to `--cancel --id <id>` the row. |
| 3 | Sent, but could not prove it landed: do not resend. Any failure after the keystrokes went out (a screen read, say) also exits 3, never 1 or 11. |
| 4 | The target shows a selection dialog, or its session record status is `waiting` or `blocked`: nothing sent, in every mode (`--now` included); under `--wait-idle`, `--deadline` or `--queue` the wait loop keeps waiting for it to clear and exits 5 if it does not. |
| 5 | `--wait-idle` or `--deadline` ran out before the target went idle: nothing sent. |
| 6 | `--queue`: a send is already queued for that window: nothing sent. |
| 7 | The target is mid-turn and none of `--wait-idle`, `--queue`, `--now` was given: nothing sent. |
| 8 | Sent with `--now` mid-turn and still mid-turn: pending in the steering queue until the tool boundary. Do not resend. |
| 9 | The composer already holds an unsubmitted paste chip that is not kitty-send's own: nothing sent. |
| 10 | Typed, not proven submitted (no session record to read): look at the window before resending. |
| 11 | Nothing sent, safe to put the message back: the screen could not be read before the send, the composer was still not clear after the recovery Enter, or the typing proof (`lib/typing-proof.mjs`, run immediately before the first keystroke by `--queue`, `--wait-idle` and `--deadline`) did not pass (a Claude Code tab that is not idle, a draft in the composer, or node or the module missing). A tab with no Claude Code process (a shell, REPL, pi or OpenCode tab) is checked for a dialog only, so it never fails the proof for being that kind of tab. A `/` text is not refused here, so an explicit `/rename` goes through. `--now` and a bare send run only the dialog check, so they still type onto a draft. agent-send re-queues on it, or reports it as 1 on the direct fallback. |
| 16 | A slash command was typed into a Claude Code tab and its composer still holds the command text after up to `KITTY_SEND_SLASH_ENTER_TRIES` (default 3) extra Enters: typed, not proven submitted, so look at the window and never resend blind. The composer is read back after the send; a swallowed Enter (the screen changes on the echo alone) is pressed again while the text remains. |

The comment block at the top of `bin/kitty-send.sh` is the authority.

Launchers (`opencode-tab.sh`, `claude-tab.sh`): exit 2 means no terminal remote control (fall back to headless and say so); exit 3 means the session started on another model and the tab was closed.

## claude-tab.sh --retire and --reseat

`--retire <window-id>` closes the window a role takeover displaced. It closes only when a handover row (written by `agent-send --claim-role R --take-over`) names that window and the caller, the window's pid is the recorded one, the id is not the caller's own window, and the displaced seat is idle.

| Code | Meaning |
|---|---|
| 0 | Closed and marked retired, or the window was already gone (the row is marked retired and its claims released). |
| 1 | Usage error (no numeric id, no calling session), the handover store could not be read, or `kitty @ ls` failed or printed something that is not a JSON array (the window is not assumed gone). Nothing closed, retired or released. |
| 2 | No terminal remote control. |
| 20 | No usable handover: none names the window, it names another session as taker, or it was already retired. Nothing closed. |
| 21 | The window's pid is not the recorded one: the id was reused. Nothing closed. |
| 22 | The id is the caller's own window. Nothing closed. |
| 23 | The displaced seat is not idle (busy, or its state cannot be proven). Nothing closed; retry when it is idle. |

## claude-tab.sh --close --after-loka

`--close <window-id> --after-loka` closes a window the launcher did not start, once its seat is shown to be finished: the Claude Code session in the window sent one message whose whole text is `LOKA-DONE <session-id>` after it started, holds no role in `seat_roles`, has no message or transcript prompt newer than it (read by `bin/seat-finished.mjs`), and is idle. Code 24 is any missing proof (no session, no marker, a role, later activity, an unreadable transcript, no `startedAt`); 25 is a live resource lease held by the session, or a place in a resource queue (release or leave first); 23 is a busy seat, 22 the caller's own window. Plain `--close` still refuses such a window. Codes 0, 1 and 2 are as above (a window already gone exits 0 with its claims released).

| Code | Meaning |
|---|---|
| 22 | The id is the caller's own window. Nothing closed. |
| 23 | The seat is not idle (busy, or its state cannot be proven). Nothing closed; retry when it is idle. |
| 24 | No finished proof: the window runs no Claude Code session, or its session has sent no "loka done" message since it started. The message names which. |

`--seat --role R --reseat <window-id>` exits 3 when the new seat started but the store does not show both halves within 90 seconds: the role claimed by the new session, and the handover retired. The message names the missing half.
