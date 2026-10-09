#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_SHA:?Set RELEASE_SHA to a full commit SHA}"
: "${GITHUB_REPOSITORY:?Set GITHUB_REPOSITORY to owner/repository}"
if [[ ! "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Manual releases require a full lowercase commit SHA" >&2
  exit 1
fi

if [[ "${BREAK_GLASS:-false}" == "true" ]]; then
  reason="${BREAK_GLASS_REASON//[[:space:]]/}"
  if [[ -z "$reason" ]]; then
    echo "BREAK_GLASS_REASON is required for a release without matching CI" >&2
    exit 1
  fi
  echo "::warning::Break-glass release without matching successful main CI: ${BREAK_GLASS_REASON}"
  exit 0
fi

: "${GH_TOKEN:?GH_TOKEN is required to check the exact CI run}"
runs="$(gh api "/repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${RELEASE_SHA}&per_page=100")"
if jq -e --arg sha "$RELEASE_SHA" '
  [.workflow_runs[]? | select(
    .head_sha == $sha and
    .head_branch == "main" and
    .event == "push" and
    .conclusion == "success"
  )] | length > 0
' <<<"$runs" >/dev/null; then
  echo "Verified successful main CI for ${RELEASE_SHA}"
  exit 0
fi

echo "No successful main-branch CI run found for ${RELEASE_SHA}; provide an explicit break-glass reason to proceed" >&2
exit 1
