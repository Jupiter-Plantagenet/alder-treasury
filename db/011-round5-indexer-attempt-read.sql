-- Round 5, expand-only grant: the reconciler classifies non-successful operations from durable attempt evidence
-- (review M2: distinct pending / replaced / outer_reverted / wallet_refused / broadcast_uncertain states), so the
-- machine indexer role needs READ (only) on attempts and wallet observations. RLS policy indexer_domain already exists.
GRANT SELECT ON treasury_attempts,treasury_observations TO alder_indexer;
