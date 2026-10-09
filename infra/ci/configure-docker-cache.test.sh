#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
mkdir -p "$temporary/bin" "$temporary/etc"

cat > "$temporary/bin/sudo" <<'SH'
#!/usr/bin/env bash
exec "$@"
SH
cat > "$temporary/bin/systemctl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
SH
cat > "$temporary/bin/docker" <<'SH'
#!/usr/bin/env bash
if [[ ${1:-} == info ]]; then
  printf '%s\n' "${FAKE_DOCKER_MIRRORS:-[\"https://mirror.gcr.io\"]}"
else
  exit 2
fi
SH
chmod +x "$temporary/bin/"*

export PATH="$temporary/bin:$PATH"
export DOCKER_DAEMON_CONFIG_PATH="$temporary/etc/daemon.json"
export SYSTEMCTL_LOG="$temporary/systemctl.log"

printf '{"debug":true,"registry-mirrors":["https://other.example"]}\n' > "$DOCKER_DAEMON_CONFIG_PATH"
bash "$root/infra/ci/configure-docker-cache.sh" > "$temporary/success.log"
python3 - "$DOCKER_DAEMON_CONFIG_PATH" <<'PY'
import json, sys
from pathlib import Path
value = json.loads(Path(sys.argv[1]).read_text())
assert value == {"debug": True, "registry-mirrors": ["https://mirror.gcr.io", "https://other.example"]}
PY
[[ $(cat "$SYSTEMCTL_LOG") == 'restart docker' ]]

# Re-running is idempotent and preserves unrelated daemon settings.
bash "$root/infra/ci/configure-docker-cache.sh" > "$temporary/idempotent.log"
python3 - "$DOCKER_DAEMON_CONFIG_PATH" <<'PY'
import json, sys
from pathlib import Path
assert json.loads(Path(sys.argv[1]).read_text())["registry-mirrors"].count("https://mirror.gcr.io") == 1
PY
[[ $(wc -l < "$SYSTEMCTL_LOG" | tr -d ' ') == 2 ]]

# An invalid daemon file fails before restarting Docker.
printf '{broken\n' > "$DOCKER_DAEMON_CONFIG_PATH"
if bash "$root/infra/ci/configure-docker-cache.sh" > "$temporary/invalid.log" 2>&1; then
  echo "invalid daemon configuration unexpectedly succeeded" >&2
  exit 1
fi
[[ $(wc -l < "$SYSTEMCTL_LOG" | tr -d ' ') == 2 ]]

# A restart that does not expose the mirror is not treated as success.
printf '{}\n' > "$DOCKER_DAEMON_CONFIG_PATH"
if FAKE_DOCKER_MIRRORS='[]' bash "$root/infra/ci/configure-docker-cache.sh" > "$temporary/inactive.log" 2>&1; then
  echo "inactive Docker mirror unexpectedly succeeded" >&2
  exit 1
fi

echo "Docker cache setup tests passed"
