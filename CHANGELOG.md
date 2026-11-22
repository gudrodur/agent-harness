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
  - Typing proof: the composer is read with `get-text --ansi`, so the faint prompt suggestion Claude Code shows after a turn no longer blocks typed delivery to an idle seat; normal text, chips and unparsable escapes still refuse. A quiet `--queue` wait now prints `held: <reason>` once per distinct reason.
  - Idle with background work: a Claude Code seat whose turn has ended while background agents or tasks still run records status `busy`, yet waits at its prompt. One shared reading (`claudeSeatState` in `lib/typing-proof.mjs`, the CLI `--mode seat` for the shell scripts) now tells it from the seat's own turn by its screen, so queued and bare sends reach it and its queued rows drain. Its own turn (`esc to interrupt`, a spinner line, a spinning title), a cut-off footer, a screen it cannot read and a dialog all stay busy or held.

## [1.0.0] - 2026-11-11

First tagged release of the multi-package agent harness repository.

### Added

- Root pnpm workspace containing:
  - `packages/live-values`: portable engine verifying computed numbers in markdown prose against registry commands, single-file bundle distribution with Bun, and adopter CI workflows.
  - `packages/switchboard`: file-backed mailbox with deliveries, acks, presence tracking, and terminal send fallback with delivery proofs.
- Workspace CI workflows including test suites, bundle freshness, and server-side no-AI-authorship markers guard.
- Issue convention guards: issue title guard, revisit date guard, and PR close-row guard.
