-- Expand-only referential hardening; old legacy operation_id NULL remains held.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='batch_operation_workspace_fk') THEN ALTER TABLE batches ADD CONSTRAINT batch_operation_workspace_fk FOREIGN KEY(workspace_id,operation_id) REFERENCES treasury_operations(workspace_id,id);END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='report_workspace_operation_id_unique') THEN ALTER TABLE treasury_reports ADD CONSTRAINT report_workspace_operation_id_unique UNIQUE(workspace_id,operation_id,id);END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='settlement_report_workspace_fk') THEN ALTER TABLE treasury_settlements ADD CONSTRAINT settlement_report_workspace_fk FOREIGN KEY(workspace_id,operation_id,report_id) REFERENCES treasury_reports(workspace_id,operation_id,id);END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='canonical_private_payment_id_unique') THEN ALTER TABLE payables ADD CONSTRAINT canonical_private_payment_id_unique UNIQUE(payment_id);END IF;
END $$;
