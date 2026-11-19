#!/usr/bin/env bash
set -euo pipefail

SWITCHBOARD_HOME="${AGENT_SWITCHBOARD_HOME:-$HOME/Development/projects/agent-harness/packages/switchboard}"
HOOK="$SWITCHBOARD_HOME/hooks/copilot/presence.mjs"
CONFIG_DIR="${COPILOT_CONFIG_DIR:-${HOME:?}/.copilot}"
SETTINGS="$CONFIG_DIR/settings.json"

if [ ! -f "$HOOK" ]; then
  printf 'copilot-install: no hook at %s\n' "$HOOK" >&2
  exit 1
fi

HOOK="$HOOK" SETTINGS="$SETTINGS" node <<'JS'
const fs = require('node:fs');
const path = require('node:path');

const settingsPath = process.env.SETTINGS;
const hook = process.env.HOOK;
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const next = {
  ...settings,
  statusLine: {
    ...(settings.statusLine ?? {}),
    type: 'command',
    command: `node ${shellQuote(hook)}`,
    refreshInterval: 5,
  },
};
const before = JSON.stringify(settings, null, 2);
const after = `${JSON.stringify(next, null, 2)}\n`;
if (before !== after.trimEnd()) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, after);
}
process.stdout.write(`${settingsPath}\n`);
JS
