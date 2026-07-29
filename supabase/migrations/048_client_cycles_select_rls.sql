-- ============================================================================
-- 048 - Non-admin SELECT RLS on client_cycles (B-080)
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-29, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- IDEMPOTENT BY DESIGN (lesson from Migration 052's CI incident on 051's
-- CREATE TRIGGER): plain CREATE POLICY is not idempotent and errors with
-- "already exists" (SQLSTATE 42710) if supabase db push re-runs this file
-- against a database that already has these policies. DROP POLICY IF EXISTS
-- before each CREATE POLICY makes this safely re-runnable without a manual
-- `supabase migration repair` step.
--
-- Spec, preflight results, rollback, and device verification: the vault's
-- projects/OracleSalesApp-Mobile/Migration-048-Report.md
--
-- Fixes B-080: public.client_cycles had no non-admin SELECT RLS policy, so
-- normal Sales, RSR, and Manager users could not read the cycle rows
-- required by Batch 3's sync-down mirror and agenda-policy pinning -
-- client_cycles_snapshot silently stayed empty for every non-admin caller.
-- Device-verified 2026-07-29: a sales_specialist session correctly synced
-- its own 11 owned cycle rows; a sales_manager session correctly read 15
-- rows spanning its team.
-- ============================================================================

drop policy if exists "Agents read own client cycles" on public.client_cycles;
create policy "Agents read own client cycles"
on public.client_cycles
for select
to authenticated
using (
  owner_id = public.current_profile_id()
);

drop policy if exists "Managers read team client cycles" on public.client_cycles;
create policy "Managers read team client cycles"
on public.client_cycles
for select
to authenticated
using (
  public.is_manager_of_profile(owner_id)
);
