#!/usr/bin/env bash
# Offline tests for release-path selection, the deploy.sh Firestore guard, and
# the Firestore release. gcloud, pnpm, and curl are stubs; nothing leaves the
# machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/assistant-release-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/dispatch"

export GCP_PROJECT="test-project"
export GCP_REGION="test-region"
export STUB_CALLS="$TEST_ROOT/calls"
export STUB_WEB_PAUSED_FILE="$TEST_ROOT/web-paused"
export STUB_JOB_IMAGE_FILE="$TEST_ROOT/browser-image"
printf 'registry/old-browser' >"$STUB_JOB_IMAGE_FILE"
printf 'false' >"$STUB_WEB_PAUSED_FILE"

# ── stubs ────────────────────────────────────────────────────────────────────
cat >"$TEST_ROOT/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
set -u
printf 'gcloud %s\n' "$*" >>"$STUB_CALLS"
args="$*"

service_json() {
  local driver="$1" extra="${2:-}" env='[]' tag="${IMAGE_TAG:-abc123}"
  local names="AGENT_URL BROWSER_JOB_NAME CLOUD_TASKS_QUEUE CODE_JOB_NAME FIRESTORE_AGENT_ID FIRESTORE_EMBEDDING_SPACE GCP_LOCATION GCP_PROJECT GMAIL_PUBSUB_TOPIC GMAIL_PUSH_SERVICE_ACCOUNT INTERNAL_AUTH_MODE INTERNAL_OIDC_AUDIENCE INTERNAL_OIDC_SERVICE_ACCOUNT OWNER_EMAIL PROCESSOR_DRIVER PROCESSOR_JOB_NAME PUBLIC_URL QUEUE_DRIVER WORKSPACE_BUCKET"
  env="["
  for name in $names; do env="${env}{\"name\":\"${name}\",\"value\":\"x\"},"; done
  env="${env}{\"name\":\"ASSISTANT_MODULES\",\"value\":\"${STUB_MODULES:-google,browser}\"},"
  env="${env}{\"name\":\"FIRESTORE_DATABASE_ID\",\"value\":\"${STUB_DATABASE:-assistant-production}\"}"
  if [[ -n "$driver" ]]; then env="${env},{\"name\":\"PERSISTENCE_DRIVER\",\"value\":\"${driver}\"}"; fi
  if [[ -n "$extra" ]]; then env="${env},${extra}"; fi
  env="${env}]"
  if [[ "${STUB_RELEASE_METADATA:-present}" != "missing" ]]; then
  env="${env%]},{\"name\":\"ASSISTANT_RELEASE_API_CONTRACT\",\"value\":\"1\"},{\"name\":\"ASSISTANT_RELEASE_WEB_API_MIN\",\"value\":\"1\"},{\"name\":\"ASSISTANT_RELEASE_WEB_API_MAX\",\"value\":\"1\"},{\"name\":\"ASSISTANT_RELEASE_AGENT_API_MIN\",\"value\":\"1\"},{\"name\":\"ASSISTANT_RELEASE_AGENT_API_MAX\",\"value\":\"1\"},{\"name\":\"ASSISTANT_RELEASE_SCHEMA_DRIVER\",\"value\":\"firestore\"},{\"name\":\"ASSISTANT_RELEASE_SCHEMA_MIN\",\"value\":\"1\"},{\"name\":\"ASSISTANT_RELEASE_SCHEMA_MAX\",\"value\":\"1\"}]"
  fi
  printf '{"metadata":{"name":"svc"},"status":{"url":"https://%s.example","traffic":[{"revisionName":"%s-old","percent":100},{"revisionName":"%s-candidate","tag":"candidate-%s","url":"https://candidate-%s-%s.example","percent":0},{"revisionName":"%s-resume","tag":"resume-%s","url":"https://resume-%s-%s.example","percent":0}]},"spec":{"template":{"spec":{"containers":[{"env":%s}]}}}}\n' \
    "${SERVICE_NAME:-assistant-agent}" "${SERVICE_NAME:-assistant-agent}" "${SERVICE_NAME:-assistant-agent}" "$tag" "$tag" "${SERVICE_NAME:-assistant-agent}" "${SERVICE_NAME:-assistant-agent}" "$tag" "$tag" "${SERVICE_NAME:-assistant-agent}" "$env"
}

case "$args" in
  *'builds submit'*) ;;
  *'artifacts docker images describe'*)
    image="${*:5:1}"
    if [[ "$image" == */agent:* || "$image" == */agent@* ]]; then component=a; elif [[ "$image" == */web:* || "$image" == */web@* ]]; then component=b; else component=c; fi
    printf 'sha256:%064d\n' 0 | sed "s/0/${component}/g" ;;
  *'run services describe assistant-agent'*'value(metadata.name)'*)
    if [[ "${STUB_AGENT_DESCRIBE:-ok}" == "missing" ]]; then echo 'ERROR: Service [assistant-agent] could not be found.' >&2; exit 1; fi
    if [[ "${STUB_AGENT_DESCRIBE:-ok}" == "denied" ]]; then echo 'ERROR: PERMISSION_DENIED' >&2; exit 1; fi
    echo assistant-agent ;;
  *'run services describe assistant-agent'*'env[].name'*)
    echo 'AGENT_URL;BROWSER_JOB_NAME;CLOUD_TASKS_QUEUE;CODE_JOB_NAME;FIRESTORE_AGENT_ID;FIRESTORE_DATABASE_ID;FIRESTORE_EMBEDDING_SPACE;GCP_LOCATION;GCP_PROJECT;GMAIL_PUBSUB_TOPIC;GMAIL_PUSH_SERVICE_ACCOUNT;INTERNAL_AUTH_MODE;INTERNAL_OIDC_AUDIENCE;INTERNAL_OIDC_SERVICE_ACCOUNT;OWNER_EMAIL;PERSISTENCE_DRIVER;PROCESSOR_DRIVER;PROCESSOR_JOB_NAME;PUBLIC_URL;QUEUE_DRIVER;WORKSPACE_BUCKET' ;;
  *'run services describe'*'value(status.url)'*) echo 'https://svc.example' ;;
  *'run services describe assistant-agent'*'--format=json'*)
    SERVICE_NAME=assistant-agent service_json "${STUB_AGENT_DRIVER-firestore}" "${STUB_AGENT_EXTRA_ENV:-}" ;;
  *'run services describe assistant-web'*'--format=json'*)
    SERVICE_NAME=assistant-web service_json "${STUB_WEB_DRIVER-firestore}" ;;
  *'run revisions describe'*'--format=json'*)
    revision="${*:4:1}"
    if [[ "$revision" == *agent* ]]; then SERVICE_NAME=assistant-agent; driver="${STUB_AGENT_DRIVER-firestore}"; else SERVICE_NAME=assistant-web; driver="${STUB_WEB_DRIVER-firestore}"; fi
    service_json "$driver" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const x=JSON.parse(s);const env=x.spec.template.spec.containers[0].env;process.stdout.write(JSON.stringify({spec:{timeoutSeconds:300,containers:[{env}]}}))})' ;;
  *'run services update assistant-web'*)
    if [[ "$args" == *'ASSISTANT_RELEASE_WRITES_PAUSED='* ]]; then
      value="${args#*ASSISTANT_RELEASE_WRITES_PAUSED=}"
      value="${value%%,*}"
      printf '%s' "${value%% *}" >"$STUB_WEB_PAUSED_FILE"
    fi
    ;;
  *'firestore databases describe'*)
    if [[ "${STUB_PITR:-on}" == "on" ]]; then
      echo '{"pointInTimeRecoveryEnablement":"POINT_IN_TIME_RECOVERY_ENABLED","earliestVersionTime":"2026-09-17T00:00:00Z","versionRetentionPeriod":"604800s"}'
    else
      echo '{"pointInTimeRecoveryEnablement":"POINT_IN_TIME_RECOVERY_DISABLED"}'
    fi ;;
  *'firestore backups list'*)
    snapshot="$(node -e 'process.stdout.write(new Date(Date.now() - Number(process.argv[1]) * 3600000).toISOString())' "${STUB_BACKUP_AGE_HOURS:-2}")"
    printf '[{"name":"projects/test-project/locations/us/backups/b1","database":"projects/test-project/databases/assistant-production","state":"READY","snapshotTime":"%s"}]\n' "$snapshot" ;;
  *'scheduler jobs describe'*) echo 'name: job' ;;
  *'scheduler jobs update'*) ;;
  *'run services update'*) ;;
  *'run services update-traffic'*) ;;
  *'run jobs describe assistant-browser'*'--format=json'*)
    node -e '
      const image = require("node:fs").readFileSync(process.env.STUB_JOB_IMAGE_FILE, "utf8");
      const shape = process.env.STUB_JOB_SHAPE || "v1";
      const dbName = process.env.STUB_JOB_DB_NAME;
      const secretName = process.env.STUB_JOB_DB_SECRET;
      const secret = process.env.STUB_JOB_DB === "1" ? "database-url" : secretName;
      const env = [{name:"X",value:"y"}];
      if (dbName) env.push({name:dbName,value:"redacted"});
      if (secret) env.push({name:"APP_CONFIG", ...(shape === "v2" ? {valueSource:{secretKeyRef:{secret,version:"latest"}}} : {valueFrom:{secretKeyRef:{name:secret,key:"latest"}}})});
      const containers = [{image,env}];
      if (process.env.STUB_JOB_DB_SIDECAR === "1") containers.push({name:"sidecar",env:[{name:"PGHOST",value:"redacted"}]});
      const job = shape === "v2" ? {template:{template:{containers}}} : {spec:{template:{spec:{template:{spec:{containers}}}}}};
      process.stdout.write(JSON.stringify(job)+"\n");
    ' ;;
  *'run jobs describe assistant-browser'*) ;;
  *'run jobs update'*)
    while (($#)); do
      if [[ "$1" == "--image" && $# -gt 1 ]]; then shift; printf '%s' "$1" >"$STUB_JOB_IMAGE_FILE"; fi
      shift
    done
    ;;
  *)
    echo "unexpected gcloud call: $args" >&2
    exit 99 ;;
esac
STUB

cat >"$TEST_ROOT/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
printf 'pnpm %s\n' "$*" >>"$STUB_CALLS"
exit "${STUB_INDEX_STATUS:-0}"
STUB

cat >"$TEST_ROOT/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$STUB_CALLS"
url="${*: -1}"
case "$url" in
  */ready|*/api/ready) printf '{"ready":true}' ;;
  */api/release-probe) printf '{"ready":true,"writesPaused":"%s"}' "$(cat "$STUB_WEB_PAUSED_FILE")" ;;
  *) printf '{"ok":true,"service":"web","sha":"%s"}' "$IMAGE_TAG" ;;
esac
STUB
cat >"$TEST_ROOT/bin/sleep" <<'STUB'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >>"$STUB_CALLS"
STUB
chmod +x "$TEST_ROOT/bin/gcloud" "$TEST_ROOT/bin/pnpm" "$TEST_ROOT/bin/curl" "$TEST_ROOT/bin/sleep"
export PATH="$TEST_ROOT/bin:$PATH"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

bash "$ROOT/release-staged-services.test.sh" || fail "staged service promotion protocol tests failed"
bash "$ROOT/release-legacy-bootstrap.test.sh" || fail "pinned legacy bootstrap helper contract failed"

workflow="$ROOT/../../.github/workflows/deploy.yml"
env_example="$ROOT/../../.env.example"
grep -Fq 'RELEASE_EMAIL_OBSERVER_WORKER_ENABLED: ${{ vars.RELEASE_EMAIL_OBSERVER_WORKER_ENABLED }}' "$workflow" ||
  fail "production release must forward the optional repository worker variable"
grep -Fxq 'EMAIL_OBSERVER_WORKER_ENABLED=false' <(grep '^EMAIL_OBSERVER_WORKER_ENABLED=' "$env_example") ||
  fail "the default worker setting in .env.example must remain false"
if grep -Fq "RELEASE_EMAIL_OBSERVER_WORKER_ENABLED: \${{ vars.RELEASE_EMAIL_OBSERVER_WORKER_ENABLED || 'true' }}" "$workflow"; then
  fail "production release must not silently default the worker to true"
fi
bash "$ROOT/verify-release-source-workflow.test.sh" ||
  fail "the manual exact-source gate must use trusted verifier source before checking out the requested SHA"

reset() {
  : >"$STUB_CALLS"
  printf 'false' >"$STUB_WEB_PAUSED_FILE"
  unset STUB_AGENT_DRIVER STUB_WEB_DRIVER STUB_AGENT_EXTRA_ENV STUB_PITR STUB_BACKUP_AGE_HOURS \
    STUB_INDEX_STATUS STUB_JOB_DB STUB_JOB_SHAPE STUB_JOB_DB_NAME STUB_JOB_DB_SECRET STUB_JOB_DB_SIDECAR STUB_AGENT_DESCRIBE STUB_RELEASE_METADATA RELEASE_PERSISTENCE_DRIVER \
    RELEASE_EMAIL_OBSERVER_WORKER_ENABLED
}

# ── release.sh selects the path from the live services ──────────────────────
cp "$ROOT/release.sh" "$ROOT/release-persistence.sh" "$TEST_ROOT/dispatch/"
printf '#!/usr/bin/env bash\necho SELECTED:postgres\n' >"$TEST_ROOT/dispatch/release-postgres.sh"
printf '#!/usr/bin/env bash\necho SELECTED:firestore\n' >"$TEST_ROOT/dispatch/release-firestore.sh"

dispatch() {
  bash "$TEST_ROOT/dispatch/release.sh" 2>&1
}

reset
export STUB_AGENT_DRIVER='' STUB_WEB_DRIVER=''
out="$(dispatch)" || fail "unset drivers should release"
grep -q 'SELECTED:postgres' <<<"$out" || fail "unset PERSISTENCE_DRIVER must select the PostgreSQL path: $out"

reset
export STUB_AGENT_DRIVER=firestore STUB_WEB_DRIVER=firestore
out="$(dispatch)" || fail "firestore services should release"
grep -q 'SELECTED:firestore' <<<"$out" || fail "firestore services must select the Firestore path: $out"

reset
export STUB_AGENT_DRIVER=firestore STUB_WEB_DRIVER=postgres
if out="$(dispatch)"; then fail "mixed services must not release"; fi
grep -q 'SELECTED' <<<"$out" && fail "mixed services started a release path"
grep -q 'cutover is in progress' <<<"$out" || fail "mixed services need an explanation: $out"

reset
export STUB_AGENT_DRIVER=postgres STUB_WEB_DRIVER=postgres RELEASE_PERSISTENCE_DRIVER=firestore
if out="$(dispatch)"; then fail "an explicit flag contradicting the live services must stop"; fi
grep -q 'SELECTED' <<<"$out" && fail "a contradicted flag started a release path"

reset
export STUB_AGENT_DRIVER=postgres STUB_WEB_DRIVER=postgres RELEASE_PERSISTENCE_DRIVER=postgres
out="$(dispatch)" || fail "matching explicit flag should release"
grep -q 'SELECTED:postgres' <<<"$out" || fail "explicit postgres must select PostgreSQL: $out"

reset
export RELEASE_PERSISTENCE_DRIVER=mysql
set +e
dispatch >/dev/null
status=$?
set -e
[[ "$status" == 2 ]] || fail "an invalid flag must exit 2, got $status"

# The PostgreSQL path is the original release script, renamed without edits.
grep -q 'set-secrets "DATABASE_URL=database-url:latest"' "$ROOT/release-postgres.sh" ||
  fail "release-postgres.sh no longer carries the original PostgreSQL release"

# ── deploy.sh refuses a Firestore installation ───────────────────────────────
guard() {
  (
    export PROJECT="$GCP_PROJECT" REGION="$GCP_REGION"
    # shellcheck source=infra/gcp/release-persistence.sh
    source "$ROOT/release-persistence.sh"
    refuse_firestore_installation
  ) 2>&1
}
reset
export STUB_AGENT_DRIVER=firestore
if out="$(guard)"; then fail "deploy.sh guard must refuse a Firestore installation"; fi
grep -q 'would reattach' <<<"$out" || fail "guard must explain the refusal: $out"
reset
export STUB_AGENT_DRIVER=postgres
guard >/dev/null || fail "deploy.sh guard must allow a PostgreSQL installation"
reset
export STUB_AGENT_DESCRIBE=missing
guard >/dev/null || fail "deploy.sh guard must allow a fresh project"
reset
export STUB_AGENT_DESCRIBE=denied
if guard >/dev/null; then fail "deploy.sh guard must not treat a permission error as a fresh project"; fi
grep -q 'refuse_firestore_installation || exit 1' "$ROOT/deploy.sh" || fail "deploy.sh does not call the guard"
grep -Fq 'SELF_URL="https://assistant-agent-${PROJECT_NUMBER}.${REGION}.run.app"' "$ROOT/deploy.sh" ||
  fail "legacy deploy must compute the agent URL before first service creation"
grep -Fq 'SELF_URL_ENV="|AGENT_URL=${SELF_URL}|PUBLIC_URL=${SELF_URL}|INTERNAL_OIDC_AUDIENCE=${SELF_URL}"' "$ROOT/deploy.sh" ||
  fail "first agent revision must receive its service URL and OIDC audience"
if grep -Fq 'SELF_URL="$(gcloud run services describe' "$ROOT/deploy.sh"; then
  fail "first-install service URL must not depend on describing a nonexistent service"
fi

# ── release-firestore.sh ─────────────────────────────────────────────────────
export IMAGE_TAG="abc123" SKIP_IMAGE_BUILD=true RELEASE_HEALTH_INTERVAL_SECONDS=0 RELEASE_HEALTH_ATTEMPTS=2
export ASSISTANT_MODULES="google,browser"

firestore_release() {
  bash "$ROOT/release-firestore.sh" 2>&1
}

reset
export RELEASE_EMAIL_OBSERVER_WORKER_ENABLED='true,EXTRA=1'
if out="$(firestore_release)"; then fail "invalid worker override must stop before Firestore release"; fi
grep -q 'must be exactly true or false' <<<"$out" || fail "invalid worker override needs a clear error: $out"
[[ ! -s "$STUB_CALLS" ]] || fail "invalid worker override must fail before release mutations"
reset
if out="$(GCP_PROJECT=test-project RELEASE_EMAIL_OBSERVER_WORKER_ENABLED=1 bash "$ROOT/release-postgres.sh" 2>&1)"; then
  fail "invalid worker override must stop before PostgreSQL release"
fi
grep -q 'must be exactly true or false' <<<"$out" || fail "invalid worker override needs a clear PostgreSQL error: $out"
[[ ! -s "$STUB_CALLS" ]] || fail "invalid worker override must fail before PostgreSQL release mutations"

assert_no_database_calls() {
  if grep -Eiq 'database-url|DATABASE_URL|assistant-migrate|assistant-backup|secrets|neon|pg_dump' "$STUB_CALLS"; then
    grep -Ei 'database-url|DATABASE_URL|assistant-migrate|assistant-backup|secrets|neon|pg_dump' "$STUB_CALLS" >&2
    fail "the Firestore release made a database call"
  fi
}

reset
export STUB_JOB_SHAPE=v1
out="$(firestore_release)" || fail "Firestore release should succeed with the standard Cloud Run v1 job JSON: $out"
grep -q 'Firestore release abc123 is live' <<<"$out" || fail "release did not finish: $out"
grep -q 'Recovery point: assistant-production at .* (point-in-time recovery' <<<"$out" ||
  fail "release must print its PITR recovery point: $out"
grep -q 'pnpm -s firestore:indexes verify --project=test-project --database=assistant-production' "$STUB_CALLS" ||
  fail "release must verify Firestore indexes"
grep -q 'run services update assistant-agent' "$STUB_CALLS" || fail "agent not rolled out"
grep -q 'run services update assistant-web' "$STUB_CALLS" || fail "web not rolled out"
grep -q 'run jobs update assistant-browser' "$STUB_CALLS" || fail "browser job not rolled out"
assert_no_database_calls

reset
export STUB_RELEASE_METADATA=missing
if out="$(firestore_release)"; then fail "Firestore release must fail closed without live API/schema declarations"; fi
if ! grep -Eiq 'do not declare|does not declare|compatib' <<<"$out"; then fail "missing compatibility explanation: $out"; fi
if grep -Eq 'builds submit|firestore:indexes verify|run services update|run services update-traffic|run jobs update' "$STUB_CALLS"; then
  fail "missing compatibility metadata must stop before build/index/revision mutations"
fi

reset
export IMAGE_TAG=abc123
out="$(bash "$ROOT/release-fast.sh" web 2>&1)" || fail "fast Firestore web release should use live compatibility metadata: $out"
grep -q 'assistant-web abc123 is live' <<<"$out" || fail "fast release did not prove the serving SHA: $out"
grep -q 'run services update assistant-web' "$STUB_CALLS" || fail "fast release did not stage a web candidate"
grep -q -- '--no-traffic' "$STUB_CALLS" || fail "fast release skipped no-traffic staging"
grep -Eiq 'assistant-migrate|assistant-backup|database-url|pg_dump' "$STUB_CALLS" && fail "fast web release invoked a database operation"

reset
export STUB_AGENT_EXTRA_ENV='{"name":"DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"database-url","key":"latest"}}}'
if out="$(firestore_release)"; then fail "a template with a database secret must stop the release"; fi
grep -q 'not a database-free Firestore composition' <<<"$out" || fail "missing composition error: $out"
grep -q 'DATABASE_URL from secret database-url' <<<"$out" || fail "the offending reference must be named: $out"
grep -q 'run services update' "$STUB_CALLS" && fail "a mixed composition was rolled out"

reset
export STUB_JOB_SHAPE=v2
out="$(firestore_release)" || fail "Firestore release should accept the Cloud Run v2 REST job shape: $out"
grep -q 'run jobs update assistant-browser' "$STUB_CALLS" || fail "the v2 worker job was not rolled out"

for shape in v1 v2; do
  reset
  export STUB_JOB_SHAPE="$shape" STUB_JOB_DB_NAME=DIRECT_DATABASE_URL
  if out="$(firestore_release)"; then fail "$shape worker job with a direct database credential name must block release"; fi
  grep -q 'env DIRECT_DATABASE_URL' <<<"$out" || fail "$shape direct database credential name was not identified: $out"
  grep -q 'run jobs update' "$STUB_CALLS" && fail "$shape direct database credential name was updated"

  reset
  export STUB_JOB_SHAPE="$shape" STUB_JOB_DB_SECRET=projects/test/secrets/database-url
  if out="$(firestore_release)"; then fail "$shape worker job with a qualified database secret reference must block release"; fi
  grep -q 'APP_CONFIG from secret projects/test/secrets/database-url' <<<"$out" || fail "$shape qualified database secret reference was not identified: $out"
  grep -q 'run jobs update' "$STUB_CALLS" && fail "$shape qualified database secret reference was updated"

  reset
  export STUB_JOB_SHAPE="$shape" STUB_JOB_DB_NAME=PROD_DATABASE_URL
  if out="$(firestore_release)"; then fail "$shape worker job with a database credential name must block release"; fi
  grep -q 'env PROD_DATABASE_URL' <<<"$out" || fail "$shape database credential name was not identified: $out"
  grep -q 'run jobs update' "$STUB_CALLS" && fail "$shape database credential name was updated"

  reset
  export STUB_JOB_SHAPE="$shape" STUB_JOB_DB_SECRET=projects/test/secrets/neon-worker-credentials
  if out="$(firestore_release)"; then fail "$shape worker job with a database secret reference must block release"; fi
  grep -q 'APP_CONFIG from secret projects/test/secrets/neon-worker-credentials' <<<"$out" || fail "$shape secret reference was not identified: $out"
  grep -q 'run jobs update' "$STUB_CALLS" && fail "$shape worker secret reference was updated"
done

reset
export STUB_JOB_SHAPE=v2 STUB_JOB_DB_SIDECAR=1
if out="$(firestore_release)"; then fail "a sidecar database credential must block release"; fi
grep -q 'env PGHOST' <<<"$out" || fail "sidecar database credential was not identified: $out"
grep -q 'run jobs update' "$STUB_CALLS" && fail "a job with a sidecar database credential was updated"

reset
export STUB_PITR=off STUB_BACKUP_AGE_HOURS=3
out="$(firestore_release)" || fail "a recent managed backup should satisfy the recovery gate: $out"
grep -q 'Recovery point: projects/test-project/locations/us/backups/b1' <<<"$out" ||
  fail "release must name the backup it relies on: $out"
assert_no_database_calls

reset
export STUB_PITR=off STUB_BACKUP_AGE_HOURS=48
if out="$(firestore_release)"; then fail "no recent recovery point must stop the release"; fi
grep -q 'No READY managed backup' <<<"$out" || fail "missing recovery-point error: $out"
grep -q 'run services update' "$STUB_CALLS" && fail "rolled out without a recovery point"

reset
export STUB_INDEX_STATUS=1
if firestore_release >/dev/null; then fail "an index mismatch must stop the release"; fi
grep -q 'run services update' "$STUB_CALLS" && fail "rolled out before indexes matched"

reset
export STUB_JOB_DB=1
if out="$(firestore_release)"; then fail "a module job with a database secret must fail the release"; fi
grep -q 'job assistant-browser is not a database-free' <<<"$out" || fail "missing job composition error: $out"
grep -q 'run jobs update assistant-browser' "$STUB_CALLS" && fail "a job with a database secret was updated"
grep -q 'run services update assistant-web' "$STUB_CALLS" || fail "web rollout should not be stranded by job drift"

echo "release path tests passed"
