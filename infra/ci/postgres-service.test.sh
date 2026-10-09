#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
temporary=$(mktemp -d)

mkdir -p "$temporary/bin" "$temporary/pgbin" "$temporary/runner"
export RUNNER_TEMP="$temporary/runner"
export POSTGRES17_BIN_DIR="$temporary/pgbin"
export GITHUB_REPOSITORY=test/repo GITHUB_RUN_ID=ci-test-$$ GITHUB_RUN_ATTEMPT=1 GITHUB_JOB=verify
owned_root="/tmp/assistant-pg17-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}"
trap 'rm -rf "$temporary"; rm -rf "$owned_root"' EXIT
export POSTGRES_USER=assistant POSTGRES_PASSWORD=assistant POSTGRES_DB=assistant
export CI_POSTGRES_HEALTH_TIMEOUT_SECONDS=1 CI_POSTGRES_HEALTH_POLL_SECONDS=1
export PG_LOG="$temporary/pg.log" PG_STATE="$temporary/pg.state"

cat > "$temporary/bin/sudo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == -u ]]; then
  shift 2
  exec "$@"
fi
if [[ ${1:-} == install && ${2:-} == -d ]]; then
  shift 2
  mode=755
  destination=
  while (($#)); do
    case $1 in
      -o|-g) shift 2 ;;
      -m) mode=$2; shift 2 ;;
      *) destination=$1; shift ;;
    esac
  done
  mkdir -p "$destination"
  chmod "$mode" "$destination"
  exit 0
fi
if [[ ${1:-} == rm && ${2:-} == -rf ]]; then
  shift 2
  rm -rf -- "$@"
  exit 0
fi
echo "unexpected sudo invocation: $*" >&2
exit 2
SH

cat > "$temporary/bin/python3" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
[[ ${FAKE_PORT_BUSY:-false} != true ]] || { echo 'port in use' >&2; exit 1; }
SH

cat > "$temporary/pgbin/postgres" <<'SH'
#!/usr/bin/env bash
echo 'postgres (PostgreSQL) 17.5'
SH

cat > "$temporary/pgbin/initdb" <<'SH'
#!/usr/bin/env bash
printf 'initdb %s\n' "$*" >> "$PG_LOG"
SH

cat > "$temporary/pgbin/pg_ctl" <<'SH'
#!/usr/bin/env bash
printf 'pg_ctl %s\n' "$*" >> "$PG_LOG"
case " $* " in
  *' status '*)
    case ${FAKE_PG_STATUS:-statefile} in
      unknown) exit 1 ;;
      failed) exit 4 ;;
      statefile) [[ -f $PG_STATE ]] && [[ $(<"$PG_STATE") == running ]] && exit 0 || exit 3 ;;
      stopped) exit 3 ;;
    esac
    ;;
  *' start '*) printf 'running\n' > "$PG_STATE" ;;
  *' stop '*)
    [[ ${FAKE_STOP_FAIL:-false} != true ]] || exit 8
    printf 'stopped\n' > "$PG_STATE"
    ;;
  *) echo "unexpected pg_ctl args: $*" >&2; exit 2 ;;
esac
SH

cat > "$temporary/pgbin/psql" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'psql %s\n' "$*" >> "$PG_LOG"
if [[ " $* " == *' --command=SHOW server_version_num '* ]]; then echo 170005; fi
if [[ " $* " == *" --command=SELECT extversion FROM pg_extension WHERE extname = 'vector' "* ]]; then echo 0.8.0; fi
if [[ " $* " == *' --command=CREATE EXTENSION vector '* ]]; then :; fi
if [[ " $* " != *' --command='* ]]; then cat >> "$PG_LOG"; fi
SH

cat > "$temporary/pgbin/createdb" <<'SH'
#!/usr/bin/env bash
printf 'createdb %s\n' "$*" >> "$PG_LOG"
SH

cat > "$temporary/pgbin/pg_isready" <<'SH'
#!/usr/bin/env bash
[[ ${FAKE_READY:-true} == true ]]
SH

chmod +x "$temporary/bin/sudo" "$temporary/bin/python3" "$temporary/pgbin"/*
export PATH="$temporary/bin:$PATH"

# Start exercises the owned cluster, password-safe SQL input, TCP credentials,
# both databases, pgvector, and the server-major assertion without real PG.
bash "$root/infra/ci/postgres-service.sh" start > "$temporary/start.log"
grep -F -- 'CREATE ROLE :"assistant_user" LOGIN SUPERUSER PASSWORD :'"'assistant_password'"';' "$PG_LOG" >/dev/null
grep -F -- "--command=SHOW server_version_num" "$PG_LOG" >/dev/null
grep -F -- "--command=CREATE EXTENSION vector" "$PG_LOG" >/dev/null
grep -F -- "assistant-pg17-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}/data" "$PG_LOG" >/dev/null
[[ $(<"$PG_STATE") == running ]]
python3 - "$owned_root" <<'PYMODE'
import os, sys
root = sys.argv[1]
assert os.stat(root).st_mode & 0o777 == 0o755
assert os.stat(root + '/data').st_mode & 0o777 == 0o700
PYMODE
bash "$root/infra/ci/postgres-service.sh" cleanup
[[ $(<"$PG_STATE") == stopped ]]
[[ ! -e "$owned_root" ]]

# A busy 5432 is rejected before the runner creates any owned state.
if FAKE_PORT_BUSY=true bash "$root/infra/ci/postgres-service.sh" start > "$temporary/busy.log" 2>&1; then
  echo 'start accepted an already-used PostgreSQL port' >&2
  exit 1
fi
[[ ! -e "$owned_root" ]]

# Readiness failure leaves the exact owned cluster for the always cleanup step.
if FAKE_READY=false bash "$root/infra/ci/postgres-service.sh" start > "$temporary/unready.log" 2>&1; then
  echo 'start accepted an unready PostgreSQL cluster' >&2
  exit 1
fi
grep -F -- 'did not become ready' "$temporary/unready.log" >/dev/null
bash "$root/infra/ci/postgres-service.sh" cleanup
[[ ! -e "$owned_root" ]]

# An uncertain pg_ctl status is not treated as stopped and the data is retained.
bash "$root/infra/ci/postgres-service.sh" start >/dev/null
for failure_status in unknown failed; do
  if FAKE_PG_STATUS=$failure_status bash "$root/infra/ci/postgres-service.sh" cleanup > "$temporary/unknown-state.log" 2>&1; then
    echo "cleanup removed a cluster with pg_ctl status $failure_status" >&2
    exit 1
  fi
  [[ -d "$owned_root"/data ]]
done
if FAKE_STOP_FAIL=true bash "$root/infra/ci/postgres-service.sh" cleanup > "$temporary/stop-failure.log" 2>&1; then
  echo 'cleanup reported success when PostgreSQL stop failed' >&2
  exit 1
fi
[[ -d "$owned_root"/data ]]
bash "$root/infra/ci/postgres-service.sh" cleanup
[[ ! -e "$owned_root" ]]

# A marker from another owner is preserved without inspecting or deleting data.
mkdir -m 755 "$owned_root"
printf 'another/repo:1:1:verify\n' > "$owned_root"/owner
if bash "$root/infra/ci/postgres-service.sh" cleanup > "$temporary/foreign-owner.log" 2>&1; then
  echo 'cleanup accepted another run cluster marker' >&2
  exit 1
fi
[[ -d "$owned_root" ]]
rm -rf "$owned_root"

echo 'PostgreSQL 17 owned-cluster lifecycle tests passed'
