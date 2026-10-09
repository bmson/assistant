#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"
export STATE="$TEST_ROOT/state.json"
cat >"$TEST_ROOT/bin/gcloud" <<'PY'
#!/usr/bin/env python3
import json, os, sys
a=sys.argv[1:]
if a[:3]==['run','services','describe']:
  s=json.load(open(os.environ['STATE']))[a[3]]; print(json.dumps(s)); sys.exit(0)
if a[:3]==['run','revisions','describe']:
  rev=a[3]
  images={'assistant-agent-00515-79z':'us-west1-docker.pkg.dev/bmson-assistant/assistant/agent@sha256:d471682171e71cbe996cb6e52936b6f7f2df54e17ca30cfdc7e120ecadf69e29',
          'assistant-web-00506-sj8':'us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:2423faa280dd89fb31ce7c09dd64a64fcd30be1a8b121a0572f0e146b9f8cf4c'}
  if os.getenv('BAD_REVISION_DIGEST')=='1' and rev=='assistant-agent-00515-79z': images[rev]=images[rev][:-1]+'0'
  print(json.dumps({'status':{'imageDigest':images[rev]}})); sys.exit(0)
sys.exit(90)
PY
chmod +x "$TEST_ROOT/bin/gcloud"
export PATH="$TEST_ROOT/bin:$PATH"
export PROJECT=bmson-assistant REGION=us-west1 RELEASE_COMPONENTS=agent,web RELEASE_PERSISTENCE_DRIVER=firestore ASSISTANT_RELEASE_WRITES_PAUSED=true
source "$ROOT/release-legacy-bootstrap.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
reset_case() {
cat >"$STATE" <<'JSON'
{"assistant-agent":{"spec":{"template":{"spec":{"containers":[{"image":"us-west1-docker.pkg.dev/bmson-assistant/assistant/agent:68e63fe7efc33789bb434d8a29ccfa2599c3b27e","env":[{"name":"PERSISTENCE_DRIVER","value":"firestore"},{"name":"FIRESTORE_DATABASE_ID","value":"assistant-production"}]}]}}},"status":{"traffic":[{"revisionName":"assistant-agent-00515-79z","percent":100}]}},"assistant-web":{"spec":{"template":{"spec":{"containers":[{"image":"us-west1-docker.pkg.dev/bmson-assistant/assistant/web:68e63fe7efc33789bb434d8a29ccfa2599c3b27e","env":[{"name":"PERSISTENCE_DRIVER","value":"firestore"},{"name":"FIRESTORE_DATABASE_ID","value":"assistant-production"}]}]}}},"status":{"traffic":[{"revisionName":"assistant-web-00506-sj8","percent":100}]}}}
JSON
export RELEASE_COMPONENTS=agent,web RELEASE_PERSISTENCE_DRIVER=firestore ASSISTANT_RELEASE_WRITES_PAUSED=true PROJECT=bmson-assistant REGION=us-west1
}
reset_case
release_preflight_legacy_firestore_bootstrap agent,web 1 1 1 || fail 'exact pinned old pair should pass under maintenance pause'

reset_case; export RELEASE_COMPONENTS=web
if release_preflight_legacy_firestore_bootstrap web 1 1 1; then fail 'web-only must fail'; fi
reset_case; export ASSISTANT_RELEASE_WRITES_PAUSED=false
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 1; then fail 'unpaused promotion must fail'; fi
reset_case; export RELEASE_PERSISTENCE_DRIVER=postgres
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 1; then fail 'PostgreSQL must fail'; fi
reset_case; export PROJECT=other-project
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 1; then fail 'other project must fail'; fi
reset_case
python3 - "$STATE" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); s['assistant-web']['spec']['template']['spec']['containers'][0]['env'][1]['value']='other-db'; open(p,'w').write(json.dumps(s))
PY
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 1; then fail 'different database must fail'; fi
reset_case
python3 - "$STATE" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); s['assistant-agent']['spec']['template']['spec']['containers'][0]['env'].append({'name':'ASSISTANT_RELEASE_API_CONTRACT','value':'1'}); open(p,'w').write(json.dumps(s))
PY
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 1; then fail 'partial release metadata must fail'; fi
reset_case
python3 - "$STATE" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); c=s['assistant-web']['spec']['template']['spec']['containers']; c.append({'name':'sidecar','env':[{'name':'ASSISTANT_RELEASE_MANIFEST','value':'partial'}]}); open(p,'w').write(json.dumps(s))
PY
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 1; then fail 'release metadata in a sidecar must fail'; fi
reset_case
python3 - "$STATE" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); s['assistant-agent']['status']['traffic'][0]['revisionName']='assistant-agent-other'; open(p,'w').write(json.dumps(s))
PY
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 1; then fail 'different revision must fail'; fi
reset_case
python3 - "$STATE" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); s['assistant-web']['spec']['template']['spec']['containers'][0]['image']='us-west1-docker.pkg.dev/bmson-assistant/assistant/web:other-tag'; open(p,'w').write(json.dumps(s))
PY
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 1; then fail 'different service template image tag must fail'; fi
reset_case
if release_preflight_legacy_firestore_bootstrap agent,web 2 1 1; then fail 'candidate API mismatch must fail'; fi
reset_case
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 2; then fail 'candidate schema mismatch must fail'; fi
reset_case
python3 - "$STATE" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); s['assistant-web']['status']['traffic'].append({'revisionName':'assistant-web-extra','percent':1}); s['assistant-web']['status']['traffic'][0]['percent']=99; open(p,'w').write(json.dumps(s))
PY
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 1; then fail 'split serving traffic must fail'; fi
reset_case; export BAD_REVISION_DIGEST=1
if release_preflight_legacy_firestore_bootstrap agent,web 1 1 1; then fail 'revision image digest mismatch must fail'; fi
echo 'legacy Firestore bootstrap profile tests passed'
