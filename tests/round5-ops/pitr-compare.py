"""O5 PITR comparison: restored instance (alder-o5-pitr) vs crash-recovered ground truth (alder-o5-pg).
Row digests of every public table (markers compared as prefix), effective ACLs, RLS flags, policies, role attributes; RPO/RTO."""
import json, subprocess, sys, hashlib
ts, tcrash, tr0, tr1, enc_sha, plain_sha = sys.argv[1:7]
def q(container, sql):
    r = subprocess.run(['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', 'alder', '-Atc', sql], capture_output=True, text=True, timeout=600)
    if r.returncode: raise SystemExit(r.stderr)
    return r.stdout.strip()
tables = q('alder-o5-pg', "select string_agg(tablename,' ' order by tablename) from pg_tables where schemaname='public'").split()
def digests(c):
    out = {}
    for t in tables:
        if t == 'o5_pitr_markers': continue
        out[t] = q(c, f"select count(*)||':'||coalesce(md5(string_agg(md5(x::text),'' order by md5(x::text))),'') from public.\"{t}\" x")
    return out
src, dst = digests('alder-o5-pg'), digests('alder-o5-pitr')
acl_sql = "select string_agg(relname||'|'||coalesce(relacl::text,'')||'|'||relrowsecurity||'|'||relforcerowsecurity,E'\\n' order by relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind in ('r','v','S')"
pol_sql = "select string_agg(tablename||'|'||policyname||'|'||array_to_string(roles,',')||'|'||cmd||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''),E'\\n' order by tablename,policyname) from pg_policies"
role_sql = "select string_agg(rolname||'|'||rolsuper||'|'||rolbypassrls||'|'||rolcanlogin,E'\\n' order by rolname) from pg_roles where rolname like 'alder%'"
h = lambda s: hashlib.sha256(s.encode()).hexdigest()
acl = {k: (h(q('alder-o5-pg', s)), h(q('alder-o5-pitr', s))) for k, s in (('tableAcls+rls', acl_sql), ('policies', pol_sql), ('roles', role_sql))}
ms = q('alder-o5-pg', "select string_agg(seq||'@'||to_char(server_at,'YYYY-MM-DD\"T\"HH24:MI:SS.US'),',' order by seq) from o5_pitr_markers").split(',')
md = q('alder-o5-pitr', "select string_agg(seq||'@'||to_char(server_at,'YYYY-MM-DD\"T\"HH24:MI:SS.US'),',' order by seq) from o5_pitr_markers").split(',')
import datetime
p = lambda x: datetime.datetime.fromisoformat(x.split('@')[1]).replace(tzinfo=datetime.timezone.utc).timestamp()
last_src, last_dst = ms[-1], (md[-1] if md and md[0] else None)
rpo = (p(last_src) - p(last_dst)) if last_dst else None
lost = len(ms) - (len(md) if last_dst else 0)
res = dict(drill=ts, tablesCompared=len(dst), tableDigestMismatches=[t for t in src if src[t] != dst.get(t)], aclPolicyRoleEqual={k: a == b for k, (a, b) in acl.items()},
           markersCommittedBeforeCrash=len(ms), markersRecovered=len(md) if last_dst else 0, markersLost=lost, recoveredIsPrefix=md == ms[:len(md)],
           lastCommitted=last_src, lastRecovered=last_dst, rpoSeconds=round(rpo, 3) if rpo is not None else None, rpoBudgetSeconds=60, rpoMet=rpo is not None and rpo <= 60,
           rtoSeconds=round(float(tr1) - float(tr0), 3), rtoBudgetSeconds=1800, encryptedBundleSha256=enc_sha, plaintextBundleSha256=plain_sha,
           note='RPO measured as server commit time of the last marker committed on the crashed source minus that of the last marker present after PITR from base backup + archived WAL only (source pg_wal treated as lost).')
print(json.dumps(res, indent=1))
