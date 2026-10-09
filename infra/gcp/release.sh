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

PROJECT="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project id}"
REGION="${GCP_REGION:-us-west1}"

DRIVER="$(resolve_release_persistence)" || exit $?
export RELEASE_PERSISTENCE_DRIVER="$DRIVER"
echo "Release path: ${DRIVER} (live services, RELEASE_PERSISTENCE_DRIVER=${RELEASE_PERSISTENCE_DRIVER:-auto})"
case "$DRIVER" in
  firestore) exec bash "${RELEASE_ROOT}/release-firestore.sh" ;;
  postgres) exec bash "${RELEASE_ROOT}/release-postgres.sh" ;;
esac
echo "Unexpected persistence driver '${DRIVER}'." >&2
exit 1
