#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/infra/gcp/email-observer-worker-env.sh"
DEPLOY="$ROOT/infra/gcp/deploy.sh"
ENV_FILE="$(mktemp)"
ERR_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE" "$ERR_FILE"' EXIT
eval "$(sed -n '/^envval() {/,/^}/p' "$DEPLOY")"

set_worker_flag() {
  if [ -z "$1" ]; then
    : > "$ENV_FILE"
  else
    printf 'EMAIL_OBSERVER_WORKER_ENABLED=%s\n' "$1" > "$ENV_FILE"
  fi
}

assert_equal() {
  local expected="$1" actual="$2" label="$3"
  if [ "$actual" != "$expected" ]; then
    printf 'FAIL %s: expected <%s>, got <%s>\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
  printf 'PASS %s\n' "$label"
}

set_worker_flag ''
assert_equal '' "$(email_observer_worker_env)" 'unset flag preserves schema default'
set_worker_flag false
assert_equal '|EMAIL_OBSERVER_WORKER_ENABLED=false' "$(email_observer_worker_env)" 'explicit false is forwarded'
set_worker_flag true
assert_equal '|EMAIL_OBSERVER_WORKER_ENABLED=true' "$(email_observer_worker_env)" 'explicit true is forwarded'
grep -Eq '^EMAIL_OBSERVER_WORKER_ENABLED=false$' "$ROOT/.env.example" || {
  printf 'FAIL .env.example must keep the rollout flag explicitly off\n' >&2
  exit 1
}
printf 'PASS example configuration keeps worker disabled\n'

DEPLOY="$ROOT/infra/gcp/deploy.sh"
AGENT_LINE="$(grep -F -- '--set-env-vars' "$DEPLOY" | grep -F 'BROWSER_JOB_NAME' | head -n 1)"
WEB_LINE="$(grep -F -- '--set-env-vars' "$DEPLOY" | grep -F 'AUTH_TRUST_HOST' | head -n 1)"
[ -n "$AGENT_LINE" ] || { printf 'FAIL agent env payload not found\n' >&2; exit 1; }
[ -n "$WEB_LINE" ] || { printf 'FAIL web env payload not found\n' >&2; exit 1; }
case "$AGENT_LINE" in *'${EMAIL_OBSERVER_WORKER_ENV}'*) printf 'PASS worker flag reaches agent env payload\n' ;; *) printf 'FAIL worker flag missing from agent env payload\n' >&2; exit 1 ;; esac
case "$WEB_LINE" in *'${EMAIL_OBSERVER_WORKER_ENV}'*) printf 'FAIL worker flag leaked into web env payload\n' >&2; exit 1 ;; *) printf 'PASS worker flag is agent-only\n' ;; esac

# Use deploy.sh's real envval function to prove the delimiter guard still stops
# deployment when the new fragment is built inside command substitution.
set_worker_flag 'true|CHAT_RECALL_ENABLED=false'
SIMULATED_DEPLOY_ARGS='unset'
EMAIL_OBSERVER_WORKER_ENV='unset'
if EMAIL_OBSERVER_WORKER_ENV="$(email_observer_worker_env 2>"$ERR_FILE")"; then
  SIMULATED_DEPLOY_ARGS="--set-env-vars ${EMAIL_OBSERVER_WORKER_ENV}"
else
  status=$?
  [ "$status" -ne 0 ] || { printf 'FAIL invalid env returned success\n' >&2; exit 1; }
fi
assert_equal unset "$SIMULATED_DEPLOY_ARGS" 'invalid delimiter stops before simulated deploy'
assert_equal '' "$EMAIL_OBSERVER_WORKER_ENV" 'invalid delimiter emits no environment fragment'
grep -q '^FATAL: EMAIL_OBSERVER_WORKER_ENABLED in ' "$ERR_FILE" || {
  printf 'FAIL real envval delimiter rejection was not observed\n' >&2
  exit 1
}
printf 'PASS real envval delimiter rejection propagates\n'
