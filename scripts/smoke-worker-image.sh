#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "usage: $0 <browser|code|processor> <image-reference>" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
worker="$1"
image="$2"
case "$worker" in
  browser) expected_input='BROWSER_JOB_INPUT is not set' ;;
  code) expected_input='CODE_JOB_INPUT is not set' ;;
  processor) expected_input='DOCUMENT_JOB_INPUT is not set' ;;
  *) usage ;;
esac
command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
command -v timeout >/dev/null || { echo 'timeout is required' >&2; exit 1; }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

run_docker() {
  timeout --signal=TERM --kill-after=5s 60s docker run \
    --rm --network none --stop-timeout 5 "$@"
}

user="$(docker image inspect --format '{{.Config.User}}' "$image")"
if [[ -z "$user" || "$user" == root || "$user" == 0 || "$user" == 0:* ]]; then
  echo "${worker}: image does not configure a non-root user (Config.User=${user:-empty})" >&2
  exit 1
fi
# Keep the command quoted so expansion happens only in the image.
# shellcheck disable=SC2016
run_docker --entrypoint sh "$image" -c 'test "$(id -u)" -ne 0'

# The actual entrypoint must load its production dependency graph and take the
# documented no-input path without credentials, callbacks, or network access.
set +e
startup_output="$(timeout --signal=TERM --kill-after=5s 30s docker run \
  --rm --network none --stop-timeout 5 "$image" 2>&1)"
startup_status=$?
set -e
if [[ $startup_status -ne 0 ]] || ! grep -Fq 'invalid job input' <<<"$startup_output" \
  || ! grep -Fq "$expected_input" <<<"$startup_output"; then
  echo "${worker}: input-free entrypoint smoke failed (exit ${startup_status})" >&2
  tail -n 30 <<<"$startup_output" >&2
  exit 1
fi

# The portable pnpm deploy output must not contain the root development tool
# graph that caused the scanner findings; tsx itself is exercised below.
# Keep the script quoted so the host shell cannot interpolate container code.
# shellcheck disable=SC2016
run_docker --entrypoint node "$image" --import tsx --input-type=module -e '
  import { readdir } from "node:fs/promises";
  const entries = await readdir("/app/node_modules/.pnpm");
  const unwanted = entries.filter((entry) =>
    /^(?:typescript@|@typescript\+|esbuild@0\.25\.12(?:_|$)|vitest@)/.test(entry)
  );
  if (unwanted.length) throw new Error(`development packages leaked into runtime: ${unwanted.join(", ")}`);
  console.log("production dependency graph: clean");
'

if [[ "$worker" == browser || "$worker" == code ]]; then
  run_docker --entrypoint node "$image" --import tsx --input-type=module -e '
    import { allowedArtifactPath } from "@assistant/persistence/artifact-path";
    if (allowedArtifactPath("artifacts/smoke.txt", ["artifacts/"]) !== "artifacts/smoke.txt")
      throw new Error("workspace persistence TypeScript export did not resolve");
    console.log("workspace persistence export: resolved");
  '
fi

case "$worker" in
  browser)
    # Exercise the packaged browser against local content in a container without
    # network access. This checks assets and rendering; Cloud Run sandbox
    # qualification remains a separate acceptance check.
    run_docker --shm-size=256m --entrypoint node "$image" --input-type=module -e '
      import { chromium } from "playwright";
      const browser = await chromium.launch({ headless: true, chromiumSandbox: false });
      try {
        const page = await browser.newPage();
        await page.setContent("<title>worker-smoke</title><main>local browser check</main>");
        if (await page.title() !== "worker-smoke") throw new Error("Chromium did not render the local page");
        console.log("bundled Chromium asset and rendering check: passed");
      } finally {
        await browser.close();
      }
    '
    ;;
  code)
    run_docker --entrypoint python3 "$image" -c \
      'import numpy, pandas, matplotlib, openpyxl; print("Python runtime imports: passed")'
    ;;
  processor)
    for binary in tesseract pdfinfo pdftoppm; do
      run_docker --entrypoint sh "$image" -c "command -v '$binary' >/dev/null"
    done
    run_docker --entrypoint tesseract "$image" --list-langs >"$scratch/languages.txt" 2>&1
    grep -qx 'eng' "$scratch/languages.txt" || {
      echo 'processor: Tesseract English language data is missing' >&2
      exit 1
    }
    python3 - "$scratch/smoke.pdf" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
stream = b"BT /F1 30 Tf 72 700 Td (WORKER IMAGE SMOKE) Tj ET\n"
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
# Keep the script quoted so the host shell cannot interpolate container code.
# shellcheck disable=SC2016
    run_docker --mount "type=bind,src=$scratch/smoke.pdf,dst=/tmp/worker-smoke.pdf,readonly" \
      --entrypoint ./node_modules/.bin/tsx "$image" --eval '
        void (async () => {
          const { readFile } = await import("node:fs/promises");
          const { extractDocument } = await import("./src/extract.ts");
          const result = await extractDocument(await readFile("/tmp/worker-smoke.pdf"), "application/pdf", "smoke.pdf");
          if (result.kind !== "text" || !/WORKER\s+IMAGE\s+SMOKE/i.test(result.text))
            throw new Error(`synthetic OCR extraction failed: ${result.kind} ${result.text}`);
          console.log("synthetic PDF OCR extraction: passed");
        })().catch((error) => { console.error(error); process.exitCode = 1; });
      '
    ;;
esac

echo "${worker}: production image smoke passed"
