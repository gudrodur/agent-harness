# Changelog

All notable changes to the agent-harness workspace are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `packages/switchboard`:
  - Resource leases: added resource lease manager (`lib/resource-leases.mjs`) and suite (`tests/resource-leases.test.mjs`) supporting exclusive resource reservation across local agent sessions.
  - Seat lifecycle: added `--retire` and `--reseat` commands, seat handover tracking (`lib/seat-handover.mjs`), and `bin/seat-finished.mjs`.
  - Delivery and typing proofs: added `lib/typing-proof.mjs` verifying composer state and typing proofs before delivery.
  - Fleet drill: added `bin/fleet-drill.mjs` and docs for nightly end-to-end send drills.
  - Busy detection: added busy-window detection preventing typing into a seat displaying the busy marker or mailbox-only seats.
  - Piped output: flushed stdout before exit to prevent truncation of piped output at 64 KiB.
  - Fallback messaging: pointed Claude Code callers at SendMessage when kitty remote control is unavailable.
- `packages/live-values`:
  - Cleaned build header: removed repository URL / slug from generated bundle header (`dist/live-values.mjs`) and added `tests/build-header.test.mjs`.

### Fixed

- `packages/live-values`:
  - `stripHeredocBodies` and `heredocBodies` in `engine/lib/shell-command.mjs` are linear: a line of many heredoc openers no longer makes them quadratic or throws a `RangeError`.
  - The heredoc readers find heredocs where bash does: never inside quotes, a comment, arithmetic (`$((…))`, `$[…]`, an array subscript) or backticks, never at a `<<<word` herestring; the delimiter is the whole quote-removed word (`<<\TAG`, `<<E"OF"`); a body starts once the command line ends. `heredocBodies` says whether each delimiter is quoted.
- `packages/switchboard`:
  - A queued note now reaches a seat whose turn never ends. A prompt posted with `delivery: queue` waits for the end of the current work, and a seat looping inside one turn (the supervisor's merge queue) never reaches it: 18 notes were held that way on 2026-11-28. `--queue` to an OpenCode seat now posts `delivery: steer`, which the server delivers before the agent's next model call even mid-work, and `opencode-prompt.mjs drain` (or `send --drain`) turns the inbox's `queue` backlog into ONE combined item carrying every note with the time it was queued, deleting the originals once the combined item is accepted. Claude Code seats keep the existing drain.
  - A prompt accepted by an OpenCode seat's server is proven by its inbox item, not only by a message. `POST /api/session/<id>/prompt` answers with a `Session.Inbox.User` that waits in the session's inbox until the agent consumes it; the proof read the message log, so every delivery to an attached seat that had not started a run was reported unproven (exit 3, "could not be read back") while the text was in the inbox. `deliverPrompt` now looks in `GET /api/session/<id>/inbox` first and falls back to the message log for an item a run already consumed, and a prompt in neither is still exit 3. A tab started `--standalone` runs its own loopback server that holds the session while the shared registry's server only has its record, where a prompt would enter an inbox no client reads: the tab's own servers are found from its process family (the beacon's host pid, or the window's) and asked before the registry, a server answering "no such session" hands the text to the next, and the POST and read-back both go to the server that took it (`--pid`/`--server` on `bin/opencode-prompt.mjs`).
  - A seat's `LOKA-DONE <session id>` marker now ends its claims: the roles it held are released, in every location, when the marker is recorded, and that session can no longer claim a role (exit 11), so a finished seat cannot take its role back and a `--close --after-loka` no longer needs a manual release first. A role claimed *after* the marker still refuses the close, and role-store events (the notice a takeover writes to the displaced seat) are delivered but are not counted as mail newer than the marker, so bookkeeping no longer voids a close-out. A finished verdict also releases the claims a marker recorded before this rule left behind.
  - A message to `role:<name>` whose live holder carries a window but no mailbox consumer flag is no longer reported as not sent when typing cannot deliver it: with the holder's mailbox key known, a failed typing attempt (kitty-send sent nothing, a busy or gone window, or no window recorded at all) parks the row in the holder's own mailbox and the sender sees exit 3, "pending, do not resend". A window target keeps its older contract.
  - A seat with several rows (one per tree it works in) is judged by its live consumer, not by its newest row. `role:<name>` resolves to the holder's row with a live consumer: the claimed cwd's row if it has one, else the newest such row, else the old order. A session key that no row answers exactly ranks on the live consumer, not the bare flag. An exact key reads as reachable when any row of the same session has a live consumer, since every consumer drains by session id. Before this, a plugin-driven seat whose tool hooks write consumerless rows per tree bounced every role send while it drained fine.
  - `opencode-tab.sh` probe: the session the pre-launch model probe creates in its throwaway directory is deleted (`session delete --standalone`) whatever the outcome, answered, failed or hung, so session pickers no longer list a pile of one-word "OK" sessions. The delete is read back (a row that outlived it is reported) and only ever runs in a probe directory.
  - Typing proof: the composer is read with `get-text --ansi`, so the faint prompt suggestion Claude Code shows after a turn no longer blocks typed delivery to an idle seat; normal text, chips and unparsable escapes still refuse. A quiet `--queue` wait now prints `held: <reason>` once per distinct reason.
  - Idle with background work: a Claude Code seat whose turn has ended while background agents or tasks still run records status `busy`, yet waits at its prompt. One shared reading (`claudeSeatState` in `lib/typing-proof.mjs`, the CLI `--mode seat` for the shell scripts) now tells it from the seat's own turn by its screen, on positive proof only (an empty composer, the footer whole to `↓ to manage`, background work listed), so queued and bare sends reach it and its queued rows drain. Its own turn (`esc to interrupt`, a progress line, a spinning title), compaction, a draft, a cut-off footer, a screen it cannot read and a dialog all stay busy or held. A send to a seat recorded busy refuses a draft in its composer, and the dialog proof runs again before every Enter (a slash command, typed with its Enter, also needs a composer on the screen first), so a prompt that opened before that read gets no Enter. `claude-tab.sh --retire` and `--close --after-loka` still refuse a seat with background work (exit 23), and so do agent-send and kitty-send, in every mode, for a command that would end or wipe its conversation (`/exit`, `/quit`, `/clear`, `/new`, `/reset`, a bare `exit` or `quit`).

## [1.0.0] - 2026-11-11

First tagged release of the multi-package agent harness repository.

### Added

- Root pnpm workspace containing:
  - `packages/live-values`: portable engine verifying computed numbers in markdown prose against registry commands, single-file bundle distribution with Bun, and adopter CI workflows.
  - `packages/switchboard`: file-backed mailbox with deliveries, acks, presence tracking, and terminal send fallback with delivery proofs.
- Workspace CI workflows including test suites, bundle freshness, and server-side no-AI-authorship markers guard.
- Issue convention guards: issue title guard, revisit date guard, and PR close-row guard.
