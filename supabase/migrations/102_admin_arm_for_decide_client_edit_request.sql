-- ============================================================================
-- 102 - decide_client_edit_request(): admin/superadmin eligibility arm
--
-- Found while investigating a separate Approvals-page report (2026-08-16), NOT
-- the reported symptom itself: approving a client-edit request from the WEB
-- Approvals page marked it "Approved" but never applied the change to the
-- client record. Unreported so far because web had few real requests to
-- approve; it would have bitten the first admin who tried.
--
-- Root cause was on the web side: lib/hooks/use-edit-requests.ts::review()
-- issued a direct UPDATE on client_edit_requests instead of calling this RPC.
-- That flipped `status`/`reviewed_by`/`reviewed_at` and nothing else — the
-- apply-loop at the bottom of this function is the ONLY thing that writes the
-- approved values onto public.clients, and there is no trigger on
-- client_edit_requests that would do it instead (verified across 001-101).
-- Web got away with the direct write because 009's "Admin full access on edit
-- requests" is FOR ALL, so RLS permitted the UPDATE that 055 deliberately
-- denies managers. It also skipped every base_conflict guard below.
--
-- Web is being switched to call this RPC (same commit). That alone would fail
-- closed, because the eligibility check inlined from 055's P3 predicate is
-- is_manager_of_profile(), which is strictly a sales_manager team-scope test
-- (029): caller role = 'sales_manager', caller.team_id not null, target shares
-- it. An admin or superadmin — the only two roles that use the web app at all
-- — fails that test and would get 'role_not_eligible' on every request.
--
-- THE FIX: widen the eligibility check to "team-scoped manager OR org-wide
-- admin/superadmin". Everything else in 080's body is reproduced verbatim:
-- the targeted per-field base_conflict check, the reassignment/lost guards,
-- the server-side allowlist, and the `-> v_key ->> 'new'` extraction.
--
-- WHY current_user_role() (011) and not is_admin(): is_admin() exists live but
-- 022's header records it as un-captured, un-owned, and orphaned-then-adopted
-- code whose body this repo has never transcribed. current_user_role() is
-- defined in this repo's own history, is SECURITY DEFINER + STABLE, and is
-- already the helper 011 uses for exactly this admin/superadmin pair.
--
-- NOT widened: 055's P1/P2/P3 RLS policies are untouched. Managers still have
-- no direct UPDATE path, and this stays the only way a decision is recorded.
-- Admins keep their FOR ALL policy, but web no longer uses it to write.
-- ============================================================================

create or replace function public.decide_client_edit_request(
  p_request_id uuid, p_decision text, p_note text default null
) returns text
language plpgsql
security definer
volatile
set search_path = public
as $$
declare
  req public.client_edit_requests%rowtype;
  clt public.clients%rowtype;
  v_allowed_keys text[] := array[
    'company_name', 'contact_person', 'contact_position', 'contact_number',
    'office_address', 'sales_channel', 'customer_type'
  ];
  v_key text;
  v_set_parts text[] := '{}';
  v_current text;
  v_expected_old text;
begin
  select * into req from public.client_edit_requests where id = p_request_id for update;
  if not found then
    return 'not_found';
  end if;

  if p_decision not in ('approved', 'rejected') then
    return 'invalid_decision';
  end if;

  -- Internal check, not solely relying on RLS (this function is SECURITY
  -- DEFINER). Two eligible callers:
  --   1. the requester's team-scoped sales_manager -- 055's P3 predicate /
  --      lib/policies/approval-policy.ts::canApproveEdit(), including
  --      both-null team_id rejection (baked into is_manager_of_profile).
  --   2. an admin or superadmin, who review org-wide from the web Approvals
  --      page and belong to no team. This arm is migration 102's addition.
  if not (
    public.is_manager_of_profile(req.requested_by)
    or public.current_user_role() in ('admin', 'superadmin')
  ) then
    return 'role_not_eligible';
  end if;

  if req.status <> 'pending' then
    return 'already_decided';
  end if;

  select * into clt from public.clients where id = req.client_id;

  -- Reassignment / lost-client conflict -- unchanged, still real signals.
  -- Admins are NOT exempt: these guard correctness, not authority.
  if clt.assigned_agent_id is distinct from req.base_assigned_agent_id
     or clt.status = 'lost' then
    return 'base_conflict';
  end if;

  -- Targeted per-field conflict check (080's fix): only the fields actually
  -- present in req.changes matter. '' / null both normalize to null before
  -- comparing, matching the client-side rule.
  foreach v_key in array v_allowed_keys loop
    if req.changes ? v_key then
      v_current := nullif(to_jsonb(clt) ->> v_key, '');
      v_expected_old := nullif(req.changes -> v_key ->> 'old', '');
      if v_current is distinct from v_expected_old then
        return 'base_conflict';
      end if;
    end if;
  end loop;

  if p_decision = 'rejected' then
    update public.client_edit_requests
       set status = 'rejected',
           reviewed_by = public.current_profile_id(),
           reviewed_at = now(),
           review_note = p_note
     where id = p_request_id;

    return 'rejected';
  end if;

  -- Approved: apply only the server-side allowlisted fields present in the
  -- changes payload. minor_notes (approval-exempt, ADR-052 section C) must
  -- never be settable via this RPC even if present in the jsonb -- it is
  -- deliberately excluded from v_allowed_keys. Unknown/disallowed keys are
  -- silently ignored, never an error.
  --
  -- `req.changes` entries are `{old: ..., new: ...}` objects, so the `new` key
  -- must be extracted specifically (080's second fix).
  foreach v_key in array v_allowed_keys loop
    if req.changes ? v_key then
      v_set_parts := v_set_parts || format('%I = %L', v_key, req.changes -> v_key ->> 'new');
    end if;
  end loop;

  if array_length(v_set_parts, 1) > 0 then
    execute format(
      'update public.clients set %s where id = %L',
      array_to_string(v_set_parts, ', '), req.client_id
    );
  end if;

  update public.client_edit_requests
     set status = 'approved',
         reviewed_by = public.current_profile_id(),
         reviewed_at = now(),
         review_note = p_note
   where id = p_request_id;

  return 'approved';
end;
$$;
revoke execute on function public.decide_client_edit_request(uuid, text, text) from public, anon;
grant execute on function public.decide_client_edit_request(uuid, text, text) to authenticated;
