-- Additive, UNAPPLIED. Out-of-band migration authority only; never run at API startup.
-- Prerequisites: original 001..006 chain (scoped roles, treasury_immutable(), business_reviews).
-- Independent of optional 007. No backfill: existing workspaces have NO policy and therefore hold
-- every new review/freeze until a reviewer/admin creates one through the API. Existing business
-- review rows (implicit policy_revision 1, policy_id NULL) are retained byte-for-byte; they no longer
-- satisfy the freeze gate, which requires a review bound to the current policy revision.
-- Business policy is application workflow only. It is not a Safe guard/module and stores no custody
-- owners/threshold; DB checks below reject those keys as defense in depth.

CREATE TABLE review_policies(
 workspace_id uuid NOT NULL,id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id));
CREATE TABLE review_policy_revisions(
 workspace_id uuid NOT NULL,policy_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 conditions jsonb NOT NULL,digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 actor_id uuid NOT NULL REFERENCES users(id),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,policy_id,revision),
 FOREIGN KEY(workspace_id,policy_id) REFERENCES review_policies(workspace_id,id),
 -- Mandatory independent review floor cannot be stored disabled or reduced.
 CONSTRAINT review_policy_mandatory_floor CHECK(
  conditions->'mandatory_review'='true'::jsonb
  AND conditions->'required_reviewer_role'='"reviewer"'::jsonb
  AND conditions->'mandatory_destination_check'='true'::jsonb
  AND jsonb_typeof(conditions->'rules')='array' AND jsonb_array_length(conditions->'rules') BETWEEN 1 AND 50),
 CONSTRAINT review_policy_no_custody CHECK(NOT(conditions ?| ARRAY['owners','owner','threshold','safe_owners','safe_threshold','custody','modules','guard'])));
-- Head always points at an existing immutable revision (deferred: head row is inserted first).
ALTER TABLE review_policies ADD CONSTRAINT review_policy_current_revision_fk
 FOREIGN KEY(workspace_id,id,revision) REFERENCES review_policy_revisions(workspace_id,policy_id,revision)
 DEFERRABLE INITIALLY DEFERRED;
-- Revision pointer may only advance by exactly one.
CREATE OR REPLACE FUNCTION review_policy_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'POLICY_REVISION_MUST_ADVANCE_BY_ONE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER review_policy_advance BEFORE UPDATE ON review_policies FOR EACH ROW EXECUTE FUNCTION review_policy_advance();
CREATE TRIGGER review_policy_no_delete BEFORE DELETE ON review_policies FOR EACH ROW EXECUTE FUNCTION treasury_immutable();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON review_policy_revisions FOR EACH ROW EXECUTE FUNCTION treasury_immutable();

-- Per-user, per-workspace preferences (TR-Preferences: self only). Contains no role or custody field.
CREATE TABLE workspace_preferences(
 workspace_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),
 revision integer NOT NULL CHECK(revision>0),
 pending_reminders boolean NOT NULL,default_redaction boolean NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,user_id),
 FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id));

-- Business reviews bind the actual matched policy revision. Legacy rows keep policy_id NULL and the
-- historical implicit revision 1; new rows must name a stored policy revision and matched rules.
-- ADD COLUMN with constant default is catalog-only (no row rewrite; immutable triggers not fired).
ALTER TABLE business_reviews ADD COLUMN policy_id uuid;
ALTER TABLE business_reviews ADD COLUMN matched_rules text[];
ALTER TABLE business_reviews ADD COLUMN decision text NOT NULL DEFAULT 'approve';
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid='public.business_reviews'::regclass AND contype='c'
  AND pg_catalog.pg_get_constraintdef(oid)='CHECK ((policy_revision = 1))' LOOP
  EXECUTE format('ALTER TABLE business_reviews DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE business_reviews ADD CONSTRAINT business_review_policy_binding CHECK(
 (policy_id IS NULL AND policy_revision=1 AND matched_rules IS NULL)
 OR (policy_id IS NOT NULL AND policy_revision>0 AND cardinality(matched_rules) BETWEEN 1 AND 50));
ALTER TABLE business_reviews ADD CONSTRAINT business_review_decision CHECK(decision IN ('approve'));
ALTER TABLE business_reviews ADD CONSTRAINT business_review_policy_revision_fk
 FOREIGN KEY(workspace_id,policy_id,policy_revision) REFERENCES review_policy_revisions(workspace_id,policy_id,revision);
CREATE INDEX business_review_policy_lookup ON business_reviews(workspace_id,payable_id,payable_revision,policy_id,policy_revision);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['review_policies','review_policy_revisions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY app_workspace ON %I TO alder_app USING(workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND m.user_id=public.alder_actor())) WITH CHECK(workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND m.user_id=public.alder_actor()))',t);
 END LOOP;
END $$;
ALTER TABLE workspace_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY own_preferences ON workspace_preferences TO alder_app
 USING(workspace_id=nullif(current_setting('alder.workspace_id',true),'')::uuid AND user_id=public.alder_actor() AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=workspace_preferences.workspace_id AND m.user_id=public.alder_actor()))
 WITH CHECK(workspace_id=nullif(current_setting('alder.workspace_id',true),'')::uuid AND user_id=public.alder_actor() AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=workspace_preferences.workspace_id AND m.user_id=public.alder_actor()));

-- Append-only app grants; only the revision pointer / preference values are updatable (column grants).
GRANT SELECT,INSERT ON review_policies,review_policy_revisions,workspace_preferences TO alder_app;
GRANT UPDATE(revision) ON review_policies TO alder_app;
GRANT UPDATE(revision,pending_reminders,default_redaction,updated_at) ON workspace_preferences TO alder_app;
-- business_reviews already has SELECT,INSERT for alder_app (005); new columns inherit table grants.
-- No UPDATE/DELETE/TRUNCATE, indexer/verifier grant, role creation, backfill or seeded policy.
