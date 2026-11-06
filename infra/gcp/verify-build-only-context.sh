#!/usr/bin/env bash
set -euo pipefail

# Pure pre-authentication scope check. The ordinary exact-main CI verifier runs next.
[[ "${BUILD_ONLY:-}" == true &&
   "${GITHUB_ACTIONS:-}" == true && "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]{0,19}$ &&
   "${GITHUB_EVENT_NAME:-}" == workflow_dispatch &&
   "${GITHUB_REF:-}" == refs/heads/main &&
   "${GITHUB_RUN_ATTEMPT:-}" == 1 &&
   "${GITHUB_REPOSITORY:-}" == bmson/assistant &&
   "${GITHUB_WORKFLOW_REF:-}" == bmson/assistant/.github/workflows/deploy.yml@refs/heads/main &&
   "${RELEASE_SHA:-}" =~ ^[a-f0-9]{40}$ &&
   "${GITHUB_SHA:-}" == "$RELEASE_SHA" &&
   "${GITHUB_WORKFLOW_SHA:-}" == "$RELEASE_SHA" &&
   "${REQUESTED_COMPONENTS:-}" == full &&
   "${REQUESTED_PERSISTENCE:-}" == firestore &&
   ( "${NATIVE_WEB_QUALIFICATION:-}" == off || -z "${NATIVE_WEB_QUALIFICATION:-}" ) &&
   "${BREAK_GLASS:-false}" == false &&
   -z "${BOOTSTRAP_SNAPSHOT:-}" && -z "${BOOTSTRAP_SNAPSHOT_SHA256:-}" ]] || {
  echo 'Build-only requires the first exact-main paired Firestore dispatch, without break-glass, qualification or bootstrap inputs.' >&2
  exit 2
}
