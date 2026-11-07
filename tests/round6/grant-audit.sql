-- Round 6 grant audit (read-only). Every privilege held by the three scoped roles and PUBLIC in schema public.
\pset format unaligned
\pset fieldsep '|'
SELECT 'ROLE' AS k,rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname IN ('alder_app','alder_indexer','alder_verifier') ORDER BY 2;
SELECT 'MEMBERSHIP' AS k,r.rolname AS member,g.rolname AS of_role FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid WHERE r.rolname LIKE 'alder_%' ORDER BY 2,3;
SELECT 'TABLE' AS k,grantee,table_name,string_agg(privilege_type,',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('alder_app','alder_indexer','alder_verifier','PUBLIC') GROUP BY 2,3 ORDER BY 2,3;
SELECT 'COLUMN' AS k,grantee,table_name,privilege_type,string_agg(column_name,',' ORDER BY column_name) FROM information_schema.column_privileges c WHERE table_schema='public' AND grantee IN ('alder_app','alder_indexer','alder_verifier') AND privilege_type IN ('UPDATE','INSERT')
 AND NOT EXISTS(SELECT 1 FROM information_schema.role_table_grants t WHERE t.table_schema='public' AND t.grantee=c.grantee AND t.table_name=c.table_name AND t.privilege_type=c.privilege_type) GROUP BY 2,3,4 ORDER BY 2,3,4;
SELECT 'FUNCTION' AS k,p.proname,p.prosecdef AS definer,coalesce(array_to_string(p.proacl,' '),'<default: PUBLIC EXECUTE>') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 2;
SELECT 'SEQUENCE' AS k,c.relname,array_to_string(c.relacl,' ') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY 2;
SELECT 'RLS' AS k,c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 2;
SELECT 'POLICY' AS k,tablename,policyname,permissive,array_to_string(roles,','),cmd FROM pg_policies WHERE schemaname='public' ORDER BY 2,3;
SELECT 'SCHEMA' AS k,has_schema_privilege('public','public','CREATE') AS public_create,has_schema_privilege('alder_app','public','CREATE') app_create,has_schema_privilege('alder_indexer','public','CREATE') indexer_create;
