#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
sha=0123456789abcdef0123456789abcdef01234567

cat >"$tmp/gh" <<'MOCK_GH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]]
[[ "$2" == "/repos/test/assistant/actions/workflows/ci.yml/runs?head_sha=${RELEASE_SHA}&per_page=100" ]]
cat "$MOCK_RUNS"
MOCK_GH
chmod +x "$tmp/gh"

cat >"$tmp/passed.json" <<JSON
{"workflow_runs":[{"head_sha":"$sha","head_branch":"main","event":"push","conclusion":"success"}]}
JSON
PATH="$tmp:$PATH" RELEASE_SHA="$sha" GITHUB_REPOSITORY=test/assistant GH_TOKEN=test \
  MOCK_RUNS="$tmp/passed.json" bash "$ROOT/verify-release-source.sh" >/dev/null

cat >"$tmp/wrong-source.json" <<JSON
{"workflow_runs":[{"head_sha":"$sha","head_branch":"feature","event":"push","conclusion":"success"}]}
JSON
if PATH="$tmp:$PATH" RELEASE_SHA="$sha" GITHUB_REPOSITORY=test/assistant GH_TOKEN=test \
  MOCK_RUNS="$tmp/wrong-source.json" bash "$ROOT/verify-release-source.sh" >/dev/null 2>&1; then
  echo "non-main CI must not authorize a manual release" >&2
  exit 1
fi

if RELEASE_SHA="$sha" GITHUB_REPOSITORY=test/assistant BREAK_GLASS=true \
  bash "$ROOT/verify-release-source.sh" >/dev/null 2>&1; then
  echo "break-glass without a reason must fail" >&2
  exit 1
fi
RELEASE_SHA="$sha" GITHUB_REPOSITORY=test/assistant BREAK_GLASS=true \
  BREAK_GLASS_REASON="incident approval" bash "$ROOT/verify-release-source.sh" >/dev/null

echo "manual release source checks passed"
