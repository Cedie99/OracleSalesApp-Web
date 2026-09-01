-- ============================================================================
-- 128 - decide_client_edit_request(): stop the lifecycle from invalidating
-- its own pending requests, and let Reject through unconditionally.
--
-- Bug (Adrian report, 2026-09-01, two live cases):
--
--   Case 1 -- a 'prospect -> existing' request filed Aug 13, still pending
--   19 days later. Neither Approve NOR Reject worked; both returned
--   'base_conflict'.
--
--   Case 2 -- a close-deal PO filed Aug 29 2:04 PM, and a
--   'prospect -> existing' edit request filed by the same agent at 2:05 PM.
--   The manager approved the PO on Sep 1, trg_promote_on_po_confirmed (110)
--   ran advance_prospect_to_new(), and the sibling request died.
--
-- TWO separate defects, one shared root cause.
--
-- Defect 1 -- the conflict check gates rejection.
--   Every guard sat ABOVE the `if p_decision = 'rejected'` branch, so a
--   conflicted request could not be approved OR rejected. It was stuck in
--   the queue permanently with no button that could clear it. A rejection
--   writes nothing to public.clients, so it has nothing to conflict with:
--   all guards now sit below that branch. Reject always works.
--
-- Defect 2 -- customer_type conflicts with itself.
--   customer_type is the only key in v_allowed_keys that the SERVER also
--   writes: advance_prospect_to_in_progress() and advance_prospect_to_new()
--   (110), advance_in_progress_to_new() (040/063). They fire on ordinary
--   agent work -- a successful meeting, an approved PO -- and know nothing
--   about a pending request. So the per-field check added by 080 (current
--   value vs the payload's captured `old`) is guaranteed to fail on this one
--   field the moment the agent does their job. The longer a request waits,
--   the likelier it is dead. 080 fixed the whole-row version of this; the
--   targeted version still self-conflicts here, because the conflict is real
--   rather than an artifact of comparing too much.
--
--   Decision (Adrian, 2026-09-01): 'existing' does not mean "further along
--   the prospect funnel" -- it means "this client was never a funnel client
--   at all". A meeting or a PO does not make that claim false; it means the
--   auto-promotion got there first. So an agent's existing-override still
--   applies over prospect AND in_progress.
--
--   'new' is deliberately NOT included. Reaching 'new' means a close-deal PO
--   was confirmed with photo evidence and approved by a manager -- a decided,
--   evidenced outcome that a stale request must not silently overwrite. It
--   still returns plain 'base_conflict' (mobile throws on unrecognized codes
--   -- see the note at that branch); the SPECIFIC reason is served by the new
--   explain_client_edit_conflict() at the bottom of this file, so the admin
--   is told to reject rather than to chase the agent for a resubmission.
--
-- Every other field keeps 080's strict equality. This migration reproduces
-- 118's body verbatim apart from the two changes above.
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
  v_requested_new text;
begin
  select * into req from public.client_edit_requests where id = p_request_id for update;
  if not found then
    return 'not_found';
  end if;

  if p_decision not in ('approved', 'rejected') then
    return 'invalid_decision';
  end if;

  -- Eligibility (118): requester's team-scoped sales_manager, an admin or
  -- superadmin (102), or any current holder of the client (ADR-067).
  if not (
    public.is_manager_of_profile(req.requested_by)
    or public.current_user_role() in ('admin', 'superadmin')
    or exists (
      select 1 from public.client_meeting_holders h
      where h.client_id = req.client_id
        and h.manager_id = public.current_profile_id()
    )
  ) then
    return 'role_not_eligible';
  end if;

  if req.status <> 'pending' then
    return 'already_decided';
  end if;

  -- ---------------------------------------------------------------------
  -- Defect 1: rejection is decided here, BEFORE any conflict guard. A
  -- reject touches only client_edit_requests, never public.clients, so no
  -- guard below is protecting anything it could damage. Gating this was
  -- what made a conflicted request unclearable.
  -- ---------------------------------------------------------------------
  if p_decision = 'rejected' then
    update public.client_edit_requests
       set status = 'rejected',
           reviewed_by = public.current_profile_id(),
           reviewed_at = now(),
           review_note = p_note
     where id = p_request_id;

    return 'rejected';
  end if;

  select * into clt from public.clients where id = req.client_id;

  -- Reassignment / lost-client conflict -- unchanged, still real signals.
  -- Holders are NOT exempt: these guard correctness, not authority.
  if clt.assigned_agent_id is distinct from req.base_assigned_agent_id
     or clt.status = 'lost' then
    return 'base_conflict';
  end if;

  -- Per-field conflict check (080), with customer_type carved out per
  -- Defect 2 above.
  foreach v_key in array v_allowed_keys loop
    if req.changes ? v_key then
      v_current := nullif(to_jsonb(clt) ->> v_key, '');
      v_expected_old := nullif(req.changes -> v_key ->> 'old', '');

      if v_key = 'customer_type' then
        v_requested_new := nullif(req.changes -> 'customer_type' ->> 'new', '');

        -- An existing-override outranks an automatic promotion out of the
        -- prospect funnel, whatever `old` was captured as. NULL is included
        -- because 013 dropped the NOT NULL and 040 treats a null stage as
        -- prospect for promotion purposes.
        if v_requested_new = 'existing'
           and (v_current is null or v_current in ('prospect', 'in_progress')) then
          null;  -- allowed; fall through to apply

        -- Evidenced, manager-decided outcome: never silently overwritten.
        -- Returns the EXISTING 'base_conflict' code rather than a new one:
        -- mobile's lib/client-edit-decision-service.ts validates the response
        -- against a hardcoded KNOWN_DECISION_CODES list and THROWS
        -- UnknownClientEditDecisionCodeError on anything else, so any new code
        -- would crash a manager's approvals screen the moment CI applied this
        -- migration -- before mobile could ship a matching build. The specific
        -- reason is served separately by explain_client_edit_conflict() below,
        -- which is purely additive and breaks no existing caller.
        elsif v_requested_new = 'existing' and v_current = 'new' then
          return 'base_conflict';

        -- Any other customer_type movement keeps strict equality.
        elsif v_current is distinct from v_expected_old then
          return 'base_conflict';
        end if;

      elsif v_current is distinct from v_expected_old then
        return 'base_conflict';
      end if;
    end if;
  end loop;

  -- Approved: apply only the server-side allowlisted fields present in the
  -- changes payload. minor_notes (approval-exempt, ADR-052 section C) must
  -- never be settable via this RPC even if present in the jsonb -- it is
  -- deliberately excluded from v_allowed_keys. Unknown/disallowed keys are
  -- silently ignored, never an error.
  --
  -- `req.changes` entries are `{old: ..., new: ...}` objects, so the `new`
  -- key must be extracted specifically.
  --
  -- in_progress_at is deliberately left as-is when customer_type moves to
  -- 'existing'. Every function that reads it (063's postdating check,
  -- 040/110's advance edges) requires customer_type = 'in_progress' to match
  -- at all, so a stale value is inert -- and meetings freeze their own
  -- client_status_at_meeting, so cutoff attribution (059/071/072) is not
  -- rewritten retroactively either.
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

-- ============================================================================
-- explain_client_edit_conflict() -- why a 'base_conflict' happened.
--
-- decide_client_edit_request() returns a bare text code, and it must keep
-- doing so: mobile validates the response against a hardcoded code list and
-- throws on anything unrecognized (lib/client-edit-decision-service.ts), so
-- widening the return type or the code set is a cross-repo break that would
-- land the moment CI applied this file. This function is the additive way to
-- get the detail: read-only, called by web ONLY after a 'base_conflict', and
-- invisible to every existing caller.
--
-- Reasons, in the same order decide_client_edit_request() checks them so the
-- explanation always matches the guard that actually fired:
--   reassigned         -- client now belongs to another agent
--   lost               -- client was marked lost
--   stage_already_new  -- an approved close-deal PO already promoted them
--   field_changed      -- some other field no longer matches the captured old
--   none               -- nothing conflicts now (decided in between; retry)
-- ============================================================================

create or replace function public.explain_client_edit_conflict(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
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
  v_current text;
  v_expected_old text;
  v_requested_new text;
  v_agent_name text;
  v_po_decided_at timestamptz;
begin
  select * into req from public.client_edit_requests where id = p_request_id;
  if not found then
    return jsonb_build_object('reason', 'not_found');
  end if;

  -- Same eligibility gate as the decision RPC. This is SECURITY DEFINER and
  -- reads client + profile rows, so it must not answer for someone who is
  -- not entitled to review the request in the first place.
  if not (
    public.is_manager_of_profile(req.requested_by)
    or public.current_user_role() in ('admin', 'superadmin')
    or exists (
      select 1 from public.client_meeting_holders h
      where h.client_id = req.client_id
        and h.manager_id = public.current_profile_id()
    )
  ) then
    return jsonb_build_object('reason', 'role_not_eligible');
  end if;

  select * into clt from public.clients where id = req.client_id;

  if clt.assigned_agent_id is distinct from req.base_assigned_agent_id then
    select full_name into v_agent_name
      from public.profiles where id = clt.assigned_agent_id;
    return jsonb_build_object(
      'reason', 'reassigned',
      'current_agent_name', v_agent_name
    );
  end if;

  if clt.status = 'lost' then
    return jsonb_build_object('reason', 'lost');
  end if;

  foreach v_key in array v_allowed_keys loop
    if req.changes ? v_key then
      v_current := nullif(to_jsonb(clt) ->> v_key, '');
      v_expected_old := nullif(req.changes -> v_key ->> 'old', '');

      if v_key = 'customer_type' then
        v_requested_new := nullif(req.changes -> 'customer_type' ->> 'new', '');

        if v_requested_new = 'existing'
           and (v_current is null or v_current in ('prospect', 'in_progress')) then
          null;  -- allowed by 128; not a conflict

        elsif v_requested_new = 'existing' and v_current = 'new' then
          -- The PO that did it, so the message can name the date. Most recent
          -- approved one wins; null is fine (a client can also reach 'new'
          -- through 040's tag-along path, which has no PO row).
          select decided_at into v_po_decided_at
            from public.po_confirmation_requests
           where client_id = req.client_id and status = 'approved'
           order by decided_at desc nulls last
           limit 1;

          return jsonb_build_object(
            'reason', 'stage_already_new',
            'po_decided_at', v_po_decided_at
          );

        elsif v_current is distinct from v_expected_old then
          return jsonb_build_object(
            'reason', 'field_changed',
            'field', v_key,
            'expected_old', v_expected_old,
            'current_value', v_current
          );
        end if;

      elsif v_current is distinct from v_expected_old then
        return jsonb_build_object(
          'reason', 'field_changed',
          'field', v_key,
          'expected_old', v_expected_old,
          'current_value', v_current
        );
      end if;
    end if;
  end loop;

  return jsonb_build_object('reason', 'none');
end;
$$;
revoke execute on function public.explain_client_edit_conflict(uuid) from public, anon;
grant execute on function public.explain_client_edit_conflict(uuid) to authenticated;
