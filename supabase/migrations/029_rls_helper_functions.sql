-- ============================================================================
-- 029 - SECURITY DEFINER helper functions for the Batch 2 RLS policies
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
-- projects/OracleSalesApp-Mobile/Migration-029-Report.md
--
-- Required by 030, 031 and 032.
-- ============================================================================

-- Migration 029: SECURITY DEFINER helpers for Batch 2 RLS policies.
-- STABLE (not VOLATILE) since these only read, never write.
create or replace function public.current_profile_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from public.profiles where user_id = auth.uid();
$$;

create or replace function public.current_team_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select team_id from public.profiles where user_id = auth.uid();
$$;

-- True if the caller is a sales_manager, has a non-null team_id, and the
-- target profile shares that team_id. Encodes ADR-017/ADR-033 correctly:
-- one sales_manager role, scope = shared team_id, member roles mixed freely.
create or replace function public.is_manager_of_profile(target_profile_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles mgr
    join public.profiles target on target.id = target_profile_id
    where mgr.user_id = auth.uid()
      and mgr.role = 'sales_manager'
      and mgr.team_id is not null
      and target.team_id = mgr.team_id
  );
$$;

create or replace function public.is_executive()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role = 'executive'
  );
$$;
