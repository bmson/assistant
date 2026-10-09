#!/usr/bin/env bash
# Firestore production release, selected by infra/gcp/release.sh when the live
# assistant-agent and assistant-web run PERSISTENCE_DRIVER=firestore.
#
# Same image rollout as the PostgreSQL path, without its database steps:
#   - no database URL and no database secret is read, set, or mounted;
#   - no PostgreSQL backup job and no migration job is created or executed;
#   - no call reaches the PostgreSQL provider.
# In their place, three hard gates run before any revision changes:
#   1. both service templates are database-free Firestore compositions;
#   2. a managed Firestore recovery point exists for the pre-release state
#      (point-in-time recovery, or a recent READY scheduled backup);
#   3. the Firestore indexes exactly match this release's index manifest.
# The rollout helpers mirror release-postgres.sh so both paths report drift
# the same way; release-postgres.sh is deleted when PostgreSQL is retired.
set -euo pipefail

# shellcheck source=infra/gcp/release-staged-services.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-staged-services.sh"
release_validate_worker_override || exit $?

PROJECT="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project id}"
REGION="${GCP_REGION:-us-west1}"
REPO="${ARTIFACT_REPOSITORY:-assistant}"
TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
RELEASE_COMPONENTS="${RELEASE_COMPONENTS:-agent,web}"
export RELEASE_PERSISTENCE_DRIVER=firestore
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
ASSISTANT_RELEASE_WRITES_PAUSED=false
if [[ "$RELEASE_COMPONENTS" == agent,web ]]; then ASSISTANT_RELEASE_WRITES_PAUSED=true; fi
export ASSISTANT_RELEASE_WRITES_PAUSED
# Fail closed before any backup/index/build/revision mutation unless the live
# pair and selected candidate declare compatible API and Firestore schema ranges.
echo "Checking live/new schema and API compatibility before Firestore release mutations"
if ! release_preflight_compatibility "$RELEASE_COMPONENTS"; then
  # This exception admits only the exact pinned 68e Firestore pair and only
  # for a full release whose first new web revision is maintenance-paused.
  # The helper never relabels historical API/schema metadata.
  # shellcheck source=infra/gcp/release-legacy-bootstrap.sh
  source "$(dirname "${BASH_SOURCE[0]}")/release-legacy-bootstrap.sh"
  release_preflight_legacy_firestore_bootstrap agent,web "$RELEASE_AGENT_API" "$RELEASE_WEB_API" "$RELEASE_SCHEMA_VERSION" || exit 1
fi
# A daily backup schedule leaves at most ~24h between recovery points.
BACKUP_MAX_AGE_HOURS="${FIRESTORE_BACKUP_MAX_AGE_HOURS:-26}"

if [[ ! "$TAG" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "IMAGE_TAG may contain only letters, digits, '.', '_' and '-'." >&2
  exit 2
fi
if [[ ! "$BACKUP_MAX_AGE_HOURS" =~ ^[1-9][0-9]*$ ]]; then
  echo "FIRESTORE_BACKUP_MAX_AGE_HOURS must be a positive whole number of hours." >&2
  exit 2
fi

IMAGE_ROOT="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
INTERNAL_INVOKER_SERVICE_ACCOUNT="assistant-internal-invoker@${PROJECT}.iam.gserviceaccount.com"

# ── release bookkeeping ──────────────────────────────────────────────────────
# Rollout steps are attempted independently and reported together, exactly as
# in release-postgres.sh. The pre-rollout gates above them stay fail-fast.
FAILURE_COUNT=0
FAILURE_LIST=""

record_failure() {
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
  FAILURE_LIST="${FAILURE_LIST}  - ${1}"$'\n'
  printf '  ✗ %s\n' "$1" >&2
}

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

service_env_value() {
  local service="$1" name="$2"
  gcloud run services describe "$service" \
    --project "$PROJECT" --region "$REGION" --format=json |
    node -e '
      const fs = require("node:fs");
      const name = process.argv[1];
      const service = JSON.parse(fs.readFileSync(0, "utf8"));
      const env = service.spec?.template?.spec?.containers?.[0]?.env ?? [];
      process.stdout.write(String(env.find((entry) => entry.name === name)?.value ?? ""));
    ' "$name"
}

agent_env_value() {
  service_env_value assistant-agent "$1"
}

# ── gate 1: database-free Firestore composition ─────────────────────────────
# Reads env names and secret references only, never values. A template that
# still carries a database setting is a mixed composition: releasing new code
# onto it would keep the old database a runtime dependency.
verify_database_free_template() {
  local kind="$1" name="$2" require_firestore="${3:-true}" description
  if [[ "$kind" == "service" ]]; then
    description="$(gcloud run services describe "$name" \
      --project "$PROJECT" --region "$REGION" --format=json)" || return 1
  else
    description="$(gcloud run jobs describe "$name" \
      --project "$PROJECT" --region "$REGION" --format=json)" || return 1
  fi
  printf '%s' "$description" | node -e '
    const fs = require("node:fs");
    const [kind, name, requireFirestore] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    const spec = kind === "service"
      ? value.spec?.template?.spec
      : value.spec?.template?.spec?.template?.spec ?? value.template?.template;
    const containers = spec?.containers;
    const databaseEnv = /^(DATABASE_URL|DIRECT_DATABASE_URL|PROD_DATABASE_URL|MIGRATION_DATABASE_URL|PG[A-Z_]*|POSTGRES_[A-Z_]+|NEON_[A-Z_]+)$/; // retirement-scan: forbids
    const databaseSecret = /^database-url($|-)|neon|postgres/i; // retirement-scan: forbids
    const problems = [];
    if (!Array.isArray(containers) || containers.length === 0) {
      problems.push("missing container template");
    }
    const env = [];
    for (const container of containers ?? []) {
      for (const entry of container.env ?? []) {
        env.push(entry);
        if (databaseEnv.test(entry.name ?? "")) problems.push(`env ${entry.name}`);
        const secret = entry.valueFrom?.secretKeyRef?.name ?? entry.valueSource?.secretKeyRef?.secret ?? "";
        if (secret && databaseSecret.test(secret.split("/").at(-1))) problems.push(`${entry.name} from secret ${secret}`);
      }
    }
    const driver = env.find((entry) => entry.name === "PERSISTENCE_DRIVER")?.value;
    if (requireFirestore === "true" && driver !== "firestore")
      problems.push(`PERSISTENCE_DRIVER=${driver ?? "(unset)"}`);
    if (problems.length) {
      process.stderr.write(`  ${kind} ${name} is not a database-free Firestore composition:\n`);
      for (const problem of problems) process.stderr.write(`    - ${problem}\n`);
      process.exit(1);
    }
    process.stdout.write(`  ${kind} ${name}: no database env or secret\n`);
  ' "$kind" "$name" "$require_firestore"
}

# ── gate 2: managed Firestore recovery point ─────────────────────────────────
# Replaces the PostgreSQL pre-migration dump. Point-in-time recovery makes the
# exact pre-release state restorable for the retention window; without it, a
# READY managed backup (from a backup schedule) no older than
# FIRESTORE_BACKUP_MAX_AGE_HOURS is accepted, and the gap is printed.
verify_firestore_recovery_point() {
  local database="$1" description backups release_time
  release_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  description="$(gcloud firestore databases describe --database="$database" \
    --project "$PROJECT" --format=json)" || return 1
  if printf '%s' "$description" | node -e '
    const fs = require("node:fs");
    const db = JSON.parse(fs.readFileSync(0, "utf8"));
    if (db.pointInTimeRecoveryEnablement !== "POINT_IN_TIME_RECOVERY_ENABLED") process.exit(1);
    process.stdout.write(
      `  Recovery point: ${process.argv[1]} at ${process.argv[2]} (point-in-time recovery; ` +
        `earliest retained version ${db.earliestVersionTime ?? "unknown"}, ` +
        `retention ${db.versionRetentionPeriod ?? "unknown"})\n`,
    );
  ' "$database" "$release_time"; then
    return 0
  fi
  echo "  Point-in-time recovery is not enabled on ${database}; looking for a recent managed backup."
  backups="$(gcloud firestore backups list --project "$PROJECT" --format=json)" || return 1
  printf '%s' "$backups" | node -e '
    const fs = require("node:fs");
    const [project, database, maxHours] = process.argv.slice(1);
    const target = `projects/${project}/databases/${database}`;
    const ready = JSON.parse(fs.readFileSync(0, "utf8") || "[]")
      .filter((backup) => backup.state === "READY" && backup.database === target)
      .sort((a, b) => String(b.snapshotTime).localeCompare(String(a.snapshotTime)));
    const newest = ready[0];
    const ageHours = newest ? (Date.now() - Date.parse(newest.snapshotTime)) / 3_600_000 : Infinity;
    if (!newest || !(ageHours <= Number(maxHours))) {
      process.stderr.write(
        `  No READY managed backup of ${database} newer than ${maxHours}h. Enable point-in-time ` +
          "recovery or a Firestore backup schedule, then re-run this release.\n",
      );
      process.exit(1);
    }
    process.stdout.write(
      `  Recovery point: ${newest.name} (snapshot ${newest.snapshotTime}, ${ageHours.toFixed(1)}h old). ` +
        "Writes after that snapshot are not covered by it.\n",
    );
  ' "$PROJECT" "$database" "$BACKUP_MAX_AGE_HOURS"
}

FIRESTORE_DATABASE_ID="$(agent_env_value FIRESTORE_DATABASE_ID)"
WEB_FIRESTORE_DATABASE_ID="$(service_env_value assistant-web FIRESTORE_DATABASE_ID)"
if [[ ! "$FIRESTORE_DATABASE_ID" =~ ^[a-z][a-z0-9-]{2,61}[a-z0-9]$ ]]; then
  echo "assistant-agent must name its Firestore database in FIRESTORE_DATABASE_ID." >&2
  exit 1
fi
if [[ "$WEB_FIRESTORE_DATABASE_ID" != "$FIRESTORE_DATABASE_ID" ]]; then
  echo "assistant-web uses Firestore database '${WEB_FIRESTORE_DATABASE_ID}', assistant-agent '${FIRESTORE_DATABASE_ID}'." >&2
  exit 1
fi

echo "── Verifying database-free Firestore templates"
verify_database_free_template service assistant-agent
verify_database_free_template service assistant-web

echo "── Verifying the pre-release Firestore recovery point for ${FIRESTORE_DATABASE_ID}"
verify_firestore_recovery_point "$FIRESTORE_DATABASE_ID"

# Firestore has no schema migration. What a release can depend on is an index:
# a query that needs a composite index fails at runtime until it is READY. The
# release does not create indexes; `pnpm firestore:indexes apply` does, and
# this gate waits for the manifest and the database to match exactly.
echo "── Verifying Firestore indexes match this release"
pnpm -s firestore:indexes verify --project="$PROJECT" --database="$FIRESTORE_DATABASE_ID"

# Images are built only after every gate passed, so a blocked release costs no build.
RELEASE_MODULES="${ASSISTANT_MODULES:-$(agent_env_value ASSISTANT_MODULES)}"
RELEASE_MODULES="${RELEASE_MODULES:-all}"
if [[ "${SKIP_IMAGE_BUILD:-false}" != "true" ]]; then
  echo "Building release ${TAG} with Cloud Build"
  gcloud builds submit . \
    --project "$PROJECT" \
    --config infra/gcp/cloudbuild-firestore.yaml \
    --substitutions "^@@^_REGION=${REGION}@@_REPO=${REPO}@@_TAG=${TAG}@@_MODULES=${RELEASE_MODULES}" \
    --quiet
else
  echo "Using pre-built release images ${TAG}"
fi

verify_agent_configuration() {
  local required agent_env_names missing_env
  local -a REQUIRED_AGENT_ENV
  REQUIRED_AGENT_ENV=(
    AGENT_URL
    BROWSER_JOB_NAME
    CLOUD_TASKS_QUEUE
    CODE_JOB_NAME
    FIRESTORE_AGENT_ID
    FIRESTORE_DATABASE_ID
    FIRESTORE_EMBEDDING_SPACE
    GCP_LOCATION
    GCP_PROJECT
    GMAIL_PUBSUB_TOPIC
    GMAIL_PUSH_SERVICE_ACCOUNT
    INTERNAL_AUTH_MODE
    INTERNAL_OIDC_AUDIENCE
    INTERNAL_OIDC_SERVICE_ACCOUNT
    OWNER_EMAIL
    PERSISTENCE_DRIVER
    PROCESSOR_DRIVER
    PROCESSOR_JOB_NAME
    PUBLIC_URL
    QUEUE_DRIVER
    WORKSPACE_BUCKET
  )
  agent_env_names="$(gcloud run services describe assistant-agent \
    --project "$PROJECT" --region "$REGION" \
    --format='value(spec.template.spec.containers[0].env[].name)' | tr ';' '\n')" || return 1
  missing_env=""
  for required in "${REQUIRED_AGENT_ENV[@]}"; do
    grep -Fxq -- "$required" <<<"$agent_env_names" || missing_env="${missing_env}    - ${required}"$'\n'
  done
  if [[ -n "$missing_env" ]]; then
    echo "  assistant-agent is missing required environment variables:" >&2
    printf '%s' "$missing_env" >&2
    echo "  Restore them on the Firestore composition, then re-run this release." >&2
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

roll_out_service() {
  local service="$1" image="$2"
  gcloud run services update "$service" \
    --project "$PROJECT" --region "$REGION" \
    --image "$image" --quiet || return 1
  gcloud run services update-traffic "$service" \
    --project "$PROJECT" --region "$REGION" --to-latest --quiet || return 1
}

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
    return 1
  fi
  return 0
}

# Module jobs must be database-free too: rolling new code onto a job that still
# mounts a database secret would keep that database a dependency.
roll_out_job() {
  local job="$1" image="$2" service_account="$3" presence="${4:-required}"
  if ! gcloud run jobs describe "$job" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
    if [[ "$presence" == "optional" ]]; then
      echo "  ${job} not provisioned yet; skipping"
      return 0
    fi
    echo "  ${job} does not exist." >&2
    return 1
  fi
  verify_database_free_template job "$job" false || return 1
  gcloud run jobs update "$job" \
    --project "$PROJECT" --region "$REGION" \
    --image "$image" --service-account "$service_account" --quiet || return 1
}

verify_web_serving_release() {
  local url payload sha
  url="$(gcloud run services describe assistant-web \
    --project "$PROJECT" --region "$REGION" --format='value(status.url)')" || return 1
  if [[ -z "$url" ]]; then
    echo "  could not resolve the assistant-web URL" >&2
    return 1
  fi
  sha=""
  for _attempt in $(seq 1 "${RELEASE_HEALTH_ATTEMPTS:-30}"); do
    payload="$(curl --fail --silent --max-time 10 "${url}/api/health")" || payload=""
    sha="$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' <<<"$payload")"
    if [[ "$sha" == "$TAG" ]]; then
      echo "  assistant-web is serving ${TAG}"
      return 0
    fi
    sleep "${RELEASE_HEALTH_INTERVAL_SECONDS:-5}"
  done
  echo "  assistant-web reports '${sha:-no sha}' after the rollout, expected '${TAG}'." >&2
  return 1
}

verify_released_templates() {
  verify_database_free_template service assistant-agent &&
    verify_database_free_template service assistant-web
}

# ── rollout ──────────────────────────────────────────────────────────────────
if step "Verifying agent configuration" verify_agent_configuration; then
  step "Staging, verifying, and promoting compatible services" release_staged_services || true
else
  record_failure "Service promotion skipped — agent configuration unverified"
fi

if [[ "$RELEASE_COMPONENTS" == agent,web ]]; then
  AGENT_URL="$(gcloud run services describe assistant-agent --project "$PROJECT" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
  if [[ -n "$AGENT_URL" ]]; then
    step "Refreshing internal scheduler OIDC" refresh_scheduler_oidc "$AGENT_URL" || true
  else
    record_failure "Refreshing internal scheduler OIDC (could not resolve the agent URL)"
  fi
fi

step "Verifying released templates stay database-free" verify_released_templates || true

if (( FAILURE_COUNT )); then
  echo "" >&2
  echo "Firestore release ${TAG} finished with ${FAILURE_COUNT} failed step(s):" >&2
  printf '%s' "$FAILURE_LIST" >&2
  echo "Steps not listed above did complete — re-running this release is safe." >&2
  exit 1
fi

echo "Firestore release ${TAG} is live"
gcloud run services describe assistant-web \
  --project "$PROJECT" --region "$REGION" --format='value(status.url)'
