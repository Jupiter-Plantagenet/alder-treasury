"""Copy the backup private tree into an isolated Docker volume and verify bytes/modes.

Run only when the shared heavy-restore lock is clear. This process never writes to
the source backup and emits aggregate evidence only; no private paths or values are
included in stdout or the proof report.
"""
from __future__ import annotations
import hashlib, json, os, shutil, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
BACKUP=ROOT/'.local'/'backups'/'codex-round6-20261103T083915Z'
MANIFEST=BACKUP/'manifest.json'
RUN=os.environ.get('ALDER_ROUND7_PRIVATE_RUN','20261103-privatefiles-a')
OWNER='r7priv'+hashlib.sha256(RUN.encode()).hexdigest()[:12]
LABEL='alder.r7.owner'; IMAGE='alder-repro:20261102-a13-linux'
VOLUME='alder-r7-private-'+OWNER; CONTAINER='alder-r7-private-copy-'+OWNER
OUT=ROOT/'.local'/('round7-restore-'+RUN)/'private-files-proof.json'
PRESERVE_VOLUME=os.environ.get('ALDER_ROUND7_PRIVATE_KEEP_VOLUME')=='1'

def call(args, *, check=True, data=None, timeout=300):
    p=subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError('COMMAND_FAILED_'+str(p.returncode))
    return p

def sha(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
    return h.hexdigest()

def docker(args, **kwargs): return call(['docker',*args], **kwargs)

manifest=json.loads(MANIFEST.read_text(encoding='utf-8'))
expected={}
for rel,item in manifest['files'].items():
    p=Path(rel.replace('\\','/'))
    if not p.parts or p.parts[0]!='private': continue
    source=(BACKUP/p).resolve(strict=True)
    if not source.is_relative_to((BACKUP/'private').resolve()) or source.is_symlink() or not source.is_file():
        raise SystemExit('PRIVATE_SOURCE_PATH_INVALID')
    expected[p.as_posix()[len('private/'):]]={'bytes':int(item['bytes']),'sha256':item['sha256']}
if not expected: raise SystemExit('PRIVATE_MANIFEST_EMPTY')
if OUT.exists(): raise SystemExit('PRIVATE_EVIDENCE_OUTPUT_ALREADY_EXISTS')
if subprocess.run(['docker','volume','inspect',VOLUME],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
    raise SystemExit('PRIVATE_VOLUME_NAME_ALREADY_EXISTS')

report={'schema':'alder.round7-private-files-restore/v1','runId':RUN,
        'startedAtUtc':datetime.now(timezone.utc).isoformat(),
        'sourceMutation':False,'secretsEmitted':False,'privateFileCountExpected':len(expected),
        'privateBytesExpected':sum(v['bytes'] for v in expected.values()),
        'destination':'owner-labeled ephemeral Docker volume','fileModeOctal':'0600',
        'directoryModeOctal':'0700'}
disk_free=shutil.disk_usage(ROOT.drive+'\\').free
report['hostDiskFreeBytesBeforeCopy']=disk_free; report['diskFloorBytes']=50_000_000_000
if disk_free<report['diskFloorBytes']: raise SystemExit('PRIVATE_COPY_DISK_FLOOR_FAILED')
created_container=False; created_volume=False
try:
    docker(['volume','create','--label',LABEL+'='+OWNER,VOLUME]); created_volume=True
    docker(['run','-d','--name',CONTAINER,'--label',LABEL+'='+OWNER,'--network','none',
            '--mount','type=volume,source='+VOLUME+',target=/restore/private',
            '--memory','512m','--cpus','1','--pids-limit','64',
            '--entrypoint','sleep',IMAGE,'infinity']); created_container=True
    docker(['exec',CONTAINER,'mkdir','-p','/restore/private'])
    t0=time.monotonic()
    docker(['cp',str(BACKUP/'private')+'/.',CONTAINER+':/restore/private/'],timeout=600)
    report['copySeconds']=round(time.monotonic()-t0,3)

    # The verifier is passed only manifest digests/relative names, never file contents.
    verifier=r'''const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root='/restore/private';let expected='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>expected+=x);
process.stdin.on('end',()=>{try{const exp=JSON.parse(expected),seen=new Set();let bytes=0,files=0,dirs=0,bad=0;
function visit(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name),rel=path.relative(root,p).split(path.sep).join('/'),st=fs.lstatSync(p);
if(st.isSymbolicLink()){bad++;continue;} if(ent.isDirectory()){visit(p);fs.chmodSync(p,0o700);dirs++;if((fs.statSync(p).mode&0o777)!==0o700)bad++;continue;}
if(!ent.isFile()){bad++;continue;}const want=exp[rel];if(!want){bad++;continue;}const h=crypto.createHash('sha256'),fd=fs.openSync(p,'r');const b=Buffer.alloc(1024*1024);let n;while((n=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n));fs.closeSync(fd);const size=fs.statSync(p).size;
if(size!==want.bytes||h.digest('hex')!==want.sha256)bad++;fs.chmodSync(p,0o600);if((fs.statSync(p).mode&0o777)!==0o600)bad++;seen.add(rel);files++;bytes+=size;}}
visit(root);for(const d of ['/restore',root]){fs.chmodSync(d,0o700);dirs++;if((fs.statSync(d).mode&0o777)!==0o700)bad++;}
if(files!==Object.keys(exp).length||[...Object.keys(exp)].some(x=>!seen.has(x)))bad++;
process.stdout.write(JSON.stringify({filesReadBack:files,bytesReadBack:bytes,mismatchCount:bad,allBytesMatched:bad===0&&files===Object.keys(exp).length,allFileModesRestricted:bad===0,allDirectoriesMode0700:bad===0,directoryCount:dirs}));
}catch(e){process.exitCode=3;}});'''
    result=docker(['exec','-i',CONTAINER,'node','-e',verifier],data=json.dumps(expected,separators=(',',':')).encode())
    proof=json.loads(result.stdout.decode('utf-8'))
    report['readback']=proof
    report['copyReadbackPass']=proof.get('allBytesMatched') is True and proof.get('mismatchCount')==0 and proof.get('filesReadBack')==len(expected) and proof.get('bytesReadBack')==report['privateBytesExpected'] and proof.get('allFileModesRestricted') is True and proof.get('allDirectoriesMode0700') is True
    if not report['copyReadbackPass']: raise RuntimeError('PRIVATE_COPY_READBACK_OR_MODE_CHECK_FAILED')
except Exception as e:
    report['copyReadbackPass']=False
    report['errorCategory']=str(e) if str(e).isupper() else type(e).__name__
finally:
    if created_container:
        own=docker(['inspect','--format','{{index .Config.Labels "'+LABEL+'"}}',CONTAINER],check=False)
        if own.returncode==0 and own.stdout.decode().strip()==OWNER: docker(['rm','-f',CONTAINER],check=False)
        else: report['containerCleanupRefused']=True
    if created_volume and not PRESERVE_VOLUME:
        own=docker(['volume','inspect','--format','{{index .Labels "'+LABEL+'"}}',VOLUME],check=False)
        if own.returncode==0 and own.stdout.decode().strip()==OWNER: docker(['volume','rm',VOLUME],check=False)
        else: report['volumeCleanupRefused']=True
    elif created_volume:
        report['volumeRetainedForIntegratedRestore']=True
    report['finishedAtUtc']=datetime.now(timezone.utc).isoformat()
    report['cleanup']='removed owner-verified container; retained verified destination volume for integrated restore' if PRESERVE_VOLUME and created_volume and not report.get('containerCleanupRefused') else ('removed owner-verified container and volume' if not report.get('containerCleanupRefused') and not report.get('volumeCleanupRefused') else 'cleanup refusal recorded')
    OUT.parent.mkdir(parents=True,exist_ok=True); OUT.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'evidence':str(OUT),'privateFileCountExpected':len(expected),
      'copyReadbackPass':report.get('copyReadbackPass'),'copySeconds':report.get('copySeconds'),
      'errorCategory':report.get('errorCategory'),'cleanup':report['cleanup']}))
if not report.get('copyReadbackPass'): sys.exit(2)
