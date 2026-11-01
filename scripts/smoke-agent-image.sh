#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "usage: $0 <built-agent-image-tag> <full-source-sha> <smoke-receipt.json>" >&2
  exit 2
}

[[ $# -eq 3 ]] || usage
image="$1"
source_sha="$2"
receipt="$3"
[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'source SHA must be a full lowercase commit SHA' >&2; exit 2; }
[[ "$image" == *":$source_sha" ]] || { echo 'agent image tag must end in the exact source SHA' >&2; exit 2; }
command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
command -v timeout >/dev/null || { echo 'timeout is required' >&2; exit 1; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 1; }

scratch="$(mktemp -d)"
fixture="$scratch/agent-image-smoke.pdf"
cidfile="$scratch/container.cid"
container_name="agent-image-smoke-${source_sha:0:12}-$$-${RANDOM}"
printf '%s\n' "$container_name" >"$scratch/container.name"
cleanup_needed=false
cleanup() {
  local result=$? cleanup_result=0
  trap - EXIT INT TERM
  if [[ "$cleanup_needed" == true ]]; then
    if ! docker_bounded 10 container rm --force "$container_name" >/dev/null 2>&1; then
      echo 'agent image smoke: bounded container cleanup did not complete; smoke fails closed' >&2
      cleanup_result=1
    fi
  fi
  if [[ $cleanup_result -ne 0 ]]; then
    result=1
    echo "agent image smoke: retained owned cidfile/name record for runner cleanup: $scratch" >&2
  else
    rm -rf "$scratch"
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker_bounded() {
  local seconds="$1"
  shift
  timeout --signal=TERM --kill-after=2s "${seconds}s" docker "$@"
}

# Generate the small PDF with the same deterministic object/xref approach as
# core's existing actual-PDF unit fixture; no binary asset is downloaded.
python3 - "$fixture" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
stream = b"BT /F1 30 Tf 72 700 Td (AGENT IMAGE SMOKE) Tj ET\n"
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
data = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
offsets = [0]
for number, obj in enumerate(objects, 1):
    offsets.append(len(data))
    data.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
xref = len(data)
data.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
for offset in offsets[1:]:
    data.extend(f"{offset:010d} 00000 n \n".encode())
data.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
path.write_bytes(data)
PY
read -r fixture_hash _ < <(sha256sum "$fixture")
[[ "$fixture_hash" == '44371569ab2dac393b780169c729e292dd5d15b99cb3d57446d7eefdf451629e' ]] || {
  echo 'generated agent PDF fixture hash mismatch' >&2
  exit 1
}

# Every daemon request is bounded; resolve once and run only the immutable ID.
image_id="$(docker_bounded 10 image inspect --format '{{.Id}}' "$image")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || {
  echo 'agent image did not resolve to an immutable local sha256 image ID' >&2
  exit 1
}
user="$(docker_bounded 10 image inspect --format '{{.Config.User}}' "$image_id")"
if [[ -z "$user" || "$user" == root || "$user" == 0 || "$user" == 0:* ]]; then
  echo "agent: image does not configure a non-root user (Config.User=${user:-empty})" >&2
  exit 1
fi
image_env="$(docker_bounded 10 image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image_id")"
grep -Fxq "BUILD_SHA=$source_sha" <<<"$image_env" || {
  echo 'agent image BUILD_SHA does not match the exact source commit' >&2
  exit 1
}

# Launch timeout 15s + bounded execution wait 45s gives a 60s start+run bound.
# The private name/cidfile lets the exit trap remove only this container after
# a wait/log timeout. Log storage and retrieval are both capped at 64 KiB.
cleanup_needed=true
docker_bounded 15 run --detach --pull=never --cidfile "$cidfile" --name "$container_name" \
  --network none --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 \
  --ulimit nofile=256:256 --stop-timeout 3 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --mount "type=bind,src=$fixture,dst=/tmp/agent-image-smoke.pdf,readonly" \
  --log-driver json-file --log-opt max-size=64k --log-opt max-file=1 \
  --env NODE_ENV=production --workdir /app --entrypoint node "$image_id" \
  --input-type=module -e '
    import { readFile } from "node:fs/promises";
    import { extractText, getDocumentProxy } from "unpdf";
    const pdf = await getDocumentProxy(new Uint8Array(await readFile("/tmp/agent-image-smoke.pdf")));
    const result = await extractText(pdf, { mergePages: true });
    const text = (Array.isArray(result.text) ? result.text.join("\n") : result.text).trim();
    if (!/AGENT\s+IMAGE\s+SMOKE/i.test(text))
      throw new Error(`copied unpdf runtime assets failed to parse deterministic PDF: ${text}`);
    console.log("agent image unpdf import and PDF parse: passed");
  ' >/dev/null

exit_code="$(docker_bounded 45 container wait "$container_name")"
[[ "$exit_code" == 0 ]] || { echo "agent image smoke container exited ${exit_code:-unknown}" >&2; exit 1; }
# Read one byte above the cap and reject by actual byte count; don't infer
# overflow from a producer's PIPESTATUS, which may be zero after buffering.
set +e
docker_bounded 10 container logs "$container_name" 2>&1 | head -c 65537 >"$scratch/logs.txt"
statuses=("${PIPESTATUS[@]}")
set -e
[[ "${statuses[0]}" == 0 && "${statuses[1]}" == 0 ]] || {
  echo 'agent image smoke log retrieval failed' >&2
  exit 1
}
log_bytes="$(wc -c <"$scratch/logs.txt")"
(( log_bytes <= 65536 )) || { echo 'agent image smoke output exceeded 64 KiB' >&2; exit 1; }
cat "$scratch/logs.txt"

# Reconfirm the local source-SHA tag still identifies exactly the smoked image.
current_id="$(docker_bounded 10 image inspect --format '{{.Id}}' "$image")"
[[ "$current_id" == "$image_id" ]] || { echo 'agent image tag changed during smoke' >&2; exit 1; }
mkdir -p "$(dirname "$receipt")"
python3 - "$receipt" "$source_sha" "$image" "$image_id" "$fixture_hash" <<'PY'
import json, sys
path, source_sha, image_tag, image_id, fixture_sha = sys.argv[1:]
with open(path, 'w', encoding='utf8') as receipt:
    json.dump({
        'schemaVersion': 1,
        'sourceSha': source_sha,
        'imageTag': image_tag,
        'localImageId': image_id,
        'fixtureSha256': fixture_sha,
        'smoke': 'passed',
    }, receipt, sort_keys=True)
    receipt.write('\n')
PY
printf 'agent_image_smoke=passed source_sha=%s image_id=%s fixture_sha256=%s\n' \
  "$source_sha" "$image_id" "$fixture_hash"
