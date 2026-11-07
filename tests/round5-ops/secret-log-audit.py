"""O5 TR-T-CSRF secret-logging audit. Never prints a secret: only counts, file names and pattern names.
Secrets loaded in memory: fixture-account password, outsider password, the three scoped DB role passwords, the backup keys
(.local/backup-key.bin, .local/o5/backup.key), and every live + scratch session CSRF token (read-only SQL).
Scanned: runtime-logs/, evidence/ (all text files), db/*.log, the isolated-API logs; plus a static code audit of every
logging call in apps/, services/, packages/, ops/."""
import json, pathlib, re, subprocess, base64, sys
ROOT = pathlib.Path('.').resolve(); OUT = ROOT / 'evidence/round5-ops/csrf'; OUT.mkdir(parents=True, exist_ok=True)
secrets = {}
acc = json.loads((ROOT / '.local/accounts.json').read_text()); secrets['fixture_password'] = acc['password']
outs = json.loads((ROOT / '.local/round4-outsiders.json').read_text()); secrets['outsider_password'] = outs['password']
for role, cfg in json.loads((ROOT / '.local/database.json').read_text()).items(): secrets[f'db_password_{role}'] = cfg['password']
for kf in ['.local/backup-key.bin', '.local/o5/backup.key']:
    p = ROOT / kf
    if p.exists():
        b = p.read_bytes(); secrets[f'{kf}:hex'] = b.hex(); secrets[f'{kf}:b64'] = base64.b64encode(b).decode()
        try:
            t = b.decode().strip()
            if len(t) >= 16: secrets[f'{kf}:text'] = t
        except Exception: pass
def csrf(container, db):
    try:
        r = subprocess.run(['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', db, '-Atc', 'select csrf from sessions'], capture_output=True, text=True, timeout=60)
        return [x for x in r.stdout.split() if x]
    except Exception: return []
tok = csrf('alder-postgres', 'alder') + csrf('alder-o5-pg', 'alder')
for i, t in enumerate(tok): secrets[f'csrf_token_{i}'] = t
secrets = {k: v for k, v in secrets.items() if v and len(v) >= 8}
patterns = {'set-cookie session value': re.compile(r'alder=[0-9a-f]{64}'), 'csrf json field': re.compile(r'"csrf"\s*:\s*"[0-9a-f]{64}"'), 'x-csrf-token header value': re.compile(r'x-csrf-token["\']?\s*[:=]\s*["\']?[0-9a-f]{64}', re.I),
            'password field with value': re.compile(r'"password"\s*:\s*"[^"]{6,}"'), 'postgres url with password': re.compile(r'postgres(?:ql)?://[^:/\s]+:[^@\s]{6,}@')}
roots = [ROOT / 'runtime-logs', ROOT / 'evidence', ROOT / 'db']
hits = []; scanned = 0; skipped = 0
for r in roots:
    for p in r.rglob('*'):
        if not p.is_file() or p.suffix.lower() in ('.png', '.jpg', '.webm', '.zip', '.gz', '.dump', '.tar', '.bin', '.enc', '.aesgcm'): continue
        if p.stat().st_size > 60_000_000: skipped += 1; continue
        try: txt = p.read_text(encoding='utf-8', errors='ignore')
        except Exception: skipped += 1; continue
        scanned += 1; rel = str(p.relative_to(ROOT)).replace('\\', '/')
        for name, val in secrets.items():
            if val in txt: hits.append(dict(file=rel, kind='exact secret', secret=re.sub(r'_\d+$', '_*', name)))
        for name, rx in patterns.items():
            n = len(rx.findall(txt))
            if n: hits.append(dict(file=rel, kind='pattern', pattern=name, count=n))
# static audit of logging calls
log_rx = re.compile(r'(console\.(?:log|error|warn|info)|\.log\.(?:info|error|warn|debug)|print)\s*\(')
static = []
for d in ['apps', 'services', 'packages', 'ops']:
    for p in (ROOT / d).rglob('*'):
        if p.suffix not in ('.ts', '.tsx', '.mjs', '.js', '.py'): continue
        t = p.read_text(encoding='utf-8', errors='ignore')
        for m in log_rx.finditer(t):
            seg = t[m.start(): m.start() + 240]; risky = re.findall(r'password|csrf|cookie|secret|private|signature|token_hash|session|key\b|database\.json|accounts\.json', seg, re.I)
            static.append(dict(file=str(p.relative_to(ROOT)).replace('\\', '/'), call=m.group(1), risky_terms=sorted(set(x.lower() for x in risky)), excerpt=re.sub(r'\s+', ' ', seg[:160])))
app = (ROOT / 'apps/api/app.ts').read_text(encoding='utf-8')
fastify_logger = re.search(r'Fastify\(\{[^)]*logger', app) is not None
error_handler_masks = "code:e.statusCode?e.message:'INTERNAL_ERROR'" in app
res = dict(secretsLoaded=len(secrets), secretKinds=sorted(set(re.sub(r'_\d+$', '_*', k) for k in secrets)), filesScanned=scanned, filesSkipped=skipped, hits=hits,
           fastifyRequestLoggerEnabled=fastify_logger, errorHandlerMasks500=error_handler_masks, staticLoggingCalls=static, staticRiskyCalls=[s for s in static if s['risky_terms']])
(OUT / 'secret-log-audit.json').write_text(json.dumps(res, indent=1), encoding='utf-8')
print(json.dumps(dict(secretsLoaded=res['secretsLoaded'], filesScanned=scanned, exactSecretHits=[h for h in hits if h['kind'] == 'exact secret'], patternHits=[h for h in hits if h['kind'] == 'pattern'][:25], fastifyLogger=fastify_logger, errorMask=error_handler_masks, staticCalls=len(static), staticRisky=[(s['file'], s['risky_terms']) for s in res['staticRiskyCalls']][:30])))
