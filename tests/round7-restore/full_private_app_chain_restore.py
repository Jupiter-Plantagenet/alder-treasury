"""End-to-end restore using copied private files, coherent DB/chain, and actual API health.

Run only after the shared heavy-restore lock is clear. This composes the bounded
private-tree copy/readback verifier with the existing DB/chain/API/rebuild harness,
mounting the verified private destination read-only into the restored API.
"""
from __future__ import annotations
import hashlib, json, os, subprocess, sys, time
from contextlib import redirect_stdout, redirect_stderr
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
RUN=os.environ.get('ALDER_ROUND7_FULL_PRIVATE_RUN','20261103-private-full-a')
PRIVATE_RUN=RUN+'-private'; APP_RUN=RUN+'-app'
OWNER='r7priv'+hashlib.sha256(PRIVATE_RUN.encode()).hexdigest()[:12]
VOLUME='alder-r7-private-'+OWNER; LABEL='alder.r7.owner'
PRIVATE_SCRIPT=ROOT/'tests'/'round7-restore'/'private_files_restore.py'
APP_SCRIPT=ROOT/'tests'/'round7-restore'/'app_chain_restore.py'
PRIVATE_PROOF=ROOT/'.local'/('round7-restore-'+PRIVATE_RUN)/'private-files-proof.json'
APP_PROOF=ROOT/'.local'/('round7-restore-'+APP_RUN)/'app-chain-proof.json'
OUT=ROOT/'.local'/('round7-restore-'+RUN)/'full-private-app-chain-proof.json'
START=time.monotonic(); report={'schema':'alder.round7-full-private-app-chain-restore/v1','runId':RUN,
 'startedAtUtc':datetime.now(timezone.utc).isoformat(),'sourceBackupMutation':False,
 'secretValuesEmitted':False,'privateDestinationVolume':VOLUME,'signerStarted':False,
 'apiProbeWorkerStarted':False,'isolatedRebuildWorkerStarted':False,'broadcastAttempted':False}

def docker(args,check=True):
 p=subprocess.run(['docker',*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 if check and p.returncode: raise RuntimeError('DOCKER_'+args[0].upper()+'_FAILED_'+str(p.returncode))
 return p

volume_created=False
try:
 run_dir=OUT.parent
 app_owner='r7app'+hashlib.sha256(APP_RUN.encode()).hexdigest()[:12]
 output_paths=[OUT,PRIVATE_PROOF,APP_PROOF]
 output_dirs=[run_dir,PRIVATE_PROOF.parent,APP_PROOF.parent]
 if any(d.exists() for d in output_dirs) or any(p.exists() for p in output_paths): raise RuntimeError('EVIDENCE_OUTPUT_PATH_ALREADY_EXISTS')
 resource_names=[VOLUME,'alder-r7-private-copy-'+OWNER,
  'alder-r7-net-'+app_owner,'alder-r7-pg-'+app_owner,'alder-r7-anvil-'+app_owner,
  'alder-r7-api-'+app_owner,'alder-r7-worker-'+app_owner,'alder-r7-build-'+app_owner,
  'alder-r7-work-'+app_owner]
 for name in resource_names:
  for kind,cmd in [('container',['inspect',name]),('network',['network','inspect',name]),('volume',['volume','inspect',name])]:
   if docker(cmd,check=False).returncode==0: raise RuntimeError('SCRATCH_NAME_ALREADY_EXISTS')
 env=os.environ.copy(); env['ALDER_ROUND7_PRIVATE_RUN']=PRIVATE_RUN; env['ALDER_ROUND7_PRIVATE_KEEP_VOLUME']='1'
 prep=subprocess.run([sys.executable,str(PRIVATE_SCRIPT)],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=900)
 report['privateCopyRunnerExitCode']=prep.returncode
 if prep.returncode: raise RuntimeError('PRIVATE_TREE_COPY_READBACK_FAILED')
 pp=json.loads(PRIVATE_PROOF.read_text(encoding='utf-8'))
 report['privateCopyEvidencePath']=str(PRIVATE_PROOF)
 report['privateCopyProofSha256']=hashlib.sha256(PRIVATE_PROOF.read_bytes()).hexdigest()
 report['privateCopyAssertions']={'copyReadbackPass':pp.get('copyReadbackPass') is True,
  'filesReadBack':(pp.get('readback') or {}).get('filesReadBack'),
  'bytesReadBack':(pp.get('readback') or {}).get('bytesReadBack'),
  'fileModesRestricted':(pp.get('readback') or {}).get('allFileModesRestricted') is True,
  'directoriesMode0700':(pp.get('readback') or {}).get('allDirectoriesMode0700') is True,
  'copySeconds':pp.get('copySeconds')}
 if not report['privateCopyAssertions']['copyReadbackPass'] or not report['privateCopyAssertions']['fileModesRestricted'] or not report['privateCopyAssertions']['directoriesMode0700']:
  raise RuntimeError('PRIVATE_TREE_COPY_ASSERTION_FAILED')
 vol=docker(['volume','inspect','--format','{{index .Labels "'+LABEL+'"}}',VOLUME])
 if vol.stdout.decode().strip()!=OWNER: raise RuntimeError('PRIVATE_VOLUME_OWNER_MISMATCH')
 volume_created=True

 # Swap only the API's private bind mount at runtime; the harness still validates
 # all source manifest files and restores DB/chain from the same coherent backup.
 source=APP_SCRIPT.read_text(encoding='utf-8')
 old='f\'type=bind,source={BACKUP/"private"},target=/work/.local,readonly\''
 new='f\'type=volume,source={private_volume},target=/work/.local,readonly\''
 if source.count(old)!=1: raise RuntimeError('API_PRIVATE_MOUNT_PATCH_POINT_NOT_UNIQUE')
 source=source.replace(old,new)
 audit="created['containers'].append(API)\n # Verify the actual API container consumes the owner-pinned restored private volume read-only.\n api_mounts=json.loads(docker(['inspect',API]).stdout)[0].get('Mounts',[])\n api_private_mount=next((m for m in api_mounts if m.get('Destination')=='/work/.local'),None)\n report['privateDestinationMountedIntoApiReadOnly']=bool(api_private_mount and api_private_mount.get('Type')=='volume' and api_private_mount.get('Name')==private_volume and api_private_mount.get('RW') is False)\n if not report['privateDestinationMountedIntoApiReadOnly']: raise RuntimeError('API_PRIVATE_RESTORE_MOUNT_ASSERTION_FAILED')\n # Request an explicit full rebuild"
 marker="created['containers'].append(API)\n # Request an explicit full rebuild"
 if source.count(marker)!=1: raise RuntimeError('API_PRIVATE_MOUNT_AUDIT_POINT_NOT_UNIQUE')
 source=source.replace(marker,audit)
 previous_app_run=os.environ.get('ALDER_ROUND7_RUN')
 os.environ['ALDER_ROUND7_RUN']=APP_RUN
 output=StringIO(); errors=StringIO(); app_code=0
 with redirect_stdout(output),redirect_stderr(errors):
  try:
   exec(compile(source,str(APP_SCRIPT),'exec'),{'__file__':str(APP_SCRIPT),'__name__':'__main__','private_volume':VOLUME})
  except SystemExit as ex: app_code=int(ex.code or 0)
  finally:
   if previous_app_run is None: os.environ.pop('ALDER_ROUND7_RUN',None)
   else: os.environ['ALDER_ROUND7_RUN']=previous_app_run
 report['appRunnerExitCode']=app_code
 if app_code: raise RuntimeError('INTEGRATED_DB_CHAIN_API_RESTORE_FAILED')
 if not APP_PROOF.is_file(): raise RuntimeError('INTEGRATED_APP_PROOF_MISSING')
 ap=json.loads(APP_PROOF.read_text(encoding='utf-8'))
 report['appEvidencePath']=str(APP_PROOF)
 report['appProofSha256']=hashlib.sha256(APP_PROOF.read_bytes()).hexdigest()
 report['backupManifestSha256']=ap.get('backupManifestSha256')
 report['coherentSnapshotLineagePass']=bool(ap.get('chainAnchorReceiptMatchesBackup') and ap.get('chainRestoreAssertions') and all(ap['chainRestoreAssertions'].values()))
 report['restoredChain']=ap.get('observedRestoredChain')
 report['apiHealthPass']=ap.get('appPass') is True
 report['apiHealthAssertions']=ap.get('appAssertions')
 report['chainDerivedRebuildPass']=ap.get('chainRebuildPass') is True
 report['chainDerivedRebuild']=ap.get('chainDerivedRebuild')
 report['privateDestinationMountedIntoApiReadOnly']=ap.get('privateDestinationMountedIntoApiReadOnly') is True
 report['privateDestinationVolumeOwnerVerified']=True
 probe=ap.get('applicationStrictTlsProbe') or {}
 report['apiProbeWorkerStarted']=probe.get('workerStarted') is True
 report['isolatedRebuildWorkerStarted']=bool(ap.get('chainDerivedRebuild') and ap.get('chainDerivedRebuild',{}).get('passes',0)>0)
 report['broadcastAttempted']=ap.get('broadcastAttempted') is True or probe.get('broadcastAttempted') is True
 report['artifactIntegrityPass']=(ap.get('manifestArtifactVerification') or {}).get('allFilesMatched') is True
 report['isolationPass']=(ap.get('isolationAssertions') or {}).get('networkInternal') is True and (ap.get('isolationAssertions') or {}).get('allContainersOwnedAndUnpublished') is True
 report['coherentSnapshotAnchorPass']=ap.get('chainAnchorReceiptMatchesBackup') is True
 report['fullRebuildComplete']=bool(ap.get('rebuildRequestCompletion',{}).get('done') is True and ap.get('rebuildRequestCompletion',{}).get('errorPresent') is False)
 report['signerStarted']=probe.get('signerStarted') is True or ap.get('signerStarted') is True
 report['signerLaunchAssertions']={'apiProbeReportsSignerStarted':probe.get('signerStarted') is True,
  'apiProcessWorkerStarted':report['apiProbeWorkerStarted'],
  'separateIndexerRebuildWorkerStarted':report['isolatedRebuildWorkerStarted'],
  'signerContainerOrProcessLaunched':report['signerStarted'],
  'broadcastAttempted':report['broadcastAttempted']}
 report['appCoreRestoreSeconds']=ap.get('rtoSeconds')
 report['privateCopySeconds']=pp.get('copySeconds')
 report['fullWorkflowElapsedSeconds']=round(time.monotonic()-START,3)
 checks=[report['privateCopyAssertions']['copyReadbackPass'],report['privateCopyAssertions']['fileModesRestricted'],report['privateCopyAssertions']['directoriesMode0700'],
  report['artifactIntegrityPass'],report['coherentSnapshotAnchorPass'],report['coherentSnapshotLineagePass'],report['apiHealthPass'],
  report['chainDerivedRebuildPass'],report['fullRebuildComplete'],report['privateDestinationMountedIntoApiReadOnly'],report['privateDestinationVolumeOwnerVerified'],
  report['isolationPass'],report['isolatedRebuildWorkerStarted'],not report['apiProbeWorkerStarted'],not report['broadcastAttempted'],not report['signerStarted']]
 report['mandatoryAssertions']=dict(zip(['privateFileDigestReadback','fileModes0600','directoryModes0700','backupArtifactIntegrity',
  'coherentSnapshotAnchor','runtimeChainLineage','strictTlsApiHealth','chainDerivedRebuild','rebuildRequestCompleted',
  'apiUsesRestoredPrivateVolumeReadOnly','privateVolumeOwnerVerified','scratchIsolation','rebuildWorkerStarted',
  'apiProbeWorkerNotStarted','broadcastNotAttempted','signerNotStarted'],checks))
 report['fullWorkflowPass']=all(checks)
 if not report['fullWorkflowPass']: raise RuntimeError('FULL_PRIVATE_APP_CHAIN_ASSERTIONS_FAILED')
except Exception as e:
 report['fullWorkflowPass']=False
 report['errorCategory']=str(e) if str(e).isupper() else type(e).__name__
finally:
 if volume_created:
  own=docker(['volume','inspect','--format','{{index .Labels "'+LABEL+'"}}',VOLUME],check=False)
  if own.returncode==0 and own.stdout.decode().strip()==OWNER:
   removed=docker(['volume','rm',VOLUME],check=False)
   report['privateDestinationCleanup']='removed exact owner-verified volume' if removed.returncode==0 else 'volume removal failed'
  else: report['privateDestinationCleanup']='owner verification refused removal'
 report['finishedAtUtc']=datetime.now(timezone.utc).isoformat()
 OUT.parent.mkdir(parents=True,exist_ok=True); OUT.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
 print(json.dumps({'evidence':str(OUT),'fullWorkflowPass':report.get('fullWorkflowPass'),
  'privateFilesReadBack':(report.get('privateCopyAssertions') or {}).get('filesReadBack'),
  'privateCopySeconds':report.get('privateCopySeconds'),'elapsedSeconds':report.get('fullWorkflowElapsedSeconds'),
  'apiHealthPass':report.get('apiHealthPass'),'chainDerivedRebuildPass':report.get('chainDerivedRebuildPass'),
  'errorCategory':report.get('errorCategory'),'cleanup':report.get('privateDestinationCleanup')}))
if not report.get('fullWorkflowPass'): sys.exit(2)
