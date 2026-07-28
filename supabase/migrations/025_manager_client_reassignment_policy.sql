-- ============================================================================
-- 025 - Managers reassign clients within their own team (RLS policy only)
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-23, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version is created with `supabase migration repair --status applied`,
-- so `supabase db push` skips it. If a push ever tries to EXECUTE this file,
-- stop and fix the repair rather than letting it run.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-025-Report.md
--
-- Renumbered from 022 by the vault on 2026-07-25: web had already claimed
-- 022 for a different migration (022_capture_adhoc_rls_and_storage.sql).
-- ============================================================================

-- Migration 025 (formerly numbered 022): managers reassign clients within their own team.
-- Both directions team-scoped: USING evaluates the OLD row (current owner
-- must be on the manager's team); WITH CHECK evaluates the NEW row (new
-- owner must also be on the manager's team) — no cross-team reassignment.
-- Ownership identity re-derived via profiles (user_id = auth.uid()),
-- never auth.uid() compared to assigned_agent_id directly (B-015 lesson).
create policy "Managers reassign team clients" on public.clients
  for update
  using (
    exists (
      select 1
      from public.profiles mgr
      join public.profiles agent on agent.id = clients.assigned_agent_id
      where mgr.user_id = auth.uid()
        and mgr.role = 'sales_manager'
        and mgr.team_id is not null
        and agent.team_id = mgr.team_id
    )
  )
  with check (
    exists (
      select 1
      from public.profiles mgr
      join public.profiles agent on agent.id = clients.assigned_agent_id
      where mgr.user_id = auth.uid()
        and mgr.role = 'sales_manager'
        and mgr.team_id is not null
        and agent.team_id = mgr.team_id
    )
  );
