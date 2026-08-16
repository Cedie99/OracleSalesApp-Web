-- ============================================================================
-- 103 - decide_po_confirmation(): admin/superadmin eligibility arm
--
-- Decision (Adrian, 2026-08-16): a PO confirmation is approved the same way a
-- client-edit request is — managers approve it, and admins can approve it too.
-- Admin is the fallback path for when the manager cannot act or something is
-- wrong on their side, not a separate kind of decision.
--
-- Until now this RPC gated on is_manager_of_profile() alone (039), which is
-- strictly a sales_manager team-scope test (029): caller role='sales_manager',
-- caller.team_id not null, target shares it. An admin or superadmin — the only
-- two roles that use the web app — fails it and got 'role_not_eligible'.
--
-- This mirrors migration 102, which added the identical arm to
-- decide_client_edit_request() for the identical reason. Same helper
-- (current_user_role(), migration 011) and the same rationale for choosing it
-- over is_admin(): 011's helper is defined in this repo's own history, is
-- SECURITY DEFINER + STABLE, and is already the one 011 uses for exactly this
-- admin/superadmin pair. See 102's header, and 022's note on why is_admin() is
-- not something to build on.
--
-- Everything else in 039's function body is reproduced verbatim, including the
-- CAS discipline: the UPDATE carries `and status = 'pending'`, so two
-- reviewers racing (a manager on mobile and an admin on web, which is now a
-- real possibility rather than a theoretical one) resolve to first-writer-wins
-- with the loser getting 'already_decided'.
--
-- NOT changed: 039's RLS policies. There is still no direct UPDATE path for
-- anyone, so this RPC remains the only way a PO decision is recorded. Note
-- that admins still cannot SELECT this table — 039's read policy covers only
-- the requester and their manager — so the web Approvals page reads it through
-- a service-role Server Function (lib/po-confirmation/actions.ts). Deciding
-- and reading are separately gated here, which is why only one of them needed
-- a migration.
-- ============================================================================

create or replace function public.decide_po_confirmation(
  p_request_id uuid, p_decision text, p_note text default null
) returns jsonb
language plpgsql security definer volatile set search_path = public as $$
declare
  req public.po_confirmation_requests%rowtype;
begin
  if p_decision not in ('approved','rejected') then
    return jsonb_build_object('ok', false, 'code', 'invalid_decision');
  end if;

  select * into req from public.po_confirmation_requests where id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  -- Two eligible callers (the admin arm is migration 103's addition):
  --   1. the requester's team-scoped sales_manager, per 039/029;
  --   2. an admin or superadmin, reviewing org-wide from the web Approvals
  --      page as the fallback when the manager cannot act.
  if not (
    public.is_manager_of_profile(req.requester_id)
    or public.current_user_role() in ('admin', 'superadmin')
  ) then
    return jsonb_build_object('ok', false, 'code', 'role_not_eligible');
  end if;

  update public.po_confirmation_requests
     set status = p_decision, decided_by = public.current_profile_id(),
         decided_at = now(), decision_note = p_note, updated_at = now()
   where id = p_request_id and status = 'pending';

  if not found then
    return jsonb_build_object('ok', false, 'code', 'already_decided');
  end if;

  return jsonb_build_object('ok', true, 'code', p_decision);
end; $$;
revoke execute on function public.decide_po_confirmation(uuid, text, text) from public, anon;
grant execute on function public.decide_po_confirmation(uuid, text, text) to authenticated;
