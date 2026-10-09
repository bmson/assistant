#!/usr/bin/env bash
# Fast single-service release for day-to-day iteration:
#   bash infra/gcp/release-fast.sh web
#   bash infra/gcp/release-fast.sh web
#
# Builds ONE image, rolls out ONE service, and verifies the rollout. It skips
# the database backup, the migration job, and every unrelated image, which is
# what makes it fast — so it is only safe when the change cannot have touched
# the schema (packages/db), seed data, or environment/provisioning. When in
# doubt, use infra/gcp/release.sh; it stays the source of truth for releases.
set -euo pipefail

TARGET="${1:-}"
case "$TARGET" in
  web) ;;
  *)
    echo "usage: bash infra/gcp/release-fast.sh web" >&2
    echo "" >&2
    echo "Builds and rolls out a single service without backup or migration." >&2
    echo "Use infra/gcp/release.sh instead when the schema, seed data, or" >&2
    echo "environment variables changed. Agent changes require the full staged release." >&2
    exit 2
    ;;
esac

# Resolve the project the same way deploy.sh does: an explicit shell variable
# wins, then the repo .env, then the gcloud CLI's configured project. Reading
# .env here means the fast path works from the same file the full provisioner
# uses, with nothing extra to export.
ENV_FILE="${ASSISTANT_ENV_FILE:-.env}"
envval() {
  [ -f "$ENV_FILE" ] || return 0
  { grep -E "^$1=" "$ENV_FILE" || true; } | head -1 | cut -d= -f2-
}
PROJECT="${GCP_PROJECT:-$(envval GCP_PROJECT)}"
if [ -z "$PROJECT" ]; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
fi
[ -n "$PROJECT" ] || { echo "Set GCP_PROJECT in ${ENV_FILE}, your shell, or gcloud config" >&2; exit 1; }
REGION="${GCP_REGION:-$(envval GCP_LOCATION)}"
REGION="${REGION:-us-west1}"
REPO="${ARTIFACT_REPOSITORY:-$(envval ARTIFACT_REPOSITORY)}"
REPO="${REPO:-assistant}"
TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"

if [[ ! "$TAG" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "IMAGE_TAG may contain only letters, digits, '.', '_' and '-'." >&2
  exit 2
fi

IMAGE_ROOT="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
SERVICE="assistant-${TARGET}"

# A fast web release is valid for either storage composition, but it still
# needs the live service contract and selected storage schema to be proven.
# Resolve the driver before building, and let the staged protocol fail closed
# when the current agent has no reviewed API/schema metadata.
# shellcheck source=infra/gcp/release-persistence.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-persistence.sh"
RELEASE_PERSISTENCE_DRIVER="$(resolve_release_persistence)" || exit $?
export RELEASE_PERSISTENCE_DRIVER
export RELEASE_COMPONENTS=web RELEASE_SCHEMA_UNCHANGED=true RELEASE_MODULES=none
# shellcheck source=infra/gcp/release-staged-services.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-staged-services.sh"
release_validate_worker_override || exit $?
release_preflight_compatibility web

echo "── building ${TARGET}:${TAG} (single image)"
gcloud builds submit . \
  --project "$PROJECT" \
  --config "infra/gcp/cloudbuild-${TARGET}.yaml" \
  --substitutions "^@@^_REGION=${REGION}@@_REPO=${REPO}@@_TAG=${TAG}" \
  --quiet

echo "── staging, probing, and promoting ${SERVICE}"
release_staged_services

echo ""
echo "${SERVICE} ${TAG} is live"
gcloud run services describe "$SERVICE" \
  --project "$PROJECT" --region "$REGION" --format='value(status.url)'
