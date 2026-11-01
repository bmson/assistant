#!/usr/bin/env bash
# Normal production release entry point. It selects the release path that
# matches the installation's persistence driver, then hands over to it:
#
#   postgres  → release-postgres.sh: the original release, unchanged. It backs
#               up PostgreSQL, runs the migration job, and rolls out images.
#   firestore → release-firestore.sh: no database URL, no database secret, no
#               PostgreSQL migration or backup; a managed Firestore recovery
#               point and index readiness gate the rollout instead.
#
# The driver comes from the live assistant-agent and assistant-web templates.
# RELEASE_PERSISTENCE_DRIVER=postgres|firestore makes the expectation explicit;
# a release whose flag contradicts the live services, or whose services
# disagree with each other, stops before anything changes.
set -euo pipefail

RELEASE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/gcp/release-persistence.sh
source "${RELEASE_ROOT}/release-persistence.sh"
# shellcheck source=infra/gcp/release-staged-services.sh
source "${RELEASE_ROOT}/release-staged-services.sh"

PROJECT="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project id}"
REGION="${GCP_REGION:-us-west1}"
REPO="${ARTIFACT_REPOSITORY:-assistant}"
TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
# Identity, scope and fixed target are pure gates. Only then may auto detection
# read the live services; the actual resolved driver gates mutation below.
release_validate_basic_editor_preflight_context "${RELEASE_COMPONENTS:-agent,web}" "$TAG" || exit $?

DRIVER="$(resolve_release_persistence)" || exit $?
release_validate_basic_editor_context "${RELEASE_COMPONENTS:-agent,web}" "$DRIVER" "$TAG" || exit $?
export RELEASE_PERSISTENCE_DRIVER="$DRIVER"
echo "Release path: ${DRIVER} (live services, RELEASE_PERSISTENCE_DRIVER=${RELEASE_PERSISTENCE_DRIVER:-auto})"
case "$DRIVER" in
  firestore) exec bash "${RELEASE_ROOT}/release-firestore.sh" ;;
  postgres) exec bash "${RELEASE_ROOT}/release-postgres.sh" ;;
esac
echo "Unexpected persistence driver '${DRIVER}'." >&2
exit 1
