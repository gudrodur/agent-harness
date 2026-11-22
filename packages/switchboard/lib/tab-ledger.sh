# The launch ledger every kitty tab launcher shares (opencode-tab.sh and
# claude-tab.sh). Sourced, not run: it defines functions and the STATE path.
#
# The caller defines die() and note() first, with its own prefix, and sets HERE.
#
# STATE is `$XDG_RUNTIME_DIR/opencode-tab-launched.<uid>`, one row per launched
# window: `WID PID @LAUNCHER TITLE`. The file was named `omp-tab-launched.<uid>`
# while omp was a launcher; a ledger under the old name is moved over (mv, one
# directory, so atomic) the first time any launcher resolves STATE and the new
# name is absent, which keeps the rows of tabs that are still open.
#
# Provided here so the two launchers cannot drift:
#   config_root, claim_cli                       helpers (kitty_up and win_pid come
#                                                from lib/kitty-ls.sh)
#   tab_ledger_list                              --list: print live rows, prune gone ones,
#                                                release a gone window's brief claims
#   tab_ledger_close <id>                        --close: close only a window this ledger
#                                                recorded, refusing a stranger or a reused id
#   tab_ledger_close_finished <id>               --close --after-loka: close a window this ledger never
#                                                launched, once its seat sent its LOKA-DONE marker and is idle
#   tab_ledger_retire <id> <taker-session>       --retire: close the window a takeover displaced,
#                                                on the strength of a handover row (below)
#   tab_ledger_slot_holders                      the one-slot gate: print the live rows of
#                                                other launchers (empty: the slot is free)
#   tab_ledger_launch_pid <id>                   the pid of a window just launched, the read
#                                                retried while kitty does not answer
#   tab_ledger_add_row <id> <pid> <title> <cwd> <brief-ref>
#                                                record a launched window and claim its brief
#
# A row's pid is `?` when the window was launched but kitty did not answer the
# pid read. Such a row holds the slot while its id is live, --list records the
# live pid into it, and --close closes on the id alone.
#
# Every read here whose answer prunes a row, releases a claim or decides the
# slot is fresh: a cached list from before a window opened would show a live
# seat as gone.
#
# Brief claims (the companion repo task-claim CLI). Two seats on ONE brief is the
# race task claims exist for: once two overseer windows ran the
# same brief and one reset the tree under the other. Every launch claims
# `brief:<basename>` in the --cwd repo for the new window (owner kitty:<id>),
# a launch whose brief another LIVE window holds is refused unless
# --slot-override, and --close releases the window's claims. A window closed by
# hand never reaches --close, so a gone window's claims are released wherever
# the script learns it is gone: the --list prune, and a --close on a gone id
# with or without its row. The claims live in the companion repo's# store, reached through its CLI; a missing CLI is a loud skip, never a
# refusal. Test seam: SWITCHBOARD_TASK_CLAIM.

STATE="${XDG_RUNTIME_DIR:-/tmp}/opencode-tab-launched.$(id -u)"
_OLD_STATE="${XDG_RUNTIME_DIR:-/tmp}/omp-tab-launched.$(id -u)"
if [ ! -e "$STATE" ] && [ -e "$_OLD_STATE" ]; then
  mv "$_OLD_STATE" "$STATE" 2>/dev/null || true
fi

# kitty_up, win_record, win_pid, live_pid_map: the window reads, through the
# shared cache, lock and breaker (lib/kitty-ls.sh). A read that returns 2 means
# kitty did not answer, never that a window is gone.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kitty-ls.sh"

config_root() {
  if [ -n "${AGENT_CONFIG_HOME:-}" ]; then printf "%s" "$AGENT_CONFIG_HOME"
  else printf "%s" "$HOME"/.claude; fi
}
CLAIM_CLI="${SWITCHBOARD_TASK_CLAIM:-$(config_root)/scripts/task-claim.mjs}"
claim_cli() {
  if [ ! -r "$CLAIM_CLI" ]; then
    note "task-claim CLI not found at $CLAIM_CLI — brief claims skipped"
    return 0
  fi
  node "$CLAIM_CLI" "$@"
}

# --list. Each live row also carries the tab's state (bin/tab-state.sh).
tab_ledger_list() {
  local pruned line id pid launcher title now s stab stline st tl ag
  local state_tab; state_tab="$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)/tab-state.sh"
  kitty_up || die "kitty remote control unavailable.$KITTY_DIAG" 2
  [ -s "$STATE" ] || { echo "(no windows launched by this script)"; return 0; }
  # One `ls` for the whole listing, ids and pids together, not one per row:
  # this file is append-only, so a per-row read cost a kitty call per
  # historical entry. A listing kitty did not give prunes nothing.
  live_pid_map fresh || die "kitty remote control did not answer the window list (${KITTY_LS_MSG:-no answer}); nothing pruned." 2
  # Gone rows are pruned on every list, not kept: a gone id can never be acted
  # on again (--close on one just deletes the row and says "already gone"), and
  # without pruning the append-only file grows forever. Only ids ABSENT from
  # kitty are pruned; REUSED ids stay, since a stranger may own that id now and
  # the row is the evidence. (The loop holds the pre-prune fd, so deleting
  # mid-loop is safe; a concurrent launch appends new lines, which the
  # id-anchored pattern never matches.)
  pruned=0
  set -f
  while IFS= read -r line; do
    # shellcheck disable=SC2086: unquoted split is the parse; globbing off via set -f.
    set -- $line
    id=${1:-}; pid=${2:-}
    # New rows mark the launcher with @; anything without the marker is a row
    # an older script wrote, whatever its token count (a legacy title has
    # spaces, so counting fields misreads `WID PID legacy title` as a launcher
    # of `legacy`). Only known-collision: a legacy title whose FIRST word
    # starts with @ — no such title has ever been written.
    case "${3:-}" in
      @*) launcher=${3#@}; shift 3; title="$*" ;;
      *) launcher=unknown; shift 2 2>/dev/null; title="$*" ;;
    esac
    if [ -n "$id" ] && now=$(live_pid_of "$id"); then
      # An id can be REUSED: kitty's counter restarts with a new instance while
      # this file survives in tmpfs. Same id + different pid is a stranger.
      if [ "$pid" = "?" ]; then
        # Launched while kitty did not answer the pid read: record it now.
        sed -i "s/^$id ? /$id $now /" "$STATE" 2>/dev/null
        s=live
      elif [ "$now" = "$pid" ]; then s=live; else s="REUSED"; fi
    else
      s=gone
    fi
    # Gone ids are dropped, not displayed; the stderr count below keeps the signal.
    if [ "$s" = "gone" ]; then
      [ -n "$id" ] && sed -i "/^$id /d" "$STATE" 2>/dev/null && pruned=$((pruned + 1))
      [ -n "$id" ] && claim_cli --release-owner "kitty:$id" >/dev/null 2>&1
      continue
    fi
    # Proof by state on every row. A missing script or a failed read keeps the
    # row but says so; a row is never dropped for it.
    stab="state=? tool=- age=-"
    if [ -x "$state_tab" ]; then
      stline=$("$state_tab" "$id" 2>/dev/null | sed -n 's/^window [0-9]* //p')
      st=$(printf '%s' "$stline" | grep -o 'state=[^ ]*' | head -1)
      if [ -n "$st" ]; then
        tl=$(printf '%s' "$stline" | grep -o 'tool=[^ ]*' | head -1)
        ag=$(printf '%s' "$stline" | grep -o 'age=[^ ]*' | head -1)
        stab="$st ${tl:-tool=-} ${ag:-age=-}"
      fi
    fi
    printf '%-6s %-8s %-12s %-28s %s\n' "$id" "$s" "$launcher" "$stab" "$title"
  done < "$STATE"
  set +f
  [ "$pruned" -gt 0 ] && note "pruned $pruned gone row(s) from $STATE"
  return 0
}

# --close <id>. Returns 0 when the window was closed or was already gone; dies
# (exit 1) for a window this ledger did not record or whose id was reused.
tab_ledger_close() {
  local id="${1:-}" row want_pid now_pid rc=0
  [ -n "$id" ] || die "--close needs a window id"
  case "$id" in *[!0-9]*|"") die "--close takes a numeric window id, got: $id" ;; esac
  kitty_up || die "kitty remote control unavailable.$KITTY_DIAG" 2

  # The whole point: only ever close what a launcher here started.
  row=$(grep "^$id " "$STATE" 2>/dev/null | head -1)
  # The pid now in that window, read fresh: 1 is gone, 2 is no answer, and no
  # answer is never taken for gone.
  win_record "$id" fresh || rc=$?
  [ "$rc" != 2 ] || die "kitty remote control did not answer for window $id (${KITTY_LS_MSG:-no answer}) — cannot tell whether it is still there; nothing closed" 2
  now_pid=$WREC_PID
  # No row but no window either (the row was pruned by --list after a hand
  # close): nothing can be closed, so the refusal guards nothing, but the
  # window's brief claims would outlive it. Release them and say so.
  if [ -z "$row" ] && [ "$rc" = 1 ]; then
    claim_cli --release-owner "kitty:$id" >/dev/null 2>&1 || true
    note "window $id is gone and has no state row — nothing to close; released its kitty:$id claims"
    return 0
  fi
  [ -n "$row" ] \
    || die "window $id was not launched by this script — refusing to close it.
        Another session's agent window looks identical in \`kitty @ ls\`;
        closing it interrupts work you cannot see.${CLOSE_HINT:-}"

  want_pid=$(printf '%s' "$row" | awk '{print $2}')
  if [ "$want_pid" = "?" ]; then
    note "window $id's row has no pid (kitty did not answer when it was launched); closing on the id alone"
    want_pid=$now_pid
  fi

  if [ "$rc" = 1 ]; then
    # Not an error worth an exit code, but it must not be reported as a closure.
    sed -i "/^$id /d" "$STATE" 2>/dev/null
    claim_cli --release-owner "kitty:$id" >/dev/null 2>&1 || true
    note "window $id was already gone — nothing to close (state row removed, claims released)"
    return 0
  fi

  # An id outlives the process that owned it. The state file lives in tmpfs and
  # survives a kitty restart, while kitty's id counter starts over, so a stale
  # row can name a window this script never launched. The pid is the identity
  # that cannot be recycled underneath us.
  if [ -n "$want_pid" ] && [ "$want_pid" != "$now_pid" ]; then
    die "window $id is NOT the one this script launched — id reused.
        state recorded pid $want_pid, that id now belongs to pid $now_pid.
        Refusing; remove the stale row by hand if you are sure."
  fi

  if kitty @ close-window --match "id:$id" 2>/dev/null; then
    note "closed window $id"
  else
    # Measured: close-window exits 1 with `Error: No matching windows` and the
    # old code discarded both the status and the message, then said "closed".
    note "close-window FAILED for $id — the window may still be open; go look"
  fi
  sed -i "/^$id /d" "$STATE" 2>/dev/null
  claim_cli --release-owner "kitty:$id" >/dev/null 2>&1 || true
  return 0
}

# Guards shared by --retire and --close --after-loka, the two paths that close a
# window this ledger never launched. One copy, so a fix lands in both.
#   _tab_ledger_numeric_id <flag> <id>   the id is a number
#   _tab_ledger_target <flag> <id>       sets LS (the window's fresh `kitty @ ls` record)
#                                        and NOW_PID (empty: the window is gone); refuses
#                                        the caller's own window (22), no answer from kitty
#                                        (2, a backing-off breaker included) and a listing
#                                        that is not a JSON array (1)
#   _tab_ledger_release_gone <id>        drop the row and release the claims of a gone window
#   _tab_ledger_require_idle <id> <why>  refuse unless the seat is idle (23)
#   _tab_ledger_close_window <id> <ok>   close it, then drop the row and release the claims
_tab_ledger_numeric_id() {
  case "${2:-}" in *[!0-9]*|"") die "$1 takes a numeric window id, got: ${2:-}" ;; esac
}
_tab_ledger_target() {
  local flag="$1" id="$2"
  [ "$id" != "${KITTY_WINDOW_ID:-}" ] \
    || die "window $id is this session's own window — refusing to close it." 22
  kitty_up || die "kitty remote control unavailable.$KITTY_DIAG" 2
  # One fresh read of the window. The listing must parse as an array: output
  # that exits 0 but is not JSON would otherwise read as "no such window" and
  # release a live seat's claims. While the breaker is open nothing asks kitty.
  local rc=0
  win_record "$id" fresh || rc=$?
  if [ "$rc" = 2 ]; then
    [ "$KITTY_LS_RC" != 75 ] || die "$(kitty_backoff_line) — nothing closed" 2
    [ "$KITTY_LS_REASON" != bad-output ] \
      || die "kitty @ ls returned something that is not a JSON array — cannot tell whether window $id is still there; nothing closed"
    die "kitty remote control did not answer for window $id (${KITTY_LS_MSG:-no answer}) — cannot tell whether it is still there; nothing closed" 2
  fi
  LS=$WREC; NOW_PID=$WREC_PID
}
_tab_ledger_release_gone() {
  sed -i "/^$1 /d" "$STATE" 2>/dev/null
  claim_cli --release-owner "kitty:$1" >/dev/null 2>&1 || true
}
# Idle to type into is not idle to close: a seat at its prompt with background
# agents or tasks (reason=claude-background) loses that work with the window.
_tab_ledger_require_idle() {
  local line st
  line=$("$TAB_LEDGER_BIN/tab-state.sh" "$1" 2>/dev/null | sed -n 's/^window [0-9]* //p')
  case " $line " in
    *" reason=claude-background "*)
      die "window $1 is not idle enough to close (its background agents or tasks still run and would end with it) — $2; retry when they have finished." 23 ;;
  esac
  st=$(printf '%s\n' "$line" | grep -o 'state=[^ ]*' | head -1)
  [ "$st" = "state=idle" ] \
    || die "window $1 is not idle (${st:-state=unknown}) — $2; retry when it is idle." 23
}
_tab_ledger_close_window() {
  if kitty @ close-window --match "id:$1" 2>/dev/null; then
    note "$2"
  else
    die "close-window FAILED for $1 — the window may still be open; go look"
  fi
  _tab_ledger_release_gone "$1"
}

# --retire <id>. Closes a window THIS ledger never launched, which --close
# refuses, on different evidence: the shared store holds a handover row that
# `agent-send --claim-role R --take-over` wrote when the caller took a role from
# the seat in that window (lib/seat-handover.mjs). Every guard must hold, and
# each refusal has its own exit code (docs/exit-codes.md):
#   20  no usable handover row: none names this window, it names another taker,
#       or it was already retired
#   21  the window's pid is not the one recorded: the id was reused
#   22  the id is the caller's own window (KITTY_WINDOW_ID)
#   23  the displaced seat is not idle (busy, or its state cannot be proven)
# 1 is a usage or store error and 2 is no kitty remote control. A displaced
# window that is already gone is not a refusal: its row is marked retired, its
# claims are released, and the exit is 0.
tab_ledger_retire() {
  local id="${1:-}" taker="${2:-}" bin verdict reason hid want_pid want_sid have_sid
  bin="$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)"
  TAB_LEDGER_BIN="$bin"
  [ -n "$id" ] || die "--retire needs a window id"
  _tab_ledger_numeric_id --retire "$id"
  [ -n "$taker" ] || die "--retire needs the calling session id: run it from the session that took the role, or pass --as <session-id>"
  _tab_ledger_target --retire "$id"

  verdict=$(node "$bin/seat-handover.mjs" check "$id" "$taker") \
    || die "could not read the handover store — nothing closed"
  if [ "$(printf '%s' "$verdict" | jq -r .ok)" != true ]; then
    reason=$(printf '%s' "$verdict" | jq -r .reason)
    case "$reason" in
      other-taker) die "the handover for window $id belongs to a different session than $taker — refusing to close it." 20 ;;
      already-retired) die "the handover for window $id was already retired — nothing to close." 20 ;;
      *) die "no handover row for window $id and session $taker — refusing to close it.
        A window is retired only by the session that took its role with
        agent-send --claim-role <role> --take-over." 20 ;;
    esac
  fi
  hid=$(printf '%s' "$verdict" | jq -r .id)
  want_pid=$(printf '%s' "$verdict" | jq -r '.pid // empty')
  want_sid=$(printf '%s' "$verdict" | jq -r '.displacedSession // empty')

  if [ -z "$NOW_PID" ]; then
    node "$bin/seat-handover.mjs" retired "$hid" >/dev/null 2>&1 \
      || die "window $id is gone but handover $hid could not be marked retired"
    _tab_ledger_release_gone "$id"
    note "window $id was already gone — nothing to close (handover retired, claims released)"
    return 0
  fi
  # The same id-reuse guard as --close: the pid recorded when the role was
  # taken. A row with no pid cannot prove anything, so it refuses too.
  [ -n "$want_pid" ] \
    || die "the handover for window $id recorded no pid, so the window cannot be shown to be the displaced seat. Refusing." 21
  if [ "$want_pid" != "$NOW_PID" ]; then
    die "window $id is NOT the seat that was displaced — id reused.
        handover recorded pid $want_pid, that id now belongs to pid $NOW_PID. Refusing." 21
  fi
  # The session in the window must be the displaced one.
  . "$bin/../lib/claude-session.sh"
  have_sid=$(claude_session_json "$id" "$LS" | jq -r '.sessionId // empty' 2>/dev/null)
  [ "$have_sid" = "$want_sid" ] \
    || die "window $id holds session '${have_sid:-<none>}', not the displaced session '$want_sid'. Refusing." 21
  _tab_ledger_require_idle "$id" "the displaced seat may be mid-turn"

  _tab_ledger_close_window "$id" "retired window $id (role handed over to $taker)"
  node "$bin/seat-handover.mjs" retired "$hid" >/dev/null 2>&1 || note "could not mark handover $hid retired"
  return 0
}

# --close <id> --after-loka. Closes a window THIS ledger never launched, on the
# evidence that its seat finished: the session in the window sent the structured
# marker "LOKA-DONE <session-id>" after it started, holds no role, has no mail
# or prompt newer than the marker (bin/seat-finished.mjs), and is idle now. The
# marker's sender is self-asserted (CLAUDE_CODE_SESSION_ID), so it can be forged
# by a process that knows the id; the other guards bound that. Exit codes
# (docs/exit-codes.md):
#   22  the id is the caller's own window
#   23  the seat is not idle (busy, or its state cannot be proven)
#   24  no finished proof: no Claude Code session in the window, no marker since
#       it started, it holds a seat role, or it shows activity after the marker
#   25  the session holds a live resource lease, or waits in a resource queue
# 1 is a usage or store error and 2 is no kitty remote control. A window that is
# already gone is not a refusal: its claims are released and the exit is 0.
tab_ledger_close_finished() {
  local id="${1:-}" bin verdict rec sid started
  bin="$(cd "$(dirname "${BASH_SOURCE[0]}")/../bin" && pwd)"
  TAB_LEDGER_BIN="$bin"
  [ -n "$id" ] || die "--close needs a window id"
  _tab_ledger_numeric_id --close "$id"
  _tab_ledger_target --close "$id"
  if [ -z "$NOW_PID" ]; then
    _tab_ledger_release_gone "$id"
    note "window $id was already gone — nothing to close (claims released)"
    return 0
  fi
  . "$bin/../lib/claude-session.sh"
  rec=$(claude_session_json "$id" "$LS") \
    || die "window $id runs no Claude Code session, so nothing shows that its seat finished. Refusing." 24
  sid=$(printf '%s' "$rec" | jq -r '.sessionId // empty')
  started=$(printf '%s' "$rec" | jq -r '.startedAt // empty')
  case "$started" in ""|*[!0-9]*) die "window $id's session record has no startedAt, so no marker can be dated against it. Refusing." 24 ;; esac
  verdict=$(node "$bin/seat-finished.mjs" check "$sid" "$started" "$(claude_transcript_of "$rec")") \
    || die "could not read the switchboard store — nothing closed"
  if [ "$(printf '%s' "$verdict" | jq -r .finished)" != true ]; then
    case "$(printf '%s' "$verdict" | jq -r '.reason // "no-marker"')" in
      holds-lease) die "window $id (session $sid) holds or waits for a resource lease (a device or a runner lane); it would stay held or queued by a dead session until its TTL ran out. Release it first. Refusing." 25 ;;
      holds-role) die "window $id (session $sid) holds a seat role; role mail would go to a dead window. Hand the role over first. Refusing." 24 ;;
      later-mail) die "window $id (session $sid) has mail to or from it newer than its LOKA-DONE marker, so it is working again. Refusing." 24 ;;
      later-turn) die "window $id (session $sid) has a prompt in its transcript newer than its LOKA-DONE marker, so it is working again. Refusing." 24 ;;
      no-transcript) die "window $id (session $sid): its transcript cannot be read, so activity after the marker cannot be ruled out. Refusing." 24 ;;
      *) die "window $id (session $sid) has sent no LOKA-DONE marker since it started, so it is not shown to be finished. Refusing.
        The marker is one message whose whole text is \"LOKA-DONE $sid\", sent by that session; free text saying \"loka done\" is not proof." 24 ;;
    esac
  fi
  _tab_ledger_require_idle "$id" "the seat is still working after its LOKA-DONE marker"
  _tab_ledger_close_window "$id" "closed finished window $id (session $sid sent its LOKA-DONE marker)"
  return 0
}

# True when PID is this script or one of its ancestors: the seat that runs a
# launcher inside a tab another seat launched sees that tab's row with the
# other seat as launcher. Walks /proc ppid links.
tab_ledger_is_ancestor() { # $1 = pid
  local p=$$ n=0
  while [ -n "$p" ] && [ "$p" != 0 ] && [ $n -lt 64 ]; do
    [ "$p" = "$1" ] && return 0
    p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null)
    n=$((n + 1))
  done
  return 1
}

# The one-slot gate, the same for every launcher: a live row (id present, pid
# unchanged, or pid `?` with the id present) whose launcher is not this one
# ($LAUNCHER) and which is not the caller's own window. One fresh listing for
# every row: the answer grants the slot. A listing kitty did not give cannot
# clear the slot, so the launch stops (exit 2) rather than guess.
tab_ledger_slot_holders() {
  [ -s "$STATE" ] || return 0
  local row row_launcher now
  live_pid_map fresh || die "kitty remote control did not answer the window list (${KITTY_LS_MSG:-no answer}); cannot tell who holds the slot — nothing launched." 2
  set -f
  while IFS= read -r row; do
    # shellcheck disable=SC2086: unquoted split is the parse; globbing off via set -f.
    set -- $row
    case "${3:-}" in @*) row_launcher=${3#@} ;; *) row_launcher=unknown ;; esac
    now=$(live_pid_of "${1:-}") || continue
    [ "${2:-}" = "?" ] || [ "$now" = "${2:-}" ] || continue
    [ "$row_launcher" = "$LAUNCHER" ] && continue
    [ -n "${KITTY_WINDOW_ID:-}" ] && [ "$1" = "$KITTY_WINDOW_ID" ] && continue
    [ "${2:-}" != "?" ] && tab_ledger_is_ancestor "${2:-}" && continue
    printf '%s (launcher %s) ' "$1" "$row_launcher"
  done < "$STATE"
  set +f
}

# The pid of a window this script just launched, read fresh; LAUNCH_PID holds
# it. 0 found, 1 gone, 2 kitty never answered. `kitty @ launch` returned an
# id, so a tab is open: a read with no answer is retried, up to
# AGENT_LAUNCH_PID_TRIES reads (default 6) on the backoff curve and never
# sooner than an open breaker allows, before the caller gives up proving it.
LAUNCH_PID=""
tab_ledger_launch_pid() { # $1 = window id
  local id="$1" tries="${AGENT_LAUNCH_PID_TRIES:-6}" n=1 rc
  case "$tries" in ''|*[!0-9]*|0) tries=6 ;; esac
  LAUNCH_PID=""
  backoff_reset
  while :; do
    rc=0; win_record "$id" fresh || rc=$?
    LAUNCH_PID=$WREC_PID
    [ "$rc" = 2 ] || return "$rc"
    [ "$n" -lt "$tries" ] || return 2
    backoff_sleep "$WREC_RETRY_MS"
    n=$((n + 1))
  done
}

# Record a launched window (`?` for a pid kitty did not give) and claim its
# brief for it.
tab_ledger_add_row() { # $1 = id, $2 = pid, $3 = title, $4 = cwd, $5 = brief ref
  printf '%s %s @%s %s\n' "$1" "$2" "$LAUNCHER" "$3" >> "$STATE"
  claim_cli --claim "$4" "$5" --owner "kitty:$1" --note "$3" >/dev/null 2>&1 || true
}

# The exit after a launch whose pid read kitty never answered. Never 2: the tab
# is open, and 2 sends the caller to a headless run of the same brief.
tab_ledger_die_unproven() { # $1 = id
  printf 'WINDOW_ID=%s\n' "$1"
  die "window $1 was launched, but kitty remote control did not answer after it (${KITTY_LS_MSG:-no answer}), so its start is not proven. Do not relaunch and do not fall back to headless: the tab is open, recorded with an unknown pid and its brief claimed. Look at the window, or run --list once kitty answers." 3
}
