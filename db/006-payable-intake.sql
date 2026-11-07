-- Proposed expand-only intake. Apply only after independent review; no retained installation/backfill.
CREATE TABLE IF NOT EXISTS payable_intakes(
 workspace_id uuid NOT NULL,payable_id uuid NOT NULL,external_reference text NOT NULL,
 token_identity jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,payable_id),UNIQUE(workspace_id,external_reference),
 FOREIGN KEY(workspace_id,payable_id) REFERENCES payables(workspace_id,id),
 CHECK(length(external_reference) BETWEEN 1 AND 200));
ALTER TABLE payable_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE payable_intakes FORCE ROW LEVEL SECURITY;
CREATE POLICY intake_workspace ON payable_intakes TO alder_app
 USING(workspace_id=nullif(current_setting('alder.workspace_id',true),'')::uuid AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=payable_intakes.workspace_id AND m.user_id=alder_actor()))
 WITH CHECK(workspace_id=nullif(current_setting('alder.workspace_id',true),'')::uuid AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=payable_intakes.workspace_id AND m.user_id=alder_actor()));
GRANT SELECT,INSERT ON payable_intakes TO alder_app;
CREATE TRIGGER immutable_intake BEFORE UPDATE OR DELETE ON payable_intakes FOR EACH ROW EXECUTE FUNCTION treasury_immutable();

-- Short-lived immutable business read snapshots, not authorization/settlement evidence.
CREATE TABLE IF NOT EXISTS payable_inbox_snapshots(
 workspace_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),
 session_hash text NOT NULL,filter_digest text NOT NULL,secret text NOT NULL,payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 PRIMARY KEY(workspace_id,id),CHECK(expires_at>created_at));
CREATE INDEX IF NOT EXISTS payable_inbox_snapshot_expiry ON payable_inbox_snapshots(expires_at);
ALTER TABLE payable_inbox_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE payable_inbox_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_snapshot_scope ON payable_inbox_snapshots TO alder_app
 USING(workspace_id=nullif(current_setting('alder.workspace_id',true),'')::uuid AND actor_id=alder_actor() AND session_hash=current_setting('alder.session_hash',true) AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=payable_inbox_snapshots.workspace_id AND m.user_id=alder_actor()))
 WITH CHECK(workspace_id=nullif(current_setting('alder.workspace_id',true),'')::uuid AND actor_id=alder_actor() AND session_hash=current_setting('alder.session_hash',true) AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=payable_inbox_snapshots.workspace_id AND m.user_id=alder_actor()));
GRANT SELECT,INSERT ON payable_inbox_snapshots TO alder_app;
CREATE TRIGGER immutable_inbox_snapshot BEFORE UPDATE OR DELETE ON payable_inbox_snapshots FOR EACH ROW EXECUTE FUNCTION treasury_immutable();
