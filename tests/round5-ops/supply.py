"""O5 TR-T-SUPPLY inventory (stdlib only; run with python -I from the alder root).
Produces evidence/round5-ops/supply/: npm-inventory.json (every lockfile package: version, licence, integrity, dev/optional,
install-script flag, installed-version match), sbom.cdx.json (CycloneDX 1.5 generated from the lockfile, used only if the
cyclonedx-npm tool is unavailable), forge-inventory.json (solc/forge pins, vendored Safe + OZ sources with SHA-256,
artifact compiler metadata), pip-inventory.json (python imports: stdlib only), install-scripts.json (postinstall review).
"""
import argparse, hashlib, json, os, pathlib, re, sys, sysconfig, datetime
ROOT = pathlib.Path(__file__).resolve().parents[2]
def output_dir():
    ap = argparse.ArgumentParser(description='Read-only Alder dependency, licence and build metadata inventory.')
    ap.add_argument('--out', default=f'.local/supply-runs/{datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")}-{os.getpid()}')
    raw = ap.parse_args().out
    candidate = pathlib.Path(raw)
    win = pathlib.PureWindowsPath(raw)
    if candidate.is_absolute() or win.is_absolute() or win.drive or any(part in ('.', '..') for part in candidate.parts):
        ap.error('--out must be a relative path inside the Alder product directory')
    resolved = (ROOT / candidate).resolve()
    try:
        resolved.relative_to(ROOT)
    except ValueError:
        ap.error('--out resolves outside the Alder product directory')
    resolved.mkdir(parents=True, exist_ok=False)
    return resolved
OUT = output_dir()
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8')); pkgjson = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
inv = []; problems = []
for key, v in lock['packages'].items():
    if not key: continue
    name = key.split('node_modules/')[-1]; inst = ROOT / key / 'package.json'; installed = None; lic_installed = None; scripts = {}
    if inst.exists():
        ij = json.loads(inst.read_text(encoding='utf-8')); installed = ij.get('version'); lic_installed = ij.get('license') if isinstance(ij.get('license'), str) else (ij.get('license') or {}).get('type') if isinstance(ij.get('license'), dict) else None
        scripts = {k: s for k, s in (ij.get('scripts') or {}).items() if k in ('preinstall', 'install', 'postinstall', 'prepare')}
    row = dict(path=key, name=name, version=v.get('version'), license=v.get('license') or lic_installed, dev=bool(v.get('dev')), optional=bool(v.get('optional')), resolved=v.get('resolved'), integrity=v.get('integrity'),
               hasInstallScript=bool(v.get('hasInstallScript')), installScripts=scripts, installedVersion=installed, installed=inst.exists(), os=v.get('os'), cpu=v.get('cpu'))
    if not v.get('integrity') or not str(v.get('integrity')).startswith('sha512-'): problems.append(f'{key}: integrity not sha512')
    if not str(v.get('resolved', '')).startswith('https://registry.npmjs.org/'): problems.append(f'{key}: resolved not npm registry: {v.get("resolved")}')
    if inst.exists() and installed != v.get('version'): problems.append(f'{key}: installed {installed} != lock {v.get("version")}')
    if not row['license']: problems.append(f'{key}: no licence declared')
    inv.append(row)
direct = {**pkgjson.get('dependencies', {}), **pkgjson.get('devDependencies', {})}
pinned = {k: (not re.search(r'[\^~*xX<>=| ]', v)) for k, v in direct.items()}
root_lock = lock['packages']['']; lock_direct = {**root_lock.get('dependencies', {}), **root_lock.get('devDependencies', {})}
lic = {}
for r in inv: lic[r['license'] or 'UNKNOWN'] = lic.get(r['license'] or 'UNKNOWN', 0) + 1
copyleft = [r for r in inv if r['license'] and re.search(r'GPL|AGPL|LGPL|SSPL|EUPL|MPL', r['license'])]
summary = dict(lockfileVersion=lock.get('lockfileVersion'), packages=len(inv), installed=sum(r['installed'] for r in inv), notInstalled=[r['path'] for r in inv if not r['installed']],
               directDependencies=direct, directExactlyPinned=pinned, packageJsonMatchesLockRoot=direct == lock_direct, licenceCounts=dict(sorted(lic.items(), key=lambda x: -x[1])),
               copyleftOrWeakCopyleft=[(r['name'], r['version'], r['license']) for r in copyleft], integrityProblems=problems,
               lockfileSha256=sha(ROOT / 'package-lock.json'), packageJsonSha256=sha(ROOT / 'package.json'))
(OUT / 'npm-inventory.json').write_text(json.dumps(dict(summary=summary, packages=inv), indent=1), encoding='utf-8')
(OUT / 'install-scripts.json').write_text(json.dumps([dict(path=r['path'], version=r['version'], installed=r['installed'], scripts=r['installScripts'], os=r['os']) for r in inv if r['hasInstallScript'] or r['installScripts']], indent=1), encoding='utf-8')
# CycloneDX 1.5 (generated from the lockfile; components carry the lock's sha512 integrity as hashes)
def purl(n, v): return f"pkg:npm/{n.replace('@', '%40')}@{v}"
comps = []
for r in inv:
    h = []
    if r['integrity'] and r['integrity'].startswith('sha512-'):
        import base64; h = [dict(alg='SHA-512', content=base64.b64decode(r['integrity'][7:]).hex())]
    comps.append({'type': 'library', 'bom-ref': r['path'], 'name': r['name'], 'version': r['version'], 'purl': purl(r['name'], r['version']), 'scope': 'optional' if r['dev'] else 'required',
                  'licenses': [{'expression': r['license']}] if r['license'] else [], 'hashes': h, 'externalReferences': [{'type': 'distribution', 'url': r['resolved']}] if r['resolved'] else []})
for name, src in (('safe-smart-account (vendored)', 'vendor/safe-1.4.1'),):
    comps.append({'type': 'library', 'bom-ref': src, 'name': name, 'version': '1.4.1', 'licenses': [{'license': {'id': 'LGPL-3.0-only'}}], 'hashes': [dict(alg='SHA-256', content=sha(ROOT / src / 'SOURCE.json'))]})
bom = {'bomFormat': 'CycloneDX', 'specVersion': '1.5', 'serialNumber': 'urn:uuid:' + hashlib.sha256(summary['lockfileSha256'].encode()).hexdigest()[:8] + '-0000-4000-8000-' + summary['lockfileSha256'][:12], 'version': 1,
       'metadata': {'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'tools': [{'vendor': 'alder-o5', 'name': 'tests/round5-ops/supply.py (stdlib CycloneDX generator from package-lock.json)'}],
                    'component': {'type': 'application', 'name': pkgjson['name'], 'version': pkgjson['version']}}, 'components': comps}
(OUT / 'sbom.cdx.json').write_text(json.dumps(bom, indent=1), encoding='utf-8')
# forge / contracts
ft = (ROOT / 'foundry.toml').read_text(encoding='utf-8'); vendor = []
for p in sorted((ROOT / 'vendor/safe-1.4.1').rglob('*')):
    if p.is_file(): vendor.append(dict(path=str(p.relative_to(ROOT)).replace('\\', '/'), sha256=sha(p)))
oz = ROOT / 'node_modules/@openzeppelin/contracts'; ozused = []
for rel in ['token/ERC20/ERC20.sol', 'token/ERC20/IERC20.sol', 'token/ERC20/utils/SafeERC20.sol', 'utils/ReentrancyGuard.sol', 'utils/Address.sol', 'package.json', 'LICENSE']:
    p = oz / rel
    if p.exists(): ozused.append(dict(path='node_modules/@openzeppelin/contracts/' + rel, sha256=sha(p)))
arts = {}
for n in ['BatchExecutor', 'ReferenceToken', 'Safe', 'SafeProxyFactory', 'SafeProxy']:
    p = ROOT / f'contracts/out/{n}.sol/{n}.json'
    if p.exists():
        a = json.loads(p.read_text(encoding='utf-8')); md = a.get('rawMetadata') and json.loads(a['rawMetadata']) or a.get('metadata') or {}
        arts[n] = dict(compiler=(md.get('compiler') or {}).get('version'), evmVersion=(md.get('settings') or {}).get('evmVersion'), optimizer=(md.get('settings') or {}).get('optimizer'), deployedBytecodeKeccakInput_sha256=hashlib.sha256(bytes.fromhex(a['deployedBytecode']['object'][2:])).hexdigest(), sourcesSha=dict(list({k: v.get('keccak256') for k, v in (md.get('sources') or {}).items()}.items())[:12]))
forge = dict(foundryToml=ft, foundryTomlSha256=sha(ROOT / 'foundry.toml'), solcPinned=re.search(r'solc_version\s*=\s*"([^"]+)"', ft).group(1), evmVersionPinned=re.search(r'evm_version\s*=\s*"([^"]+)"', ft).group(1),
             vendoredSafeSource=json.loads((ROOT / 'vendor/safe-1.4.1/SOURCE.json').read_text(encoding='utf-8')), vendoredSafeFiles=len(vendor), vendoredSafeTreeSha256=hashlib.sha256(''.join(v['path'] + v['sha256'] for v in vendor).encode()).hexdigest(), openzeppelinUsed=ozused, artifacts=arts)
(OUT / 'forge-inventory.json').write_text(json.dumps(dict(forge=forge, vendoredFiles=vendor), indent=1), encoding='utf-8')
# python: imports across repo python files vs stdlib
stdlib = set(sys.stdlib_module_names); imports = {}
for p in list(ROOT.glob('ops/*.py')) + list(ROOT.glob('tests/*.py')) + list(ROOT.glob('tests/**/*.py')):
    for m in re.findall(r'^\s*(?:from|import)\s+([A-Za-z_][\w]*)', p.read_text(encoding='utf-8', errors='replace'), re.M): imports.setdefault(m, set()).add(str(p.relative_to(ROOT)).replace('\\', '/'))
(OUT / 'pip-inventory.json').write_text(json.dumps(dict(python=sys.version, thirdParty={k: sorted(v) for k, v in imports.items() if k not in stdlib}, stdlibOnly=sorted(k for k in imports if k in stdlib), note='no requirements file; no pip dependencies'), indent=1), encoding='utf-8')
print(json.dumps(dict(packages=summary['packages'], licences=summary['licenceCounts'], copyleft=summary['copyleftOrWeakCopyleft'], integrityProblems=len(problems), firstProblems=problems[:8], directPinned=all(pinned.values()), lockMatches=summary['packageJsonMatchesLockRoot'], vendoredSafe=len(vendor), artifacts={k: (v['compiler'], v['evmVersion']) for k, v in arts.items()}, thirdPartyPython=[k for k in imports if k not in stdlib])))
