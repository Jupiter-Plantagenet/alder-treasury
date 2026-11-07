-- Round 4 (2026-10-30, user-authorized): chain lineage 2 on a NEW persistent local Anvil 127.0.0.1:8547.
-- Lineage 1 (genesis 0x439480c0…1c29) ran without state persistence and is lost. Every frozen/signed
-- authorization bound to lineage 1 can never execute and is VOIDED here by explicit, recorded voiding.
-- Nothing is deleted from batches/manifests/signatures/payables/events. Reservations of voided batches are
-- archived row-for-row into chain_lineage_voided_reservations and only then released, so the business
-- payables can be re-reviewed and re-frozen on lineage 2 (user authorization: "voided and re-frozen").
-- Out-of-band migration authority only (postgres via docker exec); never run at API startup.

CREATE TABLE IF NOT EXISTS schema_migrations(
 id text PRIMARY KEY, sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 applied_at timestamptz NOT NULL DEFAULT now(), note text NOT NULL);
REVOKE ALL ON schema_migrations FROM PUBLIC;

CREATE TABLE chain_lineage_voids(
 workspace_id uuid NOT NULL, batch_id uuid NOT NULL, prior_state text NOT NULL,
 prior_genesis text NOT NULL CHECK(prior_genesis ~ '^0x[0-9a-f]{64}$'),
 new_genesis text NOT NULL CHECK(new_genesis ~ '^0x[0-9a-f]{64}$'),
 safe_tx_hash text, reason text NOT NULL, voided_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,batch_id), FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id));
CREATE TABLE chain_lineage_voided_reservations(
 workspace_id uuid NOT NULL, payable_id uuid NOT NULL, batch_id uuid NOT NULL, archived_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,payable_id,batch_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES chain_lineage_voids(workspace_id,batch_id),
 FOREIGN KEY(workspace_id,payable_id) REFERENCES payables(workspace_id,id));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['chain_lineage_voids','chain_lineage_voided_reservations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY app_workspace ON %I FOR SELECT TO alder_app USING(workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND m.user_id=public.alder_actor()))',t);
  EXECUTE format('CREATE TRIGGER immutable_void BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION treasury_immutable()',t);
 END LOOP;
END $$;
GRANT SELECT ON chain_lineage_voids,chain_lineage_voided_reservations TO alder_app;

-- The void itself (explicit constants: the two lineages).
INSERT INTO chain_lineage_voids(workspace_id,batch_id,prior_state,prior_genesis,new_genesis,safe_tx_hash,reason)
 SELECT b.workspace_id,b.id,b.state,b.manifest->>'genesis','0xf0bcef3e005c610a62955b74b4d76ba98617fd5811d1007c99bb46e24f5dcdec',b.manifest->>'safeTxHash',
  'LINEAGE1_CHAIN_LOST: original 8547 Anvil ran without state persistence; this authorization can never execute. Voided by user-authorized round-4 lineage-2 migration; payables require fresh policy-bound review and a new freeze.'
 FROM batches b WHERE b.manifest->>'genesis'='0x439480c0c38ac57957641d700bca85152ccf4463d2be4a754c6b3dfab99d1c29' AND b.state<>'voided_lineage_lost';
INSERT INTO chain_lineage_voided_reservations(workspace_id,payable_id,batch_id)
 SELECT r.workspace_id,r.payable_id,r.batch_id FROM reservations r JOIN chain_lineage_voids v ON v.workspace_id=r.workspace_id AND v.batch_id=r.batch_id;
UPDATE batches b SET state='voided_lineage_lost' FROM chain_lineage_voids v WHERE v.workspace_id=b.workspace_id AND v.batch_id=b.id;
UPDATE treasury_operations o SET state='voided_lineage_lost' WHERE o.manifest->>'genesis'='0x439480c0c38ac57957641d700bca85152ccf4463d2be4a754c6b3dfab99d1c29' AND o.state NOT IN ('verified','voided_lineage_lost');
DELETE FROM reservations r USING chain_lineage_voided_reservations a WHERE a.workspace_id=r.workspace_id AND a.payable_id=r.payable_id AND a.batch_id=r.batch_id;
INSERT INTO events(workspace_id,actor_id,kind,data)
 SELECT v.workspace_id,'00000000-0000-4000-8000-000000000000','chain-lineage-voided',
  jsonb_build_object('batch_id',v.batch_id,'prior_genesis',v.prior_genesis,'new_genesis',v.new_genesis,'safe_tx_hash',v.safe_tx_hash,
   'archived_reservations',(SELECT count(*) FROM chain_lineage_voided_reservations a WHERE a.workspace_id=v.workspace_id AND a.batch_id=v.batch_id)::text)
 FROM chain_lineage_voids v;
