-- ============================================================================
-- 030 - Scoped SELECT policies + get_company_directory() RPC
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
-- projects/OracleSalesApp-Mobile/Migration-030-Report.md
--
-- Purely additive and inert on its own - permissive RLS policies OR
-- together, so these do nothing until 031 drops the broad ones.
-- ============================================================================

-- Migration 030: scoped SELECT policies (additive; broad policies still active).

-- clients
create policy "Agents read own clients" on public.clients
  for select using (assigned_agent_id = public.current_profile_id());

create policy "Managers read team clients" on public.clients
  for select using (public.is_manager_of_profile(assigned_agent_id));

create policy "Executives read all clients" on public.clients
  for select using (public.is_executive());

-- Tag-along participants (requester or invitee) need to read the related
-- client for the request-detail screen, regardless of team.
create policy "Tag-along participants read related client" on public.clients
  for select using (
    exists (
      select 1 from public.tag_along_requests t
      where t.related_client_id = clients.id
        and (t.requester_id = public.current_profile_id()
             or t.invitee_id = public.current_profile_id())
    )
  );

-- meetings ("Agents read own meetings" already exists and is unchanged)
create policy "Managers read team meetings" on public.meetings
  for select using (public.is_manager_of_profile(agent_id));

create policy "Executives read all meetings" on public.meetings
  for select using (public.is_executive());

-- profiles: row-scoped to self + own team roster (accepted residual: no
-- column-level REVOKE, so teammates can see each other's email/is_active —
-- Vince accepted this rather than risk PostgREST compatibility issues).
create policy "Team members read teammate profiles" on public.profiles
  for select using (
    team_id is not null and team_id = public.current_team_id()
  );

create policy "Executives read all profiles" on public.profiles
  for select using (public.is_executive());

-- New RPC: replaces the cross-agent clients reads in lib/sync-down.ts and
-- lib/client-duplicate-check.ts, which currently depend on the broad
-- "Authenticated read clients" policy Migration 031 removes. Exposes only
-- company-identity columns — strictly less than today's full-row access.
create or replace function public.get_company_directory()
returns table (id uuid, company_name text, normalized_company_name text, city text)
language sql
security definer
stable
set search_path = public
as $$
  select id, company_name, normalized_company_name, city
  from public.clients
  where status <> 'deleted';
$$;

revoke all on function public.get_company_directory() from public;
grant execute on function public.get_company_directory() to authenticated;
