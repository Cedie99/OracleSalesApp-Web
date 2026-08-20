-- ============================================================================
-- 112 — declare_client_lost(): admin/superadmin eligibility arm
--
-- Same defect as 102, in a different place, found the same way. 102's header
-- describes web's Approvals page issuing a direct UPDATE instead of calling the
-- RPC, so the request flipped its own status columns and none of the server-side
-- work happened. app/(admin)/clients/page.tsx does exactly that for the loss
-- transition:
--
--   const lostFields = isLost ? { lost_at, reassignable_at } : ...
--   .from('clients').update({ ...columns, ...lostFields }).eq('id', ...)
--
-- That writes the client columns and never touches client_cycles, which is half
-- a loss — see 111's header for the full trace, and for why the result is worse
-- than invisible: 037's diagnosis falls through to `already_claimed`, so every
-- agent who tries to claim such a client is told "Another agent already claimed
-- this client." Unlike the cron (111), this path is reachable TODAY: any admin
-- who sets a client's status to Lost from the web produces that state.
--
-- 088 already has the correct transition and web should simply call it. That
-- alone would fail closed, exactly as 102 describes: 088's eligibility check is
--
--   if caller_id is null or owner_id <> caller_id then role_not_eligible
--
-- i.e. the OWNING AGENT ONLY. Admin and superadmin — the only two roles that use
-- the web app at all — fail it on every client they do not personally own, which
-- is all of them.
--
-- THE FIX: widen to "owning agent OR org-wide admin/superadmin". Everything else
-- in 088's body is reproduced verbatim — the reason guard, the already_lost and
-- two pending-request guards, the delegation to 082's apply_lost_opportunity(),
-- and the audit insert.
--
-- WHY current_user_role() (011) and not is_admin(): 102's reasoning applies
-- unchanged. is_admin() exists live but 022 records it as un-captured, un-owned
-- code whose body this repo has never transcribed; current_user_role() is
-- defined in this repo's own history, is SECURITY DEFINER + STABLE, and is
-- already the helper 011 uses for exactly this admin/superadmin pair.
--
-- NOT WIDENED, deliberately: the owner carve-out stays as narrow as 088 made it.
-- A sales_manager still cannot declare a teammate's client lost — 088's header
-- explains that is_manager_of_profile() tests TEAM membership and would hand a
-- manager declare-lost authority over every client on their team, which is a
-- different operation from the one this function performs.
--
-- AUDIT ATTRIBUTION. 088 wrote caller_id into all three of previous_owner_id,
-- new_owner_id and actor_id, which was correct while the caller was necessarily
-- the owner. With an admin arm those come apart, so the owner columns now carry
-- the actual owner and actor_id carries whoever pressed the button. For the
-- agent path the two are the same profile and the row is byte-identical to what
-- 088 wrote. assigned_agent_id is NOT NULL (001), so owner_id cannot be null
-- against those NOT NULL columns.
-- ============================================================================

create or replace function public.declare_client_lost(
  p_client_id uuid,
  p_reason text
) returns jsonb
language plpgsql security definer volatile set search_path = public as $$
declare
  caller_id     uuid := public.current_profile_id();
  caller_role   text;
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

  -- Eligible caller: the owning agent (any role — this already covers a
  -- sales_manager who is themselves assigned_agent_id, without is_manager_of_profile()),
  -- or an admin/superadmin acting org-wide from the web dashboard.
  caller_role := public.current_user_role();
  if caller_id is null
     or (owner_id is distinct from caller_id
         and coalesce(caller_role, '') not in ('admin', 'superadmin')) then
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
    values (p_client_id, closed_cycle, owner_id, owner_id, caller_id, 'lost_declaration', p_reason);

  return jsonb_build_object('ok', true, 'code', 'declared', 'client', to_jsonb(updated_row));
end; $$;

-- Unchanged from 088; restated so the grant travels with the body.
revoke execute on function public.declare_client_lost(uuid, text) from public, anon;
grant execute on function public.declare_client_lost(uuid, text) to authenticated;

-- ============================================================================
-- VERIFICATION
--   -- As an admin who does NOT own the client, expect {"ok": true, "code": "declared"}:
--   select public.declare_client_lost('<client_id>', 'Closed down');
--
--   -- The transition must be complete, not half-written — this is the whole
--   -- point of routing web through the RPC:
--   select c.status, c.inactive_reason, c.current_cycle_id, c.cycle_started_at,
--          cc.ended_at, cc.end_reason, cc.reassignable_at
--     from public.clients c
--     join public.client_cycles cc on cc.client_id = c.id
--    where c.id = '<client_id>';
--   -- expect status='lost', current_cycle_id/cycle_started_at null,
--   --        ended_at set, end_reason='lost'
--
--   -- Audit row attributes the client to its owner and the act to the admin:
--   select previous_owner_id, new_owner_id, actor_id, kind, reason
--     from public.client_reassignment_events
--    where client_id = '<client_id>' and kind = 'lost_declaration';
--
--   -- A sales_manager who does not own the client must still be refused:
--   select public.declare_client_lost('<teammates_client_id>', 'test');
--   -- expect {"ok": false, "code": "role_not_eligible"}
--
-- ROLLBACK
--   -- Restore 088's owner-only body. Web must be reverted to its direct UPDATE
--   -- in the same change, or admins lose the ability to mark a client lost.
--   -- (That direct UPDATE is the defect this migration exists to remove, so a
--   --  rollback reinstates it — prefer fixing forward.)
-- ============================================================================
