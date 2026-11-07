-- Round 6 follow-up: persistent per-known-user login budgets prevent limiter-map
-- saturation from resetting an identity's delay. Unknown usernames never create
-- rows because the API calls these tables only after resolving users.id.
CREATE TABLE public.login_account_throttles(
 user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
 failure_times timestamptz[] NOT NULL DEFAULT '{}',
 next_at timestamptz NOT NULL DEFAULT '-infinity',
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(cardinality(failure_times)<=64)
);
CREATE TABLE public.login_device_throttles(
 user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 device_hash text NOT NULL CHECK(device_hash ~ '^[0-9a-f]{64}$'),
 bucket_kind text NOT NULL DEFAULT 'device' CHECK(bucket_kind IN ('device','overflow')),
 failure_times timestamptz[] NOT NULL DEFAULT '{}',
 next_at timestamptz NOT NULL DEFAULT '-infinity',
 expires_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,bucket_kind,device_hash),
 CHECK(cardinality(failure_times)<=64)
);
CREATE INDEX login_device_throttles_expiry ON public.login_device_throttles(user_id,expires_at);
ALTER TABLE public.login_account_throttles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_account_throttles FORCE ROW LEVEL SECURITY;
CREATE POLICY login_account_throttles_app ON public.login_account_throttles TO alder_app USING(true) WITH CHECK(true);
ALTER TABLE public.login_device_throttles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_device_throttles FORCE ROW LEVEL SECURITY;
CREATE POLICY login_device_throttles_app ON public.login_device_throttles TO alder_app USING(true) WITH CHECK(true);
REVOKE ALL ON public.login_account_throttles,public.login_device_throttles FROM PUBLIC,alder_indexer,alder_verifier;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.login_account_throttles,public.login_device_throttles TO alder_app;
