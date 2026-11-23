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

- `checkLocal` no longer misses a redirect that follows an escaped quote: `echo \' > /tmp \'`
  returned `ok: true` because `\'` opened a quote span that hid the real `> /tmp`. The write
  check now reads the command with the shared `shellWordsDetailed` scanner, so a backslash-escaped
  quote opens no span, a quoted `>` stays text, and `> /dev/null` and `2>&1` stay allowed.
  `dist/` is unchanged.
- `shellWordsDetailed` and `shellWords` join a backslash-newline as bash does: bare,
  in double quotes, in backticks and in an unquoted heredoc body (before its terminator is
  matched) the pair is removed before the words are read, so a word split over two lines
  reads whole. Single quotes, `$'...'`, a comment and a quoted heredoc body keep it, also
  inside `$(...)`: the join follows a stack of those contexts (`joinContinuations`,
  exported) with the `case` grammar and the heredocs of each, and a `#` opens a comment
  only after bash's own blanks and operators. The second `$` of `$$` opens no `$'...'`, so a quote
  after the pid parameter hides no flag after it. Known limits: `splitSegments` does not
  join, so an operator split by a backslash-newline gives different segments, and a lone
  backslash at the very end of the text is kept. (#57)
- A `word` or `int` query whose earlier pipeline stage died is could-not-check, even with
  stderr silenced: `grep -oP … 2>/dev/null | wc -w` no longer reads
  0. Only exit 2 or more on an earlier stage counts, and 141 (SIGPIPE from `head -1`) is
  excluded; exit 1 never counts (no-match `grep`, `git grep`, `jq -e`, a loop whose last
  test was false), and a compound stage is not labelled by its closing keyword. `runCommand` takes `deadStages`. Documented in `docs/grammar.md`
  and the README; snapshot-path and `runCommand` unit tests added. (#51)
- A `word` or `int` query that writes to stderr is `QUERY_FAILED` (could not check), not a
  value. A pipeline reports only its last stage's status, so `grep -oP ... | wc -w` on
  BSD grep (no `-P`) printed `0` and read as a confident "zero" (samtak-vefur#970).
  `runCommand` takes `failOnStderr`; text formats are unchanged. (#49)
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
