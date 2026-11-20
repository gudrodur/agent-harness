# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Resynced `engine/lib/doc-scope.mjs` and `engine/lib/shell-command.mjs` with the
  upstream copies they were extracted from (see 1.0.0 "Changed" for the two
  behaviour changes). The bundle header now names `live-values@<version>`.

### Fixed

- A space-padded count is read as the bare integer. BSD (macOS) `wc -l` prints
  `       0`, which `int` and `word` formats rejected as not a non-negative int.
  Both ends are trimmed before validating; only `^\s*\d+\s*$` passes, so `-1`
  and `abc` still fail. `text` format is unchanged.
- `stripHeredocBodies` and `heredocBodies` (`engine/lib/shell-command.mjs`) are
  linear in the command. A line holding many heredoc openers made them
  quadratic (`shift()` on the open-tag queue), and about 120 000 openers threw
  a `RangeError` (the tags were pushed with a spread). Output is unchanged; the
  bundle does not use them, so `dist/` is unchanged.
- The heredoc readers (`stripHeredocBodies`, `heredocBodies`) share one
  scanner that finds heredocs where bash does. A `<<` inside quotes, a
  comment, arithmetic (`$((a<<b))`, `$[a<<b]`, the subscript in
  `a[1<<2]=3`), `${…}` or a backtick span no longer opens
  a heredoc that hid every later line from the gates; one inside `$(…)` still
  does. A `<<<word` herestring opens none. The delimiter is the whole shell
  word, quote-removed (`<<\TAG`, `<<E"OF"`, `<<'EOF bar'`, `<<END-OF`), and a
  body starts only once the command line ends, after a quote or a `\`
  continuation left open on the opener's line. `heredocBodies` entries carry
  `quoted`: true when any part of the delimiter is quoted, so the shell leaves
  the body unexpanded. A test runs random commands through bash and checks
  that no line the strip drops is one bash runs. `dist/` is unchanged.

## [1.0.0] - Unreleased

First tagged release. The date is filled in when the tag is cut.

### Added

- Portable engine (`engine/live-values.mjs`) that checks computed numbers in
  prose: a live marker next to a number is verified against a command registry
  (`live-values.json`), with no dependencies and Node 24 or newer.
- Single-file bundle `dist/live-values.mjs`, built with Bun by `build.mjs`,
  which adopting repos copy verbatim to `scripts/live-values.mjs`. A copy-identity
  check keeps every copy byte-identical; the bundle header names
  `live-values@<version>`.
- Adopter workflow (`workflow/live-values.yml`), which keeps the runner-label
  lane configurable, plus adoption docs and a skill.
- World-sourced entries: a drifting world value prints a refresh line and exits
  0 instead of failing, and `--refresh-world` rewrites only world-sourced spans;
  repo drift still exits 1.
- A `word` rendering that spells out zero to twenty and renders digits above, so
  a growing count never fails a snapshot.
- Repository CI: test suite, bundle freshness gate, self-check of this repo's
  docs, pinned action versions, and a guard that fails a pull request whose
  commits or description carry an AI authorship marker.

### Changed

- `checkLocal` (the `--local` gate of a proof reader) now gates every command
  of a proof: each pipe, `&&`, `||` and `;` segment and each `$(...)` or
  backtick substitution must be on a read-only allowlist, with per-tool
  argument rules (`node` runs only `scripts/<name>.mjs`, `git` only read
  subcommands, no `find -exec`, `sed -i`, `sort -o`, `rg --pre`, writing
  `awk` programs or output redirection). It previously read the first word only.
  The refusal reason names the most telling tool (network, then container).
  `checkQuerySegments`, which the engine uses, is unchanged.
- The shell-command reader skips `exec` options (`exec -a NAME cmd`) when
  finding the command word.
