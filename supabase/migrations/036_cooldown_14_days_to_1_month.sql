-- ============================================================================
-- 036 - Lost Opportunity cooldown: 14 days to 1 calendar month
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-27, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version is created with `supabase migration repair --status applied`,
-- so `supabase db push` skips it. If a push ever tries to EXECUTE this file,
-- stop and fix the repair rather than letting it run.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-036-Report.md
-- ============================================================================

-- Migration 036: cooldown becomes a calendar month, not a hardcoded duration.
-- (1) Inside handle_lost_opportunity() (or wherever the loss trigger/job
--     computes reassignable_at), replace the old 14-day expression:
--       NEW.reassignable_at := NEW.lost_at + interval '14 days';   -- OLD
--     with:
--       NEW.reassignable_at := NEW.lost_at + interval '1 month';   -- NEW
--     (exact replace-in-place depends on the live function body captured above)

-- (2) Backfill currently-lost clients (calendar month, NOT 30 days):
update public.clients
   set reassignable_at = lost_at + interval '1 month'
 where status = 'lost' and lost_at is not null;

-- (3) Keep client_cycles consistent with the recompute:
update public.client_cycles
   set reassignable_at = lost_at + interval '1 month'
 where claimed_at is null and end_reason = 'lost';
