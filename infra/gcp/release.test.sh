#!/usr/bin/env bash
# Offline tests for release-path selection, the deploy.sh Firestore guard, and
# the Firestore release. gcloud, pnpm, and curl are stubs; nothing leaves the
# machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Every selected image must truthfully cover the bounded calendar schema bridge.
node --test "$ROOT/calendar-bridge-contract.test.mjs" "$ROOT/release-contract-133.test.mjs"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/assistant-release-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/dispatch"

# The long-standing Firestore protocol tests cover a pre-BASIC5 release source.
# Keep that source isolated so the real checkout's intrinsic capability and
# runtime file remain available for separate current-source guard assertions.
LEGACY_RELEASE_ROOT="$TEST_ROOT/legacy-release-source"
mkdir -p "$LEGACY_RELEASE_ROOT/infra/gcp" "$LEGACY_RELEASE_ROOT/packages/db/drizzle/meta"
LEGACY_RELEASE_ROOT="$(cd "$LEGACY_RELEASE_ROOT" && pwd -P)"
for file in release-firestore.sh release-fast.sh release-persistence.sh release-staged-services.sh release-legacy-bootstrap.sh \
  release-schema-version.mjs release-manifest.mjs release-contracts.json; do
  cp "$ROOT/$file" "$LEGACY_RELEASE_ROOT/infra/gcp/$file"
done
cp "${ROOT%/infra/gcp}/packages/db/drizzle/meta/_journal.json" \
  "$LEGACY_RELEASE_ROOT/packages/db/drizzle/meta/_journal.json"
node - "$LEGACY_RELEASE_ROOT/infra/gcp/release-contracts.json" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const contracts = JSON.parse(fs.readFileSync(path, 'utf8'));
delete contracts.components?.web?.ownerEditorV1;
fs.writeFileSync(path, `${JSON.stringify(contracts, null, 2)}\n`);
NODE

export GCP_PROJECT="test-project"
export GCP_REGION="test-region"
export STUB_CALLS="$TEST_ROOT/calls"
export STUB_WEB_PAUSED_FILE="$TEST_ROOT/web-paused"
export STUB_JOB_IMAGE_FILE="$TEST_ROOT/browser-image"
export STUB_CANDIDATE_TAG_FILE="$TEST_ROOT/candidate-tag" STUB_RESUME_TAG_FILE="$TEST_ROOT/resume-tag"
printf 'registry/old-browser' >"$STUB_JOB_IMAGE_FILE"
printf 'false' >"$STUB_WEB_PAUSED_FILE"

# ── stubs ────────────────────────────────────────────────────────────────────
cat >"$TEST_ROOT/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
set -u
printf 'gcloud %s\n' "$*" >>"$STUB_CALLS"
args="$*"

capture_traffic_tag() {
  local previous='' argument
  for argument in "$@"; do
    if [[ "$previous" == --tag ]]; then
      case "$argument" in
        candidate-*) printf '%s' "$argument" >"$STUB_CANDIDATE_TAG_FILE" ;;
        resume-*) printf '%s' "$argument" >"$STUB_RESUME_TAG_FILE" ;;
      esac
    fi
    previous="$argument"
  done
}

service_json() {
  local driver="$1" extra="${2:-}" env='[]' candidate_tag='' resume_tag=''
  [[ ! -f "$STUB_CANDIDATE_TAG_FILE" ]] || candidate_tag="$(cat "$STUB_CANDIDATE_TAG_FILE")"
  [[ ! -f "$STUB_RESUME_TAG_FILE" ]] || resume_tag="$(cat "$STUB_RESUME_TAG_FILE")"
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
  printf '{"metadata":{"name":"svc"},"status":{"url":"https://%s.example","traffic":[{"revisionName":"%s-old","percent":100},{"revisionName":"%s-candidate","tag":"%s","url":"https://%s-%s.example","percent":0},{"revisionName":"%s-resume","tag":"%s","url":"https://%s-%s.example","percent":0}]},"spec":{"template":{"spec":{"containers":[{"env":%s}]}}}}\n' \
    "${SERVICE_NAME:-assistant-agent}" "${SERVICE_NAME:-assistant-agent}" "${SERVICE_NAME:-assistant-agent}" "$candidate_tag" "$candidate_tag" "${SERVICE_NAME:-assistant-agent}" "${SERVICE_NAME:-assistant-agent}" "$resume_tag" "$resume_tag" "${SERVICE_NAME:-assistant-agent}" "$env"
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
    # Revision describe is immutable native metadata, not the mutable service template.
    if [[ "$revision" == *agent* ]]; then component=agent; digest_letter=a; else component=web; digest_letter=b; fi
    digest="$(printf '%064d' 0 | tr 0 "$digest_letter")"
    image="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${ARTIFACT_REPOSITORY:-assistant}/${component}@sha256:${digest}"
    paused=false
    if [[ "$revision" == *-candidate ]]; then paused=true; fi
    service_json "$driver" | node -e '
      let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{
        const x=JSON.parse(s),name=process.argv[1],image=process.argv[2];
        const env=x.spec.template.spec.containers[0].env.filter(e=>e.name!=="ASSISTANT_RELEASE_WRITES_PAUSED");
        if(name.startsWith("assistant-web"))env.push({name:"ASSISTANT_RELEASE_WRITES_PAUSED",value:process.argv[3]});
        process.stdout.write(JSON.stringify({metadata:{name},spec:{timeoutSeconds:300,containers:[{image,env}]}}));
      })' "$revision" "$image" "$paused" ;;
  *'run services update assistant-web'*)
    capture_traffic_tag "$@"
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
  *'run services update'*) capture_traffic_tag "$@" ;;
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
python3 "$ROOT/firestore-delivery-guard.test.py" || fail "Firestore delivery hold recovery tests failed"

workflow="$ROOT/../../.github/workflows/deploy.yml"
env_example="$ROOT/../../.env.example"
python3 - "$workflow" <<'PYWORKFLOW'
import os, pathlib, subprocess, sys, tempfile
workflow=open(sys.argv[1]).read()
release=workflow.split('\n  release:\n',1)[1]
start=release.index('      - name: Check intrinsic BASIC5 context before cloud authentication\n')
end=release.index('      - run: pnpm install --frozen-lockfile\n',start)
precheck=release[start:end]
auth=release.index('uses: google-github-actions/auth@')
resolver=release.index('      - name: Resolve live release path\n')
assert start < end < auth < resolver, 'pure BASIC5 check must precede install/auth/live resolution'
assert 'IMAGE_TAG: ${{ needs.plan.outputs.sha }}' in precheck
assert 'RELEASE_COMPONENTS: ${{ needs.plan.outputs.components }}' in precheck
assert 'release_validate_basic_editor_preflight_context "$RELEASE_COMPONENTS" "$TAG"' in precheck
assert 'PROJECT="$GCP_PROJECT"' in precheck and 'REGION="$GCP_REGION"' in precheck and 'REPO="$ARTIFACT_REPOSITORY"' in precheck
assert 'gcloud ' not in precheck and 'driver=' not in precheck, 'precheck cannot read or invent driver authority'
# Run the actual workflow step against an older workflow_run source checkout.
# This reproduces the new-workflow/old-source combination without cloud access.
script='\n'.join(line[10:] for line in precheck.split('        run: |\n',1)[1].splitlines())
with tempfile.TemporaryDirectory() as directory:
    staged=pathlib.Path(directory)/'infra/gcp/release-staged-services.sh'
    staged.parent.mkdir(parents=True)
    staged.write_text('release_staged_services() { :; }\n')
    env={**os.environ, 'GITHUB_EVENT_NAME':'workflow_run',
         'GITHUB_WORKFLOW_SHA':'9'*40, 'GITHUB_SHA':'9'*40, 'IMAGE_TAG':'3'*40}
    result=subprocess.run(['bash','-euo','pipefail','-c',script],cwd=directory,env=env,text=True,capture_output=True)
    assert result.returncode == 2, result.stderr
    assert 'Release source lacks the protected BASIC5 preflight validator' in result.stderr
    assert 'command not found' not in result.stderr
    # A source that supplies the validator must still execute it and preserve
    # its refusal; presence alone never authorizes a release.
    staged.write_text('release_validate_basic_editor_preflight_context() { echo source-refused >&2; return 23; }\n')
    env.update(GCP_PROJECT='bmson-assistant',GCP_REGION='us-west1',ARTIFACT_REPOSITORY='assistant',RELEASE_COMPONENTS='agent,web')
    result=subprocess.run(['bash','-euo','pipefail','-c',script],cwd=directory,env=env,text=True,capture_output=True)
    assert result.returncode == 23 and 'source-refused' in result.stderr, result.stderr
PYWORKFLOW
for worker_mapping in browser:BROWSER code:CODE processor:PROCESSOR; do
  worker="${worker_mapping%:*}"
  worker_env="${worker_mapping#*:}"
  output_line="      ${worker}: \${{ steps.modules.outputs.${worker} }}"
  [[ "$(grep -Fxc "$output_line" "$workflow")" == 1 ]] ||
    fail "the ${worker} worker plan output must be forwarded exactly once"
  grep -Fq "GUARD_WORKER_${worker_env}: \${{ needs.plan.outputs.${worker} }}" "$workflow" ||
    fail "the delivery guard must receive the ${worker} worker plan output"
done
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
DISPATCH_RELEASE_ROOT="$TEST_ROOT/dispatch/infra/gcp"
mkdir -p "$DISPATCH_RELEASE_ROOT"
cp "$ROOT/release.sh" "$ROOT/release-persistence.sh" "$ROOT/release-staged-services.sh" "$DISPATCH_RELEASE_ROOT/"
cp "$LEGACY_RELEASE_ROOT/infra/gcp/release-contracts.json" "$DISPATCH_RELEASE_ROOT/"
printf '#!/usr/bin/env bash\necho SELECTED:postgres\n' >"$DISPATCH_RELEASE_ROOT/release-postgres.sh"
printf '#!/usr/bin/env bash\necho SELECTED:firestore\n' >"$DISPATCH_RELEASE_ROOT/release-firestore.sh"

dispatch() {
  bash "$DISPATCH_RELEASE_ROOT/release.sh" 2>&1
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
  bash "$LEGACY_RELEASE_ROOT/infra/gcp/release-firestore.sh" 2>&1
}
fast_firestore_web_release() {
  bash "$LEGACY_RELEASE_ROOT/infra/gcp/release-fast.sh" web 2>&1
}
node - "$LEGACY_RELEASE_ROOT" <<'NODE' || fail "legacy fixture must not advertise or contain BASIC5 runtime"
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const contracts = JSON.parse(fs.readFileSync(path.join(root, 'infra/gcp/release-contracts.json'), 'utf8'));
if (contracts.components?.web?.ownerEditorV1 !== undefined) process.exit(1);
if (fs.existsSync(path.join(root, 'apps/web/lib/owner-editor-runtime.ts'))) process.exit(1);
NODE

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

# Running the current BASIC5 source directly without protected workflow
# identity must fail before staging a candidate, traffic, or worker template.
reset
actual_unbound_basic5_release() {
  unset GITHUB_ACTIONS GITHUB_REPOSITORY GITHUB_REF GITHUB_WORKFLOW_REF GITHUB_WORKFLOW_SHA GITHUB_SHA \
    GITHUB_EVENT_NAME GITHUB_RUN_ID GITHUB_RUN_ATTEMPT
  actual_basic5_direct_release agent,web firestore
}
actual_basic5_direct_release() {
  export IMAGE_TAG='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  export RELEASE_COMPONENTS="$1" RELEASE_SCHEMA_UNCHANGED=true SKIP_IMAGE_BUILD=false
  # Exercise the actual entry scripts, including their build/migration/scheduler
  # bookkeeping, rather than merely calling the later staging helper.
  case "$2" in
    firestore) bash "$ROOT/release-firestore.sh" ;;
    postgres) bash "$ROOT/release-postgres.sh" ;;
    *) fail "unsupported negative fixture driver" ;;
  esac
}

set_valid_basic5_context() {
  export GITHUB_ACTIONS=true GITHUB_REPOSITORY=bmson/assistant GITHUB_REF=refs/heads/main
  export GITHUB_WORKFLOW_REF=bmson/assistant/.github/workflows/deploy.yml@refs/heads/main
  export GITHUB_WORKFLOW_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  export GITHUB_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  export GITHUB_EVENT_NAME=workflow_dispatch GITHUB_RUN_ID=12345 GITHUB_RUN_ATTEMPT=1
}
if out="$(actual_unbound_basic5_release 2>&1)"; then
  fail "direct unbound BASIC5 release must fail closed"
fi
grep -Eiq 'requires .*GitHub .*identity|requires .*workflow identity' <<<"$out" ||
  fail "direct unbound BASIC5 release needs a clear pre-staging error: $out"
[[ ! -s "$STUB_CALLS" ]] || fail "direct unbound BASIC5 release must stop before any provider reads or mutations"

# Valid protected metadata cannot authorize BASIC5 with the wrong driver or
# component scope. Both refusals must happen before any provider call.
reset
set_valid_basic5_context
if out="$(actual_basic5_direct_release agent,web postgres 2>&1)"; then
  fail "BASIC5 with the PostgreSQL driver must fail before Cloud Run reads"
fi
grep -q 'requires a paired Firestore release' <<<"$out" || fail "wrong-driver BASIC5 error was unclear: $out"
[[ ! -s "$STUB_CALLS" ]] || fail "wrong-driver BASIC5 path made a provider call"

reset
set_valid_basic5_context
if out="$(actual_basic5_direct_release web firestore 2>&1)"; then
  fail "BASIC5 web-only Firestore path must fail before Cloud Run reads"
fi
grep -q 'requires a paired Firestore release' <<<"$out" || fail "web-only BASIC5 error was unclear: $out"
[[ ! -s "$STUB_CALLS" ]] || fail "web-only BASIC5 path made a provider call"

# Even otherwise valid workflow metadata must not redirect BASIC5 to a different
# project/region/repository before its fixed native client can reject it later.
reset
set_valid_basic5_context
if out="$(actual_basic5_direct_release agent,web firestore 2>&1)"; then
  fail "BASIC5 with a foreign provider target must stop at wrapper entry"
fi
grep -q 'requires the fixed bmson-assistant/us-west1/assistant target' <<<"$out" ||
  fail "foreign-target BASIC5 refusal was unclear: $out"
[[ ! -s "$STUB_CALLS" ]] || fail "foreign-target BASIC5 wrapper made a provider call"

# Fast release must reject current BASIC5 before project discovery itself.
reset
actual_basic5_fast_release() {
  unset GCP_PROJECT
  export ASSISTANT_ENV_FILE="$TEST_ROOT/absent.env" IMAGE_TAG=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  bash "$ROOT/release-fast.sh" web
}
if out="$(actual_basic5_fast_release 2>&1)"; then
  fail "BASIC5 fast web release must reject before project discovery or build"
fi
grep -q 'requires a paired Firestore release' <<<"$out" || fail "fast BASIC5 refusal was unclear: $out"
[[ ! -s "$STUB_CALLS" ]] || fail "fast BASIC5 path accessed a provider before refusal"

# The top-level dispatcher must validate identity before resolving any driver.
reset
actual_unbound_basic5_dispatch() {
  unset GITHUB_ACTIONS GITHUB_REPOSITORY GITHUB_REF GITHUB_WORKFLOW_REF GITHUB_WORKFLOW_SHA GITHUB_SHA \
    GITHUB_EVENT_NAME GITHUB_RUN_ID GITHUB_RUN_ATTEMPT
  export IMAGE_TAG=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa RELEASE_COMPONENTS=agent,web
  bash "$ROOT/release.sh"
}
if out="$(actual_unbound_basic5_dispatch 2>&1)"; then
  fail "unbound BASIC5 dispatcher must stop before live driver reads"
fi
grep -Eiq 'requires .*GitHub .*identity|requires .*workflow identity' <<<"$out" ||
  fail "unbound dispatcher refusal was unclear: $out"
[[ ! -s "$STUB_CALLS" ]] || fail "unbound BASIC5 dispatcher made a provider call"

reset
set_valid_basic5_context
if out="$(IMAGE_TAG=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa RELEASE_COMPONENTS=agent,web bash "$ROOT/release.sh" 2>&1)"; then
  fail "foreign-target BASIC5 dispatcher must stop before driver reads"
fi
grep -q 'requires the fixed bmson-assistant/us-west1/assistant target' <<<"$out" ||
  fail "foreign-target dispatcher refusal was unclear: $out"
[[ ! -s "$STUB_CALLS" ]] || fail "foreign-target dispatcher made a provider call"

# Only a bound fixed-target identity can auto-read the actual driver. A genuine
# PostgreSQL observation then refuses before entering a mutating child wrapper.
reset
set_valid_basic5_context
actual_bound_wrong_driver_dispatch() {
  export GCP_PROJECT=bmson-assistant GCP_REGION=us-west1 ARTIFACT_REPOSITORY=assistant
  export IMAGE_TAG=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa RELEASE_COMPONENTS=agent,web
  export STUB_AGENT_DRIVER=postgres STUB_WEB_DRIVER=postgres
  unset RELEASE_PERSISTENCE_DRIVER
  bash "$ROOT/release.sh"
}
if out="$(actual_bound_wrong_driver_dispatch 2>&1)"; then
  fail "BASIC5 dispatcher must reject the actual PostgreSQL driver"
fi
grep -q 'requires a paired Firestore release' <<<"$out" || fail "resolved wrong-driver refusal was unclear: $out"
[[ "$(wc -l <"$STUB_CALLS" | tr -d ' ')" == 2 ]] || fail "bound auto detection must only read both services"
if grep -Ev '^gcloud run services describe (assistant-agent|assistant-web) --project bmson-assistant --region us-west1 --format=json$' "$STUB_CALLS"; then
  fail "bound wrong-driver dispatcher made an unauthorized call"
fi

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
# The composed fake must return the native revision identity required by BASIC5,
# rather than making the new guard accept an incomplete service-shaped response.
gcloud run revisions describe assistant-web-resume --format=json | node -e '
  let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{
    const r=JSON.parse(s),c=r.spec.containers[0];
    const image=`${process.env.GCP_REGION}-docker.pkg.dev/${process.env.GCP_PROJECT}/${process.env.ARTIFACT_REPOSITORY||"assistant"}/web@sha256:${"b".repeat(64)}`;
    const paused=c.env.filter(e=>e.name==="ASSISTANT_RELEASE_WRITES_PAUSED");
    if(r.metadata.name!=="assistant-web-resume"||c.image!==image||paused.length!==1||paused[0].value!=="false")process.exit(1);
  })' || fail "resume fixture must carry exact immutable name, digest and unpaused state"

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
out="$(fast_firestore_web_release)" || fail "fast Firestore web release should use live compatibility metadata: $out"
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
