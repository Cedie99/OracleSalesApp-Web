-- ============================================================================
-- 031 - Drop the three broad authenticated-read policies (the flip)
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-26, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version is created with `supabase migration repair --status applied`,
-- so `supabase db push` skips it. If a push ever tries to EXECUTE this file,
-- stop and fix the repair rather than letting it run.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-031-Report.md
--
-- The most consequential file in Batch 2. Applied BEFORE the mobile read-
-- path swap it required was confirmed shipped, so live duplicate-name
-- checking may still be degraded - see the Post-apply status section of the
-- report. Recorded here as-is; do not attempt to fix that from this repo.
-- ============================================================================

-- Migration 031: THE FLIP. Drops the three broad "any authenticated user can
-- read anything" policies. Migration 030's scoped policies (already live)
-- take over as the only read path from this point on.
drop policy if exists "Authenticated read clients" on public.clients;
drop policy if exists "Authenticated read meetings" on public.meetings;
drop policy if exists "Authenticated read profiles" on public.profiles;
