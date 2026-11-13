# agent-switchboard

File-backed mailbox with acks between agent sessions on one machine, a kitty send-text fallback, and a tab launcher. Public MIT repo: no internal URLs or credential names, and no other repo's `#N`, no seat or window numbers, and no machine paths, in code, comments, commits, PR or issue text. A comment states its own reason in words instead of pointing at a private tracker. `.github/workflows/ai-authorship-guard.yml` also refuses AI authorship markers in commits and PR bodies. Node >= 24.

## Tests

- Full: `npm test` (runs both below; quiet, failures print detail).
- Node only: `npm run test:node`; one file: `node --import ./tests/helpers/isolate-setup.mjs --test tests/<name>.test.mjs`.
- Kitty only: `npm run test:kitty` (drives real throwaway kitty windows; exit 2 means no remote control). `KITTY_TEST_VERBOSE=1` prints every case.

## Live install

A companion configuration repo can point `AGENT_SWITCHBOARD_HOME` at a checkout of this package and import the hooks from it, so merging a change here changes running sessions on that machine. Work in a worktree and never edit that checkout in place.

## Consumers by runtime

- Claude Code: `hooks/claude/mailbox-inject.mjs` (each prompt), `hooks/claude/mailbox-tool.mjs` (PostToolUse drain), `hooks/claude/mailbox-stop.mjs` (Stop drain).
- Codex: `hooks/codex/mailbox.mjs` (`~/.codex/hooks.json`).
- opencode: not in this repo; its consumer is a plugin that lives in the companion configuration repo.

## Where things are

`bin/` sender, fallback, launchers, tab-state; `lib/` store, mailbox, presence; `tests/`; `docs/`.

## Router

- Channel map, install, sending and launching: `README.md`.
- Env vars and timers: `docs/configuration.md`. Exit codes: `docs/exit-codes.md`.
- Nightly seat drill: `docs/fleet-drill.md`.
- Seat roles: `docs/seat-roles.md`. Resource leases: `docs/resource-leases.md`. Launchers: `docs/launchers.md`.
- Message exchange patterns: `docs/patterns.md`.
