-- ============================================================================
-- 032 - Lost Opportunity write guards
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
-- projects/OracleSalesApp-Mobile/Migration-032-Report.md
--
-- Reverses the manager-reassignment exemption agreed on 2026-07-21.
-- ============================================================================

-- Migration 032: add status <> 'lost' guards to two existing policies.
-- Recreates them with the added guard rather than ALTER POLICY (Postgres
-- has no ALTER POLICY ... ADD CONDITION; policies are replaced wholesale).

drop policy if exists "Managers reassign team clients" on public.clients;
create policy "Managers reassign team clients" on public.clients
  for update
  using (
    public.is_manager_of_profile(assigned_agent_id)
    and clients.status <> 'lost'
  )
  with check (
    public.is_manager_of_profile(assigned_agent_id)
    and clients.status <> 'lost'
  );

drop policy if exists "Agents update own clients" on public.clients;
create policy "Agents update own clients" on public.clients
  for update
  using (
    assigned_agent_id = public.current_profile_id()
    and clients.status <> 'lost'
  )
  with check (
    assigned_agent_id = public.current_profile_id()
  );
