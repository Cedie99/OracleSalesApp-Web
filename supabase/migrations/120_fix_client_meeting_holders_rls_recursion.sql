-- ============================================================================
-- 120 — fix infinite recursion in client_meeting_holders RLS (ADR-067)
--
-- Migration 118's "Holders read their client's holder set" policy on
-- public.client_meeting_holders self-references the SAME table inside its
-- own USING clause's EXISTS subquery:
--
--   for select using (
--     manager_id = current_profile_id()
--     or exists (select 1 from client_meeting_holders self_row where ...)
--   )
--
-- Evaluating that policy for the subquery's own rows re-triggers RLS on
-- client_meeting_holders again, which re-evaluates the same subquery,
-- forever — Postgres surfaces this as:
--   "infinite recursion detected in policy for relation client_meeting_holders"
-- Reproduced live on staging 2026-08-22 via [use-sync] sync failures on
-- device (Vince).
--
-- Fix: same pattern as migration 029's current_profile_id()/is_manager_of_profile()
-- — move the self-referencing check into a SECURITY DEFINER function. A
-- SECURITY DEFINER function executes as its owner (the migration-applying
-- role, which bypasses RLS), so the SELECT inside it does not re-trigger the
-- calling policy. Replaces the policy to call this function instead of
-- querying client_meeting_holders directly from within its own policy.
-- ============================================================================

create or replace function public.is_client_meeting_holder(p_client_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.client_meeting_holders
    where client_id = p_client_id
      and manager_id = public.current_profile_id()
  );
$$;

drop policy if exists "Holders read their client's holder set" on public.client_meeting_holders;
create policy "Holders read their client's holder set" on public.client_meeting_holders
  for select using (
    manager_id = public.current_profile_id()
    or public.is_client_meeting_holder(client_id)
  );

-- ----------------------------------------------------------------------------
-- Also route 118's three other holder-visibility policies through the same
-- SECURITY DEFINER helper instead of an inline EXISTS on
-- client_meeting_holders. Not strictly required for THEIR recursion (they
-- protect a different table each: clients/meetings/client_edit_requests),
-- but an inline EXISTS still re-evaluates client_meeting_holders' own SELECT
-- policy on every check — routing through the already-RLS-bypassing helper
-- is simpler and one less place to get this pattern wrong in the future.
-- ----------------------------------------------------------------------------

drop policy if exists "Client record holders read held clients" on public.clients;
create policy "Client record holders read held clients" on public.clients
  for select using (public.is_client_meeting_holder(id));

drop policy if exists "Client record holders read held client meetings" on public.meetings;
create policy "Client record holders read held client meetings" on public.meetings
  for select using (public.is_client_meeting_holder(client_id));

drop policy if exists "Client record holders read held clients edit requests" on public.client_edit_requests;
create policy "Client record holders read held clients edit requests" on public.client_edit_requests
  for select using (public.is_client_meeting_holder(client_id));

-- ============================================================================
-- ROLLBACK
--   drop policy if exists "Client record holders read held clients edit requests" on public.client_edit_requests;
--   drop policy if exists "Client record holders read held client meetings" on public.meetings;
--   drop policy if exists "Client record holders read held clients" on public.clients;
--   -- restore migration 118's original (recursion-bugged) inline-EXISTS
--   -- versions of the three policies above from that file if ever needed.
--   drop policy if exists "Holders read their client's holder set" on public.client_meeting_holders;
--   create policy "Holders read their client's holder set" on public.client_meeting_holders
--     for select using (manager_id = public.current_profile_id());
--     -- (loses joint-holder visibility of each other's rows; only a stopgap)
--   drop function if exists public.is_client_meeting_holder(uuid);
-- ============================================================================
