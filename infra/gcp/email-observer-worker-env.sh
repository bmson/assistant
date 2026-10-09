#!/usr/bin/env bash
# Build the optional agent-only worker flag fragment. Caller supplies envval().
email_observer_worker_env() {
  local value
  value="$(envval EMAIL_OBSERVER_WORKER_ENABLED)" || return $?
  [ -n "$value" ] && printf '|EMAIL_OBSERVER_WORKER_ENABLED=%s' "$value"
  return 0
}
