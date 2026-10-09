#!/usr/bin/env bash
# Narrow bootstrap proof for the one deployed pair that predates release metadata.
# This never stamps or rewrites declarations on the historical revisions.
LEGACY_BOOTSTRAP_SOURCE_SHA='68e63fe7efc33789bb434d8a29ccfa2599c3b27e'
LEGACY_BOOTSTRAP_AGENT_REVISION='assistant-agent-00515-79z'
LEGACY_BOOTSTRAP_WEB_REVISION='assistant-web-00506-sj8'
LEGACY_BOOTSTRAP_AGENT_IMAGE='us-west1-docker.pkg.dev/bmson-assistant/assistant/agent@sha256:d471682171e71cbe996cb6e52936b6f7f2df54e17ca30cfdc7e120ecadf69e29'
LEGACY_BOOTSTRAP_WEB_IMAGE='us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:2423faa280dd89fb31ce7c09dd64a64fcd30be1a8b121a0572f0e146b9f8cf4c'
LEGACY_BOOTSTRAP_DATABASE='assistant-production'
LEGACY_BOOTSTRAP_CONTRACT_SHA256='8319fc0dd0a793719338a4b0692320f8de1fc82510ef08af80c08a77379a8a41'
LEGACY_BOOTSTRAP_AGENT_TEMPLATE='us-west1-docker.pkg.dev/bmson-assistant/assistant/agent:68e63fe7efc33789bb434d8a29ccfa2599c3b27e'
LEGACY_BOOTSTRAP_WEB_TEMPLATE='us-west1-docker.pkg.dev/bmson-assistant/assistant/web:68e63fe7efc33789bb434d8a29ccfa2599c3b27e'

legacy_bootstrap_service_json() {
  gcloud run services describe "$1" --project "$PROJECT" --region "$REGION" --format=json
}

legacy_bootstrap_env() {
  node -e 'const s=JSON.parse(process.argv[1]);const e=s.spec?.template?.spec?.containers?.[0]?.env??[];process.stdout.write(String(e.find(x=>x.name===process.argv[2])?.value??""))' "$1" "$2"
}

legacy_bootstrap_serving_revision() {
  node -e 'const s=JSON.parse(process.argv[1]);const rows=(s.status?.traffic??[]).filter(x=>Number(x.percent)>0);if(rows.length!==1||Number(rows[0].percent)!==100||!rows[0].revisionName)process.exit(2);process.stdout.write(rows[0].revisionName)' "$1"
}

legacy_bootstrap_revision_image_digest() {
  local revision="$1"
  gcloud run revisions describe "$revision" --project "$PROJECT" --region "$REGION" --format=json |
    node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{const x=JSON.parse(s);process.stdout.write(String(x.status?.imageDigest??""))}catch{process.exit(2)}})'
}

legacy_bootstrap_has_release_metadata() {
  node -e 'const s=JSON.parse(process.argv[1]);const cs=s.spec?.template?.spec?.containers??[];process.exit(cs.some(c=>(c.env??[]).some(x=>typeof x.name==="string"&&x.name.startsWith("ASSISTANT_RELEASE_")))?0:1)' "$1"
}

legacy_bootstrap_candidate_contract_ok() {
  local contract="${BASH_SOURCE[0]%/*}/release-contracts.json"
  node - "$contract" "$LEGACY_BOOTSTRAP_CONTRACT_SHA256" <<'NODE'
const fs=require('node:fs');
const crypto=require('node:crypto');
const path=process.argv[2];
const expectedHash=process.argv[3];
const bytes=fs.readFileSync(path);
if (crypto.createHash('sha256').update(bytes).digest('hex')!==expectedHash) process.exit(2);
const c=JSON.parse(bytes);
const schema=Number(c.storageSchemaVersion?.firestore);
if (schema!==1) process.exit(3);
for (const name of ['agent','web']) {
  const x=c.components?.[name];
  if (x?.apiContract!==1 || x?.peerApi?.min!==1 || x?.peerApi?.max!==1 ||
      x?.schema?.firestore?.min!==1 || x?.schema?.firestore?.max!==1) process.exit(4);
}
NODE
}

# Candidate contract values are passed from the release flow. Historical
# revision identity is pinned here from the verified live revision inventory.
release_preflight_legacy_firestore_bootstrap() {
  local selected="$1" agent_api="$2" web_api="$3" schema_version="$4"
  local agent_json web_json agent_template web_template agent_revision web_revision agent_digest web_digest agent_driver web_driver agent_db web_db
  if [[ "$selected" != 'agent,web' || "${RELEASE_COMPONENTS:-agent,web}" != 'agent,web' ]]; then
    echo '  legacy bootstrap requires the complete agent,web release.' >&2; return 1
  fi
  if [[ "${RELEASE_PERSISTENCE_DRIVER:-}" != firestore || "${ASSISTANT_RELEASE_WRITES_PAUSED:-false}" != true ]]; then
    echo '  legacy bootstrap requires Firestore and ASSISTANT_RELEASE_WRITES_PAUSED=true.' >&2; return 1
  fi
  if [[ "${PROJECT:-}" != bmson-assistant || "${REGION:-}" != us-west1 ]]; then
    echo '  legacy bootstrap is pinned to project bmson-assistant in us-west1.' >&2; return 1
  fi
  if [[ "$agent_api" != 1 || "$web_api" != 1 || "$schema_version" != 1 ]]; then
    echo '  legacy bootstrap candidate must declare API 1 and Firestore schema 1.' >&2; return 1
  fi
  if ! legacy_bootstrap_candidate_contract_ok; then
    echo '  current candidate release-contracts.json is not the pinned API 1 / Firestore schema 1 contract.' >&2; return 1
  fi
  agent_json="$(legacy_bootstrap_service_json assistant-agent)" || return 1
  web_json="$(legacy_bootstrap_service_json assistant-web)" || return 1
  if legacy_bootstrap_has_release_metadata "$agent_json" || legacy_bootstrap_has_release_metadata "$web_json"; then
    echo '  legacy bootstrap only accepts both services with no ASSISTANT_RELEASE_* metadata.' >&2; return 1
  fi
  agent_template="$(node -e 'const s=JSON.parse(process.argv[1]);process.stdout.write(String(s.spec?.template?.spec?.containers?.[0]?.image??""))' "$agent_json")"
  web_template="$(node -e 'const s=JSON.parse(process.argv[1]);process.stdout.write(String(s.spec?.template?.spec?.containers?.[0]?.image??""))' "$web_json")"
  if [[ "$agent_template" != "$LEGACY_BOOTSTRAP_AGENT_TEMPLATE" || "$web_template" != "$LEGACY_BOOTSTRAP_WEB_TEMPLATE" ]]; then
    echo '  live service templates do not match the pinned historical source image tags.' >&2; return 1
  fi
  agent_revision="$(legacy_bootstrap_serving_revision "$agent_json")" || {
    echo '  legacy bootstrap requires one 100% serving revision per service.' >&2; return 1;
  }
  web_revision="$(legacy_bootstrap_serving_revision "$web_json")" || {
    echo '  legacy bootstrap requires one 100% serving revision per service.' >&2; return 1;
  }
  if [[ "$agent_revision" != "$LEGACY_BOOTSTRAP_AGENT_REVISION" || "$web_revision" != "$LEGACY_BOOTSTRAP_WEB_REVISION" ]]; then
    echo '  live serving revisions do not match the pinned legacy pair.' >&2; return 1
  fi
  agent_digest="$(legacy_bootstrap_revision_image_digest "$agent_revision")" || return 1
  web_digest="$(legacy_bootstrap_revision_image_digest "$web_revision")" || return 1
  if [[ "$agent_digest" != "$LEGACY_BOOTSTRAP_AGENT_IMAGE" || "$web_digest" != "$LEGACY_BOOTSTRAP_WEB_IMAGE" ]]; then
    echo '  live serving revision image digests do not match the pinned legacy pair.' >&2; return 1
  fi
  agent_driver="$(legacy_bootstrap_env "$agent_json" PERSISTENCE_DRIVER)"
  web_driver="$(legacy_bootstrap_env "$web_json" PERSISTENCE_DRIVER)"
  agent_db="$(legacy_bootstrap_env "$agent_json" FIRESTORE_DATABASE_ID)"
  web_db="$(legacy_bootstrap_env "$web_json" FIRESTORE_DATABASE_ID)"
  if [[ "$agent_driver" != firestore || "$web_driver" != firestore ||
        "$agent_db" != "$LEGACY_BOOTSTRAP_DATABASE" || "$web_db" != "$LEGACY_BOOTSTRAP_DATABASE" ]]; then
    echo '  live service templates do not both use the pinned Firestore database.' >&2; return 1
  fi
  echo "  accepted exact legacy pair from source ${LEGACY_BOOTSTRAP_SOURCE_SHA} under paused full-stack upgrade choreography."
  return 0
}
