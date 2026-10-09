#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
mkdir -p "$temporary/bin" "$temporary/runner"

cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case ${1:-} in
  run)
    printf '%s\n' '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    ;;
  inspect)
    format=$3
    id=$4
    case $format in
      '{{.State.Status}} {{.State.Health.Status}}')
        [[ $id == 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ]] || exit 1
        case ${FAKE_HEALTH_STATE:-healthy} in
          healthy) echo 'running healthy' ;;
          starting) echo 'running starting' ;;
          stopped) echo 'exited ' ;;
        esac
        ;;
      *) printf '%s\n' "${FAKE_OWNER:-test/repo:42:1:verify}" ;;
    esac
    ;;
  ps)
    [[ ${FAKE_PS_FAIL:-false} != true ]] || exit 9
    if [[ ${FAKE_PS_ID:-} ]]; then printf '%s\n' "$FAKE_PS_ID"; fi
    ;;
  logs)
    echo 'synthetic PostgreSQL startup log'
    ;;
  rm)
    printf 'removed:%s\n' "${@: -1}" >> "$DOCKER_REMOVED"
    ;;
  *) echo "unexpected docker command: $*" >&2; exit 2 ;;
esac
SH
chmod +x "$temporary/bin/docker"
export PATH="$temporary/bin:$PATH"
export RUNNER_TEMP="$temporary/runner"
export GITHUB_REPOSITORY=test/repo GITHUB_RUN_ID=42 GITHUB_RUN_ATTEMPT=1 GITHUB_JOB=verify
export POSTGRES_USER=assistant POSTGRES_PASSWORD=assistant POSTGRES_DB=assistant
export CI_POSTGRES_HEALTH_TIMEOUT_SECONDS=2 CI_POSTGRES_HEALTH_POLL_SECONDS=1
export DOCKER_LOG="$temporary/docker.log" DOCKER_REMOVED="$temporary/removed.log"

# Healthy startup retains the exact image, credentials, port, and health probe.
bash "$root/infra/ci/postgres-service.sh" start > "$temporary/healthy.log"
rg -F -- '--publish 5432:5432' "$DOCKER_LOG" >/dev/null
rg -F -- 'POSTGRES_PASSWORD=assistant' "$DOCKER_LOG" >/dev/null
rg -F -- 'pgvector/pgvector:pg17' "$DOCKER_LOG" >/dev/null
rg -F -- 'pg_isready -U assistant' "$DOCKER_LOG" >/dev/null
bash "$root/infra/ci/postgres-service.sh" cleanup
rg -F -- 'removed:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' "$DOCKER_REMOVED" >/dev/null

# A failed health wait still leaves an owned receipt for the always cleanup.
: > "$DOCKER_LOG"
: > "$DOCKER_REMOVED"
if FAKE_HEALTH_STATE=starting bash "$root/infra/ci/postgres-service.sh" start > "$temporary/unhealthy.log" 2>&1; then
  echo "unhealthy PostgreSQL unexpectedly succeeded" >&2
  exit 1
fi
rg -F -- 'did not become healthy' "$temporary/unhealthy.log" >/dev/null
rg -F -- 'synthetic PostgreSQL startup log' "$temporary/unhealthy.log" >/dev/null
bash "$root/infra/ci/postgres-service.sh" cleanup
rg -F -- 'removed:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' "$DOCKER_REMOVED" >/dev/null

# Without a receipt, cleanup enumerates only this run's label. It verifies the
# returned container's owner before removal, leaving an unrelated ID untouched.
rm -f "$RUNNER_TEMP/assistant-ci-postgres-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}.id"
: > "$DOCKER_REMOVED"
if FAKE_PS_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa FAKE_OWNER=another/repo:1:1:verify \
  bash "$root/infra/ci/postgres-service.sh" cleanup > "$temporary/unowned.log" 2>&1; then
  echo "cleanup accepted a mismatched ownership label" >&2
  exit 1
fi
[[ ! -s $DOCKER_REMOVED ]]
if ! rg -F -- 'different ownership label' "$temporary/unowned.log" >/dev/null; then
  cat "$temporary/unowned.log" >&2
  exit 1
fi

if FAKE_PS_FAIL=true bash "$root/infra/ci/postgres-service.sh" cleanup > "$temporary/list-failure.log" 2>&1; then
  echo "cleanup succeeded after Docker ownership enumeration failed" >&2
  exit 1
fi
[[ ! -s $DOCKER_REMOVED ]]

# A stale/edited receipt cannot be used to remove a different owner's service.
receipt="$RUNNER_TEMP/assistant-ci-postgres-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}.id"
printf '%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' > "$receipt"
if FAKE_OWNER=another/repo:1:1:verify bash "$root/infra/ci/postgres-service.sh" cleanup > "$temporary/foreign-receipt.log" 2>&1; then
  echo "cleanup accepted a foreign container receipt" >&2
  exit 1
fi
[[ -f $receipt ]]
[[ ! -s $DOCKER_REMOVED ]]
rg -F -- 'different ownership label' "$temporary/foreign-receipt.log" >/dev/null

echo "PostgreSQL service lifecycle tests passed"
