"""Restore the manifest-pinned Anvil state into one isolated owned container."""
from __future__ import annotations
import hashlib, json, os, subprocess, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
RUN=os.environ.get('ALDER_ROUND7_RUN','20261103-chain')
OWNER='r7chain'+hashlib.sha256(RUN.encode()).hexdigest()[:12]
BACKUP=ROOT/'.local'/'backups'/'codex-round6-20261103T083915Z'
MANIFEST=BACKUP/'manifest.json'
STATE=BACKUP/'anvil-state.json'
CHAIN_RECEIPT=BACKUP/'private'/'chain-state'/'reload-points.jsonl'
EVIDENCE=ROOT/'.local'/('round7-restore-'+RUN)/'chain-proof.json'
IMAGE='alder-repro:20261102-a13-linux'
CONTAINER='alder-r7-chain-'+OWNER
PORT=19550
LABEL='alder.r7.owner'

def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
 return h.hexdigest()
def docker(args,check=True):
 p=subprocess.run(['docker',*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
 if check and p.returncode: raise RuntimeError('DOCKER_'+args[0].upper()+'_FAILED_'+str(p.returncode))
 return p
def rpc(method,params):
 body=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode()
 req=urllib.request.Request(f'http://127.0.0.1:{PORT}',data=body,headers={'content-type':'application/json'})
 with urllib.request.urlopen(req,timeout=3) as r: out=json.loads(r.read())
 if 'error' in out: raise RuntimeError('RPC_'+method+'_FAILED')
 return out['result']

manifest=json.loads(MANIFEST.read_text()); snap=manifest['chain_snapshot']
binding={'chainId':snap['chain_id'],'genesisHash':snap['genesis_hash'],'headNumber':snap['head_number']}
chain_item=manifest['chain_files']['private\\chain-state\\anvil-8547-state.json']
item=manifest['files'].get('anvil-state.json')
state_metadata=json.loads(STATE.read_text(encoding='utf-8'))
receipt_lines=[json.loads(line) for line in CHAIN_RECEIPT.read_text(encoding='utf-8').splitlines() if line.strip()]
anchor=next((x for x in reversed(receipt_lines) if x.get('anchorHeight')==binding['headNumber']),None)
report={'schema':'alder.round7-chain-restore/v1','startedAtUtc':datetime.now(timezone.utc).isoformat(),
 'backupManifestSha256':sha(MANIFEST),'stateSha256':sha(STATE),'stateBytes':STATE.stat().st_size,
 'statePath':str(STATE),'stateHeadNumber':int(state_metadata.get('block',{}).get('number','0x0'),16),
 'chainReloadReceiptSha256':sha(CHAIN_RECEIPT),'expectedHeadHash':anchor.get('anchorHash') if anchor else None,
 'anchorReceiptMatchesManifest':bool(anchor and anchor.get('genesis')==binding['genesisHash'] and anchor.get('height')==str(binding['headNumber']) and chain_item.get('sha256')==sha(STATE)),
 'stateManifestBinding':item is not None and STATE== (BACKUP/'anvil-state.json').resolve(),
 'manifestStateSha256':item['sha256'] if item else None,'manifestStateBytes':item['bytes'] if item else None,'expectedChainId':binding['chainId'],
 'expectedGenesisHash':binding['genesisHash'],'expectedHeadNumber':binding['headNumber'],
 'readOnlyStateMount':True,'retainedChainMutation':False,
 'broadcastAttempted':False,'containerOwner':OWNER,'hostPort':PORT}
created=False
try:
 if item and report['stateManifestBinding'] and (report['stateSha256']!=item['sha256'] or report['stateBytes']!=item['bytes']): raise RuntimeError('CHAIN_STATE_MANIFEST_DIGEST_MISMATCH')
 if report['stateHeadNumber']<binding['headNumber'] or not report['anchorReceiptMatchesManifest']: raise RuntimeError('CHAIN_STATE_OR_ANCHOR_RECEIPT_MISMATCH')
 if report['stateHeadNumber']<binding['headNumber'] or not report['anchorReceiptMatchesManifest']: raise RuntimeError('CHAIN_STATE_OR_ANCHOR_RECEIPT_MISMATCH')
 toolchain=ROOT/'.local'/'repro-acquisition'/'linux-x86_64'
 args=['run','-d','--name',CONTAINER,'--label',LABEL+'='+OWNER,'--network','bridge',
       '-p',f'127.0.0.1:{PORT}:19550',
       '--mount',f'type=bind,source={STATE},target=/chain-state.json,readonly',
       '--mount',f'type=bind,source={toolchain},target=/opt/toolchain,readonly',
       '--entrypoint','/opt/toolchain/foundry/anvil',IMAGE,
       '--host','0.0.0.0','--port','19550','--chain-id',str(int(binding['chainId'],16)),
       '--hardfork','shanghai','--load-state','/chain-state.json','--silent']
 docker(args); created=True
 deadline=time.monotonic()+60; chain_id=None
 while time.monotonic()<deadline:
  try: chain_id=rpc('eth_chainId',[]); break
  except Exception: time.sleep(.5)
 if chain_id is None: raise RuntimeError('ANVIL_STATE_RESTORE_START_TIMEOUT')
 genesis=rpc('eth_getBlockByNumber',['0x0',False]); block=rpc('eth_getBlockByNumber',[hex(int(binding['headNumber'])),False])
 report['observedChainId']=chain_id
 report['observedGenesisHash']=genesis.get('hash') if genesis else None
 report['observedPinnedHeadHash']=block.get('hash') if block else None
 report['observedHeadNumber']=int(rpc('eth_blockNumber',[]),16)
 report['chainIdMatches']=chain_id.lower()==binding['chainId'].lower()
 report['genesisMatches']=report['observedGenesisHash'].lower()==binding['genesisHash'].lower()
 report['pinnedBlockMatches']=bool(block and block.get('hash','').lower()==str(report['expectedHeadHash']).lower())
 report['restorePass']=report['chainIdMatches'] and report['genesisMatches'] and report['pinnedBlockMatches']
 if not report['restorePass']: raise RuntimeError('CHAIN_RESTORE_LINEAGE_ASSERTION_FAILED')
except Exception as e:
 report['restorePass']=False; report['errorCategory']=str(e) if str(e).isupper() else type(e).__name__
finally:
 if created:
  check=docker(['inspect','--format','{{index .Config.Labels "'+LABEL+'"}}',CONTAINER],False)
  report['ownerVerifiedBeforeCleanup']=check.returncode==0 and check.stdout.decode().strip()==OWNER
  if report['ownerVerifiedBeforeCleanup']:
   rm=docker(['rm','-f',CONTAINER],False); report['cleanup']='removed_exact_owned_container' if rm.returncode==0 else 'owned_container_remove_failed'
  else: report['cleanup']='refused_unverified_container'
 else: report['cleanup']='no_container_created'
 report['finishedAtUtc']=datetime.now(timezone.utc).isoformat()
 EVIDENCE.parent.mkdir(parents=True,exist_ok=True); EVIDENCE.write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({'evidence':str(EVIDENCE),'sha256':sha(EVIDENCE),'restorePass':report['restorePass'],
                   'chainIdMatches':report.get('chainIdMatches'),'genesisMatches':report.get('genesisMatches'),
                   'pinnedBlockMatches':report.get('pinnedBlockMatches'),'cleanup':report.get('cleanup'),
                   'errorCategory':report.get('errorCategory')}))
if not report['restorePass']: raise SystemExit(2)
