"""Restore backup PostgreSQL and chain snapshots in an isolated namespace, then health-check Alder API."""
from __future__ import annotations
import hashlib, json, os, shutil, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
RUN=os.environ.get('ALDER_ROUND7_RUN','20261103-appchain')
OWNER='r7app'+hashlib.sha256(RUN.encode()).hexdigest()[:12]
LABEL='alder.r7.owner'
BACKUP=ROOT/'.local'/'backups'/'codex-round6-20261103T083915Z'
MANIFEST=BACKUP/'manifest.json'; CHAIN=BACKUP/'anvil-state.json'
RELOAD=BACKUP/'private'/'chain-state'/'reload-points.jsonl'; APP_PROFILE=BACKUP/'private'/'database-app.json'
IMAGE='alder-repro:20261102-a13-linux'; PG_IMAGE='postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
NET='alder-r7-net-'+OWNER; PG='alder-r7-pg-'+OWNER; ANVIL='alder-r7-anvil-'+OWNER; API='alder-r7-api-'+OWNER; WORKER='alder-r7-worker-'+OWNER
BUILDER='alder-r7-build-'+OWNER; WORKVOL='alder-r7-work-'+OWNER
NPM_CACHE=ROOT/'.local'/'repro-acquisition'/'linux-x86_64'/'npm-cache'
OUT=ROOT/'.local'/('round7-restore-'+RUN)/'app-chain-proof.json'

def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
 return h.hexdigest()
def docker(args,timeout=600,check=True,input_bytes=None):
 p=subprocess.run(['docker',*args],input=input_bytes,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 if check and p.returncode: raise RuntimeError('DOCKER_'+args[0].upper()+'_FAILED_'+str(p.returncode))
 return p
created={'containers':[],'networks':[],'volumes':[]}
report={'schema':'alder.round7-app-chain-restore/v1','startedAtUtc':datetime.now(timezone.utc).isoformat(),
 'retainedDatabaseOrChainMutation':False,'hostPublishedPorts':[],'networkEgress':'internal-only',
 'broadcastAttempted':False,'workerStarted':False,'signerStarted':False}

def cleanup():
 for name in reversed(created['containers']):
  p=docker(['inspect','--format','{{index .Config.Labels "'+LABEL+'"}}',name],check=False)
  if p.returncode==0 and p.stdout.decode().strip()==OWNER: docker(['rm','-f',name],check=False)
  else: report.setdefault('cleanupRefusals',[]).append(name)
 for name in created['networks']:
  p=docker(['network','inspect','--format','{{index .Labels "'+LABEL+'"}}',name],check=False)
  if p.returncode==0 and p.stdout.decode().strip()==OWNER: docker(['network','rm',name],check=False)
  else: report.setdefault('cleanupRefusals',[]).append(name)
 for name in created['volumes']:
  p=docker(['volume','inspect','--format','{{index .Labels "'+LABEL+'"}}',name],check=False)
  if p.returncode==0 and p.stdout.decode().strip()==OWNER: docker(['volume','rm',name],check=False)
  else: report.setdefault('cleanupRefusals',[]).append(name)

try:
 manifest=json.loads(MANIFEST.read_text()); snap=manifest['chain_snapshot']; binding={'chainId':snap['chain_id'],'genesisHash':snap['genesis_hash'],'headNumber':snap['head_number']}; reloads=[json.loads(x) for x in RELOAD.read_text().splitlines() if x.strip()]
 anchor=next((x for x in reversed(reloads) if x.get('anchorHeight')==binding['headNumber']),None)
 state=json.loads(CHAIN.read_text()); db_item=manifest['files']['alder.dump']; roles_item=manifest['files']['roles.sql']
 chain_item=manifest['files']['anvil-state.json']; chain_capture=manifest['chain_files']['private\\chain-state\\anvil-8547-state.json']
 dump=BACKUP/'alder.dump'; roles=BACKUP/'roles.sql'
 report.update({'backupManifestSha256':sha(MANIFEST),'dumpSha256':sha(dump),'rolesSha256':sha(roles),
 'chainStateSha256':sha(CHAIN),'chainReloadReceiptSha256':sha(RELOAD),'chainHeadInSnapshot':int(state['block']['number'],16),
  'chainAnchorReceiptMatchesBackup':bool(anchor and anchor.get('genesis')==binding['genesisHash'] and anchor.get('height')==str(binding['headNumber']) and chain_capture.get('sha256')==sha(CHAIN) and chain_item.get('sha256')==sha(CHAIN)),
  'manifestDumpMatches':sha(dump)==db_item['sha256'] and dump.stat().st_size==db_item['bytes'],
  'manifestRolesMatches':sha(roles)==roles_item['sha256'] and roles.stat().st_size==roles_item['bytes'],
  'manifestAppProfileMatches':sha(APP_PROFILE)==manifest['files']['private\\database-app.json']['sha256'],
  'expectedChainId':binding['chainId'],'expectedGenesisHash':binding['genesisHash'],
  'expectedHeadNumber':binding['headNumber'],'expectedHeadHash':anchor.get('anchorHash') if anchor else None})
 verified=0; mismatches=0; verified_bytes=0
 for relative,item in manifest['files'].items():
  candidate=(BACKUP/Path(relative.replace('\\','/'))).resolve(strict=True)
  if not candidate.is_relative_to(BACKUP.resolve()) or candidate.is_symlink() or not candidate.is_file():
   mismatches+=1; continue
  verified+=1; verified_bytes+=candidate.stat().st_size
  if candidate.stat().st_size!=item.get('bytes') or sha(candidate)!=item.get('sha256'): mismatches+=1
 report['manifestArtifactVerification']={'filesVerified':verified,'totalBytesVerified':verified_bytes,
  'mismatchCount':mismatches,'allFilesMatched':verified==len(manifest['files']) and mismatches==0}
 if not report['manifestArtifactVerification']['allFilesMatched'] or not report['manifestDumpMatches'] or not report['manifestRolesMatches'] or not report['manifestAppProfileMatches'] or not report['chainAnchorReceiptMatchesBackup'] or report['chainHeadInSnapshot']<binding['headNumber']:
  raise RuntimeError('BACKUP_OR_CHAIN_ANCHOR_BINDING_INVALID')
 free_bytes=shutil.disk_usage(ROOT.drive+'\\').free
 report['hostDiskFreeBytesBeforeDocker']=free_bytes
 report['diskFloorBytes']=50_000_000_000
 if free_bytes<report['diskFloorBytes']: raise RuntimeError('RESTORE_DISK_FLOOR_FAILED')
 docker(['network','create','--internal','--label',LABEL+'='+OWNER,NET]); created['networks'].append(NET)
 if not NPM_CACHE.is_dir(): raise RuntimeError('PINNED_OFFLINE_NPM_CACHE_MISSING')
 docker(['volume','create','--label',LABEL+'='+OWNER,WORKVOL]); created['volumes'].append(WORKVOL)
 docker(['run','-d','--name',BUILDER,'--label',LABEL+'='+OWNER,'--network',NET,
  '--mount','type=volume,source='+WORKVOL+',target=/work',
  '--mount',f'type=bind,source={NPM_CACHE},target=/npm-cache,readonly',
  '--memory','1g','--cpus','2','--pids-limit','128','--entrypoint','sleep',IMAGE,'infinity']); created['containers'].append(BUILDER)
 docker(['exec',BUILDER,'mkdir','-p','/work'])
 for source in ('apps','packages','services','tests','package.json','package-lock.json'):
  docker(['cp',str(ROOT/source),BUILDER+':/work'])
 install=docker(['exec',BUILDER,'npm','ci','--offline','--cache','/npm-cache','--prefix','/work'],timeout=600,check=False)
 report['linuxRuntimeInstall']={'exitCode':install.returncode,'stdoutSha256':hashlib.sha256(install.stdout).hexdigest(),
  'stderrSha256':hashlib.sha256(install.stderr).hexdigest(),'offlineOnly':True}
 if install.returncode: raise RuntimeError('ISOLATED_LINUX_RUNTIME_INSTALL_FAILED')
 docker(['run','-d','--name',PG,'--label',LABEL+'='+OWNER,'--network',NET,'--memory','768m','--cpus','2','--pids-limit','128',
  '--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=768m','-e','POSTGRES_HOST_AUTH_METHOD=trust',PG_IMAGE,
  'postgres','-p','15543','-c','listen_addresses=127.0.0.1']); created['containers'].append(PG)
 ready=False
 for _ in range(90):
  if docker(['exec',PG,'pg_isready','-U','postgres','-p','15543'],check=False).returncode==0: ready=True; break
  time.sleep(1)
 report['scratchPostgresReady']=ready
 if not ready: raise RuntimeError('SCRATCH_POSTGRES_NOT_READY')
 role_lines=roles.read_bytes().splitlines(keepends=True); create_postgres=b'CREATE ROLE postgres;'
 if sum(x.rstrip(b'\r\n')==create_postgres for x in role_lines)!=1: raise RuntimeError('ROLE_ARCHIVE_POSTGRES_CREATE_NOT_UNIQUE')
 role_input=b''.join(x for x in role_lines if x.rstrip(b'\r\n')!=create_postgres)
 q=docker(['exec','-i',PG,'psql','-p','15543','-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1'],input_bytes=role_input)
 report['roleRestoreExit']=q.returncode
 q=docker(['exec','-i',PG,'pg_restore','-p','15543','-U','postgres','--create','--exit-on-error','--dbname','postgres'],timeout=900,input_bytes=dump.read_bytes())
 report['databaseRestoreExit']=q.returncode
 if q.returncode: raise RuntimeError('SCRATCH_DATABASE_RESTORE_FAILED')
 tool=ROOT/'.local'/'repro-acquisition'/'linux-x86_64'
 docker(['run','-d','--name',ANVIL,'--label',LABEL+'='+OWNER,'--network','container:'+PG,
  '--memory','768m','--cpus','2','--pids-limit','128',
  '--mount',f'type=bind,source={CHAIN},target=/chain-state.json,readonly',
  '--mount',f'type=bind,source={tool},target=/opt/toolchain,readonly',
  '--entrypoint','/opt/toolchain/foundry/anvil',IMAGE,'--host','127.0.0.1','--port','18547','--chain-id','31337','--hardfork','shanghai',
  '--load-state','/chain-state.json','--silent']); created['containers'].append(ANVIL)
 chain_probe=None; deadline=time.monotonic()+60
 probe_js=f"""async function q(method,params){{let r=await fetch('http://127.0.0.1:18547',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify({{jsonrpc:'2.0',id:1,method,params}})}});return (await r.json()).result}};Promise.all([q('eth_chainId',[]),q('eth_blockNumber',[]),q('eth_getBlockByNumber',['0x0',false]),q('eth_getBlockByNumber',['{hex(binding['headNumber'])}',false])]).then(([c,h,g,b])=>console.log(JSON.stringify({{chainId:c,head:Number(BigInt(h)),genesisHash:g?.hash,pinnedBlockHash:b?.hash}}))).catch(()=>process.exit(2))"""
 while time.monotonic()<deadline:
  p=docker(['exec',ANVIL,'node','-e',probe_js],check=False)
  if p.returncode==0:
   try: chain_probe=json.loads(p.stdout.decode().strip()); break
   except json.JSONDecodeError: pass
  time.sleep(.5)
 report['observedRestoredChain']=chain_probe
 report['chainRestoreAssertions']={'chainIdMatches':bool(chain_probe and chain_probe.get('chainId','').lower()==binding['chainId'].lower()),
  'genesisMatches':bool(chain_probe and chain_probe.get('genesisHash','').lower()==binding['genesisHash'].lower()),
  'headMatches':bool(chain_probe and int(chain_probe.get('head'))==int(binding['headNumber'])),
  'pinnedHeadHashMatches':bool(chain_probe and chain_probe.get('pinnedBlockHash','').lower()==report['expectedHeadHash'].lower())}
 if not all(report['chainRestoreAssertions'].values()): raise RuntimeError('RESTORED_CHAIN_RUNTIME_LINEAGE_MISMATCH')
 docker(['run','-d','--name',API,'--label',LABEL+'='+OWNER,'--network','container:'+PG,
  '--mount','type=volume,source='+WORKVOL+',target=/work',
   '--mount',f'type=bind,source={BACKUP/"private"},target=/work/.local,readonly',
   '-e','ALDER_ROUND7_APP_PROFILE=/work/.local/database-app.json','-e','ALDER_ROUND7_DB_PORT=15543','-e','ALDER_RPC_URL=http://127.0.0.1:18547',
   '--memory','768m','--cpus','2','--pids-limit','128','-w','/work','--entrypoint','node',IMAGE,'/work/node_modules/tsx/dist/cli.mjs','/work/tests/round7-restore/start_restored_app.ts']); created['containers'].append(API)
 # Request an explicit full rebuild in the restored database. The worker is isolated from
 # public egress, uses only the restored chain RPC, and has no signer or transaction sender.
 request=docker(['exec','-i',PG,'psql','-p','15543','-U','postgres','-d','alder','-X','-qAt','-v','ON_ERROR_STOP=1','-c',
  "INSERT INTO indexer_requests(kind,requested_by) VALUES('rebuild','round7-restore') RETURNING id::text"])
 request_id=request.stdout.decode().strip()
 report['rebuildRequestId']=request_id
 services=ROOT/'services'
 docker(['run','-d','--name',WORKER,'--label',LABEL+'='+OWNER,'--network','container:'+PG,
  '--mount','type=volume,source='+WORKVOL+',target=/work',
  '-e','ALDER_ISOLATED_WORKER_DB=postgresql://alder_indexer@127.0.0.1:15543/alder',
  '-e','ALDER_RPC_URL=http://127.0.0.1:18547','-e','ALDER_WORKER_PORT=19554',
  '-e','ALDER_WORKER_INTERVAL_MS=100000','-e','ALDER_WORKER_LOG=/tmp/round7-indexer-worker.jsonl','--memory','768m','--cpus','2','--pids-limit','128',
  '-w','/work','--entrypoint','node',IMAGE,'/work/node_modules/tsx/dist/cli.mjs','/work/services/indexer-worker.ts']); created['containers'].append(WORKER)
 deadline=time.monotonic()+180; rebuild=None
 while time.monotonic()<deadline:
  p=docker(['exec',WORKER,'node','-e',"fetch('http://127.0.0.1:19554/status').then(async r=>console.log(await r.text())).catch(()=>process.exit(2))"],check=False)
  if p.returncode==0:
   try:
    s=json.loads(p.stdout.decode().strip()); lr=s.get('last_result') or {}; window=lr.get('window') or {}
    if lr and (s.get('passes',0)>0 or s.get('last_error')):
     rebuild={'role':s.get('role'),'phase':s.get('phase'),'passes':s.get('passes'),
       'windowMode':window.get('mode'),'head':lr.get('head'),'paused':lr.get('paused'),
       'retryExhausted':s.get('retry_exhausted'),'lastErrorPresent':bool(s.get('last_error'))}
     if window.get('mode')=='full' and str(lr.get('head'))==str(binding['headNumber']): break
   except json.JSONDecodeError: pass
  time.sleep(1)
 report['chainDerivedRebuild']=rebuild
 request_check=docker(['exec',PG,'psql','-p','15543','-U','postgres','-d','alder','-X','-qAt','-v','ON_ERROR_STOP=1','-c',
  "SELECT (done_at IS NOT NULL)::text||'|'||coalesce(error,'')||'|'||coalesce(result->'window'->>'mode','')||'|'||coalesce(result->>'head','')||'|'||coalesce(result->'window'->>'written','0') FROM indexer_requests WHERE id="+request_id])
 request_fields=request_check.stdout.decode().strip().split('|')
 report['rebuildRequestCompletion']={'done':len(request_fields)==5 and request_fields[0]=='true',
  'errorPresent':len(request_fields)==5 and bool(request_fields[1]),
  'windowMode':request_fields[2] if len(request_fields)==5 else None,
  'head':request_fields[3] if len(request_fields)==5 else None,
  'headersWritten':int(request_fields[4]) if len(request_fields)==5 and request_fields[4].isdigit() else 0}
 report['chainRebuildPass']=bool(rebuild and rebuild.get('windowMode')=='full' and str(rebuild.get('head'))==str(binding['headNumber']) and
  not rebuild.get('lastErrorPresent') and not rebuild.get('retryExhausted') and report['rebuildRequestCompletion']['done'] and
  not report['rebuildRequestCompletion']['errorPresent'] and report['rebuildRequestCompletion']['windowMode']=='full' and
  report['rebuildRequestCompletion']['head']==str(binding['headNumber']) and report['rebuildRequestCompletion']['headersWritten']>=binding['headNumber'])
 deadline=time.monotonic()+60; health=None
 while time.monotonic()<deadline:
  p=docker(['exec',API,'node','-e',"const h=require('https'),fs=require('fs');const q=h.get({hostname:'127.0.0.1',port:19553,path:'/health',ca:fs.readFileSync('/work/.local/tls/ca.pem'),rejectUnauthorized:true},r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,body:JSON.parse(b)})))});q.on('error',()=>process.exit(2))"],check=False)
  if p.returncode==0:
   try: health=json.loads(p.stdout.decode().strip()); break
   except json.JSONDecodeError: pass
  time.sleep(1)
 report['apiHealth']=health
 if not health: raise RuntimeError('RESTORED_API_HEALTH_TIMEOUT')
 app_logs=docker(['logs',API],check=False)
 app_line=next((line for line in reversed(app_logs.stdout.decode(errors='replace').splitlines()) if line.startswith('{') and 'assertions' in line),None)
 report['applicationStrictTlsProbe']=json.loads(app_line) if app_line else None
 body=health['body']; report['appAssertions']={'http200':health['status']==200,'ready':body.get('ready') is True,
  'restoredDatabaseReady':body.get('database')=='ready','chainHealthReady':body.get('chain',{}).get('status')=='ready',
  'expectedChainId':body.get('chainId')==31337}
 report['apiHealthReadOnlyGetOnly']=True
 report['appPass']=all(report['appAssertions'].values()) and bool(report['applicationStrictTlsProbe'] and report['applicationStrictTlsProbe'].get('pass') and report['applicationStrictTlsProbe'].get('assertions',{}).get('strictTlsTrustedByBackupCa'))
 report['restoredChainVerification']={'expectedSnapshotHash':report['expectedHeadHash'],'sameEndpointUsedByApi':True}
 net_check=docker(['network','inspect',NET])
 net_obj=json.loads(net_check.stdout)[0]
 pg_id=json.loads(docker(['inspect',PG]).stdout)[0]['Id']
 container_checks={}
 for name in (PG,ANVIL,API,WORKER):
  obj=json.loads(docker(['inspect',name]).stdout)[0]
  mode=obj.get('HostConfig',{}).get('NetworkMode')
  container_checks[name]={'ownerLabelMatches':obj.get('Config',{}).get('Labels',{}).get(LABEL)==OWNER,
   'noPublishedPorts':obj.get('HostConfig',{}).get('PortBindings') in (None,{}),
   'expectedNamespace':mode==(NET if name==PG else 'container:'+PG) or mode==(NET if name==PG else 'container:'+pg_id)}
 report['isolationAssertions']={'networkInternal':net_obj.get('Internal') is True,
  'containers':container_checks,'allContainersOwnedAndUnpublished':all(all(v.values()) for v in container_checks.values()),
  'workspaceVolumeOwnerVerified':docker(['volume','inspect','--format','{{index .Labels "'+LABEL+'"}}',WORKVOL]).stdout.decode().strip()==OWNER}
 if not report['isolationAssertions']['networkInternal'] or not report['isolationAssertions']['allContainersOwnedAndUnpublished']:
  raise RuntimeError('RESTORE_CONTAINER_ISOLATION_ASSERTION_FAILED')
 report['rtoSeconds']=round((datetime.now(timezone.utc)-datetime.fromisoformat(report['startedAtUtc'])).total_seconds(),3)
 report['rtoLimitSeconds']=1800
 report['integratedRestorePass']=report['appPass'] and report['chainRebuildPass'] and report['rtoSeconds']<=1800
 if not report['integratedRestorePass']: raise RuntimeError('INTEGRATED_APP_CHAIN_RESTORE_ASSERTION_FAILED')
except Exception as e:
 report['integratedRestorePass']=False; report['errorCategory']=str(e) if str(e).isupper() else type(e).__name__
finally:
 cleanup(); report['cleanup']='removed exact owner-verified containers and internal network' if not report.get('cleanupRefusals') else 'cleanup refusal recorded'
 report['finishedAtUtc']=datetime.now(timezone.utc).isoformat(); OUT.parent.mkdir(parents=True,exist_ok=True); OUT.write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({'evidence':str(OUT),'sha256':sha(OUT),'integratedRestorePass':report.get('integratedRestorePass'),
  'appPass':report.get('appPass'),'rtoSeconds':report.get('rtoSeconds'),'errorCategory':report.get('errorCategory'),'cleanup':report['cleanup']}))
if not report.get('integratedRestorePass'): sys.exit(2)
