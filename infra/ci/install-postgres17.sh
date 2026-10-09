#!/usr/bin/env bash
set -euo pipefail

runner_temp=${RUNNER_TEMP:?RUNNER_TEMP is required}
repo_setup=${POSTGRES_APT_REPO_SETUP:-/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh}
config=${POSTGRES_COMMON_CONFIG_PATH:-/etc/postgresql-common/createcluster.conf}
config_dir=$(dirname "$config")
service_policy=${POSTGRES_POLICY_RC_D_PATH:-/usr/sbin/policy-rc.d}
backup="$runner_temp/assistant-postgresql-createcluster.conf"
policy_backup="$runner_temp/assistant-postgresql-policy-rc.d"
had_config=false
had_policy=false
config_touched=false
policy_touched=false

# Snapshot every existing host policy before registering a rollback trap or
# changing either file. If snapshotting fails, nothing on the host was changed.
if sudo test -f "$config"; then
  sudo cp -p "$config" "$backup"
  had_config=true
fi
if sudo test -f "$service_policy"; then
  sudo cp -p "$service_policy" "$policy_backup"
  had_policy=true
fi

restore_createcluster_config() {
  if [[ $config_touched == true ]]; then
    if [[ $had_config == true ]]; then
      sudo cp -p "$backup" "$config"
    else
      sudo rm -f "$config"
    fi
  fi
  sudo rm -f "$backup"
}
restore_service_policy() {
  if [[ $policy_touched == true ]]; then
    if [[ $had_policy == true ]]; then
      sudo cp -p "$policy_backup" "$service_policy"
    else
      sudo rm -f "$service_policy"
    fi
  fi
  sudo rm -f "$policy_backup"
}
restore_package_guards() {
  restore_service_policy
  restore_createcluster_config
}
trap restore_package_guards EXIT

if [[ $had_config != true ]]; then
  sudo install -d -m 755 "$config_dir"
  config_touched=true
  sudo install -m 644 /dev/null "$config"
else
  config_touched=true
fi
# Avoid creating the package's shared "main" cluster. policy-rc.d also blocks
# post-install scripts from starting any pre-existing PostgreSQL cluster.
printf '\n# Temporary Assistant CI setting; restored after package installation.\ncreate_main_cluster = false\n' |
  sudo tee -a "$config" >/dev/null

if [[ $had_policy != true ]]; then
  sudo install -d -m 755 "$(dirname "$service_policy")"
fi
policy_touched=true
printf '#!/bin/sh\nexit 101\n' | sudo tee "$service_policy" >/dev/null
sudo chmod 755 "$service_policy"

sudo "$repo_setup" -y
sudo apt-get update -q
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q postgresql-17 postgresql-17-pgvector

restore_package_guards
trap - EXIT

postgres_bin=${POSTGRES17_BIN_DIR:-/usr/lib/postgresql/17/bin}
[[ -x $postgres_bin/initdb && -x $postgres_bin/pg_ctl && -x $postgres_bin/psql ]] || {
  echo "PostgreSQL 17 binaries were not installed" >&2
  exit 1
}
version=$("$postgres_bin/postgres" --version)
[[ $version =~ PostgreSQL\)?[[:space:]]17([.]|$) ]] || {
  printf 'Expected PostgreSQL 17 binaries, found: %s\n' "$version" >&2
  exit 1
}
echo "Installed PostgreSQL 17 and pgvector from PostgreSQL APT"
