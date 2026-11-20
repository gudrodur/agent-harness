# Window reads for the shell scripts, through lib/kitty-ls.mjs: the one cache,
# lock and circuit breaker in front of `kitty @ ls` (see that file). Sourced,
# not run: it defines functions only, and a second source is a no-op.
#
# A read is three-valued, and a caller must keep the three apart: an
# unavailable kitty is never "the window is gone".
#   0  found          the window is there
#   1  gone           kitty answered and the window is not in its list
#   2  unavailable    kitty did not answer (timeout, refused, overloaded and
#                     backing off, or the list could not be parsed);
#                     KITTY_LS_REASON says which and KITTY_LS_RETRY_MS how long
#                     the breaker stays open (0 when it is not)
#
# kitty is the `kitty` on PATH, as every script here has always used (tests put
# a stub first on PATH); AGENT_MAILBOX_KITTY is the node callers' seam and is
# not read here. Without node the reads go to kitty directly, uncached.
#
#   kitty_up                    0 when kitty answers; else 1 with KITTY_DIAG
#   kitty_diag                  KITTY_DIAG for the read that just failed
#   win_record <id> [fresh]     sets WREC (the narrow listing, usable as the
#                               `ls` JSON argument of claude_session_json),
#                               WREC_PID, WREC_TITLE, WREC_CREATED; 0/1/2 as above
#   win_pid|win_title|win_created <id> [fresh]
#                               print that field; same return code
#   live_pid_map [fresh]        LIVE_MAP: `<id> <pid>` per live window, one full
#                               read; 0 or 2. live_pid_of <id> reads it
#   kitty_ls_full [fresh]       sets KITTY_LS_OUT to the whole listing; 0 or 2
#   backoff_reset, backoff_sleep [min_ms] [max_ms]
#                               the shared wait curve (lib/backoff.mjs's): from
#                               BACKOFF_BASE_MS doubling to BACKOFF_CAP_MS, +/-20%
[ -n "${_KITTY_LS_SH_LOADED:-}" ] && return 0
_KITTY_LS_SH_LOADED=1
_KITTY_LS_MJS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kitty-ls.mjs"

KITTY_LS_OUT=""; KITTY_LS_RC=0; KITTY_LS_REASON=""; KITTY_LS_RETRY_MS=0; KITTY_LS_MSG=""; KITTY_LS_DETAIL=""
# One read: _kitty_ls [--match id:N] [--fresh] [--probe]. Sets KITTY_LS_OUT
# (the JSON on success), KITTY_LS_RC (0 answered, 2 not, 75 backing off) and,
# on failure, KITTY_LS_REASON, KITTY_LS_RETRY_MS, KITTY_LS_MSG, KITTY_LS_DETAIL.
_kitty_ls() {
  local out rc=0
  KITTY_LS_REASON=""; KITTY_LS_RETRY_MS=0; KITTY_LS_MSG=""; KITTY_LS_DETAIL=""
  if command -v node >/dev/null 2>&1 && [ -f "$_KITTY_LS_MJS" ]; then
    # Success prints nothing on stderr, so the merge is the JSON alone.
    out=$(AGENT_MAILBOX_KITTY=kitty node "$_KITTY_LS_MJS" "$@" 2>&1) || rc=$?
  elif out=$(kitty @ ls 2>&1); then
    if ! printf '%s' "$out" | jq -e 'type == "array"' >/dev/null 2>&1; then
      case " $* " in
        *" --probe "*) ;;  # any answer means kitty is up
        *) out=$'kitty @ ls returned something that is not a JSON array\nreason=bad-output'; rc=2 ;;
      esac
    fi
  else
    out="kitty remote control is not answering"$'\n'"reason=unreachable"$'\n'"detail=${out%%$'\n'*}"; rc=2
  fi
  KITTY_LS_RC=$rc
  if [ "$rc" = 0 ]; then KITTY_LS_OUT="$out"; return 0; fi
  KITTY_LS_OUT=""
  KITTY_LS_MSG=$(printf '%s\n' "$out" | grep -v -E '^(reason|retry_in_ms|detail)=' | head -1) || true
  KITTY_LS_REASON=$(printf '%s\n' "$out" | sed -n 's/^reason=//p' | head -1) || true
  KITTY_LS_RETRY_MS=$(printf '%s\n' "$out" | sed -n 's/^retry_in_ms=//p' | head -1) || true
  KITTY_LS_DETAIL=$(printf '%s\n' "$out" | sed -n 's/^detail=//p' | head -1) || true
  case "$KITTY_LS_RETRY_MS" in ''|*[!0-9]*) KITTY_LS_RETRY_MS=0 ;; esac
  [ -n "$KITTY_LS_REASON" ] || KITTY_LS_REASON=unreachable
  return 0
}

# kitty_up keeps kitty's own error: once a /tmp sweep deleted the live socket
# and the bare "unavailable" sent a session tracing the launcher instead of
# reading "no such file or directory". On failure KITTY_DIAG holds that error,
# $KITTY_LISTEN_ON, whether the socket path still exists, and when kitty is
# overloaded, until when nothing will ask it; refusals append it. kitty_diag
# builds the same text from whichever read failed last.
KITTY_DIAG=""
kitty_up() {
  _kitty_ls --probe
  [ "$KITTY_LS_RC" = 0 ] && return 0
  kitty_diag
  return 1
}
kitty_diag() {
  local sock
  KITTY_DIAG=""
  [ "$KITTY_LS_RC" != 0 ] || return 0
  KITTY_DIAG=$'\n        kitty said: '"${KITTY_LS_DETAIL:-${KITTY_LS_MSG:-<nothing>}}"
  KITTY_DIAG+=$'\n        KITTY_LISTEN_ON='"${KITTY_LISTEN_ON:-<unset>}"
  if [ "$KITTY_LS_RC" = 75 ]; then
    KITTY_DIAG+=$'\n        '"$(kitty_backoff_line)"
  fi
  case "${KITTY_LISTEN_ON:-}" in
    unix:@*) ;;  # abstract socket: no path to check
    unix:*)
      sock=${KITTY_LISTEN_ON#unix:}
      if [ ! -e "$sock" ]; then
        KITTY_DIAG+=$'\n        The socket path does not exist: something deleted it while kitty kept'
        KITTY_DIAG+=$'\n        listening on the unlinked inode; only restart kitty restores it (it closes every window).'
      fi ;;
  esac
  return 0
}
# The refusal text while the breaker is open (after a failed read with RC 75).
kitty_backoff_line() {
  printf '%s; do not retry before then' "${KITTY_LS_MSG%, not asking again before then}"
}

# WINDOW id -> its record. `--match id:N` is ambiguous in kitty (tabs and
# windows share one number space), so lib/kitty-ls.mjs matches the id against
# `.tabs[].windows[]` only; a tab with the same id is never taken for it.
WREC=""; WREC_PID=""; WREC_TITLE=""; WREC_CREATED=""; WREC_RETRY_MS=0
win_record() { # $1 = window id, $2 = "fresh" to refuse a cached answer
  local line
  WREC=""; WREC_PID=""; WREC_TITLE=""; WREC_CREATED=""; WREC_RETRY_MS=0
  if [ "${2:-}" = fresh ]; then _kitty_ls --match "id:$1" --fresh; else _kitty_ls --match "id:$1"; fi
  if [ "$KITTY_LS_RC" != 0 ]; then WREC_RETRY_MS=$KITTY_LS_RETRY_MS; return 2; fi
  line=$(printf '%s' "$KITTY_LS_OUT" | jq -r --argjson id "$1" \
    'first(.[].tabs[].windows[] | select(.id == $id)) | "\(.pid // "")\u001f\(.created_at // "")\u001f\(.title // "")"' 2>/dev/null) || line=""
  [ -n "$line" ] || return 1
  WREC="$KITTY_LS_OUT"
  # The unit separator, not a tab: IFS whitespace folds an empty field away
  # and the title would land in WREC_CREATED.
  IFS=$'\x1f' read -r WREC_PID WREC_CREATED WREC_TITLE <<<"$line"
  return 0
}
win_pid()     { win_record "$@" || return $?; printf '%s' "$WREC_PID"; }
win_title()   { win_record "$@" || return $?; printf '%s' "$WREC_TITLE"; }
win_created() { win_record "$@" || return $?; printf '%s' "$WREC_CREATED"; }

# The whole listing (one full read) into KITTY_LS_OUT; 2 when kitty did not answer.
kitty_ls_full() { # $1 = "fresh" to refuse a cached answer
  if [ "${1:-}" = fresh ]; then _kitty_ls --fresh; else _kitty_ls; fi
  [ "$KITTY_LS_RC" = 0 ] || return 2
}
# LIVE_MAP: `<window id> <pid>` per line for every live window, from one full
# read; 2 when kitty did not answer. live_pid_of <id> prints that window's pid
# from it, or returns 1 when the id is not in it.
LIVE_MAP=""
live_pid_map() { # $1 = "fresh" to refuse a cached answer
  LIVE_MAP=""
  kitty_ls_full "$@" || return 2
  LIVE_MAP=$(printf '%s' "$KITTY_LS_OUT" | jq -r '.[].tabs[].windows[] | "\(.id) \(.pid // "")"' 2>/dev/null) || LIVE_MAP=""
}
live_pid_of() { # $1 = window id
  printf '%s\n' "$LIVE_MAP" | awk -v id="$1" '$1 == id { print $2; found = 1; exit } END { exit !found }'
}

# The wait curve: attempt 0 sleeps BACKOFF_BASE_MS, each later one twice the
# last up to BACKOFF_CAP_MS, each spread +/-20% so pollers drift apart.
# backoff_sleep [min_ms] [max_ms]: never less than min_ms (a breaker's
# retry_in_ms), never more than max_ms (what is left of a bounded wait).
# BACKOFF_SLEPT_MS is what it slept.
BACKOFF_ATTEMPT=0; BACKOFF_SLEPT_MS=0
backoff_reset() { BACKOFF_ATTEMPT=0; }
backoff_sleep() {
  local base="${BACKOFF_BASE_MS:-2000}" cap="${BACKOFF_CAP_MS:-10000}" min="${1:-0}" max="${2:-}" ms i
  ms=$base
  for ((i = 0; i < BACKOFF_ATTEMPT && ms < cap; i++)); do ms=$((ms * 2)); done
  [ "$ms" -le "$cap" ] || ms=$cap
  ms=$(( ms * (800 + RANDOM % 401) / 1000 ))
  [ "$ms" -ge "$min" ] || ms=$min
  if [ -n "$max" ] && [ "$ms" -gt "$max" ]; then ms=$max; fi
  [ "$ms" -gt 0 ] || ms=0
  BACKOFF_ATTEMPT=$((BACKOFF_ATTEMPT + 1))
  BACKOFF_SLEPT_MS=$ms
  sleep "$((ms / 1000)).$(printf '%03d' $((ms % 1000)))"
}
