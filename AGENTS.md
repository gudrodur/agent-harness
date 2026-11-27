# agent-harness

A small public MIT monorepo of tools for working with coding agents on one machine. Two
packages share CI, a license and a release rhythm but no code: `packages/switchboard`
(`agent-switchboard`, a file-backed mailbox with acknowledgements between agent sessions, a
terminal send-text fallback with delivery proof, and a kitty tab launcher) and
`packages/live-values` (`live-values`, computed numbers in prose that are checked against a
command registry, so a count cannot silently drift).

Repository: `gudrodur/agent-harness` (public).

## Stack and entry points

- Node 24+ and pnpm; the `live-values` bundle is built with Bun (version pinned in CI). The
  switchboard terminal suite needs kitty.
- `packages/switchboard/` — mailbox store, hooks, launchers, kitty fallback.
- `packages/live-values/` — `engine/` sources and the committed bundle in `dist/`.
- `.github/workflows/` — `ci.yml` plus the issue-title, PR-close-row, revisit and
  AI-authorship guards.

## Build, test and run

```sh
pnpm install
pnpm test                  # both suites, one after the other
pnpm test:switchboard
pnpm test:live-values
```

Commands that depend on a package's files (the `live-values` document check,
`node build.mjs --check`) run from that package's directory. Not run here: dependency install
and the full suites are left to CI.

## Deploy and accounts

Nothing is deployed and there is no cloud account. Releases are package versions in this
repo. `dist/live-values.mjs` is committed and must be rebuilt and committed with the sources
that produce it.

## Rules

- **Public repo.** No exploit detail, internal URLs or credential names in issues, PRs or
  commit text.
- A change to `packages/live-values/engine/` includes the rebuilt `dist/` bundle in the same
  PR; CI checks it with `node build.mjs --check`.
- The workflow guards are part of the contract: issue titles, PR close rows, `Revisit:`
  lines, and no AI authorship in commits or PR text.
- `pnpm test` is the gate, and the two packages stay independent (no cross-package imports).

## Docs

- `README.md` — package table and commands.
- `packages/switchboard/README.md`, `packages/live-values/README.md`.
- `CHANGELOG.md` — release notes.
