-- ============================================================================
-- 056 - decide_client_edit_request() RPC + approval-feed UNION extension
-- (Batch 6, File D)
--
-- decide_client_edit_request() mirrors decide_po_confirmation()'s
-- (039_po_confirmation_requests.sql) structure: SECURITY DEFINER, VOLATILE,
-- search_path pinned to public, row locked with SELECT ... FOR UPDATE,
-- CAS-style status transition. Return type follows THIS TASK's explicit
-- spec (plain TEXT status code), not decide_po_confirmation()'s jsonb
-- {ok, code} shape -- see Batch 6 migration report for that deviation.
--
-- get_manager_approval_feed() / get_my_request_statuses() (both defined in
-- 042_manager_approval_feed_rpcs.sql) gain a third UNION ALL branch for
-- client_edit_requests, column-for-column identical to the existing
-- po_confirmation/tag_along branches so the UNION type-checks. Both
-- functions stay SECURITY INVOKER -- RLS (migration 055) does the scoping,
-- these functions only reshape rows the caller can already see.
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

  -- Base-conflict check: the client changed since the request was created,
  -- or was reassigned, or is now lost. Leaves status pending -- does not
  -- apply changes, requires manual re-review.
  if clt.updated_at is distinct from req.base_updated_at
     or clt.assigned_agent_id is distinct from req.base_assigned_agent_id
     or clt.status = 'lost' then
    return 'base_conflict';
  end if;

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
  foreach v_key in array v_allowed_keys loop
    if req.changes ? v_key then
      v_set_parts := v_set_parts || format('%I = %L', v_key, req.changes ->> v_key);
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

-- ----------------------------------------------------------------------------
-- Feed UNION extension (migration 042 originals reproduced in full so
-- CREATE OR REPLACE keeps all three branches -- Postgres has no ALTER
-- FUNCTION ... ADD UNION BRANCH).
-- ----------------------------------------------------------------------------

create or replace function public.get_manager_approval_feed()
returns table (
  request_kind text, request_id uuid, requester_id uuid,
  client_id uuid, status text, created_at timestamptz,
  decided_at timestamptz, summary jsonb
)
language sql security invoker stable set search_path = public as $$
  select 'po_confirmation'::text, p.id, p.requester_id, p.client_id, p.status,
         p.created_at, p.decided_at,
         jsonb_build_object('po_photo_path', p.po_photo_path, 'meeting_id', p.meeting_id)
  from public.po_confirmation_requests p
  union all
  select 'tag_along'::text, t.id, t.requester_id, t.related_client_id, t.status,
         t.created_at, t.responded_at,
         jsonb_build_object('invitee_kind', t.invitee_kind, 'context', t.context)
  from public.tag_along_requests t
  where t.invitee_kind = 'manager'
  union all
  select 'client_edit'::text, r.id, r.requested_by, r.client_id, r.status,
         r.created_at, r.reviewed_at,
         jsonb_build_object(
           'changes', r.changes,
           'field_count', (select count(*) from jsonb_object_keys(r.changes)),
           'review_note', r.review_note
         )
  from public.client_edit_requests r;
$$;
revoke execute on function public.get_manager_approval_feed() from public, anon;
grant execute on function public.get_manager_approval_feed() to authenticated;

create or replace function public.get_my_request_statuses()
returns table (
  request_kind text, request_id uuid, client_id uuid, status text,
  created_at timestamptz, decided_at timestamptz, summary jsonb
)
language sql security invoker stable set search_path = public as $$
  select 'po_confirmation'::text, p.id, p.client_id, p.status, p.created_at, p.decided_at,
         jsonb_build_object('po_photo_path', p.po_photo_path)
  from public.po_confirmation_requests p
  where p.requester_id = public.current_profile_id()
  union all
  select 'tag_along'::text, t.id, t.related_client_id, t.status, t.created_at, t.responded_at,
         jsonb_build_object('invitee_kind', t.invitee_kind)
  from public.tag_along_requests t
  where t.requester_id = public.current_profile_id()
  union all
  select 'client_edit'::text, r.id, r.client_id, r.status, r.created_at, r.reviewed_at,
         jsonb_build_object(
           'changes', r.changes,
           'field_count', (select count(*) from jsonb_object_keys(r.changes)),
           'review_note', r.review_note
         )
  from public.client_edit_requests r
  where r.requested_by = public.current_profile_id();
$$;
revoke execute on function public.get_my_request_statuses() from public, anon;
grant execute on function public.get_my_request_statuses() to authenticated;
