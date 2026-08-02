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
-- Per Vince's decision (2026-08-01), superseding an earlier literal reading
-- of ADR-052 section A: there is NO manager UPDATE policy on this table,
-- matching 039_po_confirmation_requests.sql's discipline exactly (no manager
-- UPDATE policy there either -- see that file's "Decisions go through the
-- RPC below only" comment). All approve/reject decisions must go through
-- decide_client_edit_request() (SECURITY DEFINER, migration 056), which runs
-- with the function owner's privileges and bypasses RLS entirely -- it does
-- not need, and must not be given, a caller-facing UPDATE policy or GRANT.
-- Granting managers direct UPDATE would let them bypass the RPC's CAS/
-- base_conflict logic via direct SQL. Managers keep team-scoped SELECT (P3
-- below) so the Manager Approvals page can display eligible requests.
-- ============================================================================

-- P1 — Requester (sales_specialist/rsr only -- ADR-052 decision 1: a
-- sales_manager editing their own client always uses the direct-apply path
-- (updateClientInfo()) and must never create a client_edit_requests row.
-- Without this check, a sales_manager could INSERT a self-request and then
-- approve it via decide_client_edit_request(), since
-- is_manager_of_profile(own_id) trivially returns true for a manager
-- checking themselves -- that helper has no self-check exclusion. The role
-- check below closes that gap at the RLS layer instead of relying solely on
-- the app-layer branch in app/(tabs)/clients/complete.tsx. Creates own
-- request for a client currently assigned to them, not lost.
drop policy if exists "Requester creates own client edit request" on public.client_edit_requests;
create policy "Requester creates own client edit request" on public.client_edit_requests
  for insert with check (
    requested_by = public.current_profile_id()
    and status = 'pending'
    and base_updated_at is not null
    and exists (
      select 1 from public.profiles p
      where p.id = requested_by
        and p.role in ('sales_specialist', 'rsr')
    )
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

-- P3 — Team-scoped manager reads their team's requests (SELECT only; no
-- manager UPDATE policy -- decisions go through decide_client_edit_request()
-- only, see header comment above).
drop policy if exists "Manager reads team client edit requests" on public.client_edit_requests;
create policy "Manager reads team client edit requests" on public.client_edit_requests
  for select using (public.is_manager_of_profile(requested_by));

-- P4 — "Admin full access on edit requests" (001_initial.sql) intentionally
-- left untouched: no DROP/CREATE for it in this file.
