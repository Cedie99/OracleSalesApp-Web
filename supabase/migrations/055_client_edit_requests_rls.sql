-- ============================================================================
-- 055 - client_edit_requests RLS policies (Batch 6, File C)
--
-- Mirrors 039_po_confirmation_requests.sql's style: requester-scoped INSERT,
-- requester-scoped SELECT, manager team-scoped SELECT via the existing
-- public.is_manager_of_profile(target_profile_id) SECURITY DEFINER helper
-- (029_rls_helper_functions.sql) -- NOT a new helper. is_manager_of_profile
-- already encodes canApproveEdit()'s exact rule (lib/policies/approval-policy.ts,
-- mobile repo): caller role = sales_manager, caller.team_id IS NOT NULL, and
-- the target profile's team_id matches -- both-null team_id is rejected.
--
-- "Not lost" is represented by clients.status <> 'lost' (001_initial.sql
-- CHECK (status IN ('active','lost','deleted'))), NOT customer_type --
-- customer_type is an unrelated field (existing/new/prospect) and is itself
-- one of the 7 approval-required CLIENT_EDITABLE_FIELDS (ADR-052 section C).
--
-- public.client_edit_requests already has RLS enabled (001_initial.sql) and
-- an untouched "Admin full access on edit requests" FOR ALL policy -- P4,
-- intentionally not dropped/recreated here.
--
-- Per ADR-052 section E / 039's established discipline, decisions are meant
-- to go through decide_client_edit_request() (SECURITY DEFINER, migration
-- 056) rather than direct SQL. NOTE: ADR-052 section A nonetheless calls for
-- an explicit manager UPDATE policy (P3) here "on UPDATE: ... via
-- decide_client_edit_request() RPC only, not direct SQL" -- that RPC-only
-- constraint is UI/application-level discipline, not enforced by this
-- policy; a manager with this UPDATE grant could bypass the RPC's CAS/
-- base_conflict logic via direct SQL. Implemented as literally specified;
-- flagged for human review (see Batch 6 migration report).
-- ============================================================================

-- P1 — Requester (sales_specialist/rsr/sales_manager) creates own request
-- for a client currently assigned to them, not lost.
drop policy if exists "Requester creates own client edit request" on public.client_edit_requests;
create policy "Requester creates own client edit request" on public.client_edit_requests
  for insert with check (
    requested_by = public.current_profile_id()
    and status = 'pending'
    and base_updated_at is not null
    and exists (
      select 1 from public.clients c
      where c.id = client_id
        and c.assigned_agent_id = requested_by
        and c.status <> 'lost'
    )
  );

-- P2 — Requester reads their own requests.
drop policy if exists "Requester reads own client edit requests" on public.client_edit_requests;
create policy "Requester reads own client edit requests" on public.client_edit_requests
  for select using (requested_by = public.current_profile_id());

-- P3 — Team-scoped manager reads and updates their team's requests.
drop policy if exists "Manager reads team client edit requests" on public.client_edit_requests;
create policy "Manager reads team client edit requests" on public.client_edit_requests
  for select using (public.is_manager_of_profile(requested_by));

drop policy if exists "Manager updates team client edit requests" on public.client_edit_requests;
create policy "Manager updates team client edit requests" on public.client_edit_requests
  for update using (public.is_manager_of_profile(requested_by));

-- P4 — "Admin full access on edit requests" (001_initial.sql) intentionally
-- left untouched: no DROP/CREATE for it in this file.
