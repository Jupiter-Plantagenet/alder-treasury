"""Read-only, deterministic PostgreSQL restore comparison primitives.

This module has no command-line side effects. Callers supply docker/psql
execution and keep any captured output in a private C: evidence directory.
"""
from __future__ import annotations

import json
import re
import subprocess
from typing import Callable

SNAPSHOT_RE = re.compile(r'^[0-9A-F]+-[0-9A-F]+-[0-9]+$', re.IGNORECASE)
EXPECTED_PUBLIC_TABLES = 54


def qident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def qliteral(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def run_psql(docker: Callable[..., subprocess.CompletedProcess], container: str,
             database: str, script: str, *, user: str = 'postgres', timeout: int = 180) -> list[str]:
    result = docker(['exec', '-i', container, 'psql', '-U', user, '-d', database,
                     '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                    timeout=timeout, input_bytes=script.encode('utf-8'))
    if result.returncode:
        raise RuntimeError('BASELINE_PSQL_FAILED')
    return [line for line in result.stdout.decode('utf-8', errors='strict').splitlines() if line]


def _tagged(tag: str, expr: str) -> str:
    return f"SELECT {qliteral(tag)} || E'\\t' || ({expr})::text;"


def _catalog_queries(exclude_role: str | None) -> list[tuple[str, str]]:
    role_filter = ''
    if exclude_role:
        role_filter = f' WHERE r.rolname <> {qliteral(exclude_role)}'
    relation_sql = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name', n.nspname||'.'||c.relname,
      'kind', c.relkind::text,
      'owner', pg_get_userbyid(c.relowner),
      'rowSecurity', c.relrowsecurity,
      'forceRowSecurity', c.relforcerowsecurity,
      'persistence', c.relpersistence::text,
      'replicaIdentity', c.relreplident::text
    ) ORDER BY n.nspname,c.relname), '[]'::jsonb)::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')"""
    relation_acl = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'object', n.nspname||'.'||c.relname, 'owner', pg_get_userbyid(c.relowner),
      'grantee', CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'grantor', pg_get_userbyid(a.grantor), 'privilege', a.privilege_type,
      'grantable', a.is_grantable
    ) ORDER BY n.nspname,c.relname,
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable),
      '[]'::jsonb)::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,
      acldefault((CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END)::"char",c.relowner))) a
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')"""
    schema_sql = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name',n.nspname,'owner',pg_get_userbyid(n.nspowner)
    ) ORDER BY n.nspname),'[]'::jsonb)::text FROM pg_namespace n
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'"""
    schema_acl = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',n.nspname,'owner',pg_get_userbyid(n.nspowner),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable
    ) ORDER BY n.nspname,
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable),'[]'::jsonb)::text
    FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'"""
    default_acl = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',coalesce(n.nspname,''),'owner',pg_get_userbyid(d.defaclrole),'objectType',d.defaclobjtype::text,
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable
    ) ORDER BY coalesce(n.nspname,''),pg_get_userbyid(d.defaclrole),d.defaclobjtype,
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable),
      '[]'::jsonb)::text
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a"""
    policies = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schema',schemaname,'table',tablename,'name',policyname,'permissive',permissive,
      'roles',to_jsonb(ARRAY(SELECT unnest(roles) ORDER BY 1)), 'command',cmd,
      'using',qual,'check',with_check
    ) ORDER BY schemaname,tablename,policyname),'[]'::jsonb)::text FROM pg_policies"""
    functions = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name',n.nspname||'.'||p.proname,'identityArgs',pg_get_function_identity_arguments(p.oid),
      'owner',pg_get_userbyid(p.proowner),'kind',p.prokind::text,'language',l.lanname,
      'securityDefiner',p.prosecdef,'leakproof',p.proleakproof,'volatility',p.provolatile::text,
      'strict',p.proisstrict,'setConfig',to_jsonb(ARRAY(SELECT unnest(coalesce(p.proconfig,ARRAY[]::text[])) ORDER BY 1)),
      'definitionMd5',md5(pg_get_functiondef(p.oid))
    ) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::jsonb)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.prokind <> 'a'"""
    function_acl = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'function',n.nspname||'.'||p.proname,'identityArgs',pg_get_function_identity_arguments(p.oid),
      'owner',pg_get_userbyid(p.proowner),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable
    ) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable),
      '[]'::jsonb)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname='public' AND p.prokind <> 'a'"""
    aggregates = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name',n.nspname||'.'||p.proname,'identityArgs',pg_get_function_identity_arguments(p.oid),
      'owner',pg_get_userbyid(p.proowner),'kind',a.aggkind::text,'directArgs',a.aggnumdirectargs,
      'transitionFunction',a.aggtransfn::regprocedure::text,'finalFunction',a.aggfinalfn::regprocedure::text,
      'combineFunction',a.aggcombinefn::regprocedure::text,'transitionType',a.aggtranstype::regtype::text,
      'initialValue',a.agginitval
    ) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::jsonb)::text
    FROM pg_aggregate a JOIN pg_proc p ON p.oid=a.aggfnoid JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'"""
    aggregate_acl = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'aggregate',n.nspname||'.'||p.proname,'identityArgs',pg_get_function_identity_arguments(p.oid),
      'owner',pg_get_userbyid(p.proowner),
      'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
      'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable
    ) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),
      CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
      pg_get_userbyid(x.grantor),x.privilege_type,x.is_grantable),
      '[]'::jsonb)::text
    FROM pg_aggregate a JOIN pg_proc p ON p.oid=a.aggfnoid JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
    WHERE n.nspname='public'"""
    sequences = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name',n.nspname||'.'||c.relname,'owner',pg_get_userbyid(c.relowner),
      'type',s.seqtypid::regtype::text,'start',s.seqstart::text,'increment',s.seqincrement::text,
      'min',s.seqmin::text,'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle
    ) ORDER BY n.nspname,c.relname),'[]'::jsonb)::text
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'"""
    roles = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name',r.rolname,'superuser',r.rolsuper,'inherit',r.rolinherit,'createRole',r.rolcreaterole,
      'createDb',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,
      'bypassRls',r.rolbypassrls,'connectionLimit',r.rolconnlimit,
      'validUntil',r.rolvaliduntil::text,
      'settings',to_jsonb(ARRAY(SELECT unnest(coalesce(r.rolconfig,ARRAY[]::text[])) ORDER BY 1))
    ) ORDER BY r.rolname),'[]'::jsonb)::text FROM pg_roles r""" + role_filter
    memberships = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'role',role.rolname,'member',member.rolname,'grantor',grantor.rolname,'admin',m.admin_option
    ) ORDER BY role.rolname,member.rolname,grantor.rolname,m.admin_option),'[]'::jsonb)::text
    FROM pg_auth_members m JOIN pg_roles role ON role.oid=m.roleid
    JOIN pg_roles member ON member.oid=m.member JOIN pg_roles grantor ON grantor.oid=m.grantor"""
    extensions = """SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name',e.extname,'version',e.extversion,'schema',n.nspname,'owner',pg_get_userbyid(e.extowner)
    ) ORDER BY e.extname),'[]'::jsonb)::text
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace"""
    db = """SELECT jsonb_build_object('name',d.datname,'owner',pg_get_userbyid(d.datdba),
      'encoding',pg_encoding_to_char(d.encoding),'collation',d.datcollate,'ctype',d.datctype,
      'tablespace',(SELECT spcname FROM pg_tablespace WHERE oid=d.dattablespace),
      'allowConnections',d.datallowconn,'connectionLimit',d.datconnlimit,
      'serverVersionNum',current_setting('server_version_num'))::text
    FROM pg_database d WHERE d.datname=current_database()"""
    return [('database', db), ('relations', relation_sql), ('relation_acl', relation_acl),
            ('schemas', schema_sql), ('schema_acl', schema_acl), ('default_acl', default_acl),
            ('policies', policies), ('functions', functions), ('function_acl', function_acl),
            ('aggregates', aggregates), ('aggregate_acl', aggregate_acl),
            ('sequences', sequences), ('roles', roles), ('memberships', memberships),
            ('extensions', extensions)]


def _global_role_hash_sql(exclude_role: str | None = None) -> str:
    where = f' WHERE r.rolname <> {qliteral(exclude_role)}' if exclude_role else ''
    return """SELECT md5(coalesce(string_agg(concat_ws(E'\\x1f', r.rolname, r.rolsuper::text,
      r.rolinherit::text,r.rolcreaterole::text,r.rolcreatedb::text,r.rolcanlogin::text,
      r.rolreplication::text,r.rolbypassrls::text,r.rolconnlimit::text,
      coalesce(r.rolvaliduntil::text,''),coalesce(array_to_string(ARRAY(SELECT unnest(r.rolconfig) ORDER BY 1),','),''),
      coalesce(a.rolpassword,'')), E'\\n' ORDER BY r.rolname),''))
    FROM pg_authid a JOIN pg_roles r ON r.rolname=a.rolname""" + where


def read_global_role_hash(docker: Callable[..., subprocess.CompletedProcess], container: str,
                          database: str = 'alder', exclude_role: str | None = None,
                          user: str = 'postgres') -> str:
    rows = run_psql(docker, container, database, _global_role_hash_sql(exclude_role) + ';', user=user, timeout=30)
    if len(rows) != 1 or not re.fullmatch(r'[0-9a-f]{32}', rows[0]):
        raise RuntimeError('ROLE_CATALOG_DIGEST_UNAVAILABLE')
    return rows[0]


def capture_sequence_states(docker: Callable[..., subprocess.CompletedProcess], container: str,
                            database: str, user: str = 'postgres') -> list[dict]:
    """Read non-MVCC sequence state separately so backup can detect races."""
    inventory = """SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname)
      ORDER BY n.nspname,c.relname)::text,'[]')
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='S' AND n.nspname='public';"""
    rows = run_psql(docker, container, database, inventory, user=user, timeout=30)
    if len(rows) != 1:
        raise RuntimeError('PUBLIC_SEQUENCE_INVENTORY_UNAVAILABLE')
    sequences = json.loads(rows[0])
    states: list[dict] = []
    for sequence in sequences:
        schema = sequence.get('schema')
        name = sequence.get('name')
        if not isinstance(schema, str) or not isinstance(name, str):
            raise RuntimeError('PUBLIC_SEQUENCE_INVENTORY_INVALID')
        sql = ("SELECT jsonb_build_object('name'," + qliteral(schema + '.' + name) +
               ",'lastValue',last_value::text,'isCalled',is_called)::text FROM " +
               qident(schema) + '.' + qident(name) + ';')
        value = run_psql(docker, container, database, sql, user=user, timeout=30)
        if len(value) != 1:
            raise RuntimeError('PUBLIC_SEQUENCE_STATE_UNAVAILABLE')
        item = json.loads(value[0])
        if not isinstance(item, dict) or item.get('name') != schema + '.' + name:
            raise RuntimeError('PUBLIC_SEQUENCE_STATE_INVALID')
        states.append(item)
    return sorted(states, key=lambda item: item['name'])


def capture_baseline(docker: Callable[..., subprocess.CompletedProcess], container: str,
                     database: str, snapshot_id: str | None = None,
                     exclude_role: str | None = None, user: str = 'postgres') -> dict:
    if snapshot_id is not None and not SNAPSHOT_RE.fullmatch(snapshot_id):
        raise RuntimeError('EXPORTED_SNAPSHOT_TOKEN_INVALID')
    prefix = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
    if snapshot_id:
        prefix += f'SET TRANSACTION SNAPSHOT {qliteral(snapshot_id)};\n'
    inventory_sql = """SELECT 'TABLES' || E'\\t' || coalesce(jsonb_agg(tablename ORDER BY tablename)::text,'[]')
    FROM pg_tables WHERE schemaname='public';
    SELECT 'SEQUENCES' || E'\\t' || coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname)
      ORDER BY n.nspname,c.relname)::text,'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='S' AND n.nspname='public';"""
    lines = run_psql(docker, container, database, prefix + inventory_sql + '\nCOMMIT;\n', user=user, timeout=60)
    tagged = [line.split('\t', 1) for line in lines if '\t' in line]
    table_rows = [value for tag, value in tagged if tag == 'TABLES']
    sequence_rows = [value for tag, value in tagged if tag == 'SEQUENCES']
    if len(table_rows) != 1:
        raise RuntimeError('PUBLIC_TABLE_INVENTORY_UNAVAILABLE')
    tables = json.loads(table_rows[0])
    if len(sequence_rows) != 1:
        raise RuntimeError('PUBLIC_SEQUENCE_INVENTORY_UNAVAILABLE')
    sequence_names = json.loads(sequence_rows[0])
    if not isinstance(tables, list) or len(tables) != EXPECTED_PUBLIC_TABLES or any(not isinstance(x, str) for x in tables):
        raise RuntimeError('PUBLIC_TABLE_COUNT_NOT_54')

    statements = [prefix]
    identity = """SELECT jsonb_build_object(
      'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
      'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
      'database',current_database(),'versionNum',current_setting('server_version_num'))::text"""
    statements.append(_tagged('IDENTITY', identity))
    for table in tables:
        ident = 'public.' + qident(table)
        literal = qliteral('public.' + table)
        expr = f"""SELECT jsonb_build_object('name',{literal},'rowCount',count(*)::text,
          'rowHashMd5',coalesce(md5(string_agg(row_hash,' ' ORDER BY row_hash)),md5('')))::text
          FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM {ident} AS t) AS hashed"""
        statements.append(_tagged('TABLE', expr))
    for label, expr in _catalog_queries(exclude_role):
        statements.append(_tagged(label.upper(), expr))
    for sequence in sequence_names:
        schema = str(sequence['schema'])
        name = str(sequence['name'])
        object_name = schema + '.' + name
        state_sql = f"SELECT jsonb_build_object('name',{qliteral(object_name)},'lastValue',last_value::text,'isCalled',is_called)::text FROM {qident(schema)}.{qident(name)}"
        statements.append(_tagged('SEQUENCE_STATE', state_sql))
    statements.append(_tagged('ROLE_HASH', _global_role_hash_sql(exclude_role)))
    statements.append('COMMIT;')
    lines = run_psql(docker, container, database, '\n'.join(statements) + '\n', user=user, timeout=600)
    parsed: dict[str, list] = {}
    for line in lines:
        if '\t' not in line:
            continue
        tag, value = line.split('\t', 1)
        try:
            data = json.loads(value)
        except json.JSONDecodeError:
            data = value
        parsed.setdefault(tag.lower(), []).append(data)
    rows = parsed.get('table', [])
    catalog_names = [name for name, _ in _catalog_queries(exclude_role)]
    required = {'identity', 'role_hash', *[x.lower() for x in catalog_names]}
    if required - parsed.keys() or len(rows) != EXPECTED_PUBLIC_TABLES:
        raise RuntimeError('BASELINE_CAPTURE_INCOMPLETE')
    identity_data = parsed['identity'][0]
    role_hash = parsed['role_hash'][0]
    if not isinstance(role_hash, str) or not re.fullmatch(r'[0-9a-f]{32}', role_hash):
        raise RuntimeError('ROLE_CATALOG_DIGEST_UNAVAILABLE')
    if len({x.get('name') for x in rows if isinstance(x, dict)}) != EXPECTED_PUBLIC_TABLES:
        raise RuntimeError('BASELINE_DUPLICATE_TABLE_DIGEST')
    return {
        'schema': 'alder.pg-restore-baseline/v1',
        'snapshot': 'exported-read-only-repeatable-read' if snapshot_id else 'read-only-repeatable-read',
        'databaseIdentity': identity_data,
        'tableCount': len(rows),
        'tables': sorted(rows, key=lambda item: item['name']),
        'catalog': {**{name: parsed[name.lower()][0] for name, _ in _catalog_queries(exclude_role)},
                    'sequence_states': sorted(parsed.get('sequence_state', []), key=lambda item: item['name'])},
        'globalRoleCatalogMd5': role_hash,
    }
