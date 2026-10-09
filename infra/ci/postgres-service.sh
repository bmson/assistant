#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 start|cleanup" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
action=$1
[[ $action == start || $action == cleanup ]] || usage

run_id=${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}
run_attempt=${GITHUB_RUN_ATTEMPT:-1}
job=${GITHUB_JOB:?GITHUB_JOB is required}
owner="${GITHUB_REPOSITORY:-local}:${run_id}:${run_attempt}:${job}"
# PostgreSQL runs as the postgres account, so its data directory must be
# reachable through a traversable parent. Keep the data itself mode 0700 and
# scope the top-level path to this unique Actions run.
owned_root="/tmp/assistant-pg17-${run_id}-${run_attempt}-${job}"
data_dir="$owned_root/data"
owner_file="$owned_root/owner"
timeout=${CI_POSTGRES_HEALTH_TIMEOUT_SECONDS:-90}
interval=${CI_POSTGRES_HEALTH_POLL_SECONDS:-2}
postgres_bin=${POSTGRES17_BIN_DIR:-/usr/lib/postgresql/17/bin}
pg_ctl="$postgres_bin/pg_ctl"
psql="$postgres_bin/psql"
createdb="$postgres_bin/createdb"
pg_isready="$postgres_bin/pg_isready"
user=${POSTGRES_USER:-assistant}
password=${POSTGRES_PASSWORD:-assistant}
[[ $user == assistant && ${POSTGRES_DB:-assistant} == assistant ]] || {
  echo "CI PostgreSQL credentials must use the assistant role and database" >&2
  exit 2
}

assert_port_free() {
  python3 - 5432 <<'PY'
import errno
import socket
import sys

port = int(sys.argv[1])
for family, address in ((socket.AF_INET, ("127.0.0.1", port)), (socket.AF_INET6, ("::1", port))):
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.bind(address)
    except OSError as exc:
        if exc.errno in (errno.EAFNOSUPPORT, errno.EADDRNOTAVAIL):
            continue
        if exc.errno == errno.EADDRINUSE:
            raise SystemExit(f"TCP port {port} is already in use; refusing to stop another service")
        raise
    finally:
        sock.close()
PY
}

if [[ $action == start ]]; then
  [[ $timeout =~ ^[1-9][0-9]*$ ]] || { echo "Invalid PostgreSQL health timeout" >&2; exit 2; }
  [[ $interval =~ ^[1-9][0-9]*$ ]] || { echo "Invalid PostgreSQL health poll interval" >&2; exit 2; }
  [[ -x $postgres_bin/initdb && -x $pg_ctl && -x $postgres_bin/postgres && -x $psql && -x $createdb && -x $pg_isready ]] || {
    echo "PostgreSQL 17 is not installed; run install-postgres17.sh first" >&2
    exit 1
  }
  version=$("$postgres_bin/postgres" --version)
  [[ $version =~ PostgreSQL\)?[[:space:]]17([.]|$) ]] || {
    printf 'Expected PostgreSQL 17, found: %s\n' "$version" >&2
    exit 1
  }
  assert_port_free
  [[ ! -e $owned_root ]] || { echo "Owned PostgreSQL data path already exists" >&2; exit 1; }

  mkdir -m 755 "$owned_root"
  chmod 755 "$owned_root"
  printf '%s\n' "$owner" > "$owner_file"
  chmod 600 "$owner_file"
  sudo install -d -o postgres -g postgres -m 700 "$data_dir"
  sudo -u postgres "$postgres_bin/initdb" -D "$data_dir" --username=postgres --auth-local=peer --auth-host=scram-sha-256
  sudo -u postgres "$pg_ctl" -D "$data_dir" -l "$data_dir/server.log" -o '-h 127.0.0.1,::1 -p 5432' -w -t "$timeout" start

  ready=false
  for ((attempt = 0; attempt < timeout; attempt += interval)); do
    if "$pg_isready" --host=127.0.0.1 --port=5432 --username=postgres --dbname=postgres >/dev/null 2>&1; then
      ready=true
      break
    fi
    if (( attempt + interval < timeout )); then sleep "$interval"; fi
  done
  if [[ $ready != true ]]; then
    echo "PostgreSQL 17 did not become ready on TCP port 5432 within ${timeout}s" >&2
    tail -n 80 "$data_dir/server.log" >&2 || true
    exit 1
  fi

  sudo -u postgres "$psql" --no-psqlrc --set=ON_ERROR_STOP=1 --set="assistant_user=$user" --set="assistant_password=$password" --dbname=postgres <<'SQL'
CREATE ROLE :"assistant_user" LOGIN SUPERUSER PASSWORD :'assistant_password';
SQL
  for database in assistant assistant_test; do
    sudo -u postgres "$createdb" --owner="$user" "$database"
    sudo -u postgres "$psql" --no-psqlrc --set=ON_ERROR_STOP=1 --dbname="$database" --command='CREATE EXTENSION vector'

    server_version=$(PGPASSWORD="$password" "$psql" --no-psqlrc --tuples-only --no-align \
      --host=localhost --port=5432 --username="$user" --dbname="$database" \
      --command='SHOW server_version_num')
    [[ $server_version == 17* ]] || {
      printf 'Expected PostgreSQL 17 for database %s, got server_version_num=%s\n' "$database" "$server_version" >&2
      exit 1
    }
    vector_version=$(PGPASSWORD="$password" "$psql" --no-psqlrc --tuples-only --no-align \
      --host=localhost --port=5432 --username="$user" --dbname="$database" \
      --command="SELECT extversion FROM pg_extension WHERE extname = 'vector'")
    [[ -n $vector_version ]] || { echo "pgvector is unavailable in database $database" >&2; exit 1; }
  done
  echo "Owned PostgreSQL 17 CI cluster is ready on port 5432 with pgvector"
  exit 0
fi

# The owner marker and derived path scope cleanup to this run's temporary data.
if [[ ! -f $owner_file ]]; then
  exit 0
fi
IFS= read -r recorded_owner < "$owner_file"
if [[ $recorded_owner != "$owner" ]]; then
  echo "Refusing to clean PostgreSQL data owned by another run" >&2
  exit 1
fi
if [[ -d $data_dir ]]; then
  set +e
  sudo -u postgres "$pg_ctl" -D "$data_dir" status >/dev/null 2>&1
  status=$?
  set -e
  case $status in
    0)
      sudo -u postgres "$pg_ctl" -D "$data_dir" -m fast -w -t 30 stop
      set +e
      sudo -u postgres "$pg_ctl" -D "$data_dir" status >/dev/null 2>&1
      status=$?
      set -e
      [[ $status -eq 3 ]] || { echo "PostgreSQL cluster did not stop cleanly; preserving its data" >&2; exit 1; }
      ;;
    3) ;;
    *) echo "Could not determine PostgreSQL cluster state; preserving its data" >&2; exit 1 ;;
  esac
fi
sudo rm -rf -- "$owned_root"
echo "Removed owned PostgreSQL 17 CI cluster"
