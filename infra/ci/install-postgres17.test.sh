#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
mkdir -p "$temporary/bin" "$temporary/apt" "$temporary/etc/postgresql-common" "$temporary/runner"
export PATH="$temporary/bin:$PATH"
export RUNNER_TEMP="$temporary/runner"
export POSTGRES_APT_REPO_SETUP="$temporary/apt/setup-repository"
export POSTGRES_COMMON_CONFIG_PATH="$temporary/etc/postgresql-common/createcluster.conf"
export POSTGRES_POLICY_RC_D_PATH="$temporary/etc/policy-rc.d"
export POSTGRES17_BIN_DIR="$temporary/pgbin"
export INSTALL_LOG="$temporary/install.log"

cat > "$temporary/apt/setup-repository" <<'SH'
#!/usr/bin/env bash
printf 'repo %s\n' "$*" >> "$INSTALL_LOG"
SH
cat > "$temporary/bin/sudo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case ${1:-} in
  test|cp|rm|install)
    exec "$@"
    ;;
  tee)
    shift
    if [[ ${FAKE_TEE_APPEND_FAIL:-false} == true && ${1:-} == -a ]]; then
      cat >/dev/null
      exit 8
    fi
    exec /usr/bin/tee "$@"
    ;;
  env)
    shift
    exec env "$@"
    ;;
  *) exec "$@" ;;
esac
SH
cat > "$temporary/bin/apt-get" <<'SH'
#!/usr/bin/env bash
printf 'apt-get %s\n' "$*" >> "$INSTALL_LOG"
if [[ " $* " == *' install '* ]]; then
  grep -F 'create_main_cluster = false' "$POSTGRES_COMMON_CONFIG_PATH" >/dev/null
  grep -F 'exit 101' "$POSTGRES_POLICY_RC_D_PATH" >/dev/null
  mkdir -p "$POSTGRES17_BIN_DIR"
  cat > "$POSTGRES17_BIN_DIR/postgres" <<'POSTGRES'
#!/usr/bin/env bash
echo 'postgres (PostgreSQL) 17.5'
POSTGRES
  for binary in initdb pg_ctl psql; do
    cat > "$POSTGRES17_BIN_DIR/$binary" <<'BIN'
#!/usr/bin/env bash
exit 0
BIN
  done
  chmod +x "$POSTGRES17_BIN_DIR"/*
  [[ ${FAKE_APT_FAIL:-false} != true ]] || exit 9
fi
SH
chmod +x "$temporary/apt/setup-repository" "$temporary/bin/sudo" "$temporary/bin/apt-get"

printf 'existing-setting = true\n' > "$POSTGRES_COMMON_CONFIG_PATH"
printf '#!/bin/sh\nexit 0\n' > "$POSTGRES_POLICY_RC_D_PATH"
chmod 751 "$POSTGRES_POLICY_RC_D_PATH"
bash "$root/infra/ci/install-postgres17.sh" > "$temporary/success.log"
grep -F 'existing-setting = true' "$POSTGRES_COMMON_CONFIG_PATH" >/dev/null
grep -F 'repo -y' "$INSTALL_LOG" >/dev/null
grep -F 'install -y -q postgresql-17 postgresql-17-pgvector' "$INSTALL_LOG" >/dev/null
! grep -F 'create_main_cluster = false' "$POSTGRES_COMMON_CONFIG_PATH" >/dev/null
grep -F 'exit 0' "$POSTGRES_POLICY_RC_D_PATH" >/dev/null
python3 - "$POSTGRES_POLICY_RC_D_PATH" <<'PYMODE'
import os, sys
assert os.stat(sys.argv[1]).st_mode & 0o777 == 0o751
PYMODE
[[ ! -e $RUNNER_TEMP/assistant-postgresql-createcluster.conf ]]

# A failed package install still restores the original host cluster policy.
if FAKE_APT_FAIL=true bash "$root/infra/ci/install-postgres17.sh" > "$temporary/failure.log" 2>&1; then
  echo 'failed package installation unexpectedly succeeded' >&2
  exit 1
fi
grep -F 'existing-setting = true' "$POSTGRES_COMMON_CONFIG_PATH" >/dev/null
! grep -F 'create_main_cluster = false' "$POSTGRES_COMMON_CONFIG_PATH" >/dev/null
grep -F 'exit 0' "$POSTGRES_POLICY_RC_D_PATH" >/dev/null

# If appending the cluster policy fails before policy-rc.d is touched, the
# original policy remains in place instead of being removed by the EXIT trap.
if FAKE_TEE_APPEND_FAIL=true bash "$root/infra/ci/install-postgres17.sh" > "$temporary/append-failure.log" 2>&1; then
  echo 'failed config append unexpectedly succeeded' >&2
  exit 1
fi
grep -F 'existing-setting = true' "$POSTGRES_COMMON_CONFIG_PATH" >/dev/null
grep -F 'exit 0' "$POSTGRES_POLICY_RC_D_PATH" >/dev/null

# An absent config is removed again after success rather than left as a global
# runner setting that could affect later jobs.
rm -f "$POSTGRES_COMMON_CONFIG_PATH" "$POSTGRES_POLICY_RC_D_PATH"
bash "$root/infra/ci/install-postgres17.sh" > "$temporary/absent.log"
[[ ! -e $POSTGRES_COMMON_CONFIG_PATH ]]
[[ ! -e $POSTGRES_POLICY_RC_D_PATH ]]

echo 'PostgreSQL 17 package bootstrap tests passed'
