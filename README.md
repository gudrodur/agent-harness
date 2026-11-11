# agent-harness

Small standalone tools for working with coding agents. Each package has its own README, tests and no dependency on the other; they live in one workspace so they share CI, a license and a release rhythm.

| Package | What it is |
|---|---|
| [`packages/switchboard`](packages/switchboard) | `agent-switchboard`: a file-backed mailbox with acks between agent sessions on one machine (Claude Code, Codex, opencode), a terminal send-text fallback with delivery proof, and a kitty tab launcher. |
| [`packages/live-values`](packages/live-values) | `live-values`: computed numbers in prose. A marker in a document is checked against a command registry, so a count that changes can never silently drift out of the text. One portable engine, no dependencies. |

## Requirements

Node 24 or newer and [pnpm](https://pnpm.io). The `live-values` bundle is built with [Bun](https://bun.sh) (pinned in CI); the switchboard store parity test also needs Bun, and its terminal suite needs kitty.

## Commands

```sh
pnpm install
pnpm test                 # both suites, one after the other
pnpm test:switchboard     # mailbox, hooks, launchers, kitty fallback
pnpm test:live-values     # engine, libraries, hook
```

Commands that depend on a package's files (the `live-values` document check, `node build.mjs --check`) run from that package's directory.

## Layout

```
packages/switchboard/   agent-switchboard
packages/live-values/   live-values (engine/, committed bundle in dist/)
.github/workflows/      CI and the AI-authorship guard
```

## License

MIT, see [LICENSE](LICENSE).
