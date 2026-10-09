#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/assistant-staged-release.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"
export STUB_ROOT="$TEST_ROOT" STUB_CURL_CALLS="$TEST_ROOT/curl-calls" STUB_RELEASE_CALLS="$TEST_ROOT/release-calls" STUB_SERVICE_UPDATE_CALLS="$TEST_ROOT/service-update-calls" STUB_DRAIN_CALLS="$TEST_ROOT/drain-calls" PROJECT=test-project REGION=us-west1 TAG=abc123
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
def save(): p.write_text(json.dumps(s))
if a[:3]==['artifacts','docker','images']:
 image=a[4] if len(a)>4 else ''
 if os.getenv('FAIL_AGENT_BUILD')=='1' and '/agent:' in image: sys.exit(1)
 print('sha256:'+('a' if '/agent:' in image else 'b')*64); sys.exit(0)
if a[:3]==['run','jobs','describe']:
 name=a[3]; print(json.dumps({'spec':{'template':{'template':{'spec':{'containers':[{'image':s[name]['image']}]}}}}})); sys.exit(0)
if a[:3]==['run','jobs','update']:
 name=a[3]; s[name]['next']+=1
 image=val('--image')
 if os.getenv('FAIL_WORKER_UPDATE')=='1': sys.exit(1)
 s[name]['image']=('registry/stale' if os.getenv('STALE_WORKER_IMAGE')=='1' and 'sha256:' in image else image)
 save(); sys.exit(0)
if a[:3]==['run','services','describe']:
 name=a[3]; svc=s[name]
 if '--format=json' in a:
  traffic=[{'revisionName':r,'percent':pct} for r,pct in svc['traffic'].items()]
  traffic += [{'revisionName':x['revision'],'tag':x['tag'],'percent':0,'url':f"https://{x['tag']}-{name}.example"} for x in svc.get('staged',[])]
  print(json.dumps({'spec':{'template':{'spec':{'containers':[{'env':[{'name':k,'value':v} for k,v in svc['env'].items()]}] }}},'status':{'url':f'https://{name}.example','traffic':traffic}})); sys.exit(0)
 if 'value(status.url)' in ' '.join(a): print(f'https://{name}.example'); sys.exit(0)
if a[:3]==['run','revisions','describe']:
 revision=a[3]
 if os.getenv('FAIL_RESUME_DRAIN')=='1' and revision=='assistant-web-new2': sys.exit(1)
 for name,svc in s.items():
  if not isinstance(svc,dict): continue
  if svc.setdefault('revision',None) and svc.get('revision') not in svc.setdefault('revisions',{}):
   svc['revisions'][svc['revision']]={'env':dict(svc.get('env',{}))}; save()
  if revision in svc['revisions']:
   env=svc['revisions'][revision].get('env',{})
   spec={'containers':[{'env':[{'name':k,'value':v} for k,v in env.items()]}]}
   if os.getenv('STUB_WEB_TIMEOUT_MISSING')!='1': spec['timeoutSeconds']=int(os.getenv('STUB_WEB_TIMEOUT_SECONDS','300'))
   print(json.dumps({'spec':spec})); sys.exit(0)
  for stage in svc.get('staged',[]):
   if revision==stage['revision']:
    env=stage.get('env',{})
    spec={'containers':[{'env':[{'name':k,'value':v} for k,v in env.items()]}]}
    if os.getenv('STUB_WEB_TIMEOUT_MISSING')!='1': spec['timeoutSeconds']=int(os.getenv('STUB_WEB_TIMEOUT_SECONDS','300'))
    print(json.dumps({'spec':spec})); sys.exit(0)
 print('{}'); sys.exit(1)
if a[:3]==['run','services','update']:
 with open(os.environ['STUB_SERVICE_UPDATE_CALLS'],'a') as f: f.write(json.dumps(a)+'\n')
 name=a[3]
 if name=='assistant-agent' and os.getenv('FAIL_AGENT_STAGE')=='1': sys.exit(1)
 svc=s[name]; svc['next']+=1; rev=f"{name}-new{svc['next']}"
 for item in val('--update-env-vars').split(','):
  if '=' in item:
   k,v=item.split('=',1); svc['env'][k]=v
 svc.setdefault('staged',[]).append({'revision':rev,'tag':val('--tag'),'image':val('--image'),'env':dict(svc['env'])}); svc.setdefault('revisions',{})[rev]={'env':dict(svc['env'])}; save(); sys.exit(0)
if a[:3]==['run','services','update-traffic']:
 name=a[3]; mapping=val('--to-revisions'); svc=s[name]
 if name=='assistant-agent' and os.getenv('FAIL_AGENT_PROMOTE')=='1' and 'agent-new' in mapping: sys.exit(1)
 if name=='assistant-web' and os.getenv('FAIL_WEB_PROMOTE')=='1' and 'web-new' in mapping: sys.exit(1)
 if name=='assistant-web' and os.getenv('FAIL_REPAUSE')=='1' and 'assistant-web-new1=100' in mapping and 'assistant-web-new2' in svc.get('traffic',{}): sys.exit(1)
 svc['traffic']={}
 for item in mapping.split(','):
  r,pct=item.split('=',1); svc['traffic'][r]=int(pct)
 save(); sys.exit(0)
print('unexpected gcloud: '+' '.join(a),file=sys.stderr); sys.exit(90)
PY
cat >"$TEST_ROOT/bin/curl" <<'PY'
#!/usr/bin/env python3
import json,os,sys
url=sys.argv[-1]; path=url.split('.example',1)[-1]
s=json.load(open(os.path.join(os.environ['STUB_ROOT'],'state.json')))
with open(os.environ['STUB_CURL_CALLS'],'a') as f: f.write(json.dumps({'url':url,'web':s['assistant-web']['traffic'],'agent':s['assistant-agent']['traffic']})+'\n')
agent_new=any('new' in r for r in s['assistant-agent']['traffic'])
web_new=any('new' in r for r in s['assistant-web']['traffic'])
legacy_live_web=url.startswith('https://assistant-web.example/') and not web_new
if path=='/ready': print('{"ready":false}' if os.getenv('UNHEALTHY_AGENT')=='1' else '{"ready":true}')
elif path=='/api/health':
 print('{"ok":true,"service":"web","sha":"wrong"}' if os.getenv('UNHEALTHY_WEB')=='1' or (os.getenv('UNHEALTHY_LIVE_WEB')=='1' and 'assistant-web.example' in url) else '{"ok":true,"service":"web","sha":"abc123"}')
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
PY
chmod +x "$TEST_ROOT/bin/sleep"
source "$ROOT/release-staged-services.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
reset_case() {
 cat >"$TEST_ROOT/state.json" <<JSON
{"assistant-agent":{"revision":"agent-old","traffic":{"agent-old":100},"env":{"QUEUE_DRIVER":"cloudtasks","ASSISTANT_RELEASE_API_CONTRACT":"1","ASSISTANT_RELEASE_SCHEMA_DRIVER":"postgres","ASSISTANT_RELEASE_SCHEMA_VERSION":"${POSTGRES_SCHEMA_VERSION}","ASSISTANT_RELEASE_WEB_API_MIN":"1","ASSISTANT_RELEASE_WEB_API_MAX":"1","ASSISTANT_RELEASE_SCHEMA_DRIVER":"postgres","ASSISTANT_RELEASE_SCHEMA_MIN":"${POSTGRES_SCHEMA_VERSION}","ASSISTANT_RELEASE_SCHEMA_MAX":"${POSTGRES_SCHEMA_VERSION}"},"next":0},"assistant-web":{"revision":"web-old","traffic":{"web-old":100},"env":{"ASSISTANT_RELEASE_API_CONTRACT":"1","ASSISTANT_RELEASE_AGENT_API_MIN":"1","ASSISTANT_RELEASE_AGENT_API_MAX":"1","ASSISTANT_RELEASE_SCHEMA_DRIVER":"postgres","ASSISTANT_RELEASE_SCHEMA_MIN":"${POSTGRES_SCHEMA_VERSION}","ASSISTANT_RELEASE_SCHEMA_MAX":"${POSTGRES_SCHEMA_VERSION}"},"next":0},"assistant-browser":{"image":"registry/old-browser","next":0},"assistant-processor":{"image":"registry/old-processor","next":0}}
JSON
 unset FAIL_AGENT_BUILD FAIL_AGENT_STAGE UNHEALTHY_AGENT UNHEALTHY_WEB UNHEALTHY_LIVE_WEB \
    CANDIDATE_WEB_PROBE_FAIL FINAL_NEW_PAIR_PROBE_FAIL RESUME_WEB_PROBE_FAIL RESUME_LIVE_PROBE_FAIL \
    FAIL_AGENT_PROMOTE FAIL_WEB_PROMOTE FAIL_REPAUSE FAIL_RESUME_DRAIN STUB_WEB_TIMEOUT_SECONDS STUB_WEB_TIMEOUT_MISSING \
    FAIL_WORKER_UPDATE STALE_WORKER_IMAGE
 : >"$STUB_CURL_CALLS"
 : >"$STUB_RELEASE_CALLS"
 : >"$STUB_SERVICE_UPDATE_CALLS"
 : >"$STUB_DRAIN_CALLS"
 unset RELEASE_EMAIL_OBSERVER_WORKER_ENABLED
 export RELEASE_COMPONENTS=agent,web RELEASE_MODULES=none RELEASE_PERSISTENCE_DRIVER=postgres
}
prepare_firestore_state() {
 export RELEASE_PERSISTENCE_DRIVER=firestore
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
candidate=[x for x in probes if x['url']=='https://candidate-abc123-assistant-web.example/api/release-probe']
assert candidate and all('new' not in next(iter(x['agent'])) for x in candidate), 'tagged web must prove new-web/old-agent compatibility'
live=[x for x in probes if x['url'].startswith('https://assistant-web.example/')]
assert live and all(any('new' in revision for revision in x['web']) for x in live), 'the old web, whose routes return 404, must never receive a compatibility probe'
assert any(x['url'].endswith('/api/release-probe') and 'new' not in next(iter(x['agent'])) for x in live), 'promoted web must be probed against old agent before agent promotion'
assert any(x['url'].endswith('/api/release-probe') and any('new' in revision for revision in x['agent']) for x in live), 'promoted web must be probed again against new agent'
PY
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
release_staged_services || fail 'Firestore compatible pair should promote'
python3 - "$TEST_ROOT/manifest.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); assert m['storageDriver']=='firestore'; assert m['schemaVersion']==1
PY
python3 - "$STUB_SERVICE_UPDATE_CALLS" "$STUB_RELEASE_CALLS" "$STUB_DRAIN_CALLS" <<'PY'
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
drains=[int(line.strip()) for line in open(sys.argv[3])]
assert drains and all(0<=x<=30 for x in drains) and sum(drains)==310, drains
PY
reset_case; prepare_firestore_state; export RESUME_WEB_PROBE_FAIL=1
if release_staged_services; then fail 'unpaused tagged revision failure must roll back without moving traffic to it'; fi
assert_old_traffic
python3 - "$STUB_RELEASE_CALLS" <<'PY'
import sys
calls=open(sys.argv[1]).read().splitlines()
assert not any('assistant-web-new2=100' in x for x in calls), calls
agent_rollback=next(i for i,x in enumerate(calls) if 'update-traffic assistant-agent ' in x and 'agent-old=100' in x)
web_rollback=next(i for i,x in enumerate(calls) if 'update-traffic assistant-web ' in x and 'web-old=100' in x)
assert agent_rollback<web_rollback, calls
PY
reset_case; prepare_firestore_state; export RESUME_LIVE_PROBE_FAIL=1
if release_staged_services; then fail 'live unpaused probe failure must repause before rolling the agent back'; fi
assert_old_traffic
python3 - "$STUB_RELEASE_CALLS" "$STUB_DRAIN_CALLS" <<'PY'
import sys
calls=open(sys.argv[1]).read().splitlines()
resume=next(i for i,x in enumerate(calls) if 'update-traffic assistant-web ' in x and 'assistant-web-new2=100' in x)
repause=next(i for i,x in enumerate(calls) if 'update-traffic assistant-web ' in x and 'assistant-web-new1=100' in x and i>resume)
agent=next(i for i,x in enumerate(calls) if 'update-traffic assistant-agent ' in x and 'agent-old=100' in x)
web=next(i for i,x in enumerate(calls) if 'update-traffic assistant-web ' in x and 'web-old=100' in x)
assert resume<repause<agent<web, calls
drains=[int(x.strip()) for x in open(sys.argv[2])]
assert sum(drains)==620 and all(0<=x<=30 for x in drains), drains
PY
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
if (( POSTGRES_SCHEMA_VERSION > 125 )); then
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
echo 'staged release protocol tests passed'
