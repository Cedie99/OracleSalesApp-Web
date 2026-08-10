-- ============================================================================
-- 088 - declare_client_lost() RPC (mobile Complete Info "Declare lost
-- opportunity" action)
--
-- Gives the owning Sales/RSR agent (or a sales_manager on a client they
-- directly own — same carve-out mobile's complete.tsx already uses for
-- edits) a direct, server-authoritative way to declare a client lost from
-- Complete Info, instead of the raw client-side status write that was
-- reverted 2026-08-09 (unsafe — see vault Sprint.md "Complete Info: Lost
-- Opportunity declaration" entry and Context.md's "remains blocked" note).
--
-- Reuses 082's apply_lost_opportunity(client_id, lost_at) for the actual
-- clients/client_cycles transition (status, lost_at, reassignable_at,
-- current_cycle_id/cycle_started_at, closing the open client_cycles row) —
-- do NOT re-derive that formula here. This RPC only adds: reason handling
-- (inactive_reason, which apply_lost_opportunity() does not set),
-- authorization, and the two pending-request guards apply_lost_opportunity()
-- has no concept of.
--
-- Reuses the existing client_reassignment_events audit table (038/050/037
-- precedent) rather than a new one — adds 'lost_declaration' to its `kind`
-- CHECK constraint.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. client_reassignment_events.kind — add 'lost_declaration'.
-- ----------------------------------------------------------------------------
alter table public.client_reassignment_events
  drop constraint if exists client_reassignment_events_kind_check;

alter table public.client_reassignment_events
  add constraint client_reassignment_events_kind_check
  check (kind in ('manager_reassignment', 'lost_claim', 'lost_declaration'));

-- ----------------------------------------------------------------------------
-- 2. declare_client_lost(p_client_id, p_reason)
-- ----------------------------------------------------------------------------
create or replace function public.declare_client_lost(
  p_client_id uuid,
  p_reason text
) returns jsonb
language plpgsql security definer volatile set search_path = public as $$
declare
  caller_id     uuid := public.current_profile_id();
  owner_id      uuid;
  closed_cycle  uuid;
  updated_row   public.clients%rowtype;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'reason_required');
  end if;

  select assigned_agent_id into owner_id
    from public.clients
   where id = p_client_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  -- Eligible caller: the owning agent only, any role (assigned_agent_id =
  -- caller). This already covers the manager-owns-own-client case (a
  -- sales_manager who is themselves assigned_agent_id on the client) without
  -- needing is_manager_of_profile() at all — that helper checks TEAM
  -- membership, not self-ownership, and would wrongly grant a manager
  -- declare-lost authority over every teammate's client, not just their own.
  -- Deliberately narrower than reassign_team_client()/050's
  -- is_manager_of_profile(outgoing_owner) check, which is for a genuinely
  -- different, team-wide operation.
  if caller_id is null or owner_id <> caller_id then
    return jsonb_build_object('ok', false, 'code', 'role_not_eligible');
  end if;

  if exists (
    select 1 from public.clients
     where id = p_client_id and status in ('lost', 'deleted')
  ) then
    return jsonb_build_object('ok', false, 'code', 'already_lost');
  end if;

  if exists (
    select 1 from public.client_edit_requests
     where client_id = p_client_id and status = 'pending'
  ) then
    return jsonb_build_object('ok', false, 'code', 'pending_edit_request');
  end if;

  if exists (
    select 1 from public.po_confirmation_requests
     where client_id = p_client_id and status = 'pending'
  ) then
    return jsonb_build_object('ok', false, 'code', 'pending_po_confirmation');
  end if;

  -- The whole clients/client_cycles transition — status, lost_at,
  -- reassignable_at, current_cycle_id/cycle_started_at, cycle close — is
  -- 082's job, not this function's. Idempotent on status = 'active', which
  -- the already_lost check above already confirmed.
  perform public.apply_lost_opportunity(p_client_id, now());

  update public.clients
     set inactive_reason = p_reason
   where id = p_client_id
  returning * into updated_row;

  select id into closed_cycle
    from public.client_cycles
   where client_id = p_client_id and end_reason = 'lost'
   order by ended_at desc
   limit 1;

  insert into public.client_reassignment_events
    (client_id, cycle_id, previous_owner_id, new_owner_id, actor_id, kind, reason)
    values (p_client_id, closed_cycle, caller_id, caller_id, caller_id, 'lost_declaration', p_reason);

  return jsonb_build_object('ok', true, 'code', 'declared', 'client', to_jsonb(updated_row));
end; $$;

revoke execute on function public.declare_client_lost(uuid, text) from public, anon;
grant execute on function public.declare_client_lost(uuid, text) to authenticated;

-- ============================================================================
-- VERIFICATION
--   -- Expect the declared client: status='lost', inactive_reason set, no
--   -- open cycle, current_cycle_id/cycle_started_at null.
--   select status, inactive_reason, current_cycle_id, cycle_started_at
--     from public.clients where id = '<client_id>';
--
--   -- Expect exactly one closed, lost, claimable cycle for that client.
--   select * from public.client_cycles
--    where client_id = '<client_id>' and end_reason = 'lost';
--
--   -- Expect one 'lost_declaration' audit row.
--   select * from public.client_reassignment_events
--    where client_id = '<client_id>' and kind = 'lost_declaration';
--
-- ROLLBACK
--   revoke execute on function public.declare_client_lost(uuid, text) from authenticated;
--   drop function if exists public.declare_client_lost(uuid, text);
--   alter table public.client_reassignment_events
--     drop constraint if exists client_reassignment_events_kind_check;
--   alter table public.client_reassignment_events
--     add constraint client_reassignment_events_kind_check
--     check (kind in ('manager_reassignment', 'lost_claim'));
-- ============================================================================
