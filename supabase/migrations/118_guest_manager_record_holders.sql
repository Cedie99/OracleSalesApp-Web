-- ============================================================================
-- 118 — ADR-067: guest-manager record holders (per-meeting-invite ownership)
--
-- See projects/OracleSalesApp-Mobile/Decisions.md ADR-067 (vault, mobile
-- repo tree) for the full product spec. Summary of what changes here:
--
--   1. tag_along_requests gains `holder_decision` — a SEPARATE column from
--      `status`. `status` already tracks the meeting-invite accept/decline
--      (unchanged, still drives quota/meeting credit per migrations 076/077
--      — this migration does not touch attribution at all). `holder_decision`
--      only exists for `invitee_kind = 'manager'` rows and records whether
--      that manager separately approved/rejected becoming a PERMANENT
--      record holder for the related client. Independent decision, no
--      interaction with `status` or quota.
--
--   2. client_meeting_holders — new, append-only table. One row per
--      (client_id, manager_id) that has ever been granted holder status.
--      No UPDATE/DELETE policy exists anywhere in this migration and none is
--      planned (ADR-067 decision 3/6: holder status is permanent, no revoke
--      code path, ever). Deliberately a NEW table, NOT the retired
--      `public.client_record_holders` from the direct Joint Manager holder
--      experiment (migration 091, retired by 097) — that table/its RLS stay
--      dropped-and-dead; reusing its name or rows would resurrect a
--      superseded design ADR-067 explicitly is not.
--
--   3. decide_client_record_holder_status() — new SECURITY DEFINER RPC, the
--      only write path for `holder_decision` / `client_meeting_holders`.
--      Mirrors decide_client_edit_request()/decide_po_confirmation()'s CAS
--      shape (row locked FOR UPDATE, idempotent, plain text return code).
--      Gated on the caller being the invitee of an ACCEPTED meeting-context
--      manager tag-along request that has not yet recorded a holder
--      decision — a manager who never accepted the meeting invite, or who
--      already decided, cannot call this again.
--
--   4. decide_client_edit_request() eligibility is WIDENED (not replaced):
--      previously "the requester's team-scoped sales_manager
--      (is_manager_of_profile) OR admin/superadmin" (migration 102). This
--      adds a third arm: "OR any current holder of the client per
--      client_meeting_holders" — ADR-067 decision 5's first-come-first-served
--      rule. 102's body is reproduced verbatim otherwise (per-field
--      base_conflict check, server-side allowlist, `-> v_key ->> 'new'`
--      extraction) — CREATE OR REPLACE is safe here since the OUT-parameter
--      row type (a single `text`) is unchanged, no DROP FUNCTION needed.
--
--   5. New SELECT policies on clients/meetings/client_edit_requests scoped
--      by client_meeting_holders membership — this is what actually
--      delivers ADR-067 decision 2/4's "full client history visibility,
--      independent of meeting attendance" (a holder must see the WHOLE
--      client timeline, not just the one meeting they were invited to —
--      migration 115's tag-along-participant policy only ever covered that
--      one meeting/client pair). Narrow by construction: only rows the
--      caller is an explicit client_meeting_holders row for.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. tag_along_requests.holder_decision
-- ----------------------------------------------------------------------------

alter table public.tag_along_requests
  add column if not exists holder_decision text
    check (holder_decision in ('approved', 'rejected'));

-- ----------------------------------------------------------------------------
-- 2. client_meeting_holders
-- ----------------------------------------------------------------------------

create table if not exists public.client_meeting_holders (
  client_id uuid not null references public.clients(id),
  manager_id uuid not null references public.profiles(id),
  granted_via_request_id uuid references public.tag_along_requests(id),
  created_at timestamptz not null default now(),
  primary key (client_id, manager_id)
);

create index if not exists idx_cmh_manager on public.client_meeting_holders(manager_id);
create index if not exists idx_cmh_client on public.client_meeting_holders(client_id);

alter table public.client_meeting_holders enable row level security;

-- No INSERT/UPDATE/DELETE policy for any role, ever (ADR-067 decision 3/6) —
-- the only write path is decide_client_record_holder_status() below, which
-- is SECURITY DEFINER and bypasses RLS entirely, same discipline as
-- decide_client_edit_request()/decide_po_confirmation() writing their own
-- tables with no caller-facing UPDATE policy.
drop policy if exists "Holders read their client's holder set" on public.client_meeting_holders;
create policy "Holders read their client's holder set" on public.client_meeting_holders
  for select using (
    manager_id = public.current_profile_id()
    or exists (
      select 1 from public.client_meeting_holders self_row
      where self_row.client_id = client_meeting_holders.client_id
        and self_row.manager_id = public.current_profile_id()
    )
  );

-- ----------------------------------------------------------------------------
-- 3. decide_client_record_holder_status()
-- ----------------------------------------------------------------------------

create or replace function public.decide_client_record_holder_status(
  p_request_id uuid, p_decision text
) returns text
language plpgsql
security definer
volatile
set search_path = public
as $$
declare
  req public.tag_along_requests%rowtype;
begin
  select * into req from public.tag_along_requests where id = p_request_id for update;
  if not found then
    return 'not_found';
  end if;

  if p_decision not in ('approved', 'rejected') then
    return 'invalid_decision';
  end if;

  -- Only the invited manager of THIS meeting-context request may decide it,
  -- and only for a manager invitee — a teammate companion is never a holder
  -- candidate (ADR-067 is scoped to managers throughout).
  if req.invitee_id <> public.current_profile_id()
     or req.invitee_kind <> 'manager'
     or req.context <> 'meeting' then
    return 'role_not_eligible';
  end if;

  -- ADR-067 decision 2: holder consent is a SEPARATE decision from accepting
  -- the meeting invite, but it presupposes acceptance — a manager who
  -- declined (or hasn't yet answered) the meeting invite was never actually
  -- part of the meeting, so there is nothing to become a holder of yet.
  if req.status <> 'accepted' then
    return 'not_eligible';
  end if;

  if req.holder_decision is not null then
    return 'already_decided';
  end if;

  update public.tag_along_requests
     set holder_decision = p_decision
   where id = p_request_id;

  -- ADR-067 decision 3: permanent, additive only. ON CONFLICT DO NOTHING
  -- makes a retry of an already-approved decision a harmless no-op rather
  -- than an error (matches the CAS-idempotent spirit of the sibling RPCs,
  -- even though the `holder_decision is not null` guard above already
  -- prevents a legitimate second call from reaching this far).
  if p_decision = 'approved' and req.related_client_id is not null then
    insert into public.client_meeting_holders (client_id, manager_id, granted_via_request_id)
    values (req.related_client_id, req.invitee_id, req.id)
    on conflict (client_id, manager_id) do nothing;
  end if;

  return p_decision;
end;
$$;
revoke execute on function public.decide_client_record_holder_status(uuid, text) from public, anon;
grant execute on function public.decide_client_record_holder_status(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. decide_client_edit_request(): widen eligibility to include any current
--    holder of the client (ADR-067 decision 5 — first-come-first-served).
--    Reproduces migration 102's body verbatim except for the added arm.
-- ----------------------------------------------------------------------------

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
  -- DEFINER). THREE eligible callers as of this migration:
  --   1. the requester's team-scoped sales_manager -- 055's P3 predicate /
  --      lib/policies/approval-policy.ts::canApproveEdit().
  --   2. an admin or superadmin (migration 102).
  --   3. ADR-067: any current holder of the client per
  --      client_meeting_holders -- first valid approval among current
  --      holders wins, no pre-selection of who gets to decide.
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

  select * into clt from public.clients where id = req.client_id;

  -- Reassignment / lost-client conflict -- unchanged, still real signals.
  -- Holders are NOT exempt: these guard correctness, not authority.
  if clt.assigned_agent_id is distinct from req.base_assigned_agent_id
     or clt.status = 'lost' then
    return 'base_conflict';
  end if;

  -- Targeted per-field conflict check (migration 102): only the fields
  -- actually present in req.changes matter. '' / null both normalize to
  -- null before comparing, matching the client-side rule.
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
  -- `req.changes` entries are `{old: ..., new: ...}` objects, so the `new`
  -- key must be extracted specifically.
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

-- ----------------------------------------------------------------------------
-- 5. Full-client-history visibility for current holders (ADR-067 decision 2/4)
-- ----------------------------------------------------------------------------

drop policy if exists "Client record holders read held clients" on public.clients;
create policy "Client record holders read held clients" on public.clients
  for select using (
    exists (
      select 1 from public.client_meeting_holders h
      where h.client_id = clients.id
        and h.manager_id = public.current_profile_id()
    )
  );

drop policy if exists "Client record holders read held client meetings" on public.meetings;
create policy "Client record holders read held client meetings" on public.meetings
  for select using (
    exists (
      select 1 from public.client_meeting_holders h
      where h.client_id = meetings.client_id
        and h.manager_id = public.current_profile_id()
    )
  );

-- Needed so a holder outside the requester's team can even SEE a pending
-- client_edit_requests row to decide it (055's P3 is team-scope only) --
-- get_manager_approval_feed()/get_my_request_statuses() (042/056) are
-- SECURITY INVOKER and only reshape rows RLS already lets the caller read.
drop policy if exists "Client record holders read held clients edit requests" on public.client_edit_requests;
create policy "Client record holders read held clients edit requests" on public.client_edit_requests
  for select using (
    exists (
      select 1 from public.client_meeting_holders h
      where h.client_id = client_edit_requests.client_id
        and h.manager_id = public.current_profile_id()
    )
  );

-- ============================================================================
-- ROLLBACK
--   drop policy if exists "Client record holders read held clients edit requests" on public.client_edit_requests;
--   drop policy if exists "Client record holders read held client meetings" on public.meetings;
--   drop policy if exists "Client record holders read held clients" on public.clients;
--   -- restore migration 102's decide_client_edit_request() body (drop the
--   -- client_meeting_holders arm) via CREATE OR REPLACE.
--   drop function if exists public.decide_client_record_holder_status(uuid, text);
--   drop policy if exists "Holders read their client's holder set" on public.client_meeting_holders;
--   drop table if exists public.client_meeting_holders;
--   alter table public.tag_along_requests drop column if exists holder_decision;
-- ============================================================================
