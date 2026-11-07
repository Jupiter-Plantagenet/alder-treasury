"""Build/check a private local evidence manifest; never include credentials."""
from pathlib import Path
import hashlib, json, sys, datetime
ROOT=Path(__file__).resolve().parents[1]
TARGET=ROOT/'evidence/manifest.json'
if '--build' in sys.argv:
    paths=[]
    for folder in ['apps','packages','services','contracts/src','contracts/test','db','ops','tests','docs','vendor','evidence']:
        for p in (ROOT/folder).rglob('*'):
            if p.is_file() and p!=TARGET and not p.name.endswith('server.log'):
                paths.append(p)
    paths += [ROOT/n for n in ['package.json','package-lock.json','tsconfig.json','foundry.toml','vite.config.ts','README.md','compose.yml']]
    rows=[{'path':p.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in sorted(set(paths))]
    TARGET.write_text(json.dumps({'schema':1,'generated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'release_verdict':'NO_GO','files':rows},indent=2))
manifest=json.loads(TARGET.read_text())
for row in manifest['files']:
    p=ROOT/row['path']
    assert p.is_relative_to(ROOT) and p.is_file(), row['path']
    assert hashlib.sha256(p.read_bytes()).hexdigest()==row['sha256'], row['path']
print(f"PASS {len(manifest['files'])} source/evidence SHA256 entries; release remains NO_GO")
