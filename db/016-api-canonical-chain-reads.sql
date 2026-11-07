-- The hold resolver reads canonical chain headers and checkpoints to verify an
-- indexer release proof. These tables contain public chain lineage metadata.
-- The API receives no indexer credential or mutation/lease capability.
GRANT SELECT ON public.treasury_headers, public.treasury_checkpoints TO alder_app;
