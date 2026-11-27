#!/usr/bin/env python3
"""Bounded native control qualification after the ordinary iOS suite succeeds.

The GitHub-hosted job owns the runner; this phase owns only its fixture bundles
and subprocess groups. It never creates, boots, shuts down or deletes a device.
"""
import sys

if len(sys.argv) != 2 or sys.argv[1] not in {'run', 'cleanup'}:
    raise SystemExit('Expected run or cleanup')

if sys.argv[1] == 'run':
    import os, sys, json, re, time, signal, selectors, subprocess, hashlib, plistlib, stat
    from pathlib import Path
    root = Path(os.environ['RUNNER_TEMP']) / 'native-controls-evidence'
    root.mkdir(mode=0o700, exist_ok=False)
    build = Path(os.environ['RUNNER_TEMP']) / 'Assistant-build'
    env = {k:v for k,v in os.environ.items() if k in {'HOME','USER','LOGNAME','SHELL','TMPDIR','LANG','LC_ALL'}}
    env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin'
    log_bytes = 0
    elapsed = time.time() - float((Path(os.environ['RUNNER_TEMP'])/'native-controls-start').read_text())
    if not 0 <= elapsed < 2100: raise RuntimeError('Job budget unavailable')
    main_deadline = time.monotonic() + 2100 - elapsed
    def save(name, value):
        (root / name).write_text(json.dumps(value, indent=2) + '\n')
    def live_evidence_bytes(directory):
        total = 0
        for path in directory.rglob('*'):
            try:
                details = path.stat()
            except FileNotFoundError:
                # XCTest may remove a temporary result file during this scan.
                continue
            if stat.S_ISREG(details.st_mode):
                total += details.st_size
        return total
    def observe_group(pid, timeout_seconds):
        # Signal 0 asks the kernel about this owned process group without
        # sending a signal or spawning a potentially stalled ps process.
        try: os.killpg(pid, 0); return True, None
        except ProcessLookupError: return False, None
        except OSError as error: return None, repr(error)
    def drain(process, secondary, normal_exit, drain_deadline):
        signals = []
        def note(error):
            if len(secondary)<8: secondary.append(str(error)[:400])
        def remaining():return drain_deadline-time.monotonic()
        def observe():
            rest=remaining()
            if rest<=0:note('Group drain deadline exhausted');return None
            try:state,error=observe_group(process.pid,min(2,rest))
            except Exception as probe_error:state,error=None,repr(probe_error)
            if error:note('group observation: '+str(error))
            if state is not True and state is not False and state is not None:
                note('Invalid group observation');state=None
            return state
        def live():
            try:return process.poll() is None
            except Exception as error:note('Leader observation: '+repr(error));return None
        live()
        state=observe();residue=normal_exit and state is True
        for sig in (signal.SIGTERM,signal.SIGKILL):
            if state is False:break
            if remaining()<=0:note('Group drain deadline exhausted');state=None;break
            leader_live=live() is True
            # Unknown membership cannot authorize a signal after leader exit.
            if state is None and not leader_live:
                note('Exited leader with unknown group; no unbound signal');break
            try:os.killpg(process.pid,sig);signals.append(int(sig))
            except ProcessLookupError:state=False;break
            except Exception as error:note('Owned group signal: '+repr(error))
            until=min(time.monotonic()+1,drain_deadline)
            while live() is True:
                rest=min(until-time.monotonic(),remaining())
                if rest<=0:break
                time.sleep(min(.05,rest))
            state=observe()
        live()
        return {'closed':state is False,'normalExitResidue':residue,'signals':signals}
    def run(name, args, seconds, on_output=None):
        global log_bytes
        started=time.monotonic(); started_epoch=time.time(); process=None; selector=None; log=None
        problem=None; secondary=[]; closure={'closed':False,'normalExitResidue':False,'signals':[]}
        record={'pid':None,'args':args,'closed':False,'declaredBudgetSeconds':seconds,'startedEpochSeconds':started_epoch}
        def note(error):
            if len(secondary)<8: secondary.append(str(error)[:400])
        try:
            process=subprocess.Popen(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
            record['pid']=process.pid
            save('active-command.json',record)
            # Leave the existing main envelope room for its own drain.
            deadline=min(time.monotonic()+seconds,main_deadline-8)
            selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ)
            log=(root/(name+'.log')).open('wb')
            while selector.get_map():
                if time.monotonic()>=deadline: raise TimeoutError(name+' deadline')
                if name=='test' and live_evidence_bytes(root)>128*1024*1024: raise RuntimeError('Total evidence cap exceeded')
                for key,_ in selector.select(.2):
                    chunk=os.read(key.fd,65536)
                    if not chunk: selector.unregister(key.fileobj);continue
                    remaining=64*1024*1024-log_bytes
                    log.write(chunk[:max(0,remaining)]);log_bytes+=min(len(chunk),max(0,remaining))
                    if len(chunk)>remaining: raise RuntimeError('Total raw log cap exceeded')
            log.flush()
            if on_output:on_output((root/(name+'.log')).read_text())
            rest=deadline-time.monotonic()
            if rest<=0:raise TimeoutError(name+' deadline')
            process.wait(timeout=rest)
        except BaseException as error: problem=repr(error)
        finally:
            command_elapsed=time.monotonic()-started
            drain_deadline=min(time.monotonic()+8,main_deadline)
            if process is not None:
                try: closure=drain(process,secondary,problem is None and process.poll() is not None,drain_deadline)
                except BaseException as error:
                    # Preserve the primary failure and make one bounded
                    # known-live-only kill attempt if the observer itself broke.
                    note('Drain failed: '+repr(error))
                    try: known_live=process.poll() is None
                    except Exception as poll_error:note(repr(poll_error));known_live=False
                    if known_live:
                        for sig in (signal.SIGTERM,signal.SIGKILL):
                            rest=drain_deadline-time.monotonic()
                            if rest<=0:note('Fallback drain deadline exhausted');break
                            try:os.killpg(process.pid,sig)
                            except Exception as signal_error:note(repr(signal_error))
                            rest=drain_deadline-time.monotonic()
                            if rest>0:
                                try:process.wait(timeout=min(.5,rest))
                                except subprocess.TimeoutExpired:pass
                                except Exception as wait_error:note('Fallback wait: '+repr(wait_error))
                            try: exited=process.poll() is not None
                            except Exception as poll_error:note(repr(poll_error));exited=True
                            if exited:break
                    closure={'closed':False,'normalExitResidue':False,'signals':[]}
            else:closure['closed']=True
            for resource in (selector,log,process.stdout if process is not None else None):
                if resource is not None:
                    try:resource.close()
                    except Exception as error:note('Receipt stream close: '+repr(error))
            try:exit_code=process.poll() if process is not None else None
            except Exception as poll_error:note(repr(poll_error));exit_code=None
            record.update(closure,exit=exit_code,problem=problem,secondaryErrors=secondary,commandElapsedSeconds=round(command_elapsed,3),totalElapsedSeconds=round(time.monotonic()-started,3))
            for filename in ('active-command.json',name+'-process.json'):
                try:save(filename,record)
                except Exception as error:note('Receipt write '+filename+': '+repr(error))
            if secondary:
                try:print('CAPABILITY_COMMAND_RECEIPT '+json.dumps(record)[:16000],file=sys.stderr,flush=True)
                except Exception:pass
        if problem or secondary or closure['normalExitResidue'] or not closure['closed'] or record['exit']!=0:
            raise RuntimeError(name+' failed: '+str(record))
        return (root/(name+'.log')).read_text(errors='replace')
    try:
        if os.environ['GITHUB_RUN_ATTEMPT'] != '1': raise RuntimeError('No rerun authority')
        head = run('source-head', ['git','rev-parse','HEAD'], 10).strip()
        if head != os.environ['EXPECTED_HEAD']: raise RuntimeError('Checkout pin mismatch')
        paths = sorted(set(Path('apps/ios').rglob('*.swift')) | {Path('apps/ios/Assistant.xcodeproj/project.pbxproj'), Path('infra/ios-native-controls.py'), Path('infra/ios-detect-changes.sh'), Path('infra/ios-detect-changes.test.sh'), Path('.github/workflows/ios.yml'), Path('apps/ios/Assistant.xcodeproj/xcshareddata/xcschemes/AssistantUIFixtures.xcscheme')})
        pins = {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
        save('source.json', {'head':head,'pullRequestHead':os.environ['PR_HEAD'],'pins':pins,'qualificationVersion':3,'scope':'synthetic capability and 20-case accessibility matrix only'})
        if os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted': raise RuntimeError('Fixture ownership requires the disposable hosted job')
        udid = os.environ['DESTINATION_UDID']
        if not re.fullmatch(r'[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}',udid): raise RuntimeError('Invalid ordinary CI destination')
        save('lease.json', {'mode':'hosted-job-fixture','udid':udid,'createdByRun':os.environ['GITHUB_RUN_ID'],
            'ownership':'Fixture targets are built/launched only by this phase on the disposable hosted job; ordinary app uses distinct bundle IDs'})
        run('xcode-version', ['xcodebuild','-version'], 10)
        # The preceding ordinary app build/tests already qualified this destination.
        # Do not cold-boot, create, delete or inventory simulators here.
        if main_deadline-time.monotonic()<1800: raise RuntimeError('Insufficient admitted build/test/cleanup reserve')
        run('build', ['xcodebuild','-project','apps/ios/Assistant.xcodeproj','-scheme','AssistantUIFixtures','-configuration','Debug','-destination','id='+udid,'-derivedDataPath',str(build),'CODE_SIGNING_ALLOWED=NO','CODE_SIGNING_REQUIRED=NO','CODE_SIGN_IDENTITY=','build-for-testing'], 480)
        products = build / 'Build/Products'
        runs = list(products.glob('AssistantUIFixtures_*.xctestrun'))
        if len(runs) != 1: raise RuntimeError('Expected exactly one built xctestrun')
        specification = plistlib.loads(runs[0].read_bytes())
        if specification.get('__xctestrun_metadata__', {}).get('FormatVersion') != 1 or specification.get('AssistantUITests', {}).get('IsUITestBundle') is not True:
            raise RuntimeError('Unsupported native test specification')
        # Automatic video/screenshots are not the bounded custom evidence.
        # xcodebuild.xctestrun documents keepNever for system attachments;
        # explicit screenshots/native trees remain keepAlways in the tests.
        specification['AssistantUITests']['SystemAttachmentLifetime'] = 'keepNever'
        specification['AssistantUITests']['UserAttachmentLifetime'] = 'keepAlways'
        runs[0].write_bytes(plistlib.dumps(specification))
        save('attachment-policy.json', {'system':'keepNever','custom':'keepAlways','verboseDiagnostics':'never','customPNGLimitBytes':64*1024*1024})
        binaries = {}
        for bundle in ['AssistantUITestHost.app','AssistantUITests-Runner.app']:
            folder = products / 'Debug-iphonesimulator' / bundle
            if not folder.is_dir(): raise RuntimeError('Missing built bundle '+bundle)
            binaries[bundle] = {str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.rglob('*')) if p.is_file() and not p.is_symlink()}
        save('binary-pins.json', {'xctestrunSHA':hashlib.sha256(runs[0].read_bytes()).hexdigest(),'bundles':binaries})
        if any(hashlib.sha256(Path(p).read_bytes()).hexdigest()!=h for p,h in pins.items()): raise RuntimeError('Source drift')
        result = root / 'capability.xcresult'
        output = run('test', ['xcodebuild','test-without-building','-xctestrun',str(runs[0]),'-destination','id='+udid,'-destination-timeout','30','-collect-test-diagnostics','never','-parallel-testing-enabled','NO','-maximum-concurrent-test-simulator-destinations','1','-test-timeouts-enabled','YES','-default-test-execution-time-allowance','900','-maximum-test-execution-time-allowance','900','-only-testing:AssistantUITests/MobileControlsUITests','-resultBundlePath',str(result)], 1020)
        summary = json.loads(run('summary', ['xcrun','xcresulttool','get','test-results','summary','--path',str(result)], 10))
        tests = json.loads(run('named-tests', ['xcrun','xcresulttool','get','test-results','tests','--path',str(result)], 10))
        named = re.search(r'MobileControlsUITests[^\n]{0,160}testNativeControlsCapability[^\n]{0,80}\bpassed\b', output, re.I)
        cases = []
        def visit(node, bundle=False):
            bundle = bundle or (node.get('nodeType')=='UI test bundle' and node.get('name','').removesuffix('.xctest')=='AssistantUITests')
            if node.get('nodeType')=='Test Case': cases.append((node,bundle))
            for child in node.get('children',[]): visit(child,bundle)
        for node in tests.get('testNodes',[]): visit(node)
        identities = {node.get('nodeIdentifier','').removesuffix('()').removeprefix('AssistantUITests/') for node, _ in cases}
        structured = len(cases)==2 and identities == {'MobileControlsUITests/testNativeControlsCapability','MobileControlsUITests/testAccessibleControlsMatrix'} and all(bundle and node.get('result')=='Passed' for node,bundle in cases)
        if not structured or not named or [summary.get(k) for k in ['totalTestCount','passedTests','failedTests','skippedTests']] != [2,2,0,0]: raise RuntimeError('Missing both exact named PASS/zero-skip evidence')
        save('outcome.json', {'result':'PASS','namedTests':['AssistantUITests/MobileControlsUITests/testNativeControlsCapability','AssistantUITests/MobileControlsUITests/testAccessibleControlsMatrix'],'summary':summary,'sourceHead':head,'pullRequestHead':os.environ['PR_HEAD'],'qualification':'synthetic capability and 20-case native simulator matrix; no physical-device, VoiceOver or persistence acceptance'})
    except BaseException as error:
        save('failure.json', {'result':'HOLD','error':repr(error)})
        raise

elif sys.argv[1] == 'cleanup':
    import os, json, subprocess, signal, time, hashlib
    from pathlib import Path
    root = Path(os.environ['RUNNER_TEMP']) / 'native-controls-evidence'
    root.mkdir(mode=0o700, exist_ok=True)
    errors = []; receipt = {'attempted':True,'commands':[]}
    deadline=time.monotonic()+150
    env={k:v for k,v in os.environ.items() if k in {'HOME','USER','LOGNAME','SHELL','TMPDIR','LANG','LC_ALL'}}
    env['PATH']='/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin'
    def present(pid):
        if deadline-time.monotonic()<=0:return None
        try: os.killpg(pid, 0); return True
        except ProcessLookupError: return False
        except OSError: return None
    def call(args):
        remaining=deadline-time.monotonic()
        if remaining<=2:return 124,'Insufficient cleanup command/drain reserve'
        try: p=subprocess.Popen(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
        except Exception as error:
            receipt['commands'].append({'args':args,'pid':None,'exit':1,'closed':True,'problem':repr(error)})
            return 1,repr(error)
        problem=None; output=b''
        try:
            rest=deadline-time.monotonic()-2
            if rest<=0:raise subprocess.TimeoutExpired(args,0)
            output,_=p.communicate(timeout=min(20,rest))
        except subprocess.TimeoutExpired: problem='Cleanup command timeout'
        except Exception as error: problem=repr(error)
        finally:
            p.poll(); residue=present(p.pid)
            if residue is not False:
                if problem is None: problem='Cleanup process-group residue/unknown'
                for sig in (signal.SIGTERM,signal.SIGKILL):
                    if deadline-time.monotonic()<=0:break
                    try: os.killpg(p.pid,sig)
                    except ProcessLookupError: pass
                    except PermissionError: pass
                    rest=deadline-time.monotonic()
                    if rest>0:
                        try:output,_=p.communicate(timeout=min(.5,rest))
                        except subprocess.TimeoutExpired:pass
                    if present(p.pid) is False: break
            p.poll(); closed=present(p.pid) is False
            if not closed: errors.append('Cleanup group not closed: '+str(p.pid))
            p.stdout.close()
        if len(output)>1024*1024: problem='Cleanup response exceeds1MiB';output=output[:1024*1024]
        code=p.returncode if p.returncode is not None else 124
        if problem or not closed: code=code or 1
        text=output.decode(errors='replace')
        receipt['commands'].append({'args':args,'pid':p.pid,'exit':code,'closed':closed,'problem':problem,'detail':text[-2000:]})
        return code,text
    def app_inventory(text):
        path=root/'cleanup-app-inventory.plist';path.write_text(text)
        code,encoded=call(['/usr/bin/plutil','-convert','json','-o','-',str(path)])
        if code: raise RuntimeError('Cannot decode installed app inventory')
        value=json.loads(encoded)
        if not isinstance(value,dict): raise RuntimeError('Invalid installed app inventory')
        return value
    try:
        lease=root/'lease.json'
        active=root/'active-command.json'
        if active.exists():
            record=json.loads(active.read_text())
            observed=present(record['pid']) if record['pid'] is not None else False
            final_group=present(record['pid']) if record['pid'] is not None else False
            receipt['retainedProcessGroup']={'pid':record['pid'],'observation':'absent' if final_group is False else 'present' if final_group is True else 'unknown','closed':final_group is False}
            if final_group is not False: errors.append('Retained group presence/closure unknown')
        if lease.exists():
            owned=json.loads(lease.read_text());udid=owned['udid']
            if owned['createdByRun']!=os.environ['GITHUB_RUN_ID'] or owned['mode']!='hosted-job-fixture': raise RuntimeError('Fixture lease owner mismatch')
            bundles=['com.baldvinsmarason.assistant.uitesthost','com.baldvinsmarason.assistant.uitesthost.tests.xctrunner']
            code,running=call(['xcrun','simctl','spawn',udid,'launchctl','list'])
            if code: errors.append('Cannot inspect fixture app processes')
            else:
                for bundle in bundles:
                    if bundle in running:
                        code,detail=call(['xcrun','simctl','terminate',udid,bundle])
                        if code: receipt.setdefault('terminationObservations',[]).append({'bundle':bundle,'exit':code,'detail':detail[-300:]})
            code,text=call(['xcrun','simctl','listapps',udid])
            if code: errors.append('Cannot inventory installed fixture apps')
            else:
                apps=app_inventory(text)
                for bundle in bundles:
                    if bundle in apps:
                        code,detail=call(['xcrun','simctl','uninstall',udid,bundle])
                        if code: receipt.setdefault('uninstallObservations',[]).append({'bundle':bundle,'exit':code,'detail':detail[-300:]})
            code,text=call(['xcrun','simctl','listapps',udid])
            absent=code==0 and not any(bundle in app_inventory(text) for bundle in bundles)
            receipt['fixtureBundlesAbsent']=absent
            if not absent: errors.append('Fixture app absence unverified')
            code,running=call(['xcrun','simctl','spawn',udid,'launchctl','list'])
            processes_absent=code==0 and not any(bundle in running for bundle in bundles)
            receipt['fixtureProcessesAbsent']=processes_absent
            if not processes_absent: errors.append('Fixture app process absence unverified')
            receipt['jobDestination']=udid
    except BaseException as error: errors.append(repr(error))
    finally:
        receipt['errors']=errors;receipt['deadlineExceeded']=time.monotonic()>deadline
        (root/'cleanup.json').write_text(json.dumps(receipt,indent=2)+'\n')
        total=sum(p.stat().st_size for p in root.rglob('*') if p.is_file());upload=root
        if total>128*1024*1024:
            errors.append('Total evidence exceeds128MiB including automatic XCTest attachments')
            upload=Path(os.environ['RUNNER_TEMP'])/'native-controls-oversize';upload.mkdir(exist_ok=True)
            retained=[]; remaining=8*1024*1024
            # Preserve failure causes and canonical closure receipts even
            # when the raw result bundle exceeds the evidence bound.
            for path in sorted(root.iterdir()):
                if not path.is_file() or path.suffix not in {'.json','.log'}: continue
                size=path.stat().st_size; count=min(size,256*1024,remaining)
                if count<=0: break
                with path.open('rb') as stream:
                    stream.seek(max(0,size-count)); data=stream.read(count)
                name=path.name if size==count else path.name+'.tail.txt'
                (upload/name).write_bytes(data); remaining-=len(data)
                retained.append({'name':name,'originalBytes':size,'retainedBytes':len(data),'complete':size==count,'retainedSHA256':hashlib.sha256(data).hexdigest()})
            (upload/'failure-manifest.json').write_text(json.dumps({'result':'HOLD','totalBytes':total,'errors':errors,'retainedDiagnostics':retained,'boundary':'Oversize raw result omitted; bounded diagnostics retained; never accepted as PASS'},indent=2)+'\n')
        with open(os.environ['GITHUB_OUTPUT'],'a') as out: out.write('upload='+str(upload)+'\n')
    if errors or receipt['deadlineExceeded']: raise SystemExit('Owned closure/evidence bound failed: '+str(errors))
