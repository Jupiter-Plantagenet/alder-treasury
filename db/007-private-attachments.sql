-- Additive, UNAPPLIED. Out-of-band migration authority only; never run at API startup.
-- Prerequisites: original 001..006 chain, including scoped roles and immutable trigger.
-- Bytea storage keeps bytes + metadata + request idempotency in one transaction.
-- No public object path, original filename, scanner credential or scanner activation.
CREATE TABLE private_attachments(
 workspace_id uuid NOT NULL,id uuid NOT NULL,sha256 text NOT NULL,
 mime text NOT NULL CHECK(mime IN ('application/pdf','image/png','image/jpeg')),
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 10485760),
 content bytea NOT NULL CHECK(octet_length(content)=byte_length),
 scan_state text NOT NULL DEFAULT 'pending' CHECK(scan_state='pending'),
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,id,sha256),
 CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 CHECK(sha256=pg_catalog.encode(pg_catalog.sha256(content),'hex'))
);
CREATE TABLE payable_attachments(
 workspace_id uuid NOT NULL,payable_id uuid NOT NULL,attachment_id uuid NOT NULL,sha256 text NOT NULL,
 linked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,payable_id,attachment_id),
 FOREIGN KEY(workspace_id,payable_id) REFERENCES payables(workspace_id,id),
 FOREIGN KEY(workspace_id,attachment_id,sha256) REFERENCES private_attachments(workspace_id,id,sha256)
);
-- An independently provisioned scanner must sign the canonical v1 verdict with
-- Ed25519 and submit through separate reviewed machine authority. No writer is
-- granted here, no key is installed, and no worker/endpoint is enabled.
-- First immutable verdict wins. Re-scanning/revocation policy needs explicit
-- future machine-authority design; the API can never overwrite a verdict.
CREATE TABLE attachment_scan_verdicts(
 workspace_id uuid NOT NULL,attachment_id uuid NOT NULL,sha256 text NOT NULL,
 scan_version text NOT NULL CHECK(length(scan_version) BETWEEN 1 AND 200),
 verdict text NOT NULL CHECK(verdict IN ('clean','quarantine')),
 signature text NOT NULL CHECK(signature ~ '^[0-9a-f]{128}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,attachment_id),
 FOREIGN KEY(workspace_id,attachment_id,sha256) REFERENCES private_attachments(workspace_id,id,sha256)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['private_attachments','payable_attachments','attachment_scan_verdicts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY attachment_workspace ON %I TO alder_app USING(workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND m.user_id=public.alder_actor())) WITH CHECK(workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=nullif(current_setting(''alder.workspace_id'',true),'''')::uuid AND m.user_id=public.alder_actor()))',t);
  EXECUTE format('CREATE TRIGGER attachment_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION treasury_immutable()',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON private_attachments,payable_attachments TO alder_app;
GRANT SELECT ON attachment_scan_verdicts TO alder_app;
-- No UPDATE/DELETE/TRUNCATE, scanner write, new roles, account/data rewrite,
-- journal mutation, extension installation or retention/backfill is performed.
