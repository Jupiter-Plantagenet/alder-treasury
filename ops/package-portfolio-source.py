#!/usr/bin/env python3
"""Create Alder's allowlisted, deterministic portfolio source package."""
from __future__ import annotations
import argparse, gzip, hashlib, json, os, subprocess, tarfile
from datetime import datetime, timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.local/portfolio-release-20261103'
RID='alder-portfolio-source-20261103'
DIRS=('apps','packages','services','db','ops','tests','contracts/src','contracts/test','vendor','docs/licenses')
FILES=('docs/CUSTODY.md','docs/acceptance.json','docs/acceptance-policy-20261103.md','docs/acceptance-final-current-20261102.json','docs/inputs/treasury-blueprint.md','docs/inputs/PORTFOLIO-QUALITY-CHARTER.md','docs/TR-T-REPRO-LINUX.md','docs/TR-T-REPRO-PORTFOLIO-20261103.md','package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html','foundry.toml','compose.yml','README.md','RELEASE.md','.gitignore')
SKIP={'.git','.local','.cache','node_modules','dist','evidence','runtime-logs','chain-state','pgdata','out','cache','coverage','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','.tox','.venv','venv'}
SKIP_NAMES={'.env','accounts.json','credentials.json','secrets.json','wallet.json','wallet.dat'}
SKIP_EXT={'.pem','.key','.p12','.pfx','.sqlite','.db','.dump','.pyc','.pyo'}
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''): h.update(b)
 return h.hexdigest()
def excluded(rel):
 parts=[x.lower() for x in rel.parts]; name=parts[-1]
 return bool(set(parts[:-1])&SKIP) or name in SKIP_NAMES or name.startswith('.env.') or Path(name).suffix.lower() in SKIP_EXT
def inventory():
 found=set()
 for rel in FILES:
  p=ROOT/rel
  if not p.is_file(): raise SystemExit('REQUIRED_SOURCE_MISSING '+rel)
  found.add(p)
 for rel in DIRS:
  base=ROOT/rel
  if not base.is_dir(): raise SystemExit('REQUIRED_SOURCE_DIR_MISSING '+rel)
  for current,dirs,names in os.walk(base,topdown=True,followlinks=False):
   here=Path(current)
   for name in list(dirs):
    p=here/name
    if p.is_symlink(): raise SystemExit('SYMLINK_REFUSED '+p.relative_to(ROOT).as_posix())
    if name.lower() in SKIP: dirs.remove(name)
   for name in names:
    p=here/name
    if p.is_symlink(): raise SystemExit('SYMLINK_REFUSED '+p.relative_to(ROOT).as_posix())
    if p.is_file() and not excluded(p.relative_to(ROOT)): found.add(p)
 return sorted(found,key=lambda p:p.relative_to(ROOT).as_posix())
def tree(path):
 rows=[]
 for p in sorted(path.rglob('*'),key=lambda x:x.relative_to(path).as_posix()):
  if p.is_symlink(): raise SystemExit('RELEASE_CANDIDATE_SYMLINK_REFUSED')
  if p.is_file(): rows.append({'path':p.relative_to(path).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)})
 if not rows: raise SystemExit('RELEASE_CANDIDATE_EMPTY')
 canon=json.dumps(rows,sort_keys=True,separators=(',',':')).encode()
 return {'file_count':len(rows),'total_bytes':sum(x['bytes'] for x in rows),'tree_sha256':hashlib.sha256(canon).hexdigest(),'files':rows}
def candidate():
 source=[]
 for base in ('apps/web','packages'):
  for p in sorted((ROOT/base).rglob('*'),key=lambda x:x.as_posix()):
   if p.is_symlink(): raise SystemExit('UI_SOURCE_SYMLINK_REFUSED')
   if p.is_file() and p.suffix.lower() in {'.ts','.tsx','.css'}: source.append({'path':p.relative_to(ROOT).as_posix(),'sha256':sha(p),'bytes':p.stat().st_size})
 return {'schema':'alder.portfolio-release-candidate-ui/v1','release_id':RID,'candidate_path':'.local/release-candidate-20261103','built_by_coordinator':True,'basis':'Staged Vite release candidate was built after the Destination ActionForm fix and the coordinator reports its UI assets are unchanged for the API-only rollout. Source hashes below are the current checkout snapshot, not a served-build receipt. The rollout receipt and served asset manifest are tracked separately when available.','current_ui_source_inputs':source,'tree':tree(ROOT/'.local/release-candidate-20261103')}
def write(path,obj): path.write_text(json.dumps(obj,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
def capture():
 OUT.mkdir(parents=True,exist_ok=True); p=OUT/'candidate-ui-manifest.json'
 write(p,candidate()); print('CANDIDATE_UI_MANIFEST='+str(p.relative_to(ROOT)))
def finalize():
 OUT.mkdir(parents=True,exist_ok=True); arc=OUT/'source.tar.gz'; sm=OUT/'source-manifest.json'; rm=OUT/'release-manifest.json'
 if any(p.exists() for p in (arc,sm,rm)): raise SystemExit('FINAL_PACKAGE_EXISTS_REFUSING_OVERWRITE')
 files=inventory(); rows=[{'path':p.relative_to(ROOT).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)} for p in files]; by_path={r['path']:r for r in rows}; temp=OUT/'.source.tar.gz.tmp'
 try:
  with temp.open('xb') as raw:
   with gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0,compresslevel=9) as gz:
    with tarfile.open(fileobj=gz,mode='w',format=tarfile.GNU_FORMAT) as tar:
     for p in files:
      rel=p.relative_to(ROOT).as_posix(); row=by_path[rel]; ti=tarfile.TarInfo(rel);ti.size=row['bytes'];ti.mode=0o755 if p.stat().st_mode&0o111 else 0o644;ti.uid=ti.gid=0;ti.uname=ti.gname='';ti.mtime=1767225600
      with p.open('rb') as f:tar.addfile(ti,f)
  with tarfile.open(temp,'r:gz') as tar:
   members=tar.getmembers()
   if len(members)!=len(rows): raise SystemExit('ARCHIVE_MEMBER_COUNT_MISMATCH')
   for m in members:
    parts=set(Path(m.name).parts)
    if parts&SKIP or Path(m.name).name.lower() in SKIP_NAMES or Path(m.name).suffix.lower() in SKIP_EXT: raise SystemExit('FORBIDDEN_ARCHIVE_MEMBER')
    if not m.isfile() or m.name not in by_path: raise SystemExit('UNEXPECTED_ARCHIVE_MEMBER')
    f=tar.extractfile(m)
    if f is None: raise SystemExit('ARCHIVE_MEMBER_UNREADABLE')
    digest=hashlib.sha256()
    for block in iter(lambda:f.read(1048576),b''):digest.update(block)
    f.close()
    if m.size!=by_path[m.name]['bytes'] or digest.hexdigest()!=by_path[m.name]['sha256']: raise SystemExit('ARCHIVE_MEMBER_HASH_MISMATCH '+m.name)
  for p,row in zip(files,rows):
   if p.stat().st_size!=row['bytes'] or sha(p)!=row['sha256']: raise SystemExit('SOURCE_CHANGED_DURING_PACKAGE '+row['path'])
  os.replace(temp,arc)
 except BaseException:
  if temp.exists():temp.unlink()
  raise
 ah=sha(arc)
 commit=subprocess.run(['git','rev-parse','HEAD'],cwd=ROOT,text=True,capture_output=True,check=False)
 source={'schema':'alder.source-archive-manifest/v1','release_id':RID,'created_utc':datetime.now(timezone.utc).isoformat(),'source_commit':commit.stdout.strip() if commit.returncode==0 else 'uncommitted-source','working_tree_included':True,'archive':'source.tar.gz','archive_sha256':ah,'archive_bytes':arc.stat().st_size,'member_count':len(rows),'excluded_runtime_or_private_material':True,'files':rows}
 write(sm,source); cand=candidate()
 pins={'node':'v26.7.0','npm':'11.19.0','node_image':'node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32','postgres_image':'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777','foundry':'1.5.1 sha256 73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88','solc':'0.8.24 sha256 fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f','metamask':'13.50.0 sha256 b759caca275dec1a10edfebb9d1de1d26589a92104d8b0523ec442930e20e47c','chrome_linux':'151.0.7922.34 archive ae8736ac28bc69278551500f219fc749575648263c43ec5990749eff43b9fcf8; executable 0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71; verified local acquisition, bytes not bundled'}
 release={'schema':'alder.portfolio-release-manifest/v1','release_id':RID,'status':'source package finalized after explicit freeze','source_archive_sha256':ah,'source_manifest_sha256':sha(sm),'package_lock_sha256':sha(ROOT/'package-lock.json'),'toolchain_metadata_sha256':sha(ROOT/'tests/round6-repro/toolchain.json'),'toolchain_pins':pins,'release_candidate_ui':cand,'commands':{'build':'npm ci --ignore-scripts --no-audit --no-fund && npm run build','replay':'See docs/TR-T-REPRO-PORTFOLIO-20261103.md; stage this archive in a unique .local/repro/<run-id>, acquire pinned artifacts, build pinned runner, run isolated Linux replay.'},'execution_status':'Archive packaging only. No build or clean-host runtime claim; clean-host and independent execution waived.','source_file_count':len(rows),'release_candidate_tree_sha256':cand['tree']['tree_sha256']}
 served=tree(ROOT/'dist')
 release['served_dist']={'path':'dist','included_in_source_archive':False,'tree':served,'matches_staged_candidate':served['tree_sha256']==cand['tree']['tree_sha256']}
 write(rm,release)
 print('SOURCE_ARCHIVE='+str(arc.relative_to(ROOT)));print('SOURCE_SHA256='+ah);print('SOURCE_MANIFEST='+str(sm.relative_to(ROOT)));print('RELEASE_MANIFEST='+str(rm.relative_to(ROOT)))
def bind_companion():
 delivery=OUT/'delivery-manifest.json'
 if delivery.exists(): raise SystemExit('DELIVERY_MANIFEST_EXISTS_REFUSING_OVERWRITE')
 arc=OUT/'source.tar.gz'; sm=OUT/'source-manifest.json'; rm=OUT/'release-manifest.json'
 packet_paths=('docs/acceptance-portfolio-ready-20261103.md','docs/acceptance-portfolio-ready-20261103.json','docs/acceptance-portfolio-ready-20261103.csv')
 for p in (arc,sm,rm):
  if not p.is_file(): raise SystemExit('R3_PACKAGE_INCOMPLETE '+str(p))
 for rel in packet_paths:
  if not (ROOT/rel).is_file(): raise SystemExit('ACCEPTANCE_COMPANION_MISSING '+rel)
 packet=[{'path':rel,'bytes':(ROOT/rel).stat().st_size,'sha256':sha(ROOT/rel)} for rel in packet_paths]
 obj={'schema':'alder.portfolio-delivery-manifest/v1','release_id':RID,'source_archive':{'path':arc.name,'bytes':arc.stat().st_size,'sha256':sha(arc)},'source_manifest':{'path':sm.name,'sha256':sha(sm)},'release_manifest':{'path':rm.name,'sha256':sha(rm)},'acceptance_packet_companion':packet,'binding_note':'This companion manifest binds the immutable source archive to the separately delivered final acceptance packet. It intentionally does not hash itself.'}
 write(delivery,obj);print('DELIVERY_MANIFEST='+str(delivery.relative_to(ROOT)));print('SOURCE_SHA256='+sha(arc));print('ACCEPTANCE_PACKET_SHA256='+','.join(x['sha256'] for x in packet))
if __name__=='__main__':
 ap=argparse.ArgumentParser();g=ap.add_mutually_exclusive_group(required=True);g.add_argument('--capture-candidate',action='store_true');g.add_argument('--finalize-after-freeze',action='store_true');g.add_argument('--bind-acceptance-companion',action='store_true');ap.add_argument('--revision',choices=('1','2','3'),default='1');a=ap.parse_args()
 if a.revision in ('2','3'):
  OUT=ROOT/f'.local/portfolio-release-20261103-r{a.revision}';RID=f'alder-portfolio-source-20261103-r{a.revision}'
 if a.bind_acceptance_companion:
  bind_companion()
 else:
  capture() if a.capture_candidate else finalize()
