#!/usr/bin/env bash
set -euo pipefail

# Only a pull request can arrive here without an iOS change; the push and
# dispatch triggers already imply one.
if [ "${EVENT_NAME:?EVENT_NAME is required}" != "pull_request" ]; then
  echo "ios=true" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  exit 0
fi

# Capture the complete list before matching. grep -q can close its input early;
# with pipefail that turns a successful match into git's SIGPIPE status on large
# diffs and makes this required check appear skipped.
changed_paths="$(git diff --name-only "${BASE_SHA:?BASE_SHA is required}" HEAD)"
if grep -Eq '^(apps/ios/|\.github/workflows/ios\.yml$|infra/ios-detect-changes\.sh$|infra/ios-detect-changes\.test\.sh$)' <<<"$changed_paths"; then
  echo "ios=true" >> "$GITHUB_OUTPUT"
else
  echo "ios=false" >> "$GITHUB_OUTPUT"
fi
