#!/usr/bin/env bash
# Idempotent GCP deploy for the assistant. Run from the repo root:
#   bash infra/gcp/deploy.sh
# Requires: gcloud authenticated (gcloud auth login), .env with PROD_DATABASE_URL etc.
set -euo pipefail

# ── read .env ────────────────────────────────────────────────────────────────
ENV_FILE="${ASSISTANT_ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "${ENV_FILE} does not exist; run pnpm setup first"; exit 1; }
envval() {
  local value
  value="$( { grep -E "^$1=" "$ENV_FILE" || true; } | head -1 | cut -d= -f2- )"
  # These values are interpolated into a '|'-delimited `--set-env-vars` list, so
  # a '|' in a value would inject additional Cloud Run environment variables
  # (e.g. overriding AUTH_DEV_BYPASS). Reject rather than silently corrupt the
  # deploy. set -e turns this subshell exit into a script abort.
  case "$value" in
    *"|"*) echo "FATAL: $1 in ${ENV_FILE} must not contain a '|' character" >&2; exit 1 ;;
  esac
  printf '%s' "$value"
}

# Nothing installation-specific is hard-coded: shell variables win, followed by
# the single .env file, followed by safe infrastructure defaults.
PROJECT="${GCP_PROJECT:-$(envval GCP_PROJECT)}"
if [ -z "$PROJECT" ]; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
fi
[ -n "$PROJECT" ] || { echo "Set GCP_PROJECT in ${ENV_FILE} or gcloud config"; exit 1; }
REGION="${GCP_REGION:-$(envval GCP_LOCATION)}"
REGION="${REGION:-us-west1}"
# PostgreSQL provisioning only: stop before any change if this installation
# already runs the Firestore composition.
# shellcheck source=infra/gcp/release-persistence.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-persistence.sh"
POSTGRES_SCHEMA_VERSION="$(node "$(dirname "${BASH_SOURCE[0]}")/release-schema-version.mjs" postgres)"
IFS=$'\t' read -r POSTGRES_AGENT_SCHEMA_MIN POSTGRES_AGENT_SCHEMA_MAX <<<"$(node "$(dirname "${BASH_SOURCE[0]}")/release-schema-version.mjs" postgres agent-range)"
IFS=$'\t' read -r POSTGRES_WEB_SCHEMA_MIN POSTGRES_WEB_SCHEMA_MAX <<<"$(node "$(dirname "${BASH_SOURCE[0]}")/release-schema-version.mjs" postgres web-range)"
refuse_firestore_installation || exit 1
REPO="${ARTIFACT_REPOSITORY:-$(envval ARTIFACT_REPOSITORY)}"
REPO="${REPO:-assistant}"
QUEUE="$(envval CLOUD_TASKS_QUEUE)"
QUEUE="${QUEUE:-agent-steps}"
TOPIC="${GMAIL_TOPIC:-gmail-events}"
WEB_DOMAIN="${WEB_DOMAIN:-$(envval WEB_DOMAIN)}"

ASSISTANT_NAME="$(envval ASSISTANT_NAME)"
ASSISTANT_NAME="${ASSISTANT_NAME:-Assistant}"
# No default: the assistant's own mailbox is its identity. A placeholder here
# once reached production and stayed for weeks — the system prompt, outgoing
# From line and self-mail detection all used it, and the Gmail canary failed
# daily against the real account. The check below now actually fires.
ASSISTANT_EMAIL="$(envval ASSISTANT_EMAIL)"
ASSISTANT_WORKSPACE_ID="$(envval ASSISTANT_WORKSPACE_ID)"
ASSISTANT_WORKSPACE_ID="${ASSISTANT_WORKSPACE_ID:-assistant}"
ASSISTANT_TIMEZONE="$(envval ASSISTANT_TIMEZONE)"
ASSISTANT_TIMEZONE="${ASSISTANT_TIMEZONE:-UTC}"
ASSISTANT_LOCALE="$(envval ASSISTANT_LOCALE)"
ASSISTANT_LOCALE="${ASSISTANT_LOCALE:-en}"
ASSISTANT_MODULES="$(envval ASSISTANT_MODULES)"
ASSISTANT_MODULES="${ASSISTANT_MODULES:-all}"
# The module plan is the single source of truth for what this installation
# contains. It validates names against the configuration schema and expands
# "all"/"minimal" exactly as the running services do, so provisioning cannot
# drift from the app. Nothing here parses ASSISTANT_MODULES itself.
PLAN_ENV="$(ASSISTANT_MODULES="$ASSISTANT_MODULES" pnpm -s modules:plan --format=env)" || {
  echo "Could not read the module plan; check ASSISTANT_MODULES in ${ENV_FILE}"
  exit 1
}
eval "$PLAN_ENV"
# PLAN_MODULES is the composition narrowed by ASSISTANT_MODULES — what this
# installation actually runs. It is what the services are given, so config-driven
# consumers that cannot see the composition file (the web app, most of all)
# still agree with what the agent installed.
module_enabled() {
  case ",${PLAN_MODULES}," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

PROD_DATABASE_URL="$(envval PROD_DATABASE_URL)"
OPENROUTER_API_KEY="$(envval OPENROUTER_API_KEY)"
GOOGLE_OAUTH_CLIENT_ID="$(envval GOOGLE_OAUTH_CLIENT_ID)"
GOOGLE_OAUTH_CLIENT_SECRET="$(envval GOOGLE_OAUTH_CLIENT_SECRET)"
BOT_GOOGLE_REFRESH_TOKEN="$(envval BOT_GOOGLE_REFRESH_TOKEN)"
TWILIO_ACCOUNT_SID="$(envval TWILIO_ACCOUNT_SID)"
TWILIO_AUTH_TOKEN="$(envval TWILIO_AUTH_TOKEN)"
TWILIO_FROM_NUMBER="$(envval TWILIO_FROM_NUMBER)"
OWNER_PHONE="$(envval OWNER_PHONE)"
OWNER_NAME="$(envval OWNER_NAME)"
OWNER_NAME="${OWNER_NAME:-Owner}"
OWNER_EMAIL="$(envval OWNER_EMAIL)"
SEARCH_PROVIDER="$(envval SEARCH_PROVIDER)"
SEARCH_PROVIDER="${SEARCH_PROVIDER:-none}"
SEARCH_API_KEY="$(envval SEARCH_API_KEY)"
GITHUB_TOKEN="$(envval GITHUB_TOKEN)"
GITHUB_REPO="$(envval GITHUB_REPO)"
APNS_KEY_ID="$(envval APNS_KEY_ID)"
APNS_TEAM_ID="$(envval APNS_TEAM_ID)"
APNS_PRIVATE_KEY="$(envval APNS_PRIVATE_KEY)"
APNS_BUNDLE_ID="$(envval APNS_BUNDLE_ID)"
# Maps signs with its own MapKit key when given one, else with the APNs key
# (one Apple .p8 key can carry APNs and MapKit together).
MAPKIT_KEY_ID="$(envval MAPKIT_KEY_ID)"
MAPKIT_TEAM_ID="$(envval MAPKIT_TEAM_ID)"
MAPKIT_PRIVATE_KEY="$(envval MAPKIT_PRIVATE_KEY)"

[ -n "$PROD_DATABASE_URL" ] || { echo "PROD_DATABASE_URL missing from .env"; exit 1; }
[ -n "$OPENROUTER_API_KEY" ] || { echo "OPENROUTER_API_KEY missing from .env"; exit 1; }
[ -n "$ASSISTANT_EMAIL" ] || { echo "ASSISTANT_EMAIL missing from .env"; exit 1; }
case "$ASSISTANT_EMAIL" in
  *@example.com|*@example.org)
    echo "ASSISTANT_EMAIL is still the placeholder ($ASSISTANT_EMAIL); set it to the assistant's own Google account in .env"
    exit 1
    ;;
esac
[ -n "$OWNER_EMAIL" ] || { echo "OWNER_EMAIL missing from .env"; exit 1; }

# Stable generated secrets (persisted in .env on first run)
AUTH_SECRET="$(envval PROD_AUTH_SECRET)"
if [ -z "$AUTH_SECRET" ]; then
  AUTH_SECRET="$(openssl rand -base64 32)"
  printf 'PROD_AUTH_SECRET=%s\n' "$AUTH_SECRET" >> "$ENV_FILE"
fi
MOBILE_API_TOKEN="$(envval MOBILE_API_TOKEN)"
if [ -z "$MOBILE_API_TOKEN" ]; then
  MOBILE_API_TOKEN="$(openssl rand -hex 32)"
  printf 'MOBILE_API_TOKEN=%s\n' "$MOBILE_API_TOKEN" >> "$ENV_FILE"
fi
PROFILE_ENC_KEY="$(envval PROD_PROFILE_ENC_KEY)"
if [ -z "$PROFILE_ENC_KEY" ]; then
  PROFILE_ENC_KEY="$(openssl rand -hex 32)"
  printf 'PROD_PROFILE_ENC_KEY=%s\n' "$PROFILE_ENC_KEY" >> "$ENV_FILE"
fi
MCP_ENC_KEY="$(envval PROD_MCP_ENC_KEY)"
if [ -z "$MCP_ENC_KEY" ]; then
  MCP_ENC_KEY="$(openssl rand -hex 32)"
  printf 'PROD_MCP_ENC_KEY=%s\n' "$MCP_ENC_KEY" >> "$ENV_FILE"
fi

# ── database schema (idempotent: drizzle journal skips applied migrations; seed upserts) ──
echo "── migrating prod database"
DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @assistant/db migrate
DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @assistant/db seed

gcloud config set project "$PROJECT" --quiet

echo "── enabling APIs"
gcloud services enable run.googleapis.com cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com pubsub.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com --quiet

# APIs the enabled modules declare (for example Workspace APIs for google).
# Enabling is idempotent and additive, so this is safe to re-run.
if [ -n "${PLAN_GCP_APIS:-}" ]; then
  echo "── enabling module APIs: ${PLAN_GCP_APIS}"
  # shellcheck disable=SC2086 # deliberate word splitting: a space-separated API list
  gcloud services enable $PLAN_GCP_APIS --quiet
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
LEGACY_RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
WEB_SA="assistant-web@${PROJECT}.iam.gserviceaccount.com"
AGENT_SA="assistant-agent@${PROJECT}.iam.gserviceaccount.com"
BROWSER_SA="assistant-browser@${PROJECT}.iam.gserviceaccount.com"
CODE_SA="assistant-code@${PROJECT}.iam.gserviceaccount.com"
PROCESSOR_SA="assistant-processor@${PROJECT}.iam.gserviceaccount.com"
INTERNAL_INVOKER_SA="assistant-internal-invoker@${PROJECT}.iam.gserviceaccount.com"
GMAIL_PUSH_SA="assistant-gmail-push@${PROJECT}.iam.gserviceaccount.com"
CLOUD_TASKS_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
SCHEDULER_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
PUBSUB_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

ensure_service_account() {
  local id="$1" display_name="$2"
  gcloud iam service-accounts describe "${id}@${PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$id" --display-name="$display_name" --quiet
}

grant_service_account_role() {
  local target="$1" member="$2" role="$3"
  gcloud iam service-accounts add-iam-policy-binding "$target" \
    --member="serviceAccount:${member}" --role="$role" --quiet >/dev/null
}

# --condition=None is required, not optional: this script also installs
# condition-scoped bindings (browser objects, traces), and gcloud refuses to add
# an unconditional binding to a policy containing conditions in non-interactive
# mode unless the empty condition is stated explicitly. Without it every run
# after the first aborts here.
grant_bucket_role() {
  local bucket="$1" member="$2" role="$3"
  gcloud storage buckets add-iam-policy-binding "gs://${bucket}" \
    --member="serviceAccount:${member}" --role="$role" --condition=None --quiet >/dev/null
}

echo "── service accounts"
# Force creation of the Google-managed identities before binding them below.
for managed_service in cloudtasks.googleapis.com cloudscheduler.googleapis.com pubsub.googleapis.com; do
  gcloud beta services identity create --service="$managed_service" --project="$PROJECT" \
    --quiet >/dev/null
done
ensure_service_account assistant-web "Assistant web runtime"
ensure_service_account assistant-agent "Assistant agent runtime"
if module_enabled browser; then
  ensure_service_account assistant-browser "Assistant sandboxed browser runtime"
fi
if module_enabled code; then
  ensure_service_account assistant-code "Assistant sandboxed code runtime"
fi
if module_enabled documents; then
  ensure_service_account assistant-processor "Assistant sandboxed document processor runtime"
fi
ensure_service_account assistant-internal-invoker "Assistant internal OIDC invoker"
ensure_service_account assistant-gmail-push "Assistant Gmail Pub/Sub push identity"

# Cloud Tasks callers may request only an ID token for the unprivileged internal
# invoker identity. Google-managed service agents mint the actual signed tokens.
grant_service_account_role "$INTERNAL_INVOKER_SA" "$WEB_SA" roles/iam.serviceAccountUser
grant_service_account_role "$INTERNAL_INVOKER_SA" "$AGENT_SA" roles/iam.serviceAccountUser
grant_service_account_role \
  "$INTERNAL_INVOKER_SA" "$CLOUD_TASKS_SERVICE_AGENT" roles/iam.serviceAccountOpenIdTokenCreator
grant_service_account_role \
  "$INTERNAL_INVOKER_SA" "$SCHEDULER_SERVICE_AGENT" roles/iam.serviceAccountOpenIdTokenCreator
grant_service_account_role \
  "$GMAIL_PUSH_SA" "$PUBSUB_SERVICE_AGENT" roles/iam.serviceAccountOpenIdTokenCreator

echo "── artifact registry"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" --location="$REGION" --repository-format=docker --quiet

echo "── workspace bucket"
BUCKET="${PROJECT}-workspace"
gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1 ||
  gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --quiet
# Object versioning: a bad overwrite (bot code or a compromised worker) keeps a
# recoverable prior generation of imports, profiles, and documents. Idempotent.
gcloud storage buckets update "gs://${BUCKET}" --versioning --quiet

# Runtimes can access objects, not bucket IAM/configuration. The browser job
# gets the same object-level access only because profiles live in this bucket.
grant_bucket_role "$BUCKET" "$WEB_SA" roles/storage.objectUser
grant_bucket_role "$BUCKET" "$AGENT_SA" roles/storage.objectUser
if module_enabled browser; then
  # A compromised browser process can reach only its encrypted profile and
  # screenshots, never imports, memories, or other Workspace objects.
  gcloud storage buckets remove-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${BROWSER_SA}" --role=roles/storage.objectUser --condition=None \
    --quiet >/dev/null 2>&1 || true
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${BROWSER_SA}" --role=roles/storage.objectUser \
    --condition="expression=resource.name.startsWith(\"projects/_/buckets/${BUCKET}/objects/workspace/${ASSISTANT_WORKSPACE_ID}/browser/\"),title=browser-objects-only,description=Browser profile and screenshots only" \
    --quiet >/dev/null
fi
# The code job may create objects only under its own per-task output prefix,
# never read imports, memories, or other Workspace objects.
if module_enabled code; then
  gcloud storage buckets remove-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${CODE_SA}" --role=roles/storage.objectCreator --condition=None \
    --quiet >/dev/null 2>&1 || true
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${CODE_SA}" --role=roles/storage.objectCreator \
    --condition="expression=resource.name.startsWith(\"projects/_/buckets/${BUCKET}/objects/workspace/${ASSISTANT_WORKSPACE_ID}/code/\"),title=code-outputs-only,description=Code job outputs only" \
    --quiet >/dev/null
fi
# The document processor may read source bytes and write extracted text only
# under the documents/ prefix — never memories, imports, or other objects.
if module_enabled documents; then
  gcloud storage buckets remove-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${PROCESSOR_SA}" --role=roles/storage.objectUser --condition=None \
    --quiet >/dev/null 2>&1 || true
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${PROCESSOR_SA}" --role=roles/storage.objectUser \
    --condition="expression=resource.name.startsWith(\"projects/_/buckets/${BUCKET}/objects/workspace/${ASSISTANT_WORKSPACE_ID}/documents/\"),title=document-objects-only,description=Document source bytes and extracted text only" \
    --quiet >/dev/null
fi
# Remove the broad binding installed by older deploys that used the Compute SA.
gcloud storage buckets remove-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${LEGACY_RUNTIME_SA}" --role=roles/storage.objectAdmin \
  --quiet >/dev/null 2>&1 || true

echo "── traces bucket (30-day lifecycle)"
TRACES_BUCKET="${PROJECT}-traces"
if ! gcloud storage buckets describe "gs://${TRACES_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${TRACES_BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --quiet
  printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}' > /tmp/traces-lifecycle.json
  gcloud storage buckets update "gs://${TRACES_BUCKET}" --lifecycle-file=/tmp/traces-lifecycle.json --quiet
fi
if module_enabled browser; then
  gcloud storage buckets remove-iam-policy-binding "gs://${TRACES_BUCKET}" \
    --member="serviceAccount:${BROWSER_SA}" --role=roles/storage.objectCreator --condition=None \
    --quiet >/dev/null 2>&1 || true
  gcloud storage buckets add-iam-policy-binding "gs://${TRACES_BUCKET}" \
    --member="serviceAccount:${BROWSER_SA}" --role=roles/storage.objectCreator \
    --condition="expression=resource.name.startsWith(\"projects/_/buckets/${TRACES_BUCKET}/objects/${ASSISTANT_WORKSPACE_ID}/traces/\"),title=browser-traces-only,description=Browser trace uploads only" \
    --quiet >/dev/null
fi
gcloud storage buckets remove-iam-policy-binding "gs://${TRACES_BUCKET}" \
  --member="serviceAccount:${LEGACY_RUNTIME_SA}" --role=roles/storage.objectAdmin \
  --quiet >/dev/null 2>&1 || true

echo "── secrets"
make_secret() {
  local name="$1" value="$2"
  [ -n "$value" ] || { echo "   (skipping $name — empty)"; return 0; }
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --quiet >/dev/null
  else
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- --quiet >/dev/null
  fi
}

grant_secret() {
  local name="$1" member="$2"
  gcloud secrets describe "$name" >/dev/null 2>&1 || return 0
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${member}" --role=roles/secretmanager.secretAccessor \
    --quiet >/dev/null
}

revoke_legacy_secret_access() {
  local name="$1"
  gcloud secrets describe "$name" >/dev/null 2>&1 || return 0
  gcloud secrets remove-iam-policy-binding "$name" \
    --member="serviceAccount:${LEGACY_RUNTIME_SA}" --role=roles/secretmanager.secretAccessor \
    --quiet >/dev/null 2>&1 || true
}

make_secret database-url "$PROD_DATABASE_URL"
make_secret openrouter-api-key "$OPENROUTER_API_KEY"
make_secret google-oauth-client-id "$GOOGLE_OAUTH_CLIENT_ID"
make_secret google-oauth-client-secret "$GOOGLE_OAUTH_CLIENT_SECRET"
make_secret bot-google-refresh-token "$BOT_GOOGLE_REFRESH_TOKEN"
make_secret auth-secret "$AUTH_SECRET"
make_secret mobile-api-token "$MOBILE_API_TOKEN"
make_secret twilio-auth-token "$TWILIO_AUTH_TOKEN"
make_secret profile-enc-key "$PROFILE_ENC_KEY"
make_secret mcp-enc-key "$MCP_ENC_KEY"
make_secret search-api-key "$SEARCH_API_KEY"
make_secret github-token "$GITHUB_TOKEN"
make_secret apns-private-key "$APNS_PRIVATE_KEY"
make_secret mapkit-private-key "$MAPKIT_PRIVATE_KEY"

# Explicit per-runtime secret grants. In particular, the browser can read only
# its profile key and never receives database, model, OAuth, or Twilio secrets.
for secret in database-url openrouter-api-key google-oauth-client-id google-oauth-client-secret; do
  grant_secret "$secret" "$AGENT_SA"
done
grant_secret bot-google-refresh-token "$AGENT_SA"
grant_secret twilio-auth-token "$AGENT_SA"
grant_secret search-api-key "$AGENT_SA"
grant_secret github-token "$AGENT_SA"
grant_secret apns-private-key "$AGENT_SA"
grant_secret mapkit-private-key "$AGENT_SA"
grant_secret mcp-enc-key "$AGENT_SA"
for secret in database-url openrouter-api-key google-oauth-client-id google-oauth-client-secret auth-secret mobile-api-token; do
  grant_secret "$secret" "$WEB_SA"
done
# The owner settings page may rotate only the mobile credential.
gcloud secrets add-iam-policy-binding mobile-api-token --project "$PROJECT" \
  --member "serviceAccount:${WEB_SA}" --role roles/secretmanager.secretVersionAdder --quiet
grant_secret mcp-enc-key "$WEB_SA"
if module_enabled browser; then
  grant_secret profile-enc-key "$BROWSER_SA"
fi
for secret in database-url openrouter-api-key google-oauth-client-id google-oauth-client-secret \
  bot-google-refresh-token internal-api-secret auth-secret twilio-auth-token profile-enc-key mcp-enc-key \
  search-api-key github-token mobile-api-token apns-private-key mapkit-private-key; do
  revoke_legacy_secret_access "$secret"
done

if [ "${SKIP_BUILD:-}" = "1" ]; then
  echo "── skipping image build (SKIP_BUILD=1) — reusing the :latest images already in Artifact Registry"
else
  echo "── building images (Cloud Build)"
  gcloud builds submit --config=infra/gcp/cloudbuild.yaml \
    --substitutions="_REGION=${REGION},_REPO=${REPO}" --quiet .
fi

echo "── deploying agent service"
# Cloud Run's default URL is deterministic from service name, project number,
# and region. Put it on the first revision so Cloud Tasks/OIDC configuration
# passes production validation before the service exists. The describe below
# reconciles with Cloud Run's actual URL after creation; errors there remain
# fatal instead of being interpreted as an absent service.
SELF_URL="https://assistant-agent-${PROJECT_NUMBER}.${REGION}.run.app"
SELF_URL_ENV="|AGENT_URL=${SELF_URL}|PUBLIC_URL=${SELF_URL}|INTERNAL_OIDC_AUDIENCE=${SELF_URL}"
TWILIO_ENV=""
AGENT_SECRETS="DATABASE_URL=database-url:latest,OPENROUTER_API_KEY=openrouter-api-key:latest,GOOGLE_OAUTH_CLIENT_ID=google-oauth-client-id:latest,GOOGLE_OAUTH_CLIENT_SECRET=google-oauth-client-secret:latest,BOT_GOOGLE_REFRESH_TOKEN=bot-google-refresh-token:latest,MCP_ENC_KEY=mcp-enc-key:latest"
if [ -n "$TWILIO_ACCOUNT_SID" ] && [ -n "$TWILIO_AUTH_TOKEN" ]; then
  TWILIO_ENV="|TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}|TWILIO_FROM_NUMBER=${TWILIO_FROM_NUMBER}|OWNER_PHONE=${OWNER_PHONE}"
  TWILIO_VOICE_FROM_NUMBER="$(envval TWILIO_VOICE_FROM_NUMBER)"
  [ -n "$TWILIO_VOICE_FROM_NUMBER" ] && TWILIO_ENV="${TWILIO_ENV}|TWILIO_VOICE_FROM_NUMBER=${TWILIO_VOICE_FROM_NUMBER}"
  AGENT_SECRETS="${AGENT_SECRETS},TWILIO_AUTH_TOKEN=twilio-auth-token:latest"
fi
# Phone calls: dashboard links in check-ins, and Vertex for Gemini Live voice.
# `pnpm setup:phone` sets these on the live services; mirror them in .env so a
# full redeploy (which replaces every variable) keeps them.
VOICE_ENV=""
for pair in \
  "WEB_URL=$(envval WEB_URL)" \
  "VERTEX_PROJECT=$(envval VERTEX_PROJECT)" \
  "VERTEX_LOCATION=$(envval VERTEX_LOCATION)" \
  "CALL_ALLOWED_COUNTRY_CODES=$(envval CALL_ALLOWED_COUNTRY_CODES)" \
  "CALL_DAILY_LIMIT=$(envval CALL_DAILY_LIMIT)" \
  "CALL_MAX_MINUTES=$(envval CALL_MAX_MINUTES)"; do
  case "$pair" in *=) ;; *) VOICE_ENV="${VOICE_ENV}|${pair}" ;; esac
done
SEARCH_ENV="|SEARCH_PROVIDER=${SEARCH_PROVIDER}"
if [ -n "$SEARCH_API_KEY" ]; then
  AGENT_SECRETS="${AGENT_SECRETS},SEARCH_API_KEY=search-api-key:latest"
fi
GITHUB_ENV=""
if [ -n "$GITHUB_REPO" ]; then
  GITHUB_ENV="|GITHUB_REPO=${GITHUB_REPO}"
fi
if [ -n "$GITHUB_TOKEN" ]; then
  AGENT_SECRETS="${AGENT_SECRETS},GITHUB_TOKEN=github-token:latest"
fi
if [ -n "$APNS_PRIVATE_KEY" ]; then
  AGENT_SECRETS="${AGENT_SECRETS},APNS_PRIVATE_KEY=apns-private-key:latest"
fi
# The web service signs route map images, so it needs the same Apple key the
# agent routes with: the MapKit key when set, otherwise the APNs one.
MAPS_ENV=""
WEB_MAPS_ENV=""
WEB_MAPS_SECRETS=""
if module_enabled maps; then
  if [ -n "$MAPKIT_PRIVATE_KEY" ]; then
    MAPS_ENV="|MAPKIT_KEY_ID=${MAPKIT_KEY_ID}|MAPKIT_TEAM_ID=${MAPKIT_TEAM_ID}"
    AGENT_SECRETS="${AGENT_SECRETS},MAPKIT_PRIVATE_KEY=mapkit-private-key:latest"
    WEB_MAPS_ENV="$MAPS_ENV"
    WEB_MAPS_SECRETS=",MAPKIT_PRIVATE_KEY=mapkit-private-key:latest"
    grant_secret mapkit-private-key "$WEB_SA"
  elif [ -n "$APNS_PRIVATE_KEY" ]; then
    WEB_MAPS_ENV="|APNS_KEY_ID=${APNS_KEY_ID}|APNS_TEAM_ID=${APNS_TEAM_ID}"
    WEB_MAPS_SECRETS=",APNS_PRIVATE_KEY=apns-private-key:latest"
    grant_secret apns-private-key "$WEB_SA"
  fi
fi
CANARY_VALUE="$(envval CANARY_ENABLED)"
if [ -z "$CANARY_VALUE" ]; then
  if module_enabled google && module_enabled browser; then
    CANARY_VALUE=true
  else
    CANARY_VALUE=false
  fi
fi
CHAT_RECALL_VALUE="$(envval CHAT_RECALL_ENABLED)"
CHAT_RECALL_VALUE="${CHAT_RECALL_VALUE:-true}"
# ── mail ingest ──────────────────────────────────────────────────────────────
# These decide whether the assistant reads the owner's mail at all, and they
# were unreachable in production until now: `--set-env-vars` REPLACES the whole
# environment, so a setting this script does not name cannot be set — a console
# edit survives only until the next provisioning run, which silently wipes it.
#
# EMAIL_INGEST_MODE is the one that bites. It defaults to `direct`, which is for
# people writing TO the assistant. An owner who points a forwarding rule at this
# mailbox and leaves the default has their mail dropped as unauthenticated
# (forwarding breaks SPF alignment) or as automated — exactly the confirmations
# and invoices carrying the dates. Nothing errors; the inbox ledger just stays
# empty, and with it the importance alerts, the briefing's highlights and the
# pulse's mail moments.
#
# Each is forwarded only when set, so an unset value keeps the schema default
# rather than pinning it here where it would drift from @assistant/config.
MAIL_ENV=""
mail_env_add() {
  local value
  value="$(envval "$1")"
  [ -n "$value" ] && MAIL_ENV="${MAIL_ENV}|$1=${value}"
  return 0
}
mail_env_add EMAIL_INGEST_MODE
mail_env_add EMAIL_INGEST_IMPORTANCE_THRESHOLD
mail_env_add EMAIL_INGEST_NOTIFY_THRESHOLD
mail_env_add EMAIL_INGEST_MAX_TRIAGE_PER_DAY
mail_env_add EMAIL_OUTBOUND_DOMAINS
mail_env_add GMAIL_SYNC_ENABLED

# This rollout flag belongs to the agent's observer sweep only. Keep it out of
# MAIL_ENV because that fragment is also used by the web service.
# shellcheck source=infra/gcp/email-observer-worker-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/email-observer-worker-env.sh"
EMAIL_OBSERVER_WORKER_ENV="$(email_observer_worker_env)"

# ── model output review ──────────────────────────────────────────────────────
# The same trap as the mail settings above, for the same reason. Capture is what
# makes any question about answer quality answerable from production at all, and
# a console edit enabling it would survive only until the next provisioning run.
#
# Both services need it: the agent runs task execution and the retention sweep,
# and the web service runs the streaming chat reply — capturing one and not the
# other would silently under-report the busiest surface there is.
#
# Forwarded only when set, so an unset value keeps the schema default (off)
# rather than pinning it here where it would drift from @assistant/config.
AUDIT_ENV=""
audit_env_add() {
  local value
  value="$(envval "$1")"
  [ -n "$value" ] && AUDIT_ENV="${AUDIT_ENV}|$1=${value}"
  return 0
}
audit_env_add LLM_AUDIT_CAPTURE
audit_env_add LLM_AUDIT_RETENTION_DAYS

GMAIL_TOPIC_VALUE=""
GMAIL_PUSH_IDENTITY=""
if module_enabled google; then
  GMAIL_TOPIC_VALUE="projects/${PROJECT}/topics/${TOPIC}"
  GMAIL_PUSH_IDENTITY="$GMAIL_PUSH_SA"
fi
gcloud run deploy assistant-agent \
  --image "${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/agent:latest" \
  --region "$REGION" --allow-unauthenticated --service-account "$AGENT_SA" \
  --memory 1Gi --cpu 1 --min-instances 0 --max-instances 3 --concurrency 4 --timeout 3600 \
  --cpu-boost \
  --set-env-vars "^|^ASSISTANT_NAME=${ASSISTANT_NAME}|ASSISTANT_EMAIL=${ASSISTANT_EMAIL}|ASSISTANT_WORKSPACE_ID=${ASSISTANT_WORKSPACE_ID}|ASSISTANT_TIMEZONE=${ASSISTANT_TIMEZONE}|ASSISTANT_LOCALE=${ASSISTANT_LOCALE}|ASSISTANT_MODULES=${PLAN_MODULES}|ASSISTANT_RELEASE_API_CONTRACT=1|ASSISTANT_RELEASE_WEB_API_MIN=1|ASSISTANT_RELEASE_WEB_API_MAX=1|ASSISTANT_RELEASE_SCHEMA_DRIVER=postgres|ASSISTANT_RELEASE_SCHEMA_MIN=${POSTGRES_AGENT_SCHEMA_MIN}|ASSISTANT_RELEASE_SCHEMA_MAX=${POSTGRES_AGENT_SCHEMA_MAX}|ASSISTANT_RELEASE_SCHEMA_VERSION=${POSTGRES_SCHEMA_VERSION}|QUEUE_DRIVER=cloudtasks|FILES_DRIVER=gcs|WORKSPACE_BUCKET=${PROJECT}-workspace|GCP_PROJECT=${PROJECT}|GCP_LOCATION=${REGION}|CLOUD_TASKS_QUEUE=${QUEUE}|OWNER_NAME=${OWNER_NAME}|OWNER_EMAIL=${OWNER_EMAIL}|GMAIL_PUBSUB_TOPIC=${GMAIL_TOPIC_VALUE}|GMAIL_PUSH_SERVICE_ACCOUNT=${GMAIL_PUSH_IDENTITY}|APNS_KEY_ID=${APNS_KEY_ID}|APNS_TEAM_ID=${APNS_TEAM_ID}|APNS_BUNDLE_ID=${APNS_BUNDLE_ID}|INTERNAL_AUTH_MODE=oidc|INTERNAL_OIDC_SERVICE_ACCOUNT=${INTERNAL_INVOKER_SA}|BROWSER_DRIVER=cloudrun|BROWSER_JOB_NAME=assistant-browser|CODE_DRIVER=cloudrun|CODE_JOB_NAME=assistant-code|PROCESSOR_DRIVER=cloudrun|PROCESSOR_JOB_NAME=assistant-processor|MOBILE_API_TOKEN_SECRET_NAME=mobile-api-token|MOBILE_API_TOKEN_ROTATION_ENABLED=true|TRACES_BUCKET=${TRACES_BUCKET}|CANARY_ENABLED=${CANARY_VALUE}|CANARY_MAX_COST_USD=0.03|CHAT_RECALL_ENABLED=${CHAT_RECALL_VALUE}|OTEL_EXPORTER=none${SEARCH_ENV}${GITHUB_ENV}${TWILIO_ENV}${MAIL_ENV}${EMAIL_OBSERVER_WORKER_ENV}${AUDIT_ENV}${SELF_URL_ENV}${MAPS_ENV}${VOICE_ENV}" \
  --set-secrets "$AGENT_SECRETS" \
  --quiet

AGENT_URL="$(gcloud run services describe assistant-agent --region "$REGION" --format='value(status.url)')"
echo "   agent: $AGENT_URL"

# second pass: the service needs to know its own URL (Cloud Tasks callbacks, Pub/Sub aud)
gcloud run services update assistant-agent --region "$REGION" \
  --update-env-vars "AGENT_URL=${AGENT_URL},PUBLIC_URL=${AGENT_URL},INTERNAL_OIDC_AUDIENCE=${AGENT_URL}" --quiet

if module_enabled browser; then
  echo "── browser job (Cloud Run Job — no DB creds)"
  BROWSER_IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/browser:latest"
  if gcloud run jobs describe assistant-browser --region "$REGION" >/dev/null 2>&1; then
    gcloud run jobs update assistant-browser --region "$REGION" \
      --image "$BROWSER_IMAGE" --service-account "$BROWSER_SA" \
      --memory 2Gi --cpu 2 --task-timeout 900 --max-retries 0 \
      --set-secrets "PROFILE_ENC_KEY=profile-enc-key:latest" --quiet
  else
    gcloud run jobs create assistant-browser --region "$REGION" \
      --image "$BROWSER_IMAGE" --service-account "$BROWSER_SA" \
      --memory 2Gi --cpu 2 --task-timeout 900 --max-retries 0 \
      --set-secrets "PROFILE_ENC_KEY=profile-enc-key:latest" --quiet
  fi
  gcloud run jobs add-iam-policy-binding assistant-browser --region "$REGION" \
    --member="serviceAccount:${AGENT_SA}" --role="roles/run.jobsExecutorWithOverrides" --quiet >/dev/null
  gcloud run jobs remove-iam-policy-binding assistant-browser --region "$REGION" \
    --member="serviceAccount:${LEGACY_RUNTIME_SA}" --role="roles/run.jobsExecutorWithOverrides" \
    --quiet >/dev/null 2>&1 || true
fi

if module_enabled code; then
  echo "── code job (Cloud Run Job — no DB creds, no secrets)"
  CODE_IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/code:latest"
  if gcloud run jobs describe assistant-code --region "$REGION" >/dev/null 2>&1; then
    gcloud beta run jobs update assistant-code --region "$REGION" \
      --image "$CODE_IMAGE" --service-account "$CODE_SA" \
      --memory 1Gi --cpu 1 --task-timeout 900 --max-retries 0 --sandbox-launcher --quiet
  else
    gcloud beta run jobs create assistant-code --region "$REGION" \
      --image "$CODE_IMAGE" --service-account "$CODE_SA" \
      --memory 1Gi --cpu 1 --task-timeout 900 --max-retries 0 --sandbox-launcher --quiet
  fi
  gcloud run jobs add-iam-policy-binding assistant-code --region "$REGION" \
    --member="serviceAccount:${AGENT_SA}" --role="roles/run.jobsExecutorWithOverrides" --quiet >/dev/null
fi

if module_enabled documents; then
  echo "── document-processor job (Cloud Run Job — no DB creds, no secrets)"
  PROCESSOR_IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/processor:latest"
  if gcloud run jobs describe assistant-processor --region "$REGION" >/dev/null 2>&1; then
    gcloud run jobs update assistant-processor --region "$REGION" \
      --image "$PROCESSOR_IMAGE" --service-account "$PROCESSOR_SA" \
      --memory 2Gi --cpu 1 --task-timeout 600 --max-retries 0 --quiet
  else
    gcloud run jobs create assistant-processor --region "$REGION" \
      --image "$PROCESSOR_IMAGE" --service-account "$PROCESSOR_SA" \
      --memory 2Gi --cpu 1 --task-timeout 600 --max-retries 0 --quiet
  fi
  gcloud run jobs add-iam-policy-binding assistant-processor --region "$REGION" \
    --member="serviceAccount:${AGENT_SA}" --role="roles/run.jobsExecutorWithOverrides" --quiet >/dev/null
fi

echo "── cloud tasks queue"
if gcloud tasks queues describe "$QUEUE" --location="$REGION" >/dev/null 2>&1; then
  gcloud tasks queues update "$QUEUE" --location="$REGION" \
    --max-dispatches-per-second=5 --max-concurrent-dispatches=8 \
    --max-attempts=8 --min-backoff=10s --quiet
else
  gcloud tasks queues create "$QUEUE" --location="$REGION" \
    --max-dispatches-per-second=5 --max-concurrent-dispatches=8 \
    --max-attempts=8 --min-backoff=10s --quiet
fi
for runtime_sa in "$WEB_SA" "$AGENT_SA"; do
  gcloud tasks queues add-iam-policy-binding "$QUEUE" --location="$REGION" \
    --member="serviceAccount:${runtime_sa}" --role=roles/cloudtasks.enqueuer \
    --quiet >/dev/null
done

echo "── scheduler jobs"
make_job() {
  local name="$1" schedule="$2" path="$3"
  if gcloud scheduler jobs describe "$name" --location="$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$name" --location="$REGION" --schedule="$schedule" \
      --uri="${AGENT_URL}${path}" --http-method=POST \
      --attempt-deadline=300s --max-retry-attempts=0 \
      --clear-headers --oidc-service-account-email="$INTERNAL_INVOKER_SA" \
      --oidc-token-audience="${AGENT_URL}${path}" --quiet
  else
    gcloud scheduler jobs create http "$name" --location="$REGION" --schedule="$schedule" \
      --uri="${AGENT_URL}${path}" --http-method=POST \
      --attempt-deadline=300s --max-retry-attempts=0 \
      --oidc-service-account-email="$INTERNAL_INVOKER_SA" \
      --oidc-token-audience="${AGENT_URL}${path}" --quiet
  fi
}
make_job assistant-sweep "* * * * *" "/internal/sweep"
# Module-owned schedules come from the plan, so a module declares its cron once
# in metadata rather than here as well. The value is read as quoted lines: cron
# expressions contain spaces and `*`, which unquoted word splitting would glob.
while IFS='|' read -r job_name job_schedule job_path; do
  [ -n "$job_name" ] || continue
  make_job "$job_name" "$job_schedule" "$job_path"
done <<<"${PLAN_SCHEDULER_JOBS:-}"
if [ "$CANARY_VALUE" = "true" ]; then
  make_job assistant-canaries "17 15 * * *" "/internal/canaries/run"
  make_job assistant-canary-health "30 * * * *" "/internal/canaries/health"
fi

if module_enabled google; then
  echo "── pub/sub (gmail push)"
  gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1 ||
    gcloud pubsub topics create "$TOPIC" --quiet
  gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
    --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
    --role="roles/pubsub.publisher" --quiet >/dev/null
  if gcloud pubsub subscriptions describe gmail-events-push >/dev/null 2>&1; then
    gcloud pubsub subscriptions update gmail-events-push \
      --push-endpoint="${AGENT_URL}/webhooks/gmail/pubsub" \
      --push-auth-service-account="$GMAIL_PUSH_SA" \
      --push-auth-token-audience="${AGENT_URL}/webhooks/gmail/pubsub" \
      --ack-deadline=600 --quiet
  else
    gcloud pubsub subscriptions create gmail-events-push --topic="$TOPIC" \
      --push-endpoint="${AGENT_URL}/webhooks/gmail/pubsub" \
      --push-auth-service-account="$GMAIL_PUSH_SA" \
      --push-auth-token-audience="${AGENT_URL}/webhooks/gmail/pubsub" \
      --ack-deadline=600 --quiet
  fi
else
  echo "── pub/sub skipped (google module disabled)"
fi

BILLING_ENV=""
for name in GCP_BILLING_EXPORT_TABLE GCP_BILLING_QUERY_PROJECT GCP_BILLING_LOCATION GCP_BILLING_SCOPE GCP_BILLING_MAX_BYTES; do
  value="${!name:-$(envval "$name")}"
  [ -n "$value" ] && BILLING_ENV="${BILLING_ENV}|${name}=${value}"
done

# The Settings "Noticing" card reports which ingest mode is live, and it reads
# the web service's own config. Without this the card would confidently print
# `direct` while the agent ran `forwarded` — a diagnostic that lies is worse
# than no diagnostic, since this one exists precisely to explain silence.
WEB_MAIL_ENV=""
WEB_INGEST_MODE="$(envval EMAIL_INGEST_MODE)"
[ -n "$WEB_INGEST_MODE" ] && WEB_MAIL_ENV="|EMAIL_INGEST_MODE=${WEB_INGEST_MODE}"

echo "── deploying web service"
gcloud run deploy assistant-web \
  --image "${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/web:latest" \
  --region "$REGION" --allow-unauthenticated --service-account "$WEB_SA" \
  --memory 1Gi --cpu 1 --min-instances 1 --max-instances 2 --timeout 300 \
  --cpu-boost \
  --set-env-vars "^|^ASSISTANT_NAME=${ASSISTANT_NAME}|ASSISTANT_EMAIL=${ASSISTANT_EMAIL}|ASSISTANT_WORKSPACE_ID=${ASSISTANT_WORKSPACE_ID}|ASSISTANT_TIMEZONE=${ASSISTANT_TIMEZONE}|ASSISTANT_LOCALE=${ASSISTANT_LOCALE}|ASSISTANT_MODULES=${PLAN_MODULES}|QUEUE_DRIVER=cloudtasks|FILES_DRIVER=gcs|WORKSPACE_BUCKET=${PROJECT}-workspace|GCP_PROJECT=${PROJECT}|GCP_LOCATION=${REGION}|CLOUD_TASKS_QUEUE=${QUEUE}|OWNER_NAME=${OWNER_NAME}|OWNER_EMAIL=${OWNER_EMAIL}|AUTH_TRUST_HOST=true|AUTH_DEV_BYPASS=false|INTERNAL_AUTH_MODE=oidc|INTERNAL_OIDC_SERVICE_ACCOUNT=${INTERNAL_INVOKER_SA}|CHAT_RECALL_ENABLED=${CHAT_RECALL_VALUE}|OTEL_EXPORTER=none${WEB_MAIL_ENV}${AUDIT_ENV}${WEB_MAPS_ENV}${BILLING_ENV}" \
  --set-secrets "DATABASE_URL=database-url:latest,OPENROUTER_API_KEY=openrouter-api-key:latest,AUTH_SECRET=auth-secret:latest,AUTH_GOOGLE_ID=google-oauth-client-id:latest,AUTH_GOOGLE_SECRET=google-oauth-client-secret:latest,MOBILE_API_TOKEN=mobile-api-token:latest,MCP_ENC_KEY=mcp-enc-key:latest${WEB_MAPS_SECRETS}" \
  --quiet

WEB_URL="$(gcloud run services describe assistant-web --region "$REGION" --format='value(status.url)')"
AUTH_URL="${WEB_URL}"
if [ -n "$WEB_DOMAIN" ]; then
  AUTH_URL="https://${WEB_DOMAIN}"
  gcloud beta run domain-mappings describe --domain "$WEB_DOMAIN" --region "$REGION" >/dev/null 2>&1 ||
    gcloud beta run domain-mappings create --service assistant-web --domain "$WEB_DOMAIN" --region "$REGION" --quiet
fi
gcloud run services update assistant-web --region "$REGION" \
  --update-env-vars "AGENT_URL=${AGENT_URL},PUBLIC_URL=${AGENT_URL},INTERNAL_OIDC_AUDIENCE=${AGENT_URL},AUTH_URL=${AUTH_URL},ASSISTANT_RELEASE_API_CONTRACT=1,ASSISTANT_RELEASE_AGENT_API_MIN=1,ASSISTANT_RELEASE_AGENT_API_MAX=1,ASSISTANT_RELEASE_SCHEMA_DRIVER=postgres,ASSISTANT_RELEASE_SCHEMA_MIN=${POSTGRES_WEB_SCHEMA_MIN},ASSISTANT_RELEASE_SCHEMA_MAX=${POSTGRES_WEB_SCHEMA_MAX},ASSISTANT_RELEASE_SCHEMA_VERSION=${POSTGRES_SCHEMA_VERSION}" --quiet

echo "── monitoring (error-log metric + owner email alert)"
gcloud services enable monitoring.googleapis.com logging.googleapis.com --quiet

# One metric over every platform service and worker job: anything the code
# writes at error severity. The agent already routes real failures through
# console.error, so this is the honest "something needs a human" signal.
ERROR_LOG_FILTER='severity>=ERROR AND ((resource.type="cloud_run_revision" AND resource.labels.service_name=~"^assistant-") OR (resource.type="cloud_run_job" AND resource.labels.job_name=~"^assistant-"))'
if gcloud logging metrics describe assistant-error-logs >/dev/null 2>&1; then
  gcloud logging metrics update assistant-error-logs \
    --description="Error-severity log entries from assistant services and jobs" \
    --log-filter="$ERROR_LOG_FILTER" --quiet
else
  gcloud logging metrics create assistant-error-logs \
    --description="Error-severity log entries from assistant services and jobs" \
    --log-filter="$ERROR_LOG_FILTER" --quiet
fi

# Email channel to the owner, matched by display name so re-runs reuse it.
ALERT_CHANNEL="$(gcloud beta monitoring channels list \
  --filter='displayName="Assistant owner email"' --format='value(name)' 2>/dev/null | head -1)"
if [ -z "$ALERT_CHANNEL" ]; then
  ALERT_CHANNEL="$(gcloud beta monitoring channels create \
    --display-name="Assistant owner email" --type=email \
    --channel-labels="email_address=${OWNER_EMAIL}" --format='value(name)')"
fi

# Create-once alert policy: a burst of error logs emails the owner. Threshold
# tuning after that belongs in the console, so re-runs leave an existing
# policy (and any edits to it) alone.
if [ -z "$(gcloud alpha monitoring policies list \
  --filter='displayName="Assistant error burst"' --format='value(name)' 2>/dev/null | head -1)" ]; then
  ALERT_POLICY_FILE="$(mktemp)"
  cat >"$ALERT_POLICY_FILE" <<JSON
{
  "displayName": "Assistant error burst",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "More than 5 error logs across 5 minutes",
      "conditionThreshold": {
        "filter": "metric.type=\"logging.googleapis.com/user/assistant-error-logs\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_DELTA",
            "crossSeriesReducer": "REDUCE_SUM"
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 5,
        "duration": "0s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "notificationChannels": ["${ALERT_CHANNEL}"],
  "alertStrategy": { "autoClose": "86400s" }
}
JSON
  gcloud alpha monitoring policies create --policy-from-file="$ALERT_POLICY_FILE" --quiet
  rm -f "$ALERT_POLICY_FILE"
fi

echo ""
echo "══════════════════════════════════════════════════════"
echo " agent: ${AGENT_URL}"
echo " web:   ${WEB_URL}"
echo ""
# The checklist itself lives in @assistant/setup, which scopes it to the modules
# this installation composes and tracks which steps its settings already satisfy.
# Only the values that are not knowable until now are printed here.
echo " Values you need for the remaining manual steps:"
echo "   OAuth redirect URI:  ${AUTH_URL}/api/auth/callback/google"
if module_enabled sms; then
  echo "   Twilio SMS webhook:  ${AGENT_URL}/webhooks/twilio/sms"
fi
if [ -n "$WEB_DOMAIN" ]; then
  echo "   Domain to point:     ${WEB_DOMAIN}"
fi
echo ""
echo " For the full checklist:  pnpm setup:wizard --plan"
echo "══════════════════════════════════════════════════════"
