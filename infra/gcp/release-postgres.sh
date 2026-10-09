#!/usr/bin/env bash
# Normal production release: build one immutable image set and roll it out to
# the already-provisioned Cloud Run services/job. One-time IAM, secrets,
# networking, Scheduler, and Pub/Sub setup remains in deploy.sh.
set -euo pipefail

# shellcheck source=infra/gcp/release-diagnostics.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-diagnostics.sh"
source "$(dirname "${BASH_SOURCE[0]}")/release-staged-services.sh"
release_validate_worker_override || exit $?

PROJECT="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project id}"
REGION="${GCP_REGION:-us-west1}"
REPO="${ARTIFACT_REPOSITORY:-assistant}"
TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
RELEASE_COMPONENTS="${RELEASE_COMPONENTS:-agent,web}"

if [[ ! "$TAG" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "IMAGE_TAG may contain only letters, digits, '.', '_' and '-'." >&2
  exit 2
fi
case "$RELEASE_COMPONENTS" in
  full|agent,web|web,agent) RELEASE_COMPONENTS=agent,web ;;
  web)
    if [[ "${RELEASE_SCHEMA_UNCHANGED:-false}" != true ]]; then
      echo 'web-only release requires RELEASE_SCHEMA_UNCHANGED=true' >&2
      exit 2
    fi
    ;;
  *) echo 'RELEASE_COMPONENTS must be agent,web (default) or web' >&2; exit 2 ;;
esac
export RELEASE_COMPONENTS

IMAGE_ROOT="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
AGENT_SERVICE_ACCOUNT="assistant-agent@${PROJECT}.iam.gserviceaccount.com"
INTERNAL_INVOKER_SERVICE_ACCOUNT="assistant-internal-invoker@${PROJECT}.iam.gserviceaccount.com"

# ── release bookkeeping ──────────────────────────────────────────────────────
# Rollout steps below are attempted independently; failures are collected here
# and reported together at the end, and the release still exits non-zero.
#
# This used to be strictly fail-fast with the web rollout as its very LAST
# command. That pairing silently stranded the dashboard: an agent env var only
# deploy.sh sets, or one absent Cloud Scheduler job, aborted the script several
# steps before web was ever updated. The web image had been built, pushed, and
# tagged — production just went on serving the previous revision, and the only
# symptom was "my UI change didn't show up". Fail-fast is right for a gate that
# protects the thing being deployed (the migration below), and wrong for drift
# in a component that the next rollout does not depend on.
FAILURE_COUNT=0
FAILURE_LIST=""

record_failure() {
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
  FAILURE_LIST="${FAILURE_LIST}  - ${1}"$'\n'
  printf '  ✗ %s\n' "$1" >&2
}

# Run one release step, recording rather than propagating its failure. Call as
# `step "label" fn args...` — errexit stays armed for everything outside these.
step() {
  local label="$1"
  shift
  echo "── ${label}"
  if "$@"; then
    return 0
  fi
  record_failure "$label"
  return 1
}

agent_env_value() {
  local name="$1"
  gcloud run services describe assistant-agent \
    --project "$PROJECT" --region "$REGION" --format=json |
    node -e '
      const fs = require("node:fs");
      const name = process.argv[1];
      const service = JSON.parse(fs.readFileSync(0, "utf8"));
      const env = service.spec?.template?.spec?.containers?.[0]?.env ?? [];
      process.stdout.write(String(env.find((entry) => entry.name === name)?.value ?? ""));
    ' "$name"
}

if [[ "${SKIP_IMAGE_BUILD:-false}" != "true" ]]; then
  echo "Building release ${TAG} with Cloud Build"
  RELEASE_MODULES="${ASSISTANT_MODULES:-$(agent_env_value ASSISTANT_MODULES)}"
  RELEASE_MODULES="${RELEASE_MODULES:-all}"
  # ASSISTANT_MODULES is legitimately comma-separated (google,sms,...), and the
  # default ',' substitution delimiter would parse each module after the first
  # as another KEY=VALUE pair — breaking the build, and a crafted value could
  # override _REGION/_REPO/_TAG (which pick the image registry and tag). Use
  # gcloud's custom-delimiter form so commas inside a value stay literal.
  gcloud builds submit . \
    --project "$PROJECT" \
    --config infra/gcp/cloudbuild.yaml \
    --substitutions "^@@^_REGION=${REGION}@@_REPO=${REPO}@@_TAG=${TAG}@@_MODULES=${RELEASE_MODULES}" \
    --quiet
else
  echo "Using pre-built release images ${TAG}"
fi

echo "Checking live/new schema and API compatibility before release mutations"
release_preflight_compatibility "$RELEASE_COMPONENTS" || exit 1

# A release-tagged, consistent dump is a hard gate before schema changes. The
# backup job has the same database/storage access as the agent but no app code.
#
# SKIP_BACKUP=true opts out for releases that cannot have touched the schema
# (a web-only copy change, an iOS-only commit) — the backup and its Cloud Run
# Job round-trip cost one to two minutes that a same-day iteration loop feels.
# It stays opt-OUT, never opt-in: the default path keeps the gate.
if [[ "$RELEASE_COMPONENTS" == web ]]; then
  echo 'Web-only release: schema is declared unchanged; skipping backup and migration.'
elif [[ "${SKIP_BACKUP:-false}" == "true" ]]; then
  echo "Skipping the pre-migration backup (SKIP_BACKUP=true) — only safe when the schema is unchanged"
else
BACKUP_BUCKET="$(agent_env_value WORKSPACE_BUCKET)"
BACKUP_WORKSPACE_ID="$(agent_env_value ASSISTANT_WORKSPACE_ID)"
[ -n "$BACKUP_BUCKET" ] || { echo "WORKSPACE_BUCKET is missing on assistant-agent" >&2; exit 1; }
# The agent service can legitimately omit ASSISTANT_WORKSPACE_ID: the config
# schema (packages/config) resolves the same 'assistant' default when the
# variable is absent, so a service without it IS running workspace
# 'assistant' — hard-failing here declared every release of such a service
# undeployable while the app itself was perfectly happy. Mirror the app's
# default (the migration env below already does) so the backup lands under
# the prefix the running workspace actually uses. WORKSPACE_BUCKET stays a
# hard gate: it has no derivable default, and a backup with no destination
# is not a backup.
BACKUP_WORKSPACE_ID="${BACKUP_WORKSPACE_ID:-assistant}"
echo "Backing up the database before migration"
if gcloud run jobs describe assistant-backup --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  gcloud run jobs update assistant-backup \
    --project "$PROJECT" --region "$REGION" \
    --image "${IMAGE_ROOT}/backup:${TAG}" \
    --service-account "$AGENT_SERVICE_ACCOUNT" \
    --set-env-vars "^|^BACKUP_BUCKET=${BACKUP_BUCKET}|BACKUP_WORKSPACE_ID=${BACKUP_WORKSPACE_ID}|BACKUP_RELEASE=${TAG}" \
    --set-secrets "DATABASE_URL=database-url:latest" \
    --memory 512Mi --cpu 1 --task-timeout 1200 --max-retries 0 --quiet
else
  gcloud run jobs create assistant-backup \
    --project "$PROJECT" --region "$REGION" \
    --image "${IMAGE_ROOT}/backup:${TAG}" \
    --service-account "$AGENT_SERVICE_ACCOUNT" \
    --set-env-vars "^|^BACKUP_BUCKET=${BACKUP_BUCKET}|BACKUP_WORKSPACE_ID=${BACKUP_WORKSPACE_ID}|BACKUP_RELEASE=${TAG}" \
    --set-secrets "DATABASE_URL=database-url:latest" \
    --memory 512Mi --cpu 1 --task-timeout 1200 --max-retries 0 --quiet
fi
gcloud run jobs execute assistant-backup --project "$PROJECT" --region "$REGION" --wait --quiet
fi

# Migrations run in a short-lived Cloud Run Job with the agent's existing
# database-secret access. The GitHub deployer never receives the database URL,
# and a failed migration stops the release before any new service revision is
# made live. This one stays a hard gate on purpose: every rollout below assumes
# the schema is current, so there is nothing safe to continue to.
if [[ "$RELEASE_COMPONENTS" != web ]]; then
echo "Migrating and reconciling database defaults"
MIGRATION_ASSISTANT_NAME="$(agent_env_value ASSISTANT_NAME)"
MIGRATION_ASSISTANT_EMAIL="$(agent_env_value ASSISTANT_EMAIL)"
MIGRATION_WORKSPACE_ID="$(agent_env_value ASSISTANT_WORKSPACE_ID)"
MIGRATION_TIMEZONE="$(agent_env_value ASSISTANT_TIMEZONE)"
MIGRATION_LOCALE="$(agent_env_value ASSISTANT_LOCALE)"
MIGRATION_OWNER_NAME="$(agent_env_value OWNER_NAME)"
MIGRATION_OWNER_EMAIL="$(agent_env_value OWNER_EMAIL)"
MIGRATION_IDENTITY_ENV="^|^ASSISTANT_NAME=${MIGRATION_ASSISTANT_NAME:-Assistant}|ASSISTANT_EMAIL=${MIGRATION_ASSISTANT_EMAIL:-assistant@example.com}|ASSISTANT_WORKSPACE_ID=${MIGRATION_WORKSPACE_ID:-assistant}|ASSISTANT_TIMEZONE=${MIGRATION_TIMEZONE:-UTC}|ASSISTANT_LOCALE=${MIGRATION_LOCALE:-en}|OWNER_NAME=${MIGRATION_OWNER_NAME:-Owner}|OWNER_EMAIL=${MIGRATION_OWNER_EMAIL:-owner@example.com}"
if gcloud run jobs describe assistant-migrate --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  gcloud run jobs update assistant-migrate \
    --project "$PROJECT" --region "$REGION" \
    --image "${IMAGE_ROOT}/migrate:${TAG}" \
    --service-account "$AGENT_SERVICE_ACCOUNT" \
    --set-env-vars "$MIGRATION_IDENTITY_ENV" \
    --set-secrets "DATABASE_URL=database-url:latest" \
    --memory 512Mi --cpu 1 --task-timeout 600 --max-retries 0 --quiet
else
  gcloud run jobs create assistant-migrate \
    --project "$PROJECT" --region "$REGION" \
    --image "${IMAGE_ROOT}/migrate:${TAG}" \
    --service-account "$AGENT_SERVICE_ACCOUNT" \
    --set-env-vars "$MIGRATION_IDENTITY_ENV" \
    --set-secrets "DATABASE_URL=database-url:latest" \
    --memory 512Mi --cpu 1 --task-timeout 600 --max-retries 0 --quiet
fi
run_migration_job
fi

# This script rolls images only; deploy.sh owns environment and provisioning.
# That split is silent by default: a commit that starts depending on a new env
# var, or on a Scheduler job deploy.sh creates, ships green here and fails in
# production. It has happened — the agent served every Gmail push a 403 for days
# because GMAIL_PUSH_SERVICE_ACCOUNT was only ever set by deploy.sh, while the
# gmail-sync job that would have masked it was silently skipped below. So this
# still blocks the agent rollout and still fails the release; it just no longer
# takes the unrelated web and job rollouts down with it.
verify_agent_configuration() {
  local required agent_env_names missing_env
  local -a REQUIRED_AGENT_ENV
  REQUIRED_AGENT_ENV=(
    AGENT_URL
    BROWSER_JOB_NAME
    CLOUD_TASKS_QUEUE
    CODE_JOB_NAME
    GCP_LOCATION
    GCP_PROJECT
    GMAIL_PUBSUB_TOPIC
    GMAIL_PUSH_SERVICE_ACCOUNT
    INTERNAL_AUTH_MODE
    INTERNAL_OIDC_AUDIENCE
    INTERNAL_OIDC_SERVICE_ACCOUNT
    OWNER_EMAIL
    PROCESSOR_DRIVER
    PROCESSOR_JOB_NAME
    PUBLIC_URL
    QUEUE_DRIVER
    WORKSPACE_BUCKET
  )
  # env[].name yields names only, semicolon separated — never the values, so this
  # stays safe to run with the release log attached to a public build.
  agent_env_names="$(gcloud run services describe assistant-agent \
    --project "$PROJECT" --region "$REGION" \
    --format='value(spec.template.spec.containers[0].env[].name)' | tr ';' '\n')" || return 1
  # Accumulated as a string, not an array: `${#arr[@]}` on an empty array is an
  # unbound-variable error under `set -u` in bash 3.2, which is still what
  # /bin/bash is on macOS — and a release script must not fail differently
  # depending on whose machine runs it.
  missing_env=""
  for required in "${REQUIRED_AGENT_ENV[@]}"; do
    grep -Fxq -- "$required" <<<"$agent_env_names" || missing_env="${missing_env}    - ${required}"$'\n'
  done
  if [[ -n "$missing_env" ]]; then
    echo "  assistant-agent is missing required environment variables:" >&2
    printf '%s' "$missing_env" >&2
    echo "  These are provisioned by infra/gcp/deploy.sh. Run it, then re-run this release." >&2
    return 1
  fi
  return 0
}

configured_module_enabled() {
  local modules="$1" module="$2"
  [ "$modules" = "all" ] && return 0
  case ",${modules}," in
    *",${module},"*) return 0 ;;
    *) return 1 ;;
  esac
}

RELEASE_MODULES="${ASSISTANT_MODULES:-$(agent_env_value ASSISTANT_MODULES)}"
RELEASE_MODULES="${RELEASE_MODULES:-all}"

# A pinned traffic split is the quiet way a Cloud Run service stops tracking its
# own releases: once traffic points at a named revision (a manual rollback is
# the usual cause), every later `services update --image` creates a revision
# that receives 0% of requests. The release reads clean and the site never
# changes. Re-assert latest on each rollout so a pin cannot outlive one release.
roll_out_service() {
  local service="$1" image="$2"
  gcloud run services update "$service" \
    --project "$PROJECT" --region "$REGION" \
    --image "$image" --quiet || return 1
  gcloud run services update-traffic "$service" \
    --project "$PROJECT" --region "$REGION" --to-latest --quiet || return 1
}

# Scheduler jobs call protected internal endpoints. Keep their authentication
# route-scoped and self-healing on every release so an old static header cannot
# strand retries or silently weaken the boundary after an infrastructure change.
refresh_scheduler_oidc() {
  local agent_url="$1"
  local job_spec job_name job_path describe_output missing_jobs modules canaries
  modules="$(agent_env_value ASSISTANT_MODULES)" || return 1
  modules="${modules:-all}"
  canaries="$(agent_env_value CANARY_ENABLED)" || return 1
  missing_jobs=""
  local -a EXPECTED_JOBS
  EXPECTED_JOBS=('assistant-sweep:/internal/sweep')
  if configured_module_enabled "$modules" google; then
    EXPECTED_JOBS+=(
      'assistant-gmail-sync:/internal/gmail/sync'
      'assistant-gmail-watch:/internal/gmail/watch'
    )
  fi
  if [ "$canaries" = "true" ]; then
    EXPECTED_JOBS+=(
      'assistant-canaries:/internal/canaries/run'
      'assistant-canary-health:/internal/canaries/health'
    )
  fi
  for job_spec in "${EXPECTED_JOBS[@]}"; do
    job_name="${job_spec%%:*}"
    job_path="${job_spec#*:}"
    # A job that does not exist is drift, not a no-op to skip past: these carry the
    # mailbox poll and the canaries, so a missing one removes the very signal that
    # would report it missing.
    if ! describe_output="$(gcloud scheduler jobs describe "$job_name" \
      --project "$PROJECT" --location "$REGION" 2>&1)"; then
      if grep -Eqi 'NOT_FOUND|not found|does not exist' <<<"$describe_output"; then
        missing_jobs="${missing_jobs}    - ${job_name}"$'\n'
        continue
      fi
      echo "  Unable to inspect Cloud Scheduler job ${job_name}:" >&2
      printf '%s\n' "$describe_output" >&2
      return 1
    fi
    gcloud scheduler jobs update http "$job_name" --project "$PROJECT" --location "$REGION" \
      --uri="${agent_url}${job_path}" --http-method=POST --attempt-deadline=300s \
      --max-retry-attempts=0 --clear-headers \
      --oidc-service-account-email="$INTERNAL_INVOKER_SERVICE_ACCOUNT" \
      --oidc-token-audience="${agent_url}${job_path}" --quiet || return 1
  done
  if [[ -n "$missing_jobs" ]]; then
    echo "  Expected Cloud Scheduler jobs are absent:" >&2
    printf '%s' "$missing_jobs" >&2
    echo "  These are created by infra/gcp/deploy.sh. Run it, then re-run this release." >&2
    return 1
  fi
  return 0
}

# Roll a Cloud Run job that deploy.sh owns. `optional` jobs (assistant-code,
# assistant-processor) may not exist yet on the first release after they land,
# so an absent one is reported and skipped; assistant-browser is long since
# provisioned, so its absence is drift and fails the release.
roll_out_job() {
  local job="$1" image="$2" service_account="$3" presence="${4:-required}"
  if ! gcloud run jobs describe "$job" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
    if [[ "$presence" == "optional" ]]; then
      echo "  ${job} not provisioned yet — run infra/gcp/deploy.sh; skipping"
      return 0
    fi
    echo "  ${job} does not exist. It is created by infra/gcp/deploy.sh." >&2
    return 1
  fi
  gcloud run jobs update "$job" \
    --project "$PROJECT" --region "$REGION" \
    --image "$image" --service-account "$service_account" --quiet || return 1
}

# The proof that the release actually landed. Everything above reports on the
# control plane's behalf ("the update call succeeded"); this asks the running
# site which commit it is serving. It is what turns a stranded web rollout from
# an invisible non-event into a red release.
verify_web_serving_release() {
  local url payload sha
  url="$(gcloud run services describe assistant-web \
    --project "$PROJECT" --region "$REGION" --format='value(status.url)')" || return 1
  if [[ -z "$url" ]]; then
    echo "  could not resolve the assistant-web URL" >&2
    return 1
  fi
  sha=""
  for _attempt in $(seq 1 30); do
    payload="$(curl --fail --silent --max-time 10 "${url}/api/health")" || payload=""
    sha="$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' <<<"$payload")"
    if [[ "$sha" == "$TAG" ]]; then
      echo "  assistant-web is serving ${TAG}"
      return 0
    fi
    sleep 5
  done
  echo "  assistant-web reports '${sha:-no sha}' after the rollout, expected '${TAG}'." >&2
  echo "  The new revision exists but is not the one serving traffic. Inspect with:" >&2
  echo "    gcloud run services describe assistant-web --region ${REGION} --format='value(status.traffic)'" >&2
  return 1
}

# ── rollout ──────────────────────────────────────────────────────────────────
# Agent first (web calls it, so this is the ordering that minimises API skew),
# then web, then the reconciliation tail. Independent, so the tail cannot strand
# either service the way it used to.
if [[ "$RELEASE_COMPONENTS" == agent,web ]]; then
  if step "Verifying agent configuration" verify_agent_configuration; then
    step "Staging, verifying, and promoting compatible services" release_staged_services || true
  else
    record_failure "Service promotion skipped — agent configuration unverified"
  fi

  AGENT_URL="$(gcloud run services describe assistant-agent --project "$PROJECT" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
  if [[ -n "$AGENT_URL" ]]; then
    step "Refreshing internal scheduler OIDC" refresh_scheduler_oidc "$AGENT_URL" || true
  else
    record_failure "Refreshing internal scheduler OIDC (could not resolve the agent URL)"
  fi
else
  step "Staging, verifying, and promoting web-only release" release_staged_services || true
fi

if (( FAILURE_COUNT )); then
  echo "" >&2
  echo "Release ${TAG} finished with ${FAILURE_COUNT} failed step(s):" >&2
  printf '%s' "$FAILURE_LIST" >&2
  echo "Steps not listed above did complete — re-running this release is safe." >&2
  exit 1
fi

echo "Release ${TAG} is live"
gcloud run services describe assistant-web \
  --project "$PROJECT" --region "$REGION" --format='value(status.url)'
