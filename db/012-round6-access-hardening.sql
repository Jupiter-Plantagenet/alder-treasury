-- Round 6 access/hardening (2026-10-31, user-authorized; agent "round6-access"). Out-of-band migration authority only
-- (postgres via docker exec, ONE transaction, journaled in schema_migrations); never run at API startup.
--
-- Shape: expand-first. New columns/tables/functions/constraints are added. Some grants and one constraint are
-- deliberately NARROWED or REPLACED below; every narrowing is listed here (unlike 010, see section 0):
--   N1  worker_leases: INSERT/UPDATE revoked from alder_indexer (lease changes only via the SECURITY DEFINER lease
--       functions, which refuse a takeover while the lease is unexpired and issue a per-lease secret token).
--   N2  worker_lease_events: INSERT revoked from alder_indexer (written only by the lease functions).
--   N3  outbox: UPDATE(state,attempts,next_attempt_at,last_error) revoked from alder_app (held re-queue goes through
--       alder_outbox_requeue_held); alder_app INSERT on outbox is limited by trigger to its own invalidation notice.
--   N4  outbox: the global UNIQUE(dedupe_key) is replaced by UNIQUE(workspace_id,dedupe_key). Writers use
--       "ON CONFLICT DO NOTHING" without a column target (services/treasury-indexer.ts changed BEFORE this ran).
--   N5  EXECUTE revoked from PUBLIC on every SECURITY DEFINER function in schema public, then granted narrowly.
--   N6  memberships / membership_invites: CHECK that `admin` is never combined with owner/reviewer/preparer
--       (validated: no existing row violates it). The membership functions refuse self role changes and any
--       in-app grant of `owner` (custody-owner changes are out-of-band only).
-- No business record is rewritten or deleted. Sessions of a revoked member are deleted (access-control rows; the
-- count is archived in the immutable membership audit row).
--
-- 0. Correction of the record for migration 010 (not edited: its SHA-256 is journaled). 010's header says
--    "No existing policy, grant or constraint is dropped or narrowed", but 010 section 7 REVOKEs INSERT on
--    treasury_reports and USAGE,SELECT on treasury_reports_id_seq from alder_verifier. That narrowing is KEPT on
--    least-privilege grounds: the verifier role never wrote reports in the live stack, and report provenance
--    (H1) requires that only the fenced alder_indexer inserts reports. Verified unchanged by tests/round6/db-grants.ts.

-- ---------------------------------------------------------------- 1. single-writer lease: secret token + DB-enforced expiry
ALTER TABLE worker_leases ADD COLUMN token_hash text CHECK(token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION public.alder_lease_acquire(p_name text,p_holder text,p_ttl integer) RETURNS TABLE(fence text,token text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
#variable_conflict use_column
DECLARE tok text := replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 th text; f bigint;
BEGIN
 IF p_ttl IS NULL OR p_ttl<5 OR p_ttl>120 THEN RAISE EXCEPTION 'LEASE_TTL_INVALID'; END IF;
 th := encode(sha256(convert_to(tok,'UTF8')),'hex');
 INSERT INTO public.worker_leases(name,holder,fence,expires_at,state,token_hash) VALUES(p_name,p_holder,1,clock_timestamp()+make_interval(secs=>p_ttl),'leased',th)
  ON CONFLICT(name) DO UPDATE SET holder=EXCLUDED.holder,fence=worker_leases.fence+1,acquired_at=clock_timestamp(),expires_at=EXCLUDED.expires_at,
   heartbeat_at=clock_timestamp(),state='leased',detail='{}'::jsonb,token_hash=EXCLUDED.token_hash
  WHERE worker_leases.expires_at<=clock_timestamp()
  RETURNING worker_leases.fence INTO f;
 IF f IS NULL THEN RETURN; END IF;           -- held by an unexpired lease: no row, no takeover
 INSERT INTO public.worker_lease_events(name,holder,fence,kind) VALUES(p_name,p_holder,f,'acquired');
 fence := f::text; token := tok; RETURN NEXT;
END $$;

-- Renew (outside a pass) or extend (inside a fenced pass). Only the exact unexpired (name,fence,token).
CREATE OR REPLACE FUNCTION public.alder_lease_renew(p_name text,p_fence bigint,p_token text,p_ttl integer,p_state text,p_detail jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n integer;
BEGIN
 IF p_ttl IS NULL OR p_ttl<5 OR p_ttl>120 THEN RAISE EXCEPTION 'LEASE_TTL_INVALID'; END IF;
 UPDATE public.worker_leases SET expires_at=clock_timestamp()+make_interval(secs=>p_ttl),heartbeat_at=clock_timestamp(),
   state=coalesce(p_state,state),detail=coalesce(p_detail,detail)
  WHERE name=p_name AND fence=p_fence AND expires_at>clock_timestamp() AND token_hash=encode(sha256(convert_to(coalesce(p_token,''),'UTF8')),'hex');
 GET DIAGNOSTICS n = ROW_COUNT; RETURN n=1;
END $$;

CREATE OR REPLACE FUNCTION public.alder_lease_release(p_name text,p_fence bigint,p_token text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h text;
BEGIN
 UPDATE public.worker_leases SET expires_at=clock_timestamp(),state='released'
  WHERE name=p_name AND fence=p_fence AND token_hash=encode(sha256(convert_to(coalesce(p_token,''),'UTF8')),'hex') RETURNING holder INTO h;
 IF h IS NULL THEN RETURN false; END IF;
 INSERT INTO public.worker_lease_events(name,holder,fence,kind) VALUES(p_name,h,p_fence,'released');
 RETURN true;
END $$;

-- Called at the start of every fenced transaction: locks the lease row FOR SHARE (no takeover can commit a newer
-- fence during the transaction) and binds the transaction to (fence, token) for alder_assert_fence.
CREATE OR REPLACE FUNCTION public.alder_lease_assert(p_name text,p_fence bigint,p_token text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.worker_leases WHERE name=p_name AND fence=p_fence AND expires_at>clock_timestamp()
   AND token_hash=encode(sha256(convert_to(coalesce(p_token,''),'UTF8')),'hex') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'LEASE_LOST'; END IF;
 PERFORM set_config('alder.worker_fence',p_fence::text,true),set_config('alder.worker_name',p_name,true),set_config('alder.worker_token',p_token,true);
 RETURN true;
END $$;

-- Every machine-role projection write must carry the current unexpired fence AND that lease's secret token.
-- Reading the fence from worker_leases is no longer enough to write (review F-M3).
CREATE OR REPLACE FUNCTION public.alder_assert_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE f text := current_setting('alder.worker_fence',true); n text := coalesce(nullif(current_setting('alder.worker_name',true),''),'indexer');
 t text := current_setting('alder.worker_token',true);
BEGIN
 IF session_user<>'alder_indexer' THEN RETURN COALESCE(NEW,OLD); END IF;
 IF f IS NULL OR f !~ '^[1-9][0-9]{0,18}$' THEN RAISE EXCEPTION 'FENCE_REQUIRED'; END IF;
 IF t IS NULL OR t='' THEN RAISE EXCEPTION 'FENCE_TOKEN_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.worker_leases WHERE name=n AND fence=f::bigint AND expires_at>clock_timestamp()
   AND token_hash=encode(sha256(convert_to(t,'UTF8')),'hex')) THEN RAISE EXCEPTION 'STALE_FENCE'; END IF;
 RETURN COALESCE(NEW,OLD);
END $$;

REVOKE INSERT,UPDATE ON worker_leases FROM alder_indexer;
REVOKE INSERT ON worker_lease_events FROM alder_indexer;

-- ---------------------------------------------------------------- 2. API resync requests without the indexer credential
-- The API (alder_app) may only enqueue a coalesced resync for a workspace where the session actor is owner/admin, and
-- read the public part of a request's result. It holds no machine-role credential and no lease path.
CREATE OR REPLACE FUNCTION public.alder_request_resync(ws uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); rid bigint;
BEGIN
 IF actor IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws
   OR NOT EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=ws AND user_id=actor AND roles && ARRAY['owner','admin']) THEN RAISE EXCEPTION 'ROLE_DENIED'; END IF;
 PERFORM pg_advisory_xact_lock(8561);
 SELECT id INTO rid FROM public.indexer_requests WHERE kind='resync' AND done_at IS NULL ORDER BY id LIMIT 1;
 IF rid IS NULL THEN INSERT INTO public.indexer_requests(kind,requested_by) VALUES('resync','api:'||actor::text) RETURNING id INTO rid; END IF;
 RETURN rid;
END $$;
CREATE OR REPLACE FUNCTION public.alder_resync_status(rid bigint) RETURNS TABLE(id text,done boolean,head text,head_hash text,paused boolean,depth text,error text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT r.id::text,r.done_at IS NOT NULL,r.result->>'head',r.result->>'headHash',(r.result->>'paused')::boolean,r.result->>'depth',left(r.error,120)
 FROM public.indexer_requests r WHERE r.id=rid AND public.alder_actor() IS NOT NULL $$;

-- ---------------------------------------------------------------- 3. outbox: app cannot mark items; workspace-scoped dedupe
REVOKE UPDATE ON outbox FROM alder_app;
CREATE OR REPLACE FUNCTION public.alder_outbox_requeue_held(ws uuid,oid bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); r text;
BEGIN
 IF actor IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws
   OR NOT EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=ws AND user_id=actor AND roles && ARRAY['owner','admin']) THEN RAISE EXCEPTION 'ROLE_DENIED'; END IF;
 UPDATE public.outbox SET state='pending',attempts=0,next_attempt_at=now(),last_error=NULL WHERE workspace_id=ws AND id=oid AND state='held' RETURNING id::text INTO r;
 IF r IS NULL THEN RAISE EXCEPTION 'OUTBOX_NOT_HELD'; END IF;
 RETURN r;
END $$;
-- alder_app may insert only the invalidation-proposed notice for an invalidation of ITS workspace, with the exact key.
CREATE OR REPLACE FUNCTION public.alder_outbox_app_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF session_user<>'alder_app' THEN RETURN NEW; END IF;
 IF NEW.kind<>'invalidation.proposed' OR NEW.dedupe_key<>'invalidation-proposed:'||(NEW.payload->>'operation_id') OR NEW.state<>'pending' OR NEW.attempts<>0
   OR NOT EXISTS(SELECT 1 FROM public.operation_invalidations i WHERE i.workspace_id=NEW.workspace_id AND i.operation_id::text=NEW.payload->>'operation_id')
 THEN RAISE EXCEPTION 'OUTBOX_APP_INSERT_DENIED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outbox_app_insert_guard BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION public.alder_outbox_app_insert_guard();
CREATE UNIQUE INDEX outbox_workspace_dedupe ON outbox(workspace_id,dedupe_key);
ALTER TABLE outbox DROP CONSTRAINT outbox_dedupe_key_key;

-- ---------------------------------------------------------------- 4. membership separation of duties + session revocation
ALTER TABLE memberships ADD CONSTRAINT memberships_admin_not_treasury CHECK(NOT ('admin'=ANY(roles) AND roles && ARRAY['owner','reviewer','preparer']));
ALTER TABLE membership_invites ADD CONSTRAINT invites_admin_not_treasury CHECK(NOT ('admin'=ANY(roles) AND roles && ARRAY['owner','reviewer','preparer']));
ALTER TABLE membership_invites ADD CONSTRAINT invites_no_owner CHECK(NOT ('owner'=ANY(roles))) NOT VALID;
ALTER TABLE membership_events DROP CONSTRAINT membership_events_kind_check;
ALTER TABLE membership_events ADD CONSTRAINT membership_events_kind_check CHECK(kind IN ('invited','invite-accepted','invite-revoked','roles-changed','revoked','sessions-revoked'));

CREATE OR REPLACE FUNCTION public.alder_sod_check(new_roles text[]) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF 'admin'=ANY(new_roles) AND new_roles && ARRAY['owner','reviewer','preparer'] THEN RAISE EXCEPTION 'ADMIN_TREASURY_ROLE_CONFLICT'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.alder_membership_invite(ws uuid,invite_email text,invite_roles text[],why text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); iid uuid := gen_random_uuid(); target uuid;
BEGIN
 IF actor IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws OR NOT public.alder_is_workspace_admin(ws) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 IF NOT public.alder_roles_valid(invite_roles) THEN RAISE EXCEPTION 'INVALID_ROLES'; END IF;
 IF 'owner'=ANY(invite_roles) THEN RAISE EXCEPTION 'OWNER_GRANT_OUT_OF_BAND'; END IF;
 PERFORM public.alder_sod_check(invite_roles);
 SELECT id INTO target FROM public.users WHERE lower(email)=lower(invite_email);
 IF target=actor THEN RAISE EXCEPTION 'SELF_ROLE_CHANGE'; END IF;
 IF target IS NOT NULL AND EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=ws AND user_id=target) THEN RAISE EXCEPTION 'ALREADY_MEMBER'; END IF;
 INSERT INTO public.membership_invites(workspace_id,id,email,roles,invited_by,expires_at) VALUES(ws,iid,lower(invite_email),invite_roles,actor,now()+interval '7 days');
 INSERT INTO public.membership_events(workspace_id,kind,subject_user_id,subject_email,invite_id,actor_id,after_roles,reason) VALUES(ws,'invited',target,lower(invite_email),iid,actor,invite_roles,why);
 RETURN iid;
END $$;

CREATE OR REPLACE FUNCTION public.alder_membership_set_roles(ws uuid,subject uuid,expected text[],new_roles text[],why text) RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); cur text[]; killed integer := 0;
BEGIN
 IF actor IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws OR NOT public.alder_is_workspace_admin(ws) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 IF NOT public.alder_roles_valid(new_roles) THEN RAISE EXCEPTION 'INVALID_ROLES'; END IF;
 IF subject=actor THEN RAISE EXCEPTION 'SELF_ROLE_CHANGE'; END IF;
 PERFORM public.alder_sod_check(new_roles);
 PERFORM 1 FROM public.memberships WHERE workspace_id=ws FOR UPDATE;
 SELECT roles INTO cur FROM public.memberships WHERE workspace_id=ws AND user_id=subject;
 IF cur IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT (cur @> expected AND cur <@ expected) THEN RAISE EXCEPTION 'STALE_ROLES'; END IF;
 IF 'owner'=ANY(new_roles) AND NOT 'owner'=ANY(cur) THEN RAISE EXCEPTION 'OWNER_GRANT_OUT_OF_BAND'; END IF;
 UPDATE public.memberships SET roles=new_roles WHERE workspace_id=ws AND user_id=subject;
 IF NOT EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=ws AND 'admin'=ANY(roles)) THEN RAISE EXCEPTION 'LAST_ADMIN'; END IF;
 -- Any removed role ends the subject's sessions (and with them every open SSE stream within one poll).
 IF NOT (cur <@ new_roles) THEN DELETE FROM public.sessions WHERE user_id=subject; GET DIAGNOSTICS killed = ROW_COUNT; END IF;
 INSERT INTO public.membership_events(workspace_id,kind,subject_user_id,actor_id,before_roles,after_roles,archived,reason) VALUES(ws,'roles-changed',subject,actor,cur,new_roles,jsonb_build_object('sessions_revoked',killed),why);
 RETURN new_roles;
END $$;

CREATE OR REPLACE FUNCTION public.alder_membership_revoke(ws uuid,subject uuid,expected text[],why text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); cur text[]; prefs jsonb; killed integer := 0;
BEGIN
 IF actor IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws OR NOT public.alder_is_workspace_admin(ws) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 PERFORM 1 FROM public.memberships WHERE workspace_id=ws FOR UPDATE;
 SELECT roles INTO cur FROM public.memberships WHERE workspace_id=ws AND user_id=subject;
 IF cur IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT (cur @> expected AND cur <@ expected) THEN RAISE EXCEPTION 'STALE_ROLES'; END IF;
 SELECT to_jsonb(p) INTO prefs FROM public.workspace_preferences p WHERE workspace_id=ws AND user_id=subject;
 DELETE FROM public.workspace_preferences WHERE workspace_id=ws AND user_id=subject;
 DELETE FROM public.memberships WHERE workspace_id=ws AND user_id=subject;
 IF NOT EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=ws AND 'admin'=ANY(roles)) THEN RAISE EXCEPTION 'LAST_ADMIN'; END IF;
 -- Revocation invalidates every session of the subject (sessions are not workspace-scoped), which also ends SSE.
 DELETE FROM public.sessions WHERE user_id=subject; GET DIAGNOSTICS killed = ROW_COUNT;
 INSERT INTO public.membership_events(workspace_id,kind,subject_user_id,actor_id,before_roles,archived,reason) VALUES(ws,'revoked',subject,actor,cur,jsonb_build_object('membership',jsonb_build_object('roles',cur),'preferences',prefs,'sessions_revoked',killed),why);
 RETURN true;
END $$;

-- Admin session revocation (blueprint section 4: Admin = membership/session/config operations).
CREATE OR REPLACE FUNCTION public.alder_membership_revoke_sessions(ws uuid,subject uuid,why text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := public.alder_actor(); cur text[]; killed integer := 0;
BEGIN
 IF actor IS NULL OR nullif(current_setting('alder.workspace_id',true),'')::uuid IS DISTINCT FROM ws OR NOT public.alder_is_workspace_admin(ws) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 SELECT roles INTO cur FROM public.memberships WHERE workspace_id=ws AND user_id=subject;
 IF cur IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 DELETE FROM public.sessions WHERE user_id=subject; GET DIAGNOSTICS killed = ROW_COUNT;
 INSERT INTO public.membership_events(workspace_id,kind,subject_user_id,actor_id,before_roles,after_roles,archived,reason) VALUES(ws,'sessions-revoked',subject,actor,cur,cur,jsonb_build_object('sessions_revoked',killed),why);
 RETURN killed;
END $$;

-- ---------------------------------------------------------------- 5. invalidation bound to the target operation's own record (F-L1)
CREATE OR REPLACE FUNCTION public.alder_invalidation_binding() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t record; io record;
BEGIN
 SELECT kind,manifest INTO t FROM public.treasury_operations WHERE workspace_id=NEW.workspace_id AND id=NEW.target_operation_id;
 SELECT kind,manifest INTO io FROM public.treasury_operations WHERE workspace_id=NEW.workspace_id AND id=NEW.operation_id;
 IF t IS NULL OR io IS NULL OR io.kind<>'invalidation' OR t.kind NOT IN ('payout','allowance') THEN RAISE EXCEPTION 'INVALIDATION_BINDING'; END IF;
 IF lower(t.manifest->>'safeTxHash')<>NEW.target_safe_tx_hash OR (t.manifest->'message'->>'nonce')::numeric<>NEW.target_nonce
   OR (NEW.method='executor_cancel' AND (t.kind<>'payout' OR lower(t.manifest->>'batchId') IS DISTINCT FROM NEW.target_batch_id))
   OR (io.manifest->'target'->>'operationId') IS DISTINCT FROM NEW.target_operation_id::text
   OR lower(io.manifest->'target'->>'safeTxHash') IS DISTINCT FROM NEW.target_safe_tx_hash
   OR (io.manifest->'target'->>'nonce')::numeric IS DISTINCT FROM NEW.target_nonce
   OR lower(io.manifest->'target'->>'batchId') IS DISTINCT FROM NEW.target_batch_id
   OR (t.kind='payout' AND (io.manifest->'target'->'paymentIds') IS DISTINCT FROM (SELECT coalesce(jsonb_agg(x->'paymentId'),'[]'::jsonb) FROM jsonb_array_elements(t.manifest->'items') x))
   OR io.manifest->>'method' IS DISTINCT FROM NEW.method OR (io.manifest->'message'->>'nonce')::numeric IS DISTINCT FROM NEW.invalidation_nonce
 THEN RAISE EXCEPTION 'INVALIDATION_BINDING'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidation_binding BEFORE INSERT ON operation_invalidations FOR EACH ROW EXECUTE FUNCTION public.alder_invalidation_binding();

CREATE OR REPLACE FUNCTION public.alder_reservation_release_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.chain_lineage_voided_reservations a WHERE a.workspace_id=OLD.workspace_id AND a.payable_id=OLD.payable_id AND a.batch_id=OLD.batch_id) THEN RETURN OLD; END IF;
 IF EXISTS(SELECT 1 FROM public.reservation_releases rr
   JOIN public.operation_invalidations i ON i.workspace_id=rr.workspace_id AND i.operation_id=rr.invalidation_operation_id AND i.target_operation_id=rr.target_operation_id
   JOIN public.batches b ON b.workspace_id=rr.workspace_id AND b.id=rr.batch_id AND b.operation_id=rr.target_operation_id
   JOIN public.treasury_operations tgt ON tgt.workspace_id=rr.workspace_id AND tgt.id=rr.target_operation_id
   JOIN public.treasury_reports t ON t.workspace_id=rr.workspace_id AND t.operation_id=rr.invalidation_operation_id AND t.id=rr.report_id
  WHERE rr.workspace_id=OLD.workspace_id AND rr.payable_id=OLD.payable_id AND rr.batch_id=OLD.batch_id
   AND t.produced_by='alder_indexer'
   AND t.report->>'state'='verified' AND t.report->>'kind'='invalidation' AND t.report->>'targetOperationId'=rr.target_operation_id::text
   AND (t.report->>'targetCannotExecute')='true'
   AND lower(tgt.manifest->>'safeTxHash')=i.target_safe_tx_hash AND (tgt.manifest->'message'->>'nonce')::numeric=i.target_nonce
   AND (i.method<>'executor_cancel' OR lower(tgt.manifest->>'batchId')=i.target_batch_id)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'RESERVATION_RELEASE_REQUIRES_VERIFIED_INVALIDATION';
END $$;

-- ---------------------------------------------------------------- 6. attachment-byte retention deletion (TR-T-EXPORT)
-- Bytes may be deleted after retention; metadata, SHA-256, links and an immutable purge record are retained.
ALTER TABLE private_attachments ADD COLUMN purged_at timestamptz;
ALTER TABLE private_attachments ALTER COLUMN content DROP NOT NULL;
ALTER TABLE private_attachments DROP CONSTRAINT private_attachments_check;
ALTER TABLE private_attachments DROP CONSTRAINT private_attachments_check1;
ALTER TABLE private_attachments ADD CONSTRAINT attachment_bytes_or_purged CHECK((content IS NULL)=(purged_at IS NOT NULL));
ALTER TABLE private_attachments ADD CONSTRAINT attachment_length_exact CHECK(content IS NULL OR octet_length(content)=byte_length);
ALTER TABLE private_attachments ADD CONSTRAINT attachment_sha_exact CHECK(content IS NULL OR sha256=encode(sha256(content),'hex'));
CREATE TABLE attachment_retention_purges(
 workspace_id uuid NOT NULL, attachment_id uuid NOT NULL, sha256 text NOT NULL, byte_length integer NOT NULL,
 created_at timestamptz NOT NULL, retention_seconds bigint NOT NULL CHECK(retention_seconds>0), purged_at timestamptz NOT NULL DEFAULT now(),
 purged_by text NOT NULL, PRIMARY KEY(workspace_id,attachment_id),
 FOREIGN KEY(workspace_id,attachment_id,sha256) REFERENCES private_attachments(workspace_id,id,sha256));
CREATE TRIGGER immutable_attachment_purge BEFORE UPDATE OR DELETE ON attachment_retention_purges FOR EACH ROW EXECUTE FUNCTION treasury_immutable();
ALTER TABLE attachment_retention_purges ENABLE ROW LEVEL SECURITY;ALTER TABLE attachment_retention_purges FORCE ROW LEVEL SECURITY;
CREATE POLICY app_workspace ON attachment_retention_purges TO alder_app USING(workspace_id=nullif(current_setting('alder.workspace_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=nullif(current_setting('alder.workspace_id',true),'')::uuid AND m.user_id=public.alder_actor()));
GRANT SELECT ON attachment_retention_purges TO alder_app;
-- The only permitted mutation of private_attachments: content -> NULL with purged_at, inside the retention function.
CREATE OR REPLACE FUNCTION public.alder_attachment_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND current_setting('alder.attachment_retention_purge',true)='on' AND OLD.content IS NOT NULL AND NEW.content IS NULL AND NEW.purged_at IS NOT NULL
   AND NEW.workspace_id=OLD.workspace_id AND NEW.id=OLD.id AND NEW.sha256=OLD.sha256 AND NEW.mime=OLD.mime AND NEW.byte_length=OLD.byte_length
   AND NEW.scan_state=OLD.scan_state AND NEW.created_by=OLD.created_by AND NEW.created_at=OLD.created_at THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'immutable treasury record';
END $$;
DROP TRIGGER attachment_immutable ON private_attachments;
CREATE TRIGGER attachment_immutable BEFORE UPDATE OR DELETE ON private_attachments FOR EACH ROW EXECUTE FUNCTION public.alder_attachment_immutable();
-- Operator/retention-job entry point (not granted to any browser-facing role). Workspace-explicit; the minimum
-- retention is enforced by the caller policy (ops/attachment-retention.ts: 180 days unless a test workspace).
CREATE OR REPLACE FUNCTION public.alder_attachment_retention_purge(ws uuid,retention interval,actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n integer := 0; a record;
BEGIN
 IF retention IS NULL OR retention<interval '1 second' THEN RAISE EXCEPTION 'RETENTION_INVALID'; END IF;
 PERFORM set_config('alder.attachment_retention_purge','on',true);
 FOR a IN SELECT workspace_id,id,sha256,byte_length,created_at FROM public.private_attachments WHERE workspace_id=ws AND content IS NOT NULL AND created_at<=now()-retention FOR UPDATE LOOP
  INSERT INTO public.attachment_retention_purges(workspace_id,attachment_id,sha256,byte_length,created_at,retention_seconds,purged_by) VALUES(a.workspace_id,a.id,a.sha256,a.byte_length,a.created_at,greatest(1,extract(epoch FROM retention)::bigint),left(actor,200));
  UPDATE public.private_attachments SET content=NULL,purged_at=now() WHERE workspace_id=a.workspace_id AND id=a.id;
  n := n+1;
 END LOOP;
 PERFORM set_config('alder.attachment_retention_purge','off',true);
 RETURN n;
END $$;

-- ---------------------------------------------------------------- 7. function EXECUTE: nothing SECURITY DEFINER is PUBLIC
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
 END LOOP; END $$;
REVOKE ALL ON FUNCTION public.alder_sod_check(text[]),public.alder_attachment_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alder_actor(),public.alder_is_workspace_admin(uuid),public.alder_membership_invite(uuid,text,text[],text),public.alder_membership_accept(uuid,uuid),
 public.alder_membership_set_roles(uuid,uuid,text[],text[],text),public.alder_membership_revoke(uuid,uuid,text[],text),public.alder_invite_revoke(uuid,uuid,text),
 public.alder_membership_list(uuid),public.alder_my_invites(),public.alder_workspace_names(),public.alder_membership_revoke_sessions(uuid,uuid,text),
 public.alder_request_resync(uuid),public.alder_resync_status(bigint),public.alder_outbox_requeue_held(uuid,bigint) TO alder_app;
GRANT EXECUTE ON FUNCTION public.alder_lease_acquire(text,text,integer),public.alder_lease_renew(text,bigint,text,integer,text,jsonb),
 public.alder_lease_release(text,bigint,text),public.alder_lease_assert(text,bigint,text) TO alder_indexer;
