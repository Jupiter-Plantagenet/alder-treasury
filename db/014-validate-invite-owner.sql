-- Round 6 additive follow-up: independently observed invite rows contain no owner role,
-- and db/012 changes the application invite path to reject owner grants. Validate the
-- existing forward-enforced check without rewriting invitation rows or altering 012.
ALTER TABLE public.membership_invites VALIDATE CONSTRAINT invites_no_owner;
