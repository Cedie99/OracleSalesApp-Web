-- ============================================================================
-- 080 - decide_client_edit_request(): targeted per-field conflict check +
-- fix apply-loop reading {old,new} objects as if they were scalars
--
-- Bug (Vince report, 2026-08-10): approving/rejecting a pending client-edit
-- request almost always returned 'base_conflict' ("Client record changed —
-- please review again."), even when nothing about the actually-requested
-- fields had changed. Fixing that surfaced a second, previously-masked bug
-- in the approve path itself (see near the bottom of the function body).
--
-- Root cause: 056_client_edit_requests_decision_and_feed.sql compared the
-- WHOLE-ROW clients.updated_at against client_edit_requests.base_updated_at
-- (captured client-side at request-creation time, lib/client-edit-request-
-- service.ts). clients.updated_at is bumped by the clients_updated_at
-- trigger on ANY column change -- lifecycle promotion triggers (017/040),
-- cutoff/cycle work, office-pin updates, sync-down of unrelated fields, etc.
-- -- none of which touch the specific fields a pending edit request is
-- actually about. So any request that sat pending through one of those
-- unrelated writes (which is normal -- a manager doesn't review instantly)
-- was guaranteed to false-positive.
--
-- Fix: replace the whole-row timestamp comparison with a targeted check —
-- conflict only if the CURRENT value of a field actually named in this
-- request's `changes` payload no longer matches that field's captured `old`
-- value. This mirrors the client-side blank-normalization rule in
-- lib/client-edit-request-payload.ts::normalizeForCompare() ('' / null /
-- undefined all compare equal) so an unrelated round-trip through a
-- controlled TextInput can't manufacture a false conflict either.
--
-- base_assigned_agent_id (reassignment) and clients.status = 'lost' remain
-- real conflict signals and are unchanged. client_edit_requests.
-- base_updated_at itself is left in place (still populated client-side,
-- still useful for auditing/debugging) -- it's just no longer part of the
-- decision logic.
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
  -- DEFINER). Mirrors migration 055's P3 predicate / lib/policies/
  -- approval-policy.ts::canApproveEdit() exactly, including both-null
  -- team_id rejection (baked into is_manager_of_profile itself).
  if not public.is_manager_of_profile(req.requested_by) then
    return 'role_not_eligible';
  end if;

  if req.status <> 'pending' then
    return 'already_decided';
  end if;

  select * into clt from public.clients where id = req.client_id;

  -- Reassignment / lost-client conflict -- unchanged, still real signals.
  if clt.assigned_agent_id is distinct from req.base_assigned_agent_id
     or clt.status = 'lost' then
    return 'base_conflict';
  end if;

  -- Targeted per-field conflict check (this migration's fix): only the
  -- fields actually present in req.changes matter. '' / null both
  -- normalize to null before comparing, matching the client-side rule.
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
  -- Second fix in this migration: `req.changes` entries are
  -- `{old: ..., new: ...}` objects (mobile lib/client-edit-request-payload.ts
  -- ::computeClientEditChanges(), sent through unmodified by
  -- lib/sync/remote-upsert.ts's client_edit_requests upsert), NOT bare
  -- scalar values. The original `req.changes ->> v_key` returned the JSON
  -- TEXT of the whole {old,new} object rather than the intended new value,
  -- which would have written that literal JSON string into the clients
  -- column the moment a request got past the conflict check above -- masked
  -- until now because the whole-row conflict check almost always blocked
  -- approval first. Must extract the `new` key specifically.
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
