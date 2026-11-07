"""Ordinary bounded Alder checks; historical native helper stays read-only."""
import hashlib,importlib.util,json,os,sys,time,pathlib,shutil,re,tempfile,uuid


def public_environment(scratch, output):
 return {'SystemRoot':'C:/Windows','WINDIR':'C:/Windows','ComSpec':'C:/Windows/System32/cmd.exe',
         'PATH':'C:/Windows/System32;C:/Windows',
         'USERPROFILE':'C:/Users/user','HOME':'C:/Users/user',
         'APPDATA':'C:/Users/user/AppData/Roaming','LOCALAPPDATA':'C:/Users/user/AppData/Local',
         **{k:str(scratch) for k in ('TEMP','TMP','TMPDIR')},
         'ALDER_INBOX_OUTPUT':str(output)}


def validate_command(command):
 node='C:/Users/user/AppData/Local/hermes/tools/node-26.7.0-win32-x64/node.exe'
 pure={'tests/inbox-ui.test.tsx','tests/inbox-dependencies.test.ts','tests/ui.test.tsx','tests/attachments-ui.test.tsx','tests/destination-ui.test.tsx','tests/settlement-ui.test.tsx','tests/units.test.ts','tests/policy.test.ts','tests/policy-ui.test.tsx','tests/round5-pure.test.ts'}
 args=command[1:]
 ok=bool(command) and command[0]==node and (
  (args[:4]==['--import','tsx','--test','--test-concurrency=1'] and bool(args[4:]) and all(a in pure for a in args[4:])) or
  args in [['--import','tsx','tests/browser-inbox-component.ts'],['--import','tsx','tests/browser-inbox-round2.ts'],['--import','tsx','tests/browser-policy-component.ts'],['node_modules/typescript/bin/tsc','--noEmit']] or
  (len(args)==4 and args[:3]==['node_modules/vite/bin/vite.js','build','--outDir'] and re.fullmatch(r'docs/inbox-checks/[a-z0-9-]+-bundle',args[3]) is not None))
 if not ok:raise ValueError('COMMAND_NOT_PUBLIC_ALLOWLISTED')

# Validate before helper import or ANY argv logging (including native-preexec).
try:
 if len(sys.argv)<4 or not re.fullmatch(r'[a-z0-9-]+',sys.argv[1]):raise ValueError()
 label=sys.argv[1];seconds=int(sys.argv[2]);command=sys.argv[3:];validate_command(command)
 if not 0<seconds<=180:raise ValueError()
 if command[1]=='--import' and seconds>90:raise ValueError()
except (ValueError,IndexError):
 print('CHECK_ARGUMENTS_REFUSED: only explicit public check commands accepted');sys.exit(2)
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.dont_write_bytecode=True
HELPER=ROOT/'evidence/saved-byte-correction-20261030-a133/borrowed-native/native_job.py'
assert hashlib.sha256(HELPER.read_bytes()).hexdigest()=='9e4e94405c2ac5be9a1117a1b9ad47ee9afbfb512c533b1bb0a62336440f65ab'
spec=importlib.util.spec_from_file_location('alder_readonly_job',HELPER);assert spec and spec.loader
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
label=sys.argv[1];seconds=int(sys.argv[2]);command=sys.argv[3:]
assert 0<seconds<=180 and command
out=ROOT/'docs/inbox-checks';out.mkdir(exist_ok=True)
logfile=out/(label+'.log');reportfile=out/(label+'.json')
assert not logfile.exists() and not reportfile.exists(),'Never overwrite check output'
lock=ROOT.parent/'.cache/product-build.lock'
report={'command':command,'deadline_seconds':seconds,'whole_cap':2147483648,'native_cap':2013265920,'outside_cap':134217728,'floor':2818572288}
owned=False;job=None;owner='alder-inbox-round2-'+uuid.uuid4().hex
try:
 try:lock.mkdir();owned=True
 except FileExistsError:raise RuntimeError('SHARED_BUILD_LOCK_BUSY: defer to parent; do not poll')
 (lock/'agent.txt').write_text(owner,encoding='utf-8');report['owner']=owner
 report['admission_available']=native.available();report['disk_free']=shutil.disk_usage(ROOT).free
 if report['admission_available']<report['floor']:raise RuntimeError('RESOURCE_ADMISSION_BLOCKED')
 if report['disk_free']<10*1024**3:raise RuntimeError('DISK_ADMISSION_BLOCKED')
 scratch=pathlib.Path(tempfile.mkdtemp(prefix='alder-round2-',dir='C:/Users/user/AppData/Local/hermes/cache/scratch'))
 job=native.OwnedJob(report['native_cap']);env=public_environment(scratch,out/(label+'-browser'))
 report['environment']='explicit public OS constants + owned scratch/output only'
 start=time.monotonic();peak=0;minimum=report['admission_available']
 with logfile.open('xb') as log:
  p=job.launch(command,ROOT,env,log)
  while True:
   sample=job.capture();outside=native.memory_on_handle(native.wink.GetCurrentProcess())['rss'];available=native.available()
   peak=max(peak,sample['rss']+outside);minimum=min(minimum,available)
   if outside>report['outside_cap'] or peak>report['whole_cap'] or available<report['floor']:raise RuntimeError('RESOURCE_BOUND_BREACH')
   code=p.poll()
   if code is not None:break
   if time.monotonic()-start>seconds:raise TimeoutError('CHECK_DEADLINE')
   time.sleep(.05)
 report.update(exit_code=code,peak_whole_rss=peak,minimum_available=minimum,elapsed_seconds=time.monotonic()-start)
except BaseException as e:
 report['blocked_or_error']=str(e)
finally:
 if job:
  try:report['cleanup']=job.cleanup()
  finally:job.close()
 if owned and (lock/'agent.txt').read_text(encoding='utf-8')==owner:
  (lock/'agent.txt').unlink();lock.rmdir()
 reportfile.write_text(json.dumps(report,indent=2),encoding='utf-8')
 print(json.dumps(report))
if 'blocked_or_error' in report:sys.exit(2)
sys.exit(0 if report['exit_code']==0 else 1)
