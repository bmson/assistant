#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
mkdir -p "$TEMP_DIR/bin"

cat >"$TEMP_DIR/bin/git" <<'MOCK_GIT'
#!/usr/bin/env bash
set -euo pipefail
if [ "${MOCK_GIT_FAIL:-false}" = true ]; then
  exit 7
fi
for index in $(seq 1 3000); do
  if [ "$index" -eq 93 ] && [ "${MOCK_IOS_CHANGE:-true}" = true ]; then
    printf '%s\n' 'apps/ios/Assistant/ChatView.swift'
  elif [ "$index" -eq 94 ] && [ "${MOCK_IOS_CHANGE:-true}" = helper ]; then
    printf '%s\n' 'infra/ios-detect-changes.sh'
  else
    printf 'docs/review/path-%04d.md\n' "$index"
  fi
done
MOCK_GIT
chmod +x "$TEMP_DIR/bin/git"

fixture_bytes="$(PATH="$TEMP_DIR/bin:$PATH" git diff --name-only base HEAD | wc -c | tr -d ' ')"
if [ "$fixture_bytes" -le 65536 ]; then
  echo "expected filename fixture to exceed 64 KiB, got $fixture_bytes bytes" >&2
  exit 1
fi

run_filter() {
  local event="$1" expect="$2" ios_change="${3:-true}"
  : >"$TEMP_DIR/output"
  EVENT_NAME="$event" \
    BASE_SHA=base \
    GITHUB_OUTPUT="$TEMP_DIR/output" \
    MOCK_IOS_CHANGE="$ios_change" \
    PATH="$TEMP_DIR/bin:$PATH" \
    bash "$SCRIPT_DIR/ios-detect-changes.sh"
  grep -Fx "ios=$expect" "$TEMP_DIR/output" >/dev/null
}

run_filter pull_request true
run_filter pull_request false false
run_filter pull_request true helper
run_filter push true

: >"$TEMP_DIR/output"
if EVENT_NAME=pull_request BASE_SHA=base GITHUB_OUTPUT="$TEMP_DIR/output" \
    MOCK_GIT_FAIL=true PATH="$TEMP_DIR/bin:$PATH" \
    bash "$SCRIPT_DIR/ios-detect-changes.sh"; then
  echo "expected git failure to fail the filter" >&2
  exit 1
fi
if [ -s "$TEMP_DIR/output" ]; then
  echo "git failure must not emit a false iOS result" >&2
  exit 1
fi

echo "iOS change-filter tests passed"
