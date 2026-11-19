#!/usr/bin/env bash
set -euo pipefail

# Only a pull request can arrive here without an iOS change; the push and
# dispatch triggers already imply one.
if [ "${EVENT_NAME:?EVENT_NAME is required}" != "pull_request" ]; then
  echo "ios=true" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  echo "native_controls=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Capture the complete list before matching. grep -q can close its input early;
# with pipefail that turns a successful match into git's SIGPIPE status on large
# diffs and makes this required check appear skipped.
changed_paths="$(git diff --name-only "${BASE_SHA:?BASE_SHA is required}" HEAD)"
if grep -Eq '^(apps/ios/|\.github/workflows/ios\.yml$|infra/ios-detect-changes\.sh$|infra/ios-detect-changes\.test\.sh$|infra/ios-native-controls\.py$)' <<<"$changed_paths"; then
  echo "ios=true" >> "$GITHUB_OUTPUT"
else
  echo "ios=false" >> "$GITHUB_OUTPUT"
fi

# The isolated control matrix is narrower than the ordinary iOS suite. Changes
# elsewhere in the app keep their existing ordinary build/test coverage.
if grep -Eq '^(apps/ios/AssistantUITestHost/|apps/ios/AssistantUITests/|apps/ios/Assistant\.xcodeproj/project\.pbxproj$|apps/ios/Assistant\.xcodeproj/xcshareddata/xcschemes/AssistantUIFixtures\.xcscheme$|apps/ios/Assistant/(AppModel\.swift|Views/ApprovalsView\.swift|Components/(MessageBubble|ApprovalRequestHeader)\.swift|Design/AssistantTheme\.swift|Models/APIModels\.swift|Networking/APIClient\.swift)$|\.github/workflows/ios\.yml$|infra/ios-native-controls\.py$|infra/ios-detect-changes(\.test)?\.sh$)' <<<"$changed_paths"; then
  echo "native_controls=true" >> "$GITHUB_OUTPUT"
else
  echo "native_controls=false" >> "$GITHUB_OUTPUT"
fi
