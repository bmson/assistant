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
runner_temp=${RUNNER_TEMP:?RUNNER_TEMP is required}
owner="${GITHUB_REPOSITORY:-local}:${run_id}:${run_attempt}:${job}"
receipt="$runner_temp/assistant-ci-postgres-${run_id}-${run_attempt}-${job}.id"
container_label=com.assistant.ci.owner

print_health_diagnostics() {
  local id=$1
  docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$id" >&2 || true
  docker logs --tail 80 "$id" >&2 || true
}

if [[ $action == start ]]; then
  user=${POSTGRES_USER:-assistant}
  password=${POSTGRES_PASSWORD:-assistant}
  database=${POSTGRES_DB:-assistant}
  timeout=${CI_POSTGRES_HEALTH_TIMEOUT_SECONDS:-90}
  interval=${CI_POSTGRES_HEALTH_POLL_SECONDS:-2}
  [[ $timeout =~ ^[1-9][0-9]*$ ]] || { echo "Invalid PostgreSQL health timeout" >&2; exit 2; }
  [[ $interval =~ ^[1-9][0-9]*$ ]] || { echo "Invalid PostgreSQL health poll interval" >&2; exit 2; }

  name="assistant-ci-pg-${run_id}-${run_attempt}-${job}"
  id=$(docker run --detach \
    --name "$name" \
    --label "$container_label=$owner" \
    --publish 5432:5432 \
    --env "POSTGRES_USER=$user" \
    --env "POSTGRES_PASSWORD=$password" \
    --env "POSTGRES_DB=$database" \
    --health-cmd 'pg_isready -U assistant' \
    --health-interval 5s \
    --health-timeout 3s \
    --health-retries 10 \
    pgvector/pgvector:pg17)
  [[ $id =~ ^[[:xdigit:]]{12,64}$ ]] || { echo "Docker returned an invalid PostgreSQL container ID" >&2; exit 1; }
  mkdir -p "$runner_temp"
  printf '%s\n' "$id" > "$receipt"

  for ((attempt = 0; attempt < timeout; attempt += interval)); do
    state=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$id")
    actual_owner=$(docker inspect --format "{{index .Config.Labels \"$container_label\"}}" "$id")
    [[ $actual_owner == "$owner" ]] || { echo "PostgreSQL container ownership label changed" >&2; exit 1; }
    if [[ $state == "running healthy" ]]; then
      echo "PostgreSQL CI service is healthy"
      exit 0
    fi
    if [[ $state == "exited "* || $state == "dead "* ]]; then
      echo "PostgreSQL CI service stopped before becoming healthy: $state" >&2
      print_health_diagnostics "$id"
      exit 1
    fi
    if (( attempt + interval < timeout )); then
      sleep "$interval"
    fi
  done
  echo "PostgreSQL CI service did not become healthy within ${timeout}s" >&2
  print_health_diagnostics "$id"
  exit 1
fi

# The receipt handles the normal path. The label-only fallback also cleans up a
# container if Docker created it but the runner stopped before writing receipt.
ids=()
if [[ -f $receipt ]]; then
  IFS= read -r id < "$receipt" || true
  if [[ $id =~ ^[[:xdigit:]]{12,64}$ ]]; then
    ids+=("$id")
  fi
fi
if ((${#ids[@]} == 0)); then
  listed_ids=$(docker ps --all --quiet --filter "label=$container_label=$owner")
  while IFS= read -r listed_id; do
    [[ -n $listed_id ]] && ids+=("$listed_id")
  done <<< "$listed_ids"
fi

for id in "${ids[@]}"; do
  [[ $id =~ ^[[:xdigit:]]{12,64}$ ]] || continue
  if ! inspect_result=$(docker inspect --format "{{index .Config.Labels \"$container_label\"}}" "$id" 2>&1); then
    if [[ $inspect_result == *"No such object"* || $inspect_result == *"No such container"* ]]; then
      continue
    fi
    printf 'Could not verify PostgreSQL container ownership before cleanup: %s\n' "$inspect_result" >&2
    exit 1
  fi
  if [[ $inspect_result != "$owner" ]]; then
    echo "Refusing to remove PostgreSQL container with a different ownership label" >&2
    exit 1
  fi
  docker rm --force "$id"
done
rm -f "$receipt"
