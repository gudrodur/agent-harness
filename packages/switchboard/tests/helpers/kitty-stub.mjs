// A `kitty` stand-in for the kitty-ls tests. Each call appends one line to
// `calls` (epoch ms, then the argv); `@ ls` serves `ls.json`, where a
// `__N__` is replaced by the call's ordinal when the stub counts. The mode
// file picks the behaviour:
//   ok        serve the listing
//   slow:S    sleep S seconds, then serve it
//   hang      never answer (the caller's timeout ends it)
//   refused   exit 1 with a connection error
//   nomatch   a `--match` read exits 1 with "No matching windows"
//   badopt    a `--match` read exits 1 with an unknown-option error
import fs from 'node:fs';
import path from 'node:path';

export const makeKittyStub = (dir, { windows = [{ id: 11, title: 'one', pid: 101 }, { id: 12, title: 'two', pid: 102 }], counting = false } = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'kitty');
  const calls = path.join(dir, 'calls');
  const mode = path.join(dir, 'mode');
  const ls = path.join(dir, 'ls.json');
  const counter = path.join(dir, 'counter');
  fs.writeFileSync(bin, [
    '#!/usr/bin/env bash',
    `d=${JSON.stringify(dir)}`,
    'printf \'%s %s\\n\' "$(date +%s%3N)" "$*" >> "$d/calls"',
    'm=$(cat "$d/mode" 2>/dev/null || echo ok)',
    '[ "${1:-}" = "@" ] || exit 0',
    'case "$m" in',
    '  hang) exec sleep 30 ;;',
    '  refused) echo "Error: Failed to connect to the kitty socket: Connection refused" >&2; exit 1 ;;',
    'esac',
    'case " $* " in *" --match "*)',
    '  case "$m" in',
    '    nomatch) echo "Error: No matching windows for expression: x" >&2; exit 1 ;;',
    '    badopt) echo "Error: unknown option --match" >&2; exit 1 ;;',
    '  esac ;;',
    'esac',
    'case "$m" in slow:*) sleep "${m#slow:}" ;; esac',
    'if [ -f "$d/counter" ]; then n=$(( $(cat "$d/counter") + 1 )); echo "$n" > "$d/counter"; sed "s/__N__/$n/g" "$d/ls.json"; else cat "$d/ls.json"; fi',
    '',
  ].join('\n'), { mode: 0o755 });
  const setWindows = (wins) => fs.writeFileSync(ls, JSON.stringify([{ id: 1, tabs: [{ id: 1, title: 'tab', windows: wins }] }]));
  setWindows(windows);
  if (counting) fs.writeFileSync(counter, '0');
  return {
    bin,
    dir,
    setWindows,
    setMode: (m) => fs.writeFileSync(mode, m),
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf-8').trim().split('\n').filter(Boolean) : []),
    lsCalls() { return this.calls().filter((l) => / @ ls\b/.test(` ${l.split(' ').slice(1).join(' ')}`)); },
    resetCalls: () => fs.rmSync(calls, { force: true }),
  };
};
