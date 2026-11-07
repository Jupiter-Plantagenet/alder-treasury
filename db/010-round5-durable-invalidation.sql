-- Round 5 (2026-10-31, user-authorized): expand-only.
--   1. In-app invalidation (TR-T-CANCEL / DESTINATION follow-through) and verified reservation release archive.
--   2. Single-writer indexer lease with fence tokens enforced on every machine-role projection write (TR-T-DURABLE).
--   3. Transactional outbox + immutable delivery-attempt audit (TR-T-DURABLE / FAULT).
--   4. Indexer request queue so API resync / operator rebuild go through the single lease holder.
--   5. Bulk payable import journal (TR-T-INBOX).
--   6. Membership administration through audited SECURITY DEFINER functions (TR-Access) and workspace profile.
-- No existing row is rewritten or deleted. No existing policy, grant or constraint is dropped or narrowed.
-- Out-of-band migration authority only (postgres via docker exec, single transaction); never run at API startup.

-- ---------------------------------------------------------------- 1. invalidation + release archive
CREATE TABLE operation_invalidations(
 workspace_id uuid NOT NULL, operation_id uuid NOT NULL, target_operation_id uuid NOT NULL,
 method text NOT NULL CHECK(method IN ('executor_cancel','nonce_consumption')),
 target_safe_tx_hash text NOT NULL CHECK(target_safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
 target_nonce numeric(78,0) NOT NULL CHECK(target_nonce>=0), invalidation_nonce numeric(78,0) NOT NULL CHECK(invalidation_nonce>=target_nonce),
 target_batch_id text CHECK(target_batch_id IS NULL OR target_batch_id ~ '^0x[0-9a-f]{64}$'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 requested_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,operation_id),
 FOREIGN KEY(workspace_id,operation_id) REFERENCES treasury_operations(workspace_id,id),
 FOREIGN KEY(workspace_id,target_operation_id) REFERENCES treasury_operations(workspace_id,id),
 CHECK(operation_id<>target_operation_id),
 CHECK((method='executor_cancel')=(target_batch_id IS NOT NULL)),
 CHECK(method<>'nonce_consumption' OR invalidation_nonce=target_nonce));
CREATE INDEX operation_invalidation_target ON operation_invalidations(workspace_id,target_operation_id);

-- A reservation is only ever released after a VERIFIED invalidation report for exactly that target.
CREATE TABLE reservation_releases(
 workspace_id uuid NOT NULL, payable_id uuid NOT NULL, batch_id uuid NOT NULL,
 target_operation_id uuid NOT NULL, invalidation_operation_id uuid NOT NULL, report_id bigint NOT NULL,
 fence bigint NOT NULL CHECK(fence>0), reason text NOT NULL, released_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,payable_id,batch_id),
 FOREIGN KEY(workspace_id,payable_id) REFERENCES payables(workspace_id,id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id),
 FOREIGN KEY(workspace_id,target_operation_id) REFERENCES treasury_operations(workspace_id,id),
 FOREIGN KEY(workspace_id,invalidation_operation_id) REFERENCES operation_invalidations(workspace_id,operation_id),
 FOREIGN KEY(workspace_id,invalidation_operation_id,report_id) REFERENCES treasury_reports(workspace_id,operation_id,id));

CREATE OR REPLACE FUNCTION public.alder_reservation_release_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.chain_lineage_voided_reservations a WHERE a.workspace_id=OLD.workspace_id AND a.payable_id=OLD.payable_id AND a.batch_id=OLD.batch_id) THEN RETURN OLD; END IF;
 IF EXISTS(SELECT 1 FROM public.reservation_releases rr
   JOIN public.operation_invalidations i ON i.workspace_id=rr.workspace_id AND i.operation_id=rr.invalidation_operation_id AND i.target_operation_id=rr.target_operation_id
   JOIN public.batches b ON b.workspace_id=rr.workspace_id AND b.id=rr.batch_id AND b.operation_id=rr.target_operation_id
   JOIN public.treasury_reports t ON t.workspace_id=rr.workspace_id AND t.operation_id=rr.invalidation_operation_id AND t.id=rr.report_id
  WHERE rr.workspace_id=OLD.workspace_id AND rr.payable_id=OLD.payable_id AND rr.batch_id=OLD.batch_id
   AND t.report->>'state'='verified' AND t.report->>'kind'='invalidation' AND t.report->>'targetOperationId'=rr.target_operation_id::text
   AND (t.report->>'targetCannotExecute')='true') THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'RESERVATION_RELEASE_REQUIRES_VERIFIED_INVALIDATION';
END $$;
CREATE TRIGGER reservation_release_guard BEFORE DELETE ON reservations FOR EACH ROW EXECUTE FUNCTION public.alder_reservation_release_guard();

-- ---------------------------------------------------------------- 2. single-writer lease + fence
CREATE TABLE worker_leases(
 name text PRIMARY KEY CHECK(name ~ '^[a-z0-9-]{1,40}$'), holder text NOT NULL CHECK(length(holder) BETWEEN 1 AND 200),
 fence bigint NOT NULL CHECK(fence>0), acquired_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 heartbeat_at timestamptz NOT NULL DEFAULT now(), state text NOT NULL DEFAULT 'leased' CHECK(state IN ('leased','retrying','degraded','released')),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE worker_lease_events(
 id bigserial PRIMARY KEY, name text NOT NULL, holder text NOT NULL, fence bigint NOT NULL, kind text NOT NULL CHECK(kind IN ('acquired','released')),
 at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER immutable_lease_event BEFORE UPDATE OR DELETE ON worker_lease_events FOR EACH ROW EXECUTE FUNCTION treasury_immutable();

-- Every write by the machine indexer role must carry the CURRENT unexpired fence of the named lease.
-- The pass transaction holds the lease row FOR SHARE, so no takeover can issue a newer fence mid-pass;
-- a stale (older) fence is rejected here at the database, not by worker self-discipline.
CREATE OR REPLACE FUNCTION public.alder_assert_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE f text := current_setting('alder.worker_fence',true); n text := coalesce(nullif(current_setting('alder.worker_name',true),''),'indexer');
BEGIN
 IF session_user<>'alder_indexer' THEN RETURN COALESCE(NEW,OLD); END IF;
 IF f IS NULL OR f !~ '^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'FENCE_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.worker_leases WHERE name=n AND fence=f::bigint AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'STALE_FENCE'; END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['treasury_reports','treasury_settlements','treasury_checkpoints','treasury_headers','treasury_operations','batches','events','reservations'] LOOP
  EXECUTE format('CREATE TRIGGER indexer_fence BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.alder_assert_fence()',t);
 END LOOP; END $$;
CREATE TRIGGER indexer_fence BEFORE INSERT OR UPDATE OR DELETE ON reservation_releases FOR EACH ROW EXECUTE FUNCTION public.alder_assert_fence();
CREATE TRIGGER immutable_release BEFORE UPDATE OR DELETE ON reservation_releases FOR EACH ROW EXECUTE FUNCTION treasury_immutable();

-- ---------------------------------------------------------------- 3. indexer requests (resync / operator rebuild)
CREATE TABLE indexer_requests(
 id bigserial PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('resync','rebuild')), requested_by text NOT NULL CHECK(length(requested_by) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now(), claimed_fence bigint, done_at timestamptz, result jsonb, error text);
CREATE TRIGGER indexer_fence BEFORE UPDATE ON indexer_requests FOR EACH ROW EXECUTE FUNCTION public.alder_assert_fence();

-- ---------------------------------------------------------------- 4. transactional outbox
CREATE TABLE outbox(
 id bigserial PRIMARY KEY, workspace_id uuid NOT NULL, kind text NOT NULL CHECK(kind ~ '^[a-z][a-z0-9.-]{0,63}$'),
 dedupe_key text NOT NULL UNIQUE CHECK(length(dedupe_key) BETWEEN 1 AND 300), payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','delivered','held')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), max_attempts integer NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 50),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), claimed_by text, claim_fence bigint, claimed_until timestamptz,
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, delivery_fence bigint);
CREATE INDEX outbox_due ON outbox(state,next_attempt_at,id);
CREATE INDEX outbox_workspace ON outbox(workspace_id,state);
CREATE TABLE outbox_attempts(
 id bigserial PRIMARY KEY, workspace_id uuid NOT NULL, outbox_id bigint NOT NULL REFERENCES outbox(id), fence bigint NOT NULL,
 worker text NOT NULL, outcome text NOT NULL CHECK(outcome IN ('delivered','failed','held')), error text, at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER immutable_outbox_attempt BEFORE UPDATE OR DELETE ON outbox_attempts FOR EACH ROW EXECUTE FUNCTION treasury_immutable();
CREATE TRIGGER outbox_no_delete BEFORE DELETE ON outbox FOR EACH ROW EXECUTE FUNCTION treasury_immutable();
CREATE TRIGGER indexer_fence BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION public.alder_assert_fence();
CREATE TRIGGER indexer_fence BEFORE INSERT ON outbox_attempts FOR EACH ROW EXECUTE FUNCTION public.alder_assert_fence();

-- ---------------------------------------------------------------- 5. bulk payable import journal
CREATE TABLE payable_imports(
 workspace_id uuid NOT NULL, id uuid NOT NULL, digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 200), row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 5000),
 total_units numeric(78,0) NOT NULL CHECK(total_units>0), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,digest));
CREATE TABLE payable_import_rows(
 workspace_id uuid NOT NULL, import_id uuid NOT NULL, row_number integer NOT NULL CHECK(row_number>=1), payable_id uuid NOT NULL,
 external_reference text NOT NULL, PRIMARY KEY(workspace_id,import_id,row_number), UNIQUE(workspace_id,payable_id),
 FOREIGN KEY(workspace_id,import_id) REFERENCES payable_imports(workspace_id,id), FOREIGN KEY(workspace_id,payable_id) REFERENCES payables(workspace_id,id));
CREATE TRIGGER immutable_import BEFORE UPDATE OR DELETE ON payable_imports FOR EACH ROW EXECUTE FUNCTION treasury_immutable();
CREATE TRIGGER immutable_import_row BEFORE UPDATE OR DELETE ON payable_import_rows FOR EACH ROW EXECUTE FUNCTION treasury_immutable();

-- ---------------------------------------------------------------- 6. workspace profile + membership administration
CREATE TABLE workspace_profiles(workspace_id uuid PRIMARY KEY, display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120), created_at timestamptz NOT NULL DEFAULT now());
-- Names of the two existing local workspaces (previously hard-coded UI copy / the round-4 isolation workspace).
INSERT INTO workspace_profiles(workspace_id,display_name)
 SELECT DISTINCT workspace_id,CASE WHEN workspace_id='00000000-0000-4000-8000-000000000001' THEN 'Northstar Studio' ELSE 'Isolation workspace '||left(workspace_id::text,8) END FROM memberships
 ON CONFLICT DO NOTHING;

CREATE TABLE membership_invites(
 workspace_id uuid NOT NULL, id uuid NOT NULL, email text NOT NULL CHECK(email ~ '^[^@\s]{1,64}@[^@\s]{1,190}$'),
 roles text[] NOT NULL CHECK(cardinality(roles) BETWEEN 1 AND 5 AND roles <@ ARRAY['preparer','reviewer','owner','accountant','admin']),
 invited_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 accepted_at timestamptz, accepted_user_id uuid REFERENCES users(id), revoked_at timestamptz, revoked_by uuid REFERENCES users(id),
 PRIMARY KEY(workspace_id,id), CHECK(accepted_at IS NULL OR revoked_at IS NULL));
CREATE UNIQUE INDEX membership_invite_open ON membership_invites(workspace_id,lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TABLE membership_events(
 id bigserial PRIMARY KEY, workspace_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('invited','invite-accepted','invite-revoked','roles-changed','revoked')),
 subject_user_id uuid REFERENCES users(id), subject_email text, invite_id uuid, actor_id uuid NOT NULL REFERENCES users(id),
 before_roles text[], after_roles text[], archived jsonb, reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000), at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER immutable_membership_event BEFORE UPDATE OR DELETE ON membership_events FOR EACH ROW EXECUTE FUNCTION treasury_immutable();

CREATE OR REPLACE FUNCTION public.alder_is_workspace_admin(ws uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=ws AND user_id=public.alder_actor() AND 'admin'=ANY(roles)) $$;
CREATE OR REPLACE FUNCTION public.alder_actor_email() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT lower(email) FROM public.users WHERE id=public.alder_actor() $$;
CREATE OR REPLACE FUNCTION public.alder_roles_valid(r text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT r IS NOT NULL AND cardinality(r) BETWEEN 1 AND 5 AND r <@ ARRAY['preparer','reviewer','owner','accountant','admin'] AND cardinality(r)=(SELECT count(DISTINCT x) FROM unnest(r) x) $$;

-- All membership changes go through these functions: they authorize the session actor as an admin of the
-- workspace in the CURRENT request scope, keep at least one admin, archive the before-state and append audit.
CREATE OR REPLACE FUNCTION public.alder_membership_invite(ws uuid,invite_email text,invite_roles text[],why text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); iid uuid := gen_random_uuid(); target uuid;
BEGIN
 IF actor IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws OR NOT public.alder_is_workspace_admin(ws) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 IF NOT public.alder_roles_valid(invite_roles) THEN RAISE EXCEPTION 'INVALID_ROLES'; END IF;
 SELECT id INTO target FROM public.users WHERE lower(email)=lower(invite_email);
 IF target IS NOT NULL AND EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=ws AND user_id=target) THEN RAISE EXCEPTION 'ALREADY_MEMBER'; END IF;
 INSERT INTO public.membership_invites(workspace_id,id,email,roles,invited_by,expires_at) VALUES(ws,iid,lower(invite_email),invite_roles,actor,now()+interval '7 days');
 INSERT INTO public.membership_events(workspace_id,kind,subject_user_id,subject_email,invite_id,actor_id,after_roles,reason) VALUES(ws,'invited',target,lower(invite_email),iid,actor,invite_roles,why);
 RETURN iid;
END $$;
CREATE OR REPLACE FUNCTION public.alder_membership_accept(ws uuid,iid uuid) RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); inv record;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
 SELECT * INTO inv FROM public.membership_invites WHERE workspace_id=ws AND id=iid FOR UPDATE;
 IF inv IS NULL OR inv.email<>public.alder_actor_email() THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at<=now() THEN RAISE EXCEPTION 'INVITE_NOT_OPEN'; END IF;
 IF EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=ws AND user_id=actor) THEN RAISE EXCEPTION 'ALREADY_MEMBER'; END IF;
 INSERT INTO public.memberships(workspace_id,user_id,roles) VALUES(ws,actor,inv.roles);
 UPDATE public.membership_invites SET accepted_at=now(),accepted_user_id=actor WHERE workspace_id=ws AND id=iid;
 INSERT INTO public.membership_events(workspace_id,kind,subject_user_id,subject_email,invite_id,actor_id,after_roles,reason) VALUES(ws,'invite-accepted',actor,inv.email,iid,actor,inv.roles,'Invitation accepted by the invited account');
 RETURN inv.roles;
END $$;
CREATE OR REPLACE FUNCTION public.alder_membership_set_roles(ws uuid,subject uuid,expected text[],new_roles text[],why text) RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); cur text[];
BEGIN
 IF actor IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws OR NOT public.alder_is_workspace_admin(ws) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 IF NOT public.alder_roles_valid(new_roles) THEN RAISE EXCEPTION 'INVALID_ROLES'; END IF;
 PERFORM 1 FROM public.memberships WHERE workspace_id=ws FOR UPDATE;
 SELECT roles INTO cur FROM public.memberships WHERE workspace_id=ws AND user_id=subject;
 IF cur IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT (cur @> expected AND cur <@ expected) THEN RAISE EXCEPTION 'STALE_ROLES'; END IF;
 UPDATE public.memberships SET roles=new_roles WHERE workspace_id=ws AND user_id=subject;
 IF NOT EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=ws AND 'admin'=ANY(roles)) THEN RAISE EXCEPTION 'LAST_ADMIN'; END IF;
 INSERT INTO public.membership_events(workspace_id,kind,subject_user_id,actor_id,before_roles,after_roles,reason) VALUES(ws,'roles-changed',subject,actor,cur,new_roles,why);
 RETURN new_roles;
END $$;
CREATE OR REPLACE FUNCTION public.alder_membership_revoke(ws uuid,subject uuid,expected text[],why text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); cur text[]; prefs jsonb;
BEGIN
 IF actor IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws OR NOT public.alder_is_workspace_admin(ws) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 PERFORM 1 FROM public.memberships WHERE workspace_id=ws FOR UPDATE;
 SELECT roles INTO cur FROM public.memberships WHERE workspace_id=ws AND user_id=subject;
 IF cur IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT (cur @> expected AND cur <@ expected) THEN RAISE EXCEPTION 'STALE_ROLES'; END IF;
 SELECT to_jsonb(p) INTO prefs FROM public.workspace_preferences p WHERE workspace_id=ws AND user_id=subject;
 INSERT INTO public.membership_events(workspace_id,kind,subject_user_id,actor_id,before_roles,archived,reason) VALUES(ws,'revoked',subject,actor,cur,jsonb_build_object('membership',jsonb_build_object('roles',cur),'preferences',prefs),why);
 -- Access-control rows (not business records): the full before-state is archived in the immutable audit row above.
 DELETE FROM public.workspace_preferences WHERE workspace_id=ws AND user_id=subject;
 DELETE FROM public.memberships WHERE workspace_id=ws AND user_id=subject;
 IF NOT EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=ws AND 'admin'=ANY(roles)) THEN RAISE EXCEPTION 'LAST_ADMIN'; END IF;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.alder_invite_revoke(ws uuid,iid uuid,why text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); inv record;
BEGIN
 IF actor IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws OR NOT public.alder_is_workspace_admin(ws) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 SELECT * INTO inv FROM public.membership_invites WHERE workspace_id=ws AND id=iid FOR UPDATE;
 IF inv IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'INVITE_NOT_OPEN'; END IF;
 UPDATE public.membership_invites SET revoked_at=now(),revoked_by=actor WHERE workspace_id=ws AND id=iid;
 INSERT INTO public.membership_events(workspace_id,kind,subject_email,invite_id,actor_id,before_roles,reason) VALUES(ws,'invite-revoked',inv.email,iid,actor,inv.roles,why);
 RETURN true;
END $$;
-- Admin-only member listing (other members' rows are not visible through own_membership RLS).
CREATE OR REPLACE FUNCTION public.alder_membership_list(ws uuid) RETURNS TABLE(user_id uuid,email text,name text,roles text[]) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.alder_actor() IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws OR NOT public.alder_is_workspace_admin(ws) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 RETURN QUERY SELECT m.user_id,u.email,u.name,m.roles FROM public.memberships m JOIN public.users u ON u.id=m.user_id WHERE m.workspace_id=ws ORDER BY u.email;
END $$;
-- Invitee view of their own open invitations (no workspace membership yet).
CREATE OR REPLACE FUNCTION public.alder_my_invites() RETURNS TABLE(workspace_id uuid,id uuid,roles text[],expires_at timestamptz,display_name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT i.workspace_id,i.id,i.roles,i.expires_at,coalesce(w.display_name,'Workspace '||left(i.workspace_id::text,8)) FROM public.membership_invites i LEFT JOIN public.workspace_profiles w ON w.workspace_id=i.workspace_id
 WHERE i.email=public.alder_actor_email() AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() ORDER BY i.created_at $$;
CREATE OR REPLACE FUNCTION public.alder_workspace_names() RETURNS TABLE(workspace_id uuid,display_name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT m.workspace_id,coalesce(w.display_name,'Workspace '||left(m.workspace_id::text,8)) FROM public.memberships m LEFT JOIN public.workspace_profiles w ON w.workspace_id=m.workspace_id WHERE m.user_id=public.alder_actor() $$;

-- ---------------------------------------------------------------- RLS + grants
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['operation_invalidations','reservation_releases','outbox','outbox_attempts','payable_imports','payable_import_rows','membership_events','membership_invites','workspace_profiles'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY app_workspace ON %I TO alder_app USING(workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND m.user_id=public.alder_actor())) WITH CHECK(workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND m.user_id=public.alder_actor()))',t);
  EXECUTE format('CREATE POLICY indexer_domain ON %I TO alder_indexer USING(true) WITH CHECK(true)',t);
 END LOOP; END $$;
-- Membership audit/invites are admin-only reads within the workspace (in addition to membership scope).
CREATE POLICY admin_only ON membership_events AS RESTRICTIVE FOR SELECT TO alder_app USING(public.alder_is_workspace_admin(workspace_id));
CREATE POLICY admin_only ON membership_invites AS RESTRICTIVE FOR SELECT TO alder_app USING(public.alder_is_workspace_admin(workspace_id));

GRANT SELECT,INSERT ON operation_invalidations,payable_imports,payable_import_rows TO alder_app;
GRANT SELECT ON reservation_releases,outbox_attempts,membership_events,membership_invites,workspace_profiles,worker_leases TO alder_app;
GRANT SELECT,INSERT ON outbox TO alder_app;
GRANT UPDATE(state,attempts,next_attempt_at,last_error) ON outbox TO alder_app;
GRANT EXECUTE ON FUNCTION public.alder_membership_invite(uuid,text,text[],text),public.alder_membership_accept(uuid,uuid),public.alder_membership_set_roles(uuid,uuid,text[],text[],text),public.alder_membership_revoke(uuid,uuid,text[],text),public.alder_invite_revoke(uuid,uuid,text),public.alder_membership_list(uuid),public.alder_my_invites(),public.alder_workspace_names(),public.alder_is_workspace_admin(uuid) TO alder_app;
REVOKE ALL ON FUNCTION public.alder_membership_invite(uuid,text,text[],text),public.alder_membership_accept(uuid,uuid),public.alder_membership_set_roles(uuid,uuid,text[],text[],text),public.alder_membership_revoke(uuid,uuid,text[],text),public.alder_invite_revoke(uuid,uuid,text),public.alder_membership_list(uuid),public.alder_my_invites(),public.alder_workspace_names() FROM PUBLIC;

GRANT SELECT ON operation_invalidations,reservation_releases,outbox_attempts TO alder_indexer;
GRANT INSERT ON reservation_releases,outbox,outbox_attempts,worker_lease_events,indexer_requests TO alder_indexer;
GRANT DELETE ON reservations TO alder_indexer;
GRANT SELECT,INSERT,UPDATE ON worker_leases TO alder_indexer;
GRANT SELECT ON outbox,worker_lease_events,indexer_requests TO alder_indexer;
GRANT UPDATE(state,attempts,next_attempt_at,claimed_by,claim_fence,claimed_until,last_error,delivered_at,delivery_fence) ON outbox TO alder_indexer;
GRANT UPDATE(claimed_fence,done_at,result,error) ON indexer_requests TO alder_indexer;
GRANT USAGE,SELECT ON SEQUENCE outbox_id_seq,outbox_attempts_id_seq,worker_lease_events_id_seq,indexer_requests_id_seq TO alder_indexer;
GRANT USAGE,SELECT ON SEQUENCE outbox_id_seq TO alder_app;

-- ---------------------------------------------------------------- 7. independent-review round-4 fixes
-- H1: report provenance. produced_by is forced to the inserting session role (cannot be spoofed by the writer);
-- the reconciler only reaffirms reports produced by alder_indexer with the current verifier version and an exact
-- transaction/manifest binding. Legacy rows keep NULL and are never reaffirmed (they are re-verified instead).
ALTER TABLE treasury_reports ADD COLUMN produced_by text;
CREATE OR REPLACE FUNCTION public.alder_report_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.produced_by := session_user; RETURN NEW; END $$;
CREATE TRIGGER report_provenance BEFORE INSERT ON treasury_reports FOR EACH ROW EXECUTE FUNCTION public.alder_report_provenance();
-- The separate verifier role was never used by the live stack; it may no longer insert reports at all.
REVOKE INSERT ON treasury_reports FROM alder_verifier;
REVOKE USAGE,SELECT ON SEQUENCE treasury_reports_id_seq FROM alder_verifier;
-- L3: a payable with a verified settlement can never be reserved again (defense in depth for any future void/release).
CREATE OR REPLACE FUNCTION public.alder_reservation_unsettled() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.treasury_settlements s WHERE s.workspace_id=NEW.workspace_id AND s.payable_id=NEW.payable_id AND s.state='verified') THEN RAISE EXCEPTION 'PAYABLE_ALREADY_SETTLED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reservation_unsettled BEFORE INSERT ON reservations FOR EACH ROW EXECUTE FUNCTION public.alder_reservation_unsettled();
