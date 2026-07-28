-- ============================================================================
-- 033 - claim_lost_opportunity RPC (guarded stub)
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
-- projects/OracleSalesApp-Mobile/Migration-033-Report.md
--
-- Replaced by migration 037, which CREATE OR REPLACEs it with the atomic
-- version. Same signature.
-- ============================================================================

-- Migration 033: guarded stub for the eventual atomic claim RPC.
-- Batch 2 ships every rejection path for real; the success path is a
-- deliberate dead end until Batch 3 replaces it with the compare-and-swap
-- claim + 'already_claimed' code.
create or replace function public.claim_lost_opportunity(p_client_id uuid)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public
as $$
declare
  caller_id uuid := public.current_profile_id();
  caller_role text;
  target record;
begin
  select role into caller_role from public.profiles where id = caller_id;

  if caller_role is null or caller_role not in ('sales_specialist', 'rsr') then
    return jsonb_build_object('ok', false, 'code', 'role_not_eligible');
  end if;

  select id, status, reassignable_at, assigned_agent_id
    into target
    from public.clients
    where id = p_client_id;

  if target.id is null or target.status <> 'lost' or target.reassignable_at > now() then
    return jsonb_build_object('ok', false, 'code', 'not_claimable');
  end if;

  if target.assigned_agent_id = caller_id then
    return jsonb_build_object('ok', false, 'code', 'former_owner_excluded');
  end if;

  -- All authorization checks passed. Batch 2 intentionally stops here —
  -- Batch 3 replaces this branch with the atomic compare-and-swap claim.
  return jsonb_build_object('ok', false, 'code', 'feature_disabled');
end;
$$;

revoke execute on function public.claim_lost_opportunity(uuid) from public, anon;
grant execute on function public.claim_lost_opportunity(uuid) to authenticated;
