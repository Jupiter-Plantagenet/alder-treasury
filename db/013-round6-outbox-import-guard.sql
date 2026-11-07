-- Round 6 (access agent) follow-up to 012, found by the inbox-import rerun: the alder_app outbox INSERT guard of 012
-- allowed only the invalidation notice, but the bulk import (apps/api/imports.ts) also enqueues `payables.imported`.
-- Widening only: alder_app may additionally insert exactly that notice, keyed 'import:<import id>', for an import that
-- exists in the SAME workspace. Everything else stays refused (OUTBOX_APP_INSERT_DENIED). No data change.
CREATE OR REPLACE FUNCTION public.alder_outbox_app_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF session_user<>'alder_app' THEN RETURN NEW; END IF;
 IF NEW.state<>'pending' OR NEW.attempts<>0 THEN RAISE EXCEPTION 'OUTBOX_APP_INSERT_DENIED'; END IF;
 IF NEW.kind='invalidation.proposed' AND NEW.dedupe_key='invalidation-proposed:'||(NEW.payload->>'operation_id')
   AND EXISTS(SELECT 1 FROM public.operation_invalidations i WHERE i.workspace_id=NEW.workspace_id AND i.operation_id::text=NEW.payload->>'operation_id') THEN RETURN NEW; END IF;
 IF NEW.kind='payables.imported' AND NEW.dedupe_key='import:'||(NEW.payload->>'entity_id')
   AND EXISTS(SELECT 1 FROM public.payable_imports p WHERE p.workspace_id=NEW.workspace_id AND p.id::text=NEW.payload->>'entity_id') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'OUTBOX_APP_INSERT_DENIED';
END $$;
REVOKE ALL ON FUNCTION public.alder_outbox_app_insert_guard() FROM PUBLIC;
