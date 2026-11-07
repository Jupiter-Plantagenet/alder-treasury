"""Summarize an O5 load raw.ndjson: per class/endpoint counts, status mix, p50/p95/p99, error rate, per-minute p95 trend."""
import json, sys, collections, math
path = sys.argv[1]; rows = []
for l in open(path, encoding='utf-8'):
    try: rows.append(json.loads(l))
    except Exception: pass
def pct(v, q):
    v = sorted(v); return round(v[min(len(v) - 1, int(q * len(v)))], 1) if v else None
out = {'samples': len(rows), 'durationS': round(max(r['t'] for r in rows) / 1000, 1) if rows else 0, 'classes': {}, 'endpoints': {}, 'perMinute': {}}
for cls in ['read', 'write', 'isolation', 'chain', 'auth']:
    rs = [r for r in rows if r['cls'] == cls]
    if not rs: continue
    ok = [r for r in rs if 200 <= r['st'] < 300] if cls != 'isolation' else rs
    errs = [r for r in rs if not (200 <= r['st'] < 300)] if cls != 'isolation' else [r for r in rs if r['st'] != 404]
    out['classes'][cls] = dict(n=len(rs), errors=len(errs), errorRate=round(len(errs) / len(rs), 4), p50=pct([r['ms'] for r in rs], .5), p95=pct([r['ms'] for r in rs], .95), p99=pct([r['ms'] for r in rs], .99), p95_ok_only=pct([r['ms'] for r in ok], .95))
g = collections.defaultdict(list)
for r in rows: g[(r['cls'], r['ep'])].append(r)
for (c, e), rs in sorted(g.items()):
    st = collections.Counter(f"{r['st']}{(':' + r['code']) if r.get('code') else ''}" for r in rs)
    out['endpoints'][f'{c} {e}'] = dict(n=len(rs), status=dict(st), p50=pct([r['ms'] for r in rs], .5), p95=pct([r['ms'] for r in rs], .95), p99=pct([r['ms'] for r in rs], .99), meanBytes=round(sum(r['bytes'] for r in rs) / len(rs)))
for m in range(0, int(out['durationS'] // 60) + 1):
    rs = [r for r in rows if r['cls'] in ('read', 'write') and m * 60000 <= r['t'] < (m + 1) * 60000]
    if rs: out['perMinute'][m] = dict(n=len(rs), p95=pct([r['ms'] for r in rs], .95), errors=sum(1 for r in rs if not (200 <= r['st'] < 300)))
hist = collections.Counter()
for r in rows:
    if r['cls'] in ('read', 'write'): hist[min(16, int(math.log2(max(1, r['ms']))))] += 1
out['histogram_log2ms'] = {f'<{2**(k+1)}ms': v for k, v in sorted(hist.items())}
allrw = [r for r in rows if r['cls'] in ('read', 'write')]; out['overallErrorRate'] = round(sum(1 for r in allrw if not (200 <= r['st'] < 300)) / max(1, len(allrw)), 4)
json.dump(out, open(sys.argv[2], 'w'), indent=1); print(json.dumps({k: out[k] for k in ('samples', 'durationS', 'classes', 'overallErrorRate')}), json.dumps(out['perMinute']))
