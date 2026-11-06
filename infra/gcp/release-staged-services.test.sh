#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/assistant-staged-release.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"
export STUB_ROOT="$TEST_ROOT" STUB_CURL_CALLS="$TEST_ROOT/curl-calls" STUB_RELEASE_CALLS="$TEST_ROOT/release-calls" STUB_SERVICE_UPDATE_CALLS="$TEST_ROOT/service-update-calls" STUB_DRAIN_CALLS="$TEST_ROOT/drain-calls" STUB_ADMISSION_CALLS="$TEST_ROOT/admission-calls" STUB_ADMISSION_COMMANDS="$TEST_ROOT/admission-commands" PROJECT=test-project REGION=us-west1 TAG=abc123
export IMAGE_ROOT=us-west1-docker.pkg.dev/test-project/assistant RELEASE_HEALTH_ATTEMPTS=1 RELEASE_HEALTH_INTERVAL_SECONDS=0 RELEASE_MANIFEST_PATH="$TEST_ROOT/manifest.json"
POSTGRES_SCHEMA_VERSION="$(node "$ROOT/release-schema-version.mjs" postgres)"
POSTGRES_PREVIOUS_SCHEMA_VERSION=$((POSTGRES_SCHEMA_VERSION - 1))
export POSTGRES_SCHEMA_VERSION POSTGRES_PREVIOUS_SCHEMA_VERSION
cat >"$TEST_ROOT/state.json" <<JSON
{"assistant-agent":{"revision":"agent-old","traffic":{"agent-old":100},"env":{"QUEUE_DRIVER":"cloudtasks","ASSISTANT_RELEASE_API_CONTRACT":"1","ASSISTANT_RELEASE_SCHEMA_DRIVER":"postgres","ASSISTANT_RELEASE_SCHEMA_VERSION":"${POSTGRES_SCHEMA_VERSION}","ASSISTANT_RELEASE_WEB_API_MIN":"1","ASSISTANT_RELEASE_WEB_API_MAX":"1","ASSISTANT_RELEASE_SCHEMA_DRIVER":"postgres","ASSISTANT_RELEASE_SCHEMA_MIN":"${POSTGRES_SCHEMA_VERSION}","ASSISTANT_RELEASE_SCHEMA_MAX":"${POSTGRES_SCHEMA_VERSION}"},"next":0},"assistant-web":{"revision":"web-old","traffic":{"web-old":100},"env":{"ASSISTANT_RELEASE_API_CONTRACT":"1","ASSISTANT_RELEASE_AGENT_API_MIN":"1","ASSISTANT_RELEASE_AGENT_API_MAX":"1","ASSISTANT_RELEASE_SCHEMA_DRIVER":"postgres","ASSISTANT_RELEASE_SCHEMA_MIN":"${POSTGRES_SCHEMA_VERSION}","ASSISTANT_RELEASE_SCHEMA_MAX":"${POSTGRES_SCHEMA_VERSION}"},"next":0},"assistant-browser":{"image":"registry/old-browser","next":0},"assistant-processor":{"image":"registry/old-processor","next":0}}
JSON
cat >"$TEST_ROOT/bin/gcloud" <<'PY'
#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p=Path(os.environ['STUB_ROOT'])/'state.json'; s=json.loads(p.read_text()); a=sys.argv[1:]
if a[:4]==['run','services','update-traffic','assistant-agent'] or a[:4]==['run','services','update-traffic','assistant-web']:
 with open(os.environ['STUB_RELEASE_CALLS'],'a') as f: f.write('gcloud '+' '.join(a)+'\n')
def val(k):
 for i,x in enumerate(a):
  if x==k and i+1<len(a): return a[i+1]
  if x.startswith(k+'='): return x.split('=',1)[1]
 return ''
if a[:3]==['run','services','update-traffic']:
 with open(os.environ['STUB_ADMISSION_CALLS'],'a') as f: f.write('traffic:'+a[3]+':'+val('--to-revisions')+'\n')
def save(): p.write_text(json.dumps(s))
if a[:3]==['artifacts','docker','images']:
 image=a[4] if len(a)>4 else ''
 if os.getenv('FAIL_AGENT_BUILD')=='1' and '/agent:' in image: sys.exit(1)
 print('sha256:'+('a' if '/agent:' in image else 'b')*64); sys.exit(0)
if a[:3]==['run','jobs','describe']:
 name=a[3]; containers=[{'image':s[name]['image']}]
 shape=os.getenv('STUB_JOB_SHAPE','v1')
 job={'template':{'template':{'containers':containers}}} if shape=='v2' else {'spec':{'template':{'spec':{'template':{'spec':{'containers':containers}}}}}}
 print(json.dumps(job)); sys.exit(0)
if a[:3]==['run','jobs','update']:
 name=a[3]; s[name]['next']+=1
 image=val('--image')
 if os.getenv('FAIL_WORKER_UPDATE')=='1': sys.exit(1)
 s[name]['image']=('registry/stale' if os.getenv('STALE_WORKER_IMAGE')=='1' and 'sha256:' in image else image)
 save(); sys.exit(0)
if a[:3]==['run','services','describe']:
 name=a[3]; svc=s[name]
 if '--format=json' in a:
  traffic=[]
  for revision,pct in svc['traffic'].items():
   tags=[x for x in svc.get('tags',[]) if x['revision']==revision]
   if tags:
    traffic += [{'revisionName':revision,'tag':x['tag'],'percent':pct if index==0 else 0,'url':f"https://{x['tag']}-{name}.example"} for index,x in enumerate(tags)]
   else:
    traffic.append({'revisionName':revision,'percent':pct})
  active_revisions=set(svc['traffic'])
  traffic += [{'revisionName':x['revision'],'tag':x['tag'],'percent':0,'url':f"https://{x['tag']}-{name}.example"} for x in svc.get('tags',[]) if x['revision'] not in active_revisions]
  traffic += [{'revisionName':x['revision'],'tag':x['tag'],'percent':0,'url':f"https://{x['tag']}-{name}.example"} for x in svc.get('staged',[])]
  print(json.dumps({'spec':{'template':{'spec':{'containers':[{'env':[{'name':k,'value':v} for k,v in svc['env'].items()]}] }}},'status':{'url':f'https://{name}.example','traffic':traffic}})); sys.exit(0)
 if 'value(status.url)' in ' '.join(a): print(f'https://{name}.example'); sys.exit(0)
if a[:3]==['run','revisions','describe']:
 revision=a[3]
 if os.getenv('FAIL_RESUME_DRAIN')=='1' and revision=='assistant-web-new2' and not any(x.get('revision')==revision for x in s['assistant-web'].get('staged',[])): sys.exit(1)
 for name,svc in s.items():
  if not isinstance(svc,dict): continue
  if svc.setdefault('revision',None) and svc.get('revision') not in svc.setdefault('revisions',{}):
   svc['revisions'][svc['revision']]={'env':dict(svc.get('env',{}))}; save()
  if revision in svc['revisions']:
   env=svc['revisions'][revision].get('env',{})
   spec={'containers':[{'image':svc['revisions'][revision].get('image','legacy-image'),'env':[{'name':k,'value':v} for k,v in env.items()]}]}
   if os.getenv('STUB_WEB_TIMEOUT_MISSING')!='1': spec['timeoutSeconds']=int(os.getenv('STUB_WEB_TIMEOUT_SECONDS','300'))
   print(json.dumps({'metadata':{'name':revision},'spec':spec})); sys.exit(0)
  for stage in svc.get('staged',[]):
   if revision==stage['revision']:
    env=stage.get('env',{})
    spec={'containers':[{'image':stage.get('image',''),'env':[{'name':k,'value':v} for k,v in env.items()]}]}
    if os.getenv('STUB_WEB_TIMEOUT_MISSING')!='1': spec['timeoutSeconds']=int(os.getenv('STUB_WEB_TIMEOUT_SECONDS','300'))
    print(json.dumps({'metadata':{'name':revision},'spec':spec})); sys.exit(0)
 print('{}'); sys.exit(1)
if a[:3]==['run','services','update']:
 with open(os.environ['STUB_SERVICE_UPDATE_CALLS'],'a') as f: f.write(json.dumps(a)+'\n')
 name=a[3]
 if len(name)+len(val('--tag'))>46:
  print('traffic tag and service exceed Cloud Run limit', file=sys.stderr); sys.exit(2)
 if name=='assistant-agent' and os.getenv('FAIL_AGENT_STAGE')=='1': sys.exit(1)
 svc=s[name]; svc['next']+=1; rev=f"{name}-new{svc['next']}"
 for item in val('--update-env-vars').split(','):
  if '=' in item:
   k,v=item.split('=',1); svc['env'][k]=v
 svc.setdefault('staged',[]).append({'revision':rev,'tag':val('--tag'),'image':val('--image'),'env':dict(svc['env'])}); svc.setdefault('revisions',{})[rev]={'env':dict(svc['env']),'image':val('--image')}; save()
 with open(os.environ['STUB_ADMISSION_CALLS'],'a') as f: f.write('stage:'+name+':'+val('--tag')+':'+svc['env'].get('ASSISTANT_RELEASE_WRITES_PAUSED','')+'\n')
 if name=='assistant-web' and svc['env'].get('ASSISTANT_RELEASE_WRITES_PAUSED')=='false' and os.getenv('FAIL_RESUME_STAGE_UNCERTAIN')=='1': sys.exit(1)
 sys.exit(0)
if a[:3]==['run','services','update-traffic']:
 name=a[3]; mapping=val('--to-revisions'); svc=s[name]
 if '--remove-tags' in a:
  if os.getenv('FAIL_TAG_REMOVAL')=='1': sys.exit(1)
  tags=set(val('--remove-tags').split(','))
  svc['staged']=[stage for stage in svc.get('staged',[]) if stage.get('tag') not in tags]
  svc['tags']=[tag for tag in svc.get('tags',[]) if tag.get('tag') not in tags]
  if os.getenv('MUTATE_TRAFFIC_AFTER_TAG_REMOVAL')=='1': svc['traffic']={'web-raced':100}
  save(); sys.exit(0)
 if name=='assistant-agent' and os.getenv('FAIL_AGENT_PROMOTE')=='1' and 'agent-new' in mapping: sys.exit(1)
 if name=='assistant-web' and os.getenv('FAIL_WEB_PROMOTE')=='1' and 'web-new' in mapping: sys.exit(1)
 if name=='assistant-web' and os.getenv('FAIL_REPAUSE')=='1' and 'assistant-web-new1=100' in mapping and 'assistant-web-new2' in svc.get('traffic',{}): sys.exit(1)
 if name=='assistant-web' and mapping=='assistant-web-new1=100' and 'assistant-web-new2' in svc.get('traffic',{}) and os.getenv('REASSIGN_RESUME_TAG_ON_REPAUSE')=='1':
  for stage in svc.get('staged',[]):
   if stage['tag'].startswith('resume-'): stage['revision']='foreign-revision'
 svc['traffic']={}
 for item in mapping.split(','):
  r,pct=item.split('=',1); svc['traffic'][r]=int(pct)
 if os.getenv('ADD_FOREIGN_TAG_TO_PROMOTED_REVISION')=='1' and name=='assistant-web':
  revision=next(iter(svc['traffic']))
  svc.setdefault('tags',[]).append({'revision':revision,'tag':'operator-canary'})
 save(); sys.exit(0)
print('unexpected gcloud: '+' '.join(a),file=sys.stderr); sys.exit(90)
PY
cat >"$TEST_ROOT/bin/curl" <<'PY'
#!/usr/bin/env python3
import json,os,sys
url=sys.argv[-1]; path=url.split('.example',1)[-1]
s=json.load(open(os.path.join(os.environ['STUB_ROOT'],'state.json')))
with open(os.environ['STUB_CURL_CALLS'],'a') as f: f.write(json.dumps({'url':url,'web':s['assistant-web']['traffic'],'agent':s['assistant-agent']['traffic']})+'\n')
with open(os.environ['STUB_ADMISSION_CALLS'],'a') as f: f.write('probe:'+url+'\n')
agent_new=any('new' in r for r in s['assistant-agent']['traffic'])
web_new=any('new' in r for r in s['assistant-web']['traffic'])
legacy_live_web=url.startswith('https://assistant-web.example/') and not web_new
if path=='/ready': print('{"ready":false}' if os.getenv('UNHEALTHY_AGENT')=='1' else '{"ready":true}')
elif path=='/api/health':
 print(json.dumps({'ok':True,'service':'web','sha':'wrong' if os.getenv('UNHEALTHY_WEB')=='1' or (os.getenv('UNHEALTHY_LIVE_WEB')=='1' and 'assistant-web.example' in url) else os.environ['TAG']}))
elif path=='/api/ready':
 if legacy_live_web: sys.exit(22)
 print('{"ready":true}')
elif path=='/api/release-probe':
 if legacy_live_web: sys.exit(22)
 fail=(os.getenv('CANDIDATE_WEB_PROBE_FAIL')=='1' and 'candidate-' in url) or (os.getenv('FINAL_NEW_PAIR_PROBE_FAIL')=='1' and web_new and agent_new)
 fail=fail or (os.getenv('RESUME_WEB_PROBE_FAIL')=='1' and 'resume-' in url)
 if os.getenv('RESUME_LIVE_PROBE_FAIL')=='1' and url.startswith('https://assistant-web.example/'):
  if any('new' in rev for rev in s['assistant-web']['traffic']) and s['assistant-web']['env'].get('ASSISTANT_RELEASE_WRITES_PAUSED')=='false': fail=True
 if url.startswith('https://candidate-') or url.startswith('https://resume-'):
  tag=url.split('https://',1)[1].split('-assistant-web.example',1)[0]
  stage=next((x for x in s['assistant-web'].get('staged',[]) if x['tag']==tag),None)
  paused=(stage or {}).get('env',{}).get('ASSISTANT_RELEASE_WRITES_PAUSED','false')
 else:
  paused=s['assistant-web']['env'].get('ASSISTANT_RELEASE_WRITES_PAUSED','false')
 print(json.dumps({'ready':not fail,'writesPaused':paused=='true'}))
else: print('{}')
PY
chmod +x "$TEST_ROOT/bin/gcloud" "$TEST_ROOT/bin/curl"
export PATH="$TEST_ROOT/bin:$PATH"
cat >"$TEST_ROOT/bin/sleep" <<'PY'
#!/usr/bin/env python3
import os,sys
with open(os.environ['STUB_DRAIN_CALLS'],'a') as f: f.write(sys.argv[1]+'\n')
with open(os.environ['STUB_ADMISSION_CALLS'],'a') as f: f.write('drain:'+sys.argv[1]+'\n')
PY
chmod +x "$TEST_ROOT/bin/sleep"
source "$ROOT/release-staged-services.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
cat >"$TEST_ROOT/bin/pnpm" <<'PY'
#!/usr/bin/env python3
import json,os,sys
with open(os.environ['STUB_ADMISSION_COMMANDS'],'a') as f:
 f.write(json.dumps({'source':os.getenv('OWNER_TAG_RELEASE_SOURCE'),
  'manifestPath':os.getenv('OWNER_TAG_MANIFEST_PATH'),
  'manifestDigest':os.getenv('OWNER_TAG_MANIFEST_DIGEST'),
  'stagingTag':os.getenv('OWNER_TAG_STAGING_TAG'),
  'args':sys.argv[1:]})+'\n')
PY
chmod +x "$TEST_ROOT/bin/pnpm"
admission_source='a8f6d2e3b74265c9a10f4d8e6b2c7a9012345678'
admission_digest='f3a41b7298d65c0e4b1a73d9c5e8f201a4b6c8d0e2f517394b6d8a0c2e4f6173'
release_capture_owned_web_tags "$admission_source" "$RELEASE_MANIFEST_PATH" "$admission_digest" candidate-12345-1 || fail 'capture wrapper should invoke the fixed observation command'
release_retire_captured_web_tags "$admission_source" "$RELEASE_MANIFEST_PATH" "$admission_digest" candidate-12345-1 || fail 'retirement wrapper should invoke the fixed barrier command'
release_verify_owned_web_tag_admission "$admission_source" "$RELEASE_MANIFEST_PATH" "$admission_digest" candidate-12345-1 || fail 'verification wrapper should invoke the fixed admission command'
release_record_owned_web_tag candidate "$admission_source" "$RELEASE_MANIFEST_PATH" "$admission_digest" candidate-12345-1 || fail 'candidate receipt wrapper should invoke the fixed record command'
release_record_owned_web_tag resume "$admission_source" "$RELEASE_MANIFEST_PATH" "$admission_digest" candidate-12345-1 || fail 'resume receipt wrapper should invoke the fixed record command'
python3 - "$STUB_ADMISSION_COMMANDS" "$admission_source" "$RELEASE_MANIFEST_PATH" "$admission_digest" <<'PY'
import json,sys
rows=[json.loads(x) for x in open(sys.argv[1])]
assert [x['args'] for x in rows]==[
 ['exec','tsx','scripts/owner-web-tag-admission.ts','--capture'],
 ['exec','tsx','scripts/owner-web-tag-admission.ts','--retire-after-paused'],
 ['exec','tsx','scripts/owner-web-tag-admission.ts','--verify-admission'],
 ['exec','tsx','scripts/owner-web-tag-admission.ts','--record-candidate'],
 ['exec','tsx','scripts/owner-web-tag-admission.ts','--record-resume'],
], rows
for row in rows:
 assert row['source']==sys.argv[2] and row['manifestPath']==sys.argv[3] and row['manifestDigest']==sys.argv[4], row
assert [x['stagingTag'] for x in rows]==['candidate-12345-1']*5, rows
PY
TEST_BASIC5_CAPABILITY=false
release_basic_editor_forward_only() { printf '%s' "$TEST_BASIC5_CAPABILITY"; }
release_capture_owned_web_tags() {
  printf 'capture:%s:%s:%s:%s\n' "$1" "$2" "$3" "$4" >>"$STUB_ADMISSION_CALLS"
  [[ "${FAIL_ADMISSION_CAPTURE:-0}" != 1 ]]
}
release_initialize_basic_web_lifecycle() {
  printf 'native-init:%s:%s:%s:%s\n' "$1" "$2" "$3" "$4" >>"$STUB_ADMISSION_CALLS"
}
release_wait_for_basic_web_operator_hold() {
  printf 'native-hold:%s:%s:%s:%s\n' "$1" "$2" "$3" "$4" >>"$STUB_ADMISSION_CALLS"
}
release_accept_basic_web_agent_ready() {
  printf 'agent-ready:%s:%s:%s:%s\n' "$1" "$2" "$3" "$4" >>"$STUB_ADMISSION_CALLS"
  [[ "${FAIL_AGENT_READY_RECEIPT:-0}" != 1 ]]
}
release_run_basic_web_phase() {
  local phase="$1" source="$2" digest="$4" tag="$5" suffix image env
  printf 'native-phase:%s\n' "$phase" >>"$STUB_ADMISSION_CALLS"
  suffix="${tag#candidate-}"
  image="${IMAGE_ROOT}/web@$(release_component_digest web)"
  case "$phase" in
    createP)
      env="ASSISTANT_RELEASE_API_CONTRACT=${RELEASE_WEB_API},ASSISTANT_RELEASE_AGENT_API_MIN=${RELEASE_WEB_PEER_MIN},ASSISTANT_RELEASE_AGENT_API_MAX=${RELEASE_WEB_PEER_MAX},ASSISTANT_RELEASE_SCHEMA_DRIVER=${RELEASE_STORAGE_DRIVER},ASSISTANT_RELEASE_SCHEMA_MIN=${RELEASE_WEB_SCHEMA_MIN},ASSISTANT_RELEASE_SCHEMA_MAX=${RELEASE_WEB_SCHEMA_MAX},ASSISTANT_RELEASE_SCHEMA_VERSION=${RELEASE_SCHEMA_VERSION},ASSISTANT_RELEASE_MANIFEST=${digest},ASSISTANT_RELEASE_WRITES_PAUSED=true,ASSISTANT_RELEASE_WORKFLOW_RUN_ID=${GITHUB_RUN_ID},ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT=${GITHUB_RUN_ATTEMPT},ASSISTANT_RELEASE_SOURCE_SHA=${source}"
      gcloud run services update assistant-web --project "$PROJECT" --region "$REGION" --image "$image" --no-traffic --tag "$tag" --update-env-vars "$env" --quiet
      ;;
    attachP|attachR) : ;;
    promoteP) gcloud run services update-traffic assistant-web --project "$PROJECT" --region "$REGION" --to-revisions assistant-web-new1=100 --quiet ;;
    createR)
      env="ASSISTANT_RELEASE_API_CONTRACT=${RELEASE_WEB_API},ASSISTANT_RELEASE_AGENT_API_MIN=${RELEASE_WEB_PEER_MIN},ASSISTANT_RELEASE_AGENT_API_MAX=${RELEASE_WEB_PEER_MAX},ASSISTANT_RELEASE_SCHEMA_DRIVER=${RELEASE_STORAGE_DRIVER},ASSISTANT_RELEASE_SCHEMA_MIN=${RELEASE_WEB_SCHEMA_MIN},ASSISTANT_RELEASE_SCHEMA_MAX=${RELEASE_WEB_SCHEMA_MAX},ASSISTANT_RELEASE_SCHEMA_VERSION=${RELEASE_SCHEMA_VERSION},ASSISTANT_RELEASE_MANIFEST=${digest},ASSISTANT_RELEASE_WRITES_PAUSED=false,ASSISTANT_RELEASE_WORKFLOW_RUN_ID=${GITHUB_RUN_ID},ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT=${GITHUB_RUN_ATTEMPT},ASSISTANT_RELEASE_SOURCE_SHA=${source}"
      gcloud run services update assistant-web --project "$PROJECT" --region "$REGION" --image "$image" --no-traffic --tag "resume-${suffix}" --update-env-vars "$env" --quiet
      ;;
    promoteR) gcloud run services update-traffic assistant-web --project "$PROJECT" --region "$REGION" --to-revisions assistant-web-new2=100 --quiet ;;
    repauseP) gcloud run services update-traffic assistant-web --project "$PROJECT" --region "$REGION" --to-revisions assistant-web-new1=100 --quiet ;;
    closeP) gcloud run services update-traffic assistant-web --project "$PROJECT" --region "$REGION" --remove-tags "$tag" --quiet ;;
    closeR)
      [[ "${REASSIGN_RESUME_TAG_ON_REPAUSE:-0}" != 1 ]] || return 1
      gcloud run services update-traffic assistant-web --project "$PROJECT" --region "$REGION" --remove-tags "resume-${suffix}" --quiet
      ;;
    restoreC) gcloud run services update-traffic assistant-web --project "$PROJECT" --region "$REGION" --to-revisions web-old=100 --quiet ;;
    *) return 2 ;;
  esac
}
release_retire_captured_web_tags() {
  printf 'retire:%s:%s:%s:%s:%s\n' "$1" "$2" "$3" "$4" "${OWNED_TAGS_ALREADY_ABSENT:-0}" >>"$STUB_ADMISSION_CALLS"
  [[ "${FAIL_ADMISSION_RETIRE:-0}" != 1 ]] || return 1
}
release_verify_owned_web_tag_admission() {
  printf 'verify:%s:%s:%s:%s:%s\n' "$1" "$2" "$3" "$4" "${FAIL_ADMISSION_VERIFY:-0}" >>"$STUB_ADMISSION_CALLS"
  [[ "${FAIL_ADMISSION_VERIFY:-0}" != 1 ]]
}
release_record_owned_web_tag() {
  printf 'record:%s:%s:%s:%s:%s:%s\n' "$1" "$2" "$3" "$4" "$5" "${FAIL_CANDIDATE_RECEIPT:-0}:${FAIL_RESUME_RECEIPT:-0}" >>"$STUB_ADMISSION_CALLS"
  if [[ "$1" == candidate && "${FAIL_CANDIDATE_RECEIPT:-0}" == 1 ]]; then return 1; fi
  if [[ "$1" == resume && "${FAIL_RESUME_RECEIPT:-0}" == 1 ]]; then return 1; fi
  return 0
}
v1_job='{"spec":{"template":{"spec":{"template":{"spec":{"containers":[{"image":"registry/v1-image"}]}}}}}}'
v2_job='{"template":{"template":{"containers":[{"image":"registry/v2-image"}]}}}'
[[ "$(release_job_image "$v1_job")" == registry/v1-image ]] || { echo 'v1 job image path not parsed' >&2; exit 1; }
[[ "$(release_job_image "$v2_job")" == registry/v2-image ]] || { echo 'v2 job image path not parsed' >&2; exit 1; }
reset_case() {
 cat >"$TEST_ROOT/state.json" <<JSON
{"assistant-agent":{"revision":"agent-old","traffic":{"agent-old":100},"env":{"QUEUE_DRIVER":"cloudtasks","ASSISTANT_RELEASE_API_CONTRACT":"1","ASSISTANT_RELEASE_SCHEMA_DRIVER":"postgres","ASSISTANT_RELEASE_SCHEMA_VERSION":"${POSTGRES_SCHEMA_VERSION}","ASSISTANT_RELEASE_WEB_API_MIN":"1","ASSISTANT_RELEASE_WEB_API_MAX":"1","ASSISTANT_RELEASE_SCHEMA_DRIVER":"postgres","ASSISTANT_RELEASE_SCHEMA_MIN":"${POSTGRES_SCHEMA_VERSION}","ASSISTANT_RELEASE_SCHEMA_MAX":"${POSTGRES_SCHEMA_VERSION}"},"next":0},"assistant-web":{"revision":"web-old","traffic":{"web-old":100},"env":{"ASSISTANT_RELEASE_API_CONTRACT":"1","ASSISTANT_RELEASE_AGENT_API_MIN":"1","ASSISTANT_RELEASE_AGENT_API_MAX":"1","ASSISTANT_RELEASE_SCHEMA_DRIVER":"postgres","ASSISTANT_RELEASE_SCHEMA_MIN":"${POSTGRES_SCHEMA_VERSION}","ASSISTANT_RELEASE_SCHEMA_MAX":"${POSTGRES_SCHEMA_VERSION}"},"next":0},"assistant-browser":{"image":"registry/old-browser","next":0},"assistant-processor":{"image":"registry/old-processor","next":0}}
JSON
 unset FAIL_AGENT_BUILD FAIL_AGENT_STAGE UNHEALTHY_AGENT UNHEALTHY_WEB UNHEALTHY_LIVE_WEB \
    CANDIDATE_WEB_PROBE_FAIL FINAL_NEW_PAIR_PROBE_FAIL RESUME_WEB_PROBE_FAIL RESUME_LIVE_PROBE_FAIL \
    FAIL_AGENT_PROMOTE FAIL_WEB_PROMOTE FAIL_REPAUSE FAIL_RESUME_DRAIN STUB_WEB_TIMEOUT_SECONDS STUB_WEB_TIMEOUT_MISSING \
    FAIL_WORKER_UPDATE STALE_WORKER_IMAGE FAIL_TAG_REMOVAL MUTATE_TRAFFIC_AFTER_TAG_REMOVAL \
    ADD_FOREIGN_TAG_TO_PROMOTED_REVISION FAIL_RESUME_STAGE_UNCERTAIN REASSIGN_RESUME_TAG_ON_REPAUSE AGENT_IMAGE_PUSH_DIGEST \
    FAIL_ADMISSION_CAPTURE FAIL_ADMISSION_RETIRE FAIL_ADMISSION_VERIFY FAIL_CANDIDATE_RECEIPT FAIL_RESUME_RECEIPT FAIL_AGENT_READY_RECEIPT OWNED_TAGS_ALREADY_ABSENT
 : >"$STUB_CURL_CALLS"
 : >"$STUB_RELEASE_CALLS"
 : >"$STUB_SERVICE_UPDATE_CALLS"
 : >"$STUB_DRAIN_CALLS"
 : >"$STUB_ADMISSION_CALLS"
 TEST_BASIC5_CAPABILITY=false
 unset RELEASE_EMAIL_OBSERVER_WORKER_ENABLED
 export RELEASE_COMPONENTS=agent,web RELEASE_MODULES=none RELEASE_PERSISTENCE_DRIVER=postgres
 export PROJECT=test-project REGION=us-west1 REPO=assistant IMAGE_ROOT=us-west1-docker.pkg.dev/test-project/assistant
}
prepare_firestore_state() {
 export RELEASE_PERSISTENCE_DRIVER=firestore
 export PROJECT=bmson-assistant REGION=us-west1 REPO=assistant IMAGE_ROOT=us-west1-docker.pkg.dev/bmson-assistant/assistant
 export TAG=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa GITHUB_RUN_ID=12345 GITHUB_RUN_ATTEMPT=1
 export GITHUB_ACTIONS=true GITHUB_REPOSITORY=bmson/assistant GITHUB_REF=refs/heads/main
 export GITHUB_EVENT_NAME=workflow_run GITHUB_WORKFLOW_REF=bmson/assistant/.github/workflows/deploy.yml@refs/heads/main
 export GITHUB_SHA="$TAG" GITHUB_WORKFLOW_SHA="$TAG"
 TEST_BASIC5_CAPABILITY=true
 python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p))
for service in ('assistant-agent','assistant-web'):
    env=s[service]['env']; env['ASSISTANT_RELEASE_SCHEMA_DRIVER']='firestore'; env['ASSISTANT_RELEASE_SCHEMA_MIN']='1'; env['ASSISTANT_RELEASE_SCHEMA_MAX']='1'
open(p,'w').write(json.dumps(s))
PY
}
assert_old_traffic() { python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); assert s['assistant-agent']['traffic']=={'agent-old':100}; assert s['assistant-web']['traffic']=={'web-old':100}
PY
}
reset_case; export AGENT_IMAGE_PUSH_DIGEST=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
if release_staged_services; then fail 'agent release must reject a digest that differs from the smoke/push receipt'; fi
assert_old_traffic
[[ ! -s "$STUB_SERVICE_UPDATE_CALLS" ]] || fail 'digest mismatch must fail before staging services'
reset_case; export AGENT_IMAGE_PUSH_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
release_staged_services || fail 'matching agent smoke/push digest should reach the existing release path'
reset_case; export FAIL_AGENT_BUILD=1
if release_staged_services; then fail 'agent image failure should stop before staging'; fi
assert_old_traffic
reset_case; export UNHEALTHY_AGENT=1
if release_staged_services; then fail 'unhealthy staged agent should stop before promotion'; fi
assert_old_traffic
reset_case; export UNHEALTHY_WEB=1
if release_staged_services; then fail 'web health failure should stop before promotion'; fi
assert_old_traffic
reset_case; export CANDIDATE_WEB_PROBE_FAIL=1
if release_staged_services; then fail 'tagged new web must fail closed when its old-agent probe fails'; fi
assert_old_traffic
[[ ! -s "$STUB_RELEASE_CALLS" ]] || fail 'a failed tagged candidate must not move traffic'
reset_case; export FAIL_AGENT_PROMOTE=1
if release_staged_services; then fail 'uncertain agent promotion result must restore the captured traffic map'; fi
assert_old_traffic
reset_case; export FAIL_WEB_PROMOTE=1
if release_staged_services; then fail 'uncertain first web promotion must restore captured traffic'; fi
assert_old_traffic
reset_case
release_preflight_compatibility agent,web || fail 'fixture baseline must be compatible before serving-revision mismatch control'
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); env=s['assistant-agent']['revisions']['agent-old']['env']; old=__import__('os').environ['POSTGRES_PREVIOUS_SCHEMA_VERSION']; env['ASSISTANT_RELEASE_SCHEMA_MIN']=old; env['ASSISTANT_RELEASE_SCHEMA_MAX']=old; open(p,'w').write(json.dumps(s))
PY
if release_preflight_compatibility agent,web; then fail 'historical live agent metadata must not be broadened implicitly'; fi
python3 - "$TEST_ROOT/state.json" <<'PYCONTROL'
import json,sys
import os
s=json.load(open(sys.argv[1])); env=s['assistant-agent']['env']; live=s['assistant-agent']['revisions']['agent-old']['env']; current=os.environ['POSTGRES_SCHEMA_VERSION']; old=os.environ['POSTGRES_PREVIOUS_SCHEMA_VERSION']; assert env['ASSISTANT_RELEASE_SCHEMA_MIN']==current; assert env['ASSISTANT_RELEASE_SCHEMA_MAX']==current; assert live['ASSISTANT_RELEASE_SCHEMA_MIN']==old; assert live['ASSISTANT_RELEASE_SCHEMA_MAX']==old
PYCONTROL
reset_case; export RELEASE_EMAIL_OBSERVER_WORKER_ENABLED=bogus
if release_staged_services; then fail 'invalid worker flag must fail before staging'; fi
[[ ! -s "$STUB_SERVICE_UPDATE_CALLS" && ! -s "$STUB_RELEASE_CALLS" ]] || fail 'invalid worker flag reached a staging or traffic mutation'
assert_old_traffic
reset_case; export RELEASE_EMAIL_OBSERVER_WORKER_ENABLED='true,OTHER=value'
if release_staged_services; then fail 'delimiter injection in worker flag must fail before staging'; fi
[[ ! -s "$STUB_SERVICE_UPDATE_CALLS" && ! -s "$STUB_RELEASE_CALLS" ]] || fail 'delimiter injection reached a staging or traffic mutation'
assert_old_traffic
reset_case; export RELEASE_EMAIL_OBSERVER_WORKER_ENABLED=''
release_staged_services || fail 'empty worker override should behave as unset'
python3 - "$STUB_SERVICE_UPDATE_CALLS" <<'PY'
import json,sys
calls=[json.loads(line) for line in open(sys.argv[1])]
agent=next(x for x in calls if x[3]=='assistant-agent')
web=next(x for x in calls if x[3]=='assistant-web')
assert 'EMAIL_OBSERVER_WORKER_ENABLED=' not in agent[agent.index('--update-env-vars')+1]
assert 'EMAIL_OBSERVER_WORKER_ENABLED=' not in web[web.index('--update-env-vars')+1]
PY
reset_case; export RELEASE_EMAIL_OBSERVER_WORKER_ENABLED=false
release_staged_services || fail 'explicit false worker override should promote'
python3 - "$STUB_SERVICE_UPDATE_CALLS" <<'PY'
import json,sys
calls=[json.loads(line) for line in open(sys.argv[1])]
agent=next(x for x in calls if x[3]=='assistant-agent')
web=next(x for x in calls if x[3]=='assistant-web')
assert 'EMAIL_OBSERVER_WORKER_ENABLED=false' in agent[agent.index('--update-env-vars')+1]
assert 'EMAIL_OBSERVER_WORKER_ENABLED=' not in web[web.index('--update-env-vars')+1]
PY
reset_case; export RELEASE_EMAIL_OBSERVER_WORKER_ENABLED=true
release_staged_services || fail 'explicit true worker override should promote'
python3 - "$STUB_SERVICE_UPDATE_CALLS" <<'PY'
import json,sys
calls=[json.loads(line) for line in open(sys.argv[1])]
agent=next(x for x in calls if x[3]=='assistant-agent')
web=next(x for x in calls if x[3]=='assistant-web')
assert 'EMAIL_OBSERVER_WORKER_ENABLED=true' in agent[agent.index('--update-env-vars')+1]
assert 'EMAIL_OBSERVER_WORKER_ENABLED=' not in web[web.index('--update-env-vars')+1]
PY
reset_case
release_preflight_compatibility agent,web || fail 'compatible declared live/new contracts should pass preflight'
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); s['assistant-agent']['revisions']['agent-old']['env']['ASSISTANT_RELEASE_SCHEMA_MAX']='99'; open(p,'w').write(json.dumps(s))
PY
if release_preflight_compatibility agent,web; then fail 'schema incompatibility must fail before migration'; fi
reset_case
release_staged_services || fail 'compatible pair should promote with a legacy web that lacks /api/ready and /api/release-probe'
python3 - "$TEST_ROOT/state.json" "$STUB_RELEASE_CALLS" "$STUB_CURL_CALLS" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); assert list(s['assistant-agent']['traffic'])[0].startswith('assistant-agent-new'); assert list(s['assistant-web']['traffic'])[0].startswith('assistant-web-new')
release_calls=open(sys.argv[2]).read().splitlines()
web=next(i for i,x in enumerate(release_calls) if 'update-traffic assistant-web ' in x and 'assistant-web-new' in x)
agent=next(i for i,x in enumerate(release_calls) if 'update-traffic assistant-agent ' in x and 'assistant-agent-new' in x)
assert web < agent, 'new web must be promoted and checked against old agent before agent promotion'
probes=[json.loads(line) for line in open(sys.argv[3])]
candidate=[x for x in probes if x['url'].startswith('https://candidate-') and x['url'].endswith('-assistant-web.example/api/release-probe')]
assert candidate and all('new' not in next(iter(x['agent'])) for x in candidate), 'tagged web must prove new-web/old-agent compatibility'
live=[x for x in probes if x['url'].startswith('https://assistant-web.example/')]
assert live and all(any('new' in revision for revision in x['web']) for x in live), 'the old web, whose routes return 404, must never receive a compatibility probe'
assert any(x['url'].endswith('/api/release-probe') and 'new' not in next(iter(x['agent'])) for x in live), 'promoted web must be probed against old agent before agent promotion'
assert any(x['url'].endswith('/api/release-probe') and any('new' in revision for revision in x['agent']) for x in live), 'promoted web must be probed again against new agent'
PY
reset_case
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p))
s['assistant-agent']['tags']=[
    {'revision':'agent-old','tag':'candidate-12345-1'},
    {'revision':'agent-old','tag':'candidate-foreign'},
    {'revision':'agent-old','tag':'candidate-12345-x'},
    {'revision':'agent-old','tag':'candidate-12345'},
]
s['assistant-web']['tags']=[
    {'revision':'web-old','tag':'candidate-12345-1'},
    {'revision':'web-old','tag':'resume-12345-1'},
    {'revision':'web-old','tag':'candidate-foreign'},
    {'revision':'web-old','tag':'manual-preview'},
    {'revision':'web-old','tag':'resume-12345-1-extra'},
]
open(p,'w').write(json.dumps(s))
PY
export ADD_FOREIGN_TAG_TO_PROMOTED_REVISION=1
release_staged_services || fail 'prior release-owned tags should retire after successful promotion'
python3 - "$TEST_ROOT/state.json" "$STUB_RELEASE_CALLS" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); calls=open(sys.argv[2]).read().splitlines()
for service in ('assistant-agent','assistant-web'):
    tags={entry['tag'] for entry in s[service].get('tags',[])}
    assert 'candidate-foreign' in tags, (service,tags)
    if service=='assistant-web': assert 'manual-preview' in tags, (service,tags)
    assert tags.intersection({'candidate-12345-x','candidate-12345','resume-12345-1-extra'}), (service,tags)
    assert not tags.intersection({'candidate-12345-1','resume-12345-1'}), (service,tags)
    assert any(stage['tag'].startswith('candidate-') for stage in s[service].get('staged',[])), (service,s[service].get('staged'))
web_current=next(iter(s['assistant-web']['traffic']))
assert any(entry['revision']==web_current and entry['tag']=='operator-canary' for entry in s['assistant-web'].get('tags',[])), s['assistant-web'].get('tags')
removals=[line for line in calls if '--remove-tags' in line]
assert len(removals)==3, removals
assert sum('candidate-12345-1' in line for line in removals)==2, removals
assert sum('resume-12345-1' in line for line in removals)==1, removals
assert not any('candidate-foreign' in line for line in removals), removals
PY
reset_case
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p))
s['assistant-web']['traffic']={'web-current':100}
s['assistant-web']['tags']=[{'revision':'web-reassigned','tag':'candidate-12345-1'}]
open(p,'w').write(json.dumps(s))
PY
if release_retire_nonserving_candidate_tag assistant-web candidate-12345-1 '' web-current web-old; then
  fail 'tag reassigned to a different revision must not be retired'
fi
[[ ! -s "$STUB_RELEASE_CALLS" ]] || fail 'reassigned tag reached a removal mutation'
reset_case
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p))
s['assistant-web']['traffic']={'web-current':60,'web-foreign':40}
s['assistant-web']['tags']=[{'revision':'web-old','tag':'candidate-12345-1'}]
open(p,'w').write(json.dumps(s))
PY
if release_retire_nonserving_candidate_tag assistant-web candidate-12345-1 '' web-current web-old; then
  fail 'split traffic must prevent tag retirement'
fi
[[ ! -s "$STUB_RELEASE_CALLS" ]] || fail 'split traffic reached a tag removal mutation'
reset_case
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p))
s['assistant-web']['traffic']={'web-current':100}
s['assistant-web']['tags']=[{'revision':'web-old','tag':'candidate-12345-1'}]
open(p,'w').write(json.dumps(s))
PY
export FAIL_TAG_REMOVAL=1
if release_retire_nonserving_candidate_tag assistant-web candidate-12345-1 '' web-current web-old; then
  fail 'failed tag removal must be reported'
fi
python3 - "$TEST_ROOT/state.json" "$STUB_RELEASE_CALLS" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); calls=open(sys.argv[2]).read().splitlines()
assert s['assistant-web']['tags']==[{'revision':'web-old','tag':'candidate-12345-1'}]
assert len(calls)==1 and '--remove-tags candidate-12345-1 ' in calls[0], calls
PY
unset FAIL_TAG_REMOVAL
reset_case
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p))
s['assistant-web']['traffic']={'web-current':100}
s['assistant-web']['tags']=[{'revision':'web-old','tag':'candidate-12345-1'}]
open(p,'w').write(json.dumps(s))
PY
export MUTATE_TRAFFIC_AFTER_TAG_REMOVAL=1
if release_retire_nonserving_candidate_tag assistant-web candidate-12345-1 '' web-current web-old; then
  fail 'serving traffic change after tag removal must fail post-removal verification'
fi
unset MUTATE_TRAFFIC_AFTER_TAG_REMOVAL
reset_case; export FINAL_NEW_PAIR_PROBE_FAIL=1
if release_staged_services; then fail 'new-web/new-agent probe failure must roll back both services'; fi
assert_old_traffic
python3 - "$STUB_RELEASE_CALLS" <<'PY'
import sys
calls=open(sys.argv[1]).read().splitlines()
updates=[x for x in calls if 'update-traffic ' in x]
assert len(updates)>=4, updates
assert 'assistant-agent' in updates[-2] and 'assistant-web' in updates[-1], 'rollback must reverse agent then web promotion order'
PY
reset_case; export UNHEALTHY_LIVE_WEB=1
if release_staged_services; then fail 'web health failure after promotion must restore captured traffic'; fi
assert_old_traffic
reset_case; export RELEASE_MODULES=browser STALE_WORKER_IMAGE=1
if release_staged_services; then fail 'stale worker template image must block promotion'; fi
assert_old_traffic
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); assert s['assistant-browser']['image']=='registry/old-browser'
PY
reset_case; export RELEASE_COMPONENTS=web RELEASE_SCHEMA_UNCHANGED=true
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); s['assistant-agent']['env']['ASSISTANT_RELEASE_API_CONTRACT']='2'; open(p,'w').write(json.dumps(s))
PY
if release_staged_services; then fail 'web-only release must reject incompatible live API metadata'; fi
assert_old_traffic
reset_case
prepare_firestore_state
release_preflight_compatibility agent,web || fail 'Firestore contract metadata should pass preflight'
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p))
open(p,'w').write(json.dumps(s))
PY
export OWNED_TAGS_ALREADY_ABSENT=1
release_staged_services || fail 'Firestore compatible pair should promote'
python3 - "$TEST_ROOT/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); assert m['storageDriver']=='firestore'; assert m['schemaVersion']==1
PY
python3 - "$STUB_SERVICE_UPDATE_CALLS" "$STUB_RELEASE_CALLS" "$STUB_DRAIN_CALLS" "$TEST_ROOT/state.json" "$STUB_ADMISSION_CALLS" <<'PY'
import json,sys
updates=[json.loads(line) for line in open(sys.argv[1])]
web_updates=[x[x.index('--update-env-vars')+1] for x in updates if x[3]=='assistant-web']
assert len(web_updates)==2, web_updates
assert 'ASSISTANT_RELEASE_WRITES_PAUSED=true' in web_updates[0]
assert 'ASSISTANT_RELEASE_WRITES_PAUSED=false' in web_updates[1]
calls=open(sys.argv[2]).read().splitlines()
web_pause=next(i for i,x in enumerate(calls) if 'update-traffic assistant-web ' in x and 'assistant-web-new1=100' in x)
agent=next(i for i,x in enumerate(calls) if 'update-traffic assistant-agent ' in x and 'assistant-agent-new1=100' in x)
web_resume=next(i for i,x in enumerate(calls) if 'update-traffic assistant-web ' in x and 'assistant-web-new2=100' in x)
assert web_pause<agent<web_resume, calls
remove_calls=[x for x in calls if '--remove-tags' in x]
assert len(remove_calls)==1 and 'assistant-web' in remove_calls[0] and 'candidate-12345-1' in remove_calls[0], remove_calls
own_candidate=next(x[x.index('--tag')+1] for x in updates if x[3]=='assistant-web')
resume_tag=next(x[x.index('--tag')+1] for x in updates if x[3]=='assistant-web' and 'ASSISTANT_RELEASE_WRITES_PAUSED=false' in x[x.index('--update-env-vars')+1])
s=json.load(open(sys.argv[4]))
web_tags={x['tag'] for x in s['assistant-web'].get('staged',[])}
agent_tags={x['tag'] for x in s['assistant-agent'].get('staged',[])}
assert own_candidate not in web_tags, web_tags
assert resume_tag in web_tags and 'candidate-foreign' not in web_tags, web_tags
assert own_candidate in agent_tags, agent_tags
drains=[int(line.strip()) for line in open(sys.argv[3])]
assert drains and all(0<=x<=30 for x in drains) and sum(drains)==310, drains
events=open(sys.argv[5]).read().splitlines()
capture=next(i for i,x in enumerate(events) if x.startswith('capture:'))
agent_stage=next(i for i,x in enumerate(events) if x.startswith('stage:assistant-agent:'))
pause=next(i for i,x in enumerate(events) if x=='traffic:assistant-web:assistant-web-new1=100')
old_drain=max(i for i,x in enumerate(events) if x.startswith('drain:'))
retire=next(i for i,x in enumerate(events) if x.startswith('retire:'))
agent_promote=next(i for i,x in enumerate(events) if x=='traffic:assistant-agent:assistant-agent-new1=100')
unpaused_create=next(i for i,x in enumerate(events) if x.startswith('stage:assistant-web:resume-') and x.endswith(':false'))
assert capture<agent_stage, events
assert pause<old_drain<retire<agent_promote<unpaused_create, events
assert events[retire].endswith(':1'), events
verify=next(i for i,x in enumerate(events) if x.startswith('verify:'))
resume_stage=next(i for i,x in enumerate(events) if x.startswith('stage:assistant-web:resume-'))
assert retire<verify<resume_stage, events
assert any(x.startswith('record:candidate:') for x in events), events
assert any(x.startswith('record:resume:') for x in events), events
candidate_receipt=next(i for i,x in enumerate(events) if x.startswith('record:candidate:'))
candidate_probe=next(i for i,x in enumerate(events) if x.startswith('probe:https://candidate-') and 'assistant-web.example' in x)
resume_receipt=next(i for i,x in enumerate(events) if x.startswith('record:resume:'))
resume_probe=next(i for i,x in enumerate(events) if x.startswith('probe:https://resume-'))
assert candidate_receipt<candidate_probe, events
assert resume_receipt<resume_probe, events
agent_ready=next(i for i,x in enumerate(events) if x.startswith('agent-ready:'))
create_resume=next(i for i,x in enumerate(events) if x=='native-phase:createR')
assert agent_ready<create_resume, events
assert all(key in web_updates[0] for key in (
 'ASSISTANT_RELEASE_WORKFLOW_RUN_ID=12345',
 'ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT=1',
 'ASSISTANT_RELEASE_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
assert all(key in web_updates[1] for key in (
 'ASSISTANT_RELEASE_WORKFLOW_RUN_ID=12345',
 'ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT=1',
 'ASSISTANT_RELEASE_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
PY
# Before any unpaused tagged revision exists, old-pair rollback still applies.
reset_case; prepare_firestore_state; export RELEASE_MODULES=browser FINAL_NEW_PAIR_PROBE_FAIL=1
if release_staged_services; then fail 'paused preadmission probe failure must roll back'; fi
assert_old_traffic
python3 - "$TEST_ROOT/state.json" "$STUB_SERVICE_UPDATE_CALLS" <<'PYCASE'
import json,sys
state=json.load(open(sys.argv[1])); updates=[json.loads(x) for x in open(sys.argv[2])]
assert state['assistant-browser']['image']=='registry/old-browser', state
assert not any('ASSISTANT_RELEASE_WRITES_PAUSED=false' in x[x.index('--update-env-vars')+1] for x in updates), updates
PYCASE

# BASIC5 must never enter the staging path outside a paired Firestore release.
reset_case; TEST_BASIC5_CAPABILITY=true
if release_staged_services; then fail 'BASIC5 PostgreSQL release must be rejected before staging'; fi
[[ ! -s "$STUB_SERVICE_UPDATE_CALLS" && ! -s "$STUB_RELEASE_CALLS" ]] || fail 'non-Firestore BASIC5 path reached a mutation'
reset_case; prepare_firestore_state; export RELEASE_COMPONENTS=web RELEASE_SCHEMA_UNCHANGED=true
if release_staged_services; then fail 'BASIC5 web-only Firestore release must be rejected before staging'; fi
[[ ! -s "$STUB_SERVICE_UPDATE_CALLS" && ! -s "$STUB_RELEASE_CALLS" ]] || fail 'non-paired BASIC5 path reached a mutation'

# Capture and candidate-record failures stop before any user traffic promotion.
reset_case; prepare_firestore_state; export FAIL_ADMISSION_CAPTURE=1
if release_staged_services; then fail 'failed owned-tag capture must refuse staging'; fi
[[ ! -s "$STUB_SERVICE_UPDATE_CALLS" && ! -s "$STUB_RELEASE_CALLS" ]] || fail 'failed capture reached a staging or traffic mutation'
grep -q '^capture:' "$STUB_ADMISSION_CALLS" || fail 'capture failure event was not recorded'
reset_case; prepare_firestore_state; export FAIL_CANDIDATE_RECEIPT=1
if release_staged_services; then fail 'failed paused candidate receipt must refuse promotion'; fi
assert_old_traffic
[[ ! -s "$STUB_RELEASE_CALLS" ]] || fail 'candidate receipt failure reached traffic promotion'
python3 - "$STUB_ADMISSION_CALLS" "$STUB_SERVICE_UPDATE_CALLS" <<'PY'
import json,sys
events=open(sys.argv[1]).read().splitlines(); updates=[json.loads(x) for x in open(sys.argv[2])]
assert any(x.startswith('record:candidate:') for x in events), events
assert not any(x[3]=='assistant-web' and 'ASSISTANT_RELEASE_WRITES_PAUSED=false' in x[x.index('--update-env-vars')+1] for x in updates), updates
PY

# An uncertain captured-tag retirement rolls back canonical traffic only; it does not restore aliases.
reset_case; prepare_firestore_state; export FAIL_ADMISSION_RETIRE=1
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); s['assistant-web']['tags']=[
 {'revision':'web-old','tag':'resume-111-1'}, {'revision':'web-old','tag':'manual-preview'}]
open(p,'w').write(json.dumps(s))
PY
if release_staged_services; then fail 'failed captured-tag retirement must stop before agent promotion'; fi
python3 - "$TEST_ROOT/state.json" "$STUB_RELEASE_CALLS" "$STUB_ADMISSION_CALLS" "$STUB_SERVICE_UPDATE_CALLS" <<'PY'
import json,sys
state=json.load(open(sys.argv[1])); calls=open(sys.argv[2]).read().splitlines(); events=open(sys.argv[3]).read().splitlines()
updates=[json.loads(x) for x in open(sys.argv[4])]
assert state['assistant-web']['traffic']=={'web-old':100}, state['assistant-web']['traffic']
assert state['assistant-web']['tags']==[
 {'revision':'web-old','tag':'resume-111-1'}, {'revision':'web-old','tag':'manual-preview'}], state['assistant-web']['tags']
assert any(x.startswith('retire:') for x in events), events
assert any('assistant-web ' in x and 'web-old=100' in x for x in calls), calls
assert not any('assistant-agent-new1=100' in x or 'assistant-web-new2=100' in x for x in calls), calls
assert not any(x[3]=='assistant-web' and 'ASSISTANT_RELEASE_WRITES_PAUSED=false' in x[x.index('--update-env-vars')+1] for x in updates), updates
assert not any('--remove-tags' in x for x in calls), calls
PY

assert_basic5_retained() { python3 - "$TEST_ROOT/state.json" "$STUB_RELEASE_CALLS" <<'PYCASE'
import json,sys
state=json.load(open(sys.argv[1])); calls=open(sys.argv[2]).read().splitlines()
assert state['assistant-agent']['traffic']=={'assistant-agent-new1':100}, state
assert state['assistant-web']['traffic']=={'assistant-web-new1':100}, state
assert state['assistant-browser']['image']!='registry/old-browser', state
assert not any('agent-old=100' in x or 'web-old=100' in x for x in calls), calls
PYCASE
}
# A fresh admission check failure must prevent creating any unpaused revision.
reset_case; prepare_firestore_state; export RELEASE_MODULES=browser FAIL_ADMISSION_VERIFY=1
if release_staged_services; then fail 'failed fresh admission verification must stop before unpaused creation'; fi
assert_old_traffic
python3 - "$STUB_ADMISSION_CALLS" "$STUB_SERVICE_UPDATE_CALLS" "$STUB_RELEASE_CALLS" <<'PYCASE'
import json,sys
events=open(sys.argv[1]).read().splitlines(); updates=[json.loads(x) for x in open(sys.argv[2])]; calls=open(sys.argv[3]).read().splitlines()
assert any(x.startswith('verify:') for x in events), events
assert not any(x[3]=='assistant-web' and 'ASSISTANT_RELEASE_WRITES_PAUSED=false' in x[x.index('--update-env-vars')+1] for x in updates), updates
assert not any('assistant-web-new2=100' in x for x in calls), calls
PYCASE
reset_case; prepare_firestore_state; export RELEASE_MODULES=browser RESUME_WEB_PROBE_FAIL=1
if release_staged_services; then fail 'unpaused tagged probe failure must retain current pair even before traffic promotion'; fi
assert_basic5_retained
python3 - "$STUB_RELEASE_CALLS" "$TEST_ROOT/state.json" <<'PYCASE'
import json,sys
calls=open(sys.argv[1]).read().splitlines(); state=json.load(open(sys.argv[2]))
assert not any('assistant-web-new2=100' in x for x in calls), calls
assert any('--remove-tags resume-' in x for x in calls), calls
assert not any(x['tag'].startswith('resume-') for x in state['assistant-web']['staged']), state
assert any(x['tag'].startswith('candidate-') for x in state['assistant-web']['staged']), state
PYCASE
reset_case; prepare_firestore_state; export RELEASE_MODULES=browser FAIL_RESUME_RECEIPT=1
if release_staged_services; then fail 'failed unpaused resume receipt must prevent unpaused traffic promotion'; fi
assert_basic5_retained
python3 - "$STUB_RELEASE_CALLS" "$STUB_ADMISSION_CALLS" <<'PYCASE'
import sys
calls=open(sys.argv[1]).read().splitlines(); events=open(sys.argv[2]).read().splitlines()
assert not any('assistant-web-new2=100' in x for x in calls), calls
assert any(x.startswith('record:resume:') for x in events), events
PYCASE
reset_case; prepare_firestore_state; export RELEASE_MODULES=browser FAIL_AGENT_READY_RECEIPT=1
if release_staged_services; then fail 'failed paired agent readiness receipt must prevent unpaused creation'; fi
assert_old_traffic
python3 - "$STUB_RELEASE_CALLS" "$STUB_ADMISSION_CALLS" <<'PYCASE'
import sys
calls=open(sys.argv[1]).read().splitlines(); events=open(sys.argv[2]).read().splitlines()
assert not any('assistant-web-new2=100' in x for x in calls), calls
assert any(x.startswith('agent-ready:') for x in events), events
assert not any(x=='native-phase:createR' for x in events), events
PYCASE
reset_case; prepare_firestore_state; export RELEASE_MODULES=browser RESUME_LIVE_PROBE_FAIL=1
if release_staged_services; then fail 'postadmission failure must repause and retain marker-aware runtimes'; fi
assert_basic5_retained
python3 - "$STUB_RELEASE_CALLS" "$STUB_DRAIN_CALLS" <<'PYCASE'
import sys
calls=open(sys.argv[1]).read().splitlines()
resume=next(i for i,x in enumerate(calls) if 'assistant-web-new2=100' in x)
repause=next(i for i,x in enumerate(calls) if 'assistant-web-new1=100' in x and i>resume)
retire=next(i for i,x in enumerate(calls) if '--remove-tags resume-' in x)
assert resume<repause<retire, calls
assert sum(int(x) for x in open(sys.argv[2]))==620
PYCASE
reset_case; prepare_firestore_state; export RELEASE_MODULES=browser FAIL_RESUME_STAGE_UNCERTAIN=1
if release_staged_services; then fail 'uncertain unpaused revision create must not restore old runtimes'; fi
assert_basic5_retained
python3 - "$STUB_RELEASE_CALLS" <<'PYCASE'
import sys
calls=open(sys.argv[1]).read().splitlines()
assert not any('--remove-tags' in x for x in calls), calls
PYCASE
reset_case; prepare_firestore_state; export RELEASE_MODULES=browser RESUME_LIVE_PROBE_FAIL=1 REASSIGN_RESUME_TAG_ON_REPAUSE=1
if release_staged_services; then fail 'reassigned tag must stop recovery without deletion or old rollback'; fi
assert_basic5_retained
python3 - "$STUB_RELEASE_CALLS" "$TEST_ROOT/state.json" <<'PYCASE'
import json,sys
calls=open(sys.argv[1]).read().splitlines(); state=json.load(open(sys.argv[2]))
assert not any('--remove-tags' in x for x in calls), calls
assert any(x['revision']=='foreign-revision' for x in state['assistant-web']['staged']), state
PYCASE
reset_case; prepare_firestore_state; export RELEASE_MODULES=browser RESUME_LIVE_PROBE_FAIL=1 FAIL_TAG_REMOVAL=1
if release_staged_services; then fail 'failed owned-tag retirement must retain new paused pair'; fi
assert_basic5_retained

# Source without BASIC5 keeps its existing rollback policy; no operator opt-out exists.
reset_case; prepare_firestore_state; export RESUME_LIVE_PROBE_FAIL=1
if (release_basic_editor_forward_only() { printf false; }; release_staged_services); then fail 'legacy failure must still return failure'; fi
assert_old_traffic

reset_case; prepare_firestore_state; export RELEASE_MODULES=browser RESUME_LIVE_PROBE_FAIL=1 FAIL_REPAUSE=1
if release_staged_services; then fail 'failed repause must stop automatic rollback'; fi
python3 - "$TEST_ROOT/state.json" "$STUB_RELEASE_CALLS" <<'PY'
import json,sys
state=json.load(open(sys.argv[1])); calls=open(sys.argv[2]).read().splitlines()
assert state['assistant-agent']['traffic']=={'assistant-agent-new1':100}, state['assistant-agent']['traffic']
assert state['assistant-web']['traffic']=={'assistant-web-new2':100}, state['assistant-web']['traffic']
assert state['assistant-browser']['image']!='registry/old-browser', state['assistant-browser']
assert not any('agent-old=100' in x or 'web-old=100' in x for x in calls), calls
PY
reset_case; prepare_firestore_state; export RESUME_LIVE_PROBE_FAIL=1 FAIL_RESUME_DRAIN=1
if release_staged_services; then fail 'failed drain after repause must stop automatic rollback'; fi
python3 - "$TEST_ROOT/state.json" "$STUB_RELEASE_CALLS" <<'PY'
import json,sys
state=json.load(open(sys.argv[1])); calls=open(sys.argv[2]).read().splitlines()
assert state['assistant-agent']['traffic']=={'assistant-agent-new1':100}, state['assistant-agent']['traffic']
assert state['assistant-web']['traffic']=={'assistant-web-new1':100}, state['assistant-web']['traffic']
assert not any('agent-old=100' in x or 'web-old=100' in x for x in calls), calls
PY
reset_case; prepare_firestore_state; export STUB_WEB_TIMEOUT_SECONDS=601
if release_staged_services; then fail 'uncapped old-web request timeout must fail closed'; fi
assert_old_traffic
python3 - "$STUB_RELEASE_CALLS" <<'PY'
import sys
calls=open(sys.argv[1]).read().splitlines()
assert not any('update-traffic assistant-agent ' in x and 'agent-new' in x for x in calls), calls
PY
reset_case; prepare_firestore_state; export STUB_WEB_TIMEOUT_MISSING=1
if release_staged_services; then fail 'missing old-web request timeout must fail closed'; fi
assert_old_traffic
python3 - "$STUB_RELEASE_CALLS" <<'PY'
import sys
calls=open(sys.argv[1]).read().splitlines()
assert not any('update-traffic assistant-agent ' in x and 'agent-new' in x for x in calls), calls
PY
reset_case
export RELEASE_PERSISTENCE_DRIVER=firestore RELEASE_COMPONENTS=web RELEASE_SCHEMA_UNCHANGED=true
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
p=sys.argv[1]; s=json.load(open(p)); env=s['assistant-agent']['env']; env['ASSISTANT_RELEASE_SCHEMA_DRIVER']='firestore'; env['ASSISTANT_RELEASE_SCHEMA_MIN']='1'; env['ASSISTANT_RELEASE_SCHEMA_MAX']='1'; open(p,'w').write(json.dumps(s))
PY
release_preflight_compatibility web || fail 'Firestore web-only compatibility proof should pass'
release_staged_services || fail 'Firestore web-only release with proven live agent should pass'
python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); assert s['assistant-agent']['traffic']=={'agent-old':100}; assert list(s['assistant-web']['traffic'])[0].startswith('assistant-web-new')
PY
reset_case; export RELEASE_MODULES=documents
PROCESSOR_SCHEMA_MIN="$(node -e 'process.stdout.write(String(require(process.argv[1]).components.processor.schema.postgres.min))' "$ROOT/release-contracts.json")"
PROCESSOR_SCHEMA_MAX="$(node -e 'process.stdout.write(String(require(process.argv[1]).components.processor.schema.postgres.max))' "$ROOT/release-contracts.json")"
if (( POSTGRES_SCHEMA_VERSION < PROCESSOR_SCHEMA_MIN || POSTGRES_SCHEMA_VERSION > PROCESSOR_SCHEMA_MAX )); then
  if release_staged_services; then fail 'documents processor outside its declared schema range must fail closed'; fi
  assert_old_traffic
  python3 - "$TEST_ROOT/state.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); assert s['assistant-processor']['image']=='registry/old-processor'
PY
else
  release_staged_services || fail 'documents module should stage its processor worker image while within the declared schema range'
  python3 - "$TEST_ROOT/manifest.json" "$TEST_ROOT/state.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); s=json.load(open(sys.argv[2])); assert 'processor' in m['selected']; assert '@sha256:' in s['assistant-processor']['image']
PY
fi
reset_case; prepare_firestore_state
export TAG=c77cd3152d27364316451a1a055f2e9edc176fc3
export GITHUB_SHA="$TAG" GITHUB_WORKFLOW_SHA="$TAG"
release_staged_services || fail 'full 40-character release SHA must fit Cloud Run traffic tags'
python3 - "$TEST_ROOT/state.json" "$TEST_ROOT/manifest.json" "$TAG" <<'PYTEST'
import json,sys
state=json.load(open(sys.argv[1])); manifest=json.load(open(sys.argv[2])); source=sys.argv[3]
assert manifest['release']==source, 'full source identity must remain in the manifest'
for name in ('assistant-agent','assistant-web'):
 for stage in state[name]['staged']:
  assert len(name)+len(stage['tag'])<=46
  assert '@sha256:' in stage['image'], 'traffic aliases must not alter immutable image identity'
PYTEST
export TAG=abc123
(
 export GITHUB_RUN_ID=37996499728 GITHUB_RUN_ATTEMPT=1
 first="$(release_traffic_tag_suffix)"
 export GITHUB_RUN_ATTEMPT=2
 second="$(release_traffic_tag_suffix)"
 [[ "$first" == 37996499728-1 && "$second" == 37996499728-2 && "$first" != "$second" ]] || fail 'reruns must use distinct traffic aliases'
 export GITHUB_RUN_ID=12345678901234567890
 if release_traffic_tag_suffix; then fail 'oversized traffic alias must fail before staging'; fi
 export GITHUB_RUN_ID=invalid
 if release_traffic_tag_suffix; then fail 'invalid traffic alias must fail before staging'; fi
 unset GITHUB_RUN_ID GITHUB_RUN_ATTEMPT
 [[ "$(release_traffic_tag_suffix)" =~ ^[0-9a-f]{20}$ ]] || fail 'local aliases must fit the same budget'
)
# Intrinsic capability is validated from source, including a legacy-absent case.
CAP_FIXTURE_ROOT="$TEST_ROOT/capability"
mkdir -p "$CAP_FIXTURE_ROOT/infra/gcp" "$CAP_FIXTURE_ROOT/apps/web/lib"
cp "$ROOT/release-staged-services.sh" "$CAP_FIXTURE_ROOT/infra/gcp/release-staged-services.sh"
cp "$ROOT/release-contracts.json" "$CAP_FIXTURE_ROOT/infra/gcp/release-contracts.json"
: >"$CAP_FIXTURE_ROOT/apps/web/lib/owner-editor-runtime.ts"
[[ "$(bash -c 'source "$1"; release_basic_editor_forward_only' -- "$CAP_FIXTURE_ROOT/infra/gcp/release-staged-services.sh")" == true ]] || fail 'intrinsic person-note source capability not detected'
python3 - "$CAP_FIXTURE_ROOT/infra/gcp/release-contracts.json" <<'PYCASE'
import json,sys
p=sys.argv[1]; c=json.load(open(p)); c['components']['web']['ownerEditorV1'].append('remove_person'); open(p,'w').write(json.dumps(c))
PYCASE
if bash -c 'source "$1"; release_basic_editor_forward_only' -- "$CAP_FIXTURE_ROOT/infra/gcp/release-staged-services.sh"; then fail 'broadened capability must fail closed'; fi
python3 - "$CAP_FIXTURE_ROOT/infra/gcp/release-contracts.json" <<'PYCASE'
import json,sys
p=sys.argv[1]; c=json.load(open(p)); del c['components']['web']['ownerEditorV1']; open(p,'w').write(json.dumps(c))
PYCASE
if bash -c 'source "$1"; release_basic_editor_forward_only' -- "$CAP_FIXTURE_ROOT/infra/gcp/release-staged-services.sh"; then fail 'runtime without capability must fail closed'; fi
rm "$CAP_FIXTURE_ROOT/apps/web/lib/owner-editor-runtime.ts"
[[ "$(bash -c 'source "$1"; release_basic_editor_forward_only' -- "$CAP_FIXTURE_ROOT/infra/gcp/release-staged-services.sh")" == false ]] || fail 'older source without runtime/capability must remain legacy'

# Bootstrap uses the same promotion phases; no successful promotion means no admission restoration.
release_bootstrap_scaling() {
  printf 'bootstrap:%s:%s:%s\n' "$1" "$2" "$3" >>"$STUB_ADMISSION_CALLS"
  if [[ "${FAIL_BOOTSTRAP_UNKNOWN:-0}" == 1 && "$2" == web ]]; then return 1; fi
}
reset_case; prepare_firestore_state
export OWNER_RELEASE_BOOTSTRAP_RECEIPT='{"format":1,"kind":"disabled-bootstrap","source":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
export OWNER_RELEASE_BOOTSTRAP_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
release_staged_services >/dev/null || fail 'reviewed bootstrap phase handoff should succeed'
python3 - "$STUB_ADMISSION_CALLS" <<'PYCASE'
import sys
rows=open(sys.argv[1]).read().splitlines()
def index(prefix): return next(i for i,x in enumerate(rows) if x.startswith(prefix))
assert index('native-phase:promoteP') < index('bootstrap:--bootstrap-restore:web') < index('traffic:assistant-agent:assistant-agent-new1=100')
assert index('traffic:assistant-agent:assistant-agent-new1=100') < index('bootstrap:--bootstrap-restore:agent') < index('agent-ready:')
PYCASE
reset_case; prepare_firestore_state
export FAIL_WEB_PROMOTE=1
if release_staged_services >/dev/null 2>&1; then fail 'failed paused web promotion must fail bootstrap'; fi
if rg -q '^bootstrap:--bootstrap-restore:' "$STUB_ADMISSION_CALLS"; then fail 'failed promotion restored automatic scaling'; fi
reset_case; prepare_firestore_state
export FAIL_AGENT_PROMOTE=1
if release_staged_services >/dev/null 2>&1; then fail 'failed agent promotion must fail bootstrap'; fi
python3 - "$STUB_ADMISSION_CALLS" <<'PYCASE'
import sys
rows=open(sys.argv[1]).read().splitlines()
assert not any(x.startswith('bootstrap:--bootstrap-restore:agent') for x in rows)
hold=next(i for i,x in enumerate(rows) if x.startswith('bootstrap:--bootstrap-hold:web'))
rollback=next(i for i,x in enumerate(rows) if x.startswith('native-phase:restoreC'))
assert hold < rollback
PYCASE
reset_case; prepare_firestore_state
export FAIL_BOOTSTRAP_UNKNOWN=1
if release_staged_services >/dev/null 2>&1; then fail 'unknown scaling restoration must fail closed'; fi
if rg -q '^native-phase:restoreC' "$STUB_ADMISSION_CALLS"; then fail 'unknown scaling outcome resumed legacy traffic'; fi
unset FAIL_BOOTSTRAP_UNKNOWN OWNER_RELEASE_BOOTSTRAP_RECEIPT OWNER_RELEASE_BOOTSTRAP_SHA256
echo 'staged release protocol tests passed'
