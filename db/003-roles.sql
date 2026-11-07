-- App and machine credentials are non-owner, non-BYPASSRLS. Run only by out-of-band migration principal.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO alder_app,alder_indexer,alder_verifier;
CREATE OR REPLACE FUNCTION public.alder_actor() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT user_id FROM public.sessions WHERE token_hash=nullif(current_setting('alder.session_hash',true),'') AND expires_at>now() $$;
REVOKE ALL ON FUNCTION public.alder_actor() FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.alder_actor() TO alder_app;
GRANT SELECT ON users TO alder_app;
GRANT SELECT,INSERT,DELETE ON sessions TO alder_app;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_session ON sessions;CREATE POLICY own_session ON sessions TO alder_app USING(token_hash=nullif(current_setting('alder.session_hash',true),'')) WITH CHECK(token_hash=nullif(current_setting('alder.session_hash',true),''));
GRANT SELECT ON memberships TO alder_app;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_membership ON memberships;CREATE POLICY own_membership ON memberships TO alder_app USING(user_id=public.alder_actor());
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['payables','batches','reservations','signatures','events','idempotency','treasury_operations','treasury_signatures','treasury_attempts','treasury_observations','treasury_reports','treasury_settlements'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('DROP POLICY IF EXISTS app_workspace ON %I',t);
 EXECUTE format('CREATE POLICY app_workspace ON %I TO alder_app USING(workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND m.user_id=public.alder_actor())) WITH CHECK(workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND m.user_id=public.alder_actor()))',t);
 EXECUTE format('DROP POLICY IF EXISTS indexer_domain ON %I',t);EXECUTE format('CREATE POLICY indexer_domain ON %I TO alder_indexer USING(true) WITH CHECK(true)',t);
 END LOOP;END $$;
-- Deliberately no UPDATE/DELETE on immutable authorization evidence or report/projection write to app.
GRANT SELECT,INSERT ON payables,batches,reservations,signatures,events,idempotency,treasury_operations,treasury_signatures,treasury_attempts,treasury_observations TO alder_app;
GRANT UPDATE(reviewed_by,revision,verified,recipient,amount_units,contact,service) ON payables TO alder_app;
GRANT UPDATE(state,operation_id) ON batches TO alder_app;
GRANT UPDATE(state) ON treasury_operations TO alder_app;
GRANT SELECT ON treasury_reports,treasury_settlements TO alder_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO alder_app;
GRANT SELECT ON payables,batches,reservations,treasury_operations,treasury_reports,treasury_settlements,treasury_headers,treasury_checkpoints TO alder_indexer;
GRANT INSERT ON treasury_reports,treasury_settlements,treasury_headers,treasury_checkpoints,events TO alder_indexer;
GRANT UPDATE(state) ON treasury_operations,batches TO alder_indexer;
GRANT UPDATE(state,report_id) ON treasury_settlements TO alder_indexer;
GRANT UPDATE(canonical) ON treasury_headers TO alder_indexer;
GRANT UPDATE(number,hash,paused) ON treasury_checkpoints TO alder_indexer;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO alder_indexer;
GRANT SELECT ON treasury_operations TO alder_verifier;
GRANT INSERT ON treasury_reports TO alder_verifier;
GRANT USAGE,SELECT ON SEQUENCE treasury_reports_id_seq TO alder_verifier;
DROP POLICY IF EXISTS verifier_manifest ON treasury_operations;CREATE POLICY verifier_manifest ON treasury_operations FOR SELECT TO alder_verifier USING(true);
DROP POLICY IF EXISTS verifier_report ON treasury_reports;CREATE POLICY verifier_report ON treasury_reports FOR INSERT TO alder_verifier WITH CHECK(true);
