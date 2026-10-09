#!/usr/bin/env bash
set -euo pipefail

daemon_config=${DOCKER_DAEMON_CONFIG_PATH:-/etc/docker/daemon.json}
sudo python3 - "$daemon_config" <<'PY'
import json
import os
import pathlib
import stat
import sys
import tempfile

path = pathlib.Path(sys.argv[1])
config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
if not isinstance(config, dict):
    raise SystemExit("Docker daemon configuration must be a JSON object")
mirrors = config.setdefault("registry-mirrors", [])
if not isinstance(mirrors, list) or any(not isinstance(item, str) for item in mirrors):
    raise SystemExit("Docker registry-mirrors must be a list of strings")
mirror = "https://mirror.gcr.io"
if mirror not in mirrors:
    mirrors.insert(0, mirror)

path.parent.mkdir(parents=True, exist_ok=True)
mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(config, output, separators=(",", ":"))
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY

sudo systemctl restart docker
mirrors=$(docker info --format '{{json .RegistryConfig.Mirrors}}')
python3 -c '
import json, sys
mirrors = json.loads(sys.argv[1])
if "https://mirror.gcr.io" not in [item.rstrip("/") for item in mirrors]:
    raise SystemExit("Docker Hub cache is not active")
' "$mirrors"
echo "Docker Hub cache is active"
