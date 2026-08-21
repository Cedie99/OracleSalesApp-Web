-- ============================================================================
-- 118 — ADR-067: guest-manager record holders (per-meeting-invite ownership)
--
-- See projects/OracleSalesApp-Mobile/Decisions.md ADR-067 (vault, mobile
-- repo tree) for the full product spec. Summary of what changes here:
--
--   1. client_meeting_holders — new, append-only table. One row per
--      (client_id, manager_id) that has ever been granted holder status.
--      No UPDATE/DELETE policy exists anywhere in this migration and none is
--      planned (ADR-067 decision 3: holder status is permanent, no revoke
--      code path, ever). Deliberately a NEW table, NOT the retired
--      `public.client_record_holders` from the direct Joint Manager holder
--      experiment (migration 091, retired by 097) — that table/its RLS stay
--      dropped-and-dead; reusing its name or rows would resurrect a
--      superseded design ADR-067 explicitly is not.
--
--   2. Holder status has exactly ONE trigger: a manager accepting a
--      meeting-context Tag-Along invite. Corrected 2026-08-22 — there is
--      NO separate "approve becoming a holder" decision/RPC/column. The
--      existing "Invitee responds to pending" RLS policy (migration 019)
--      already lets the invitee flip `status` from 'pending' to
--      'accepted'/'declined' directly; a trigger on that UPDATE inserts
--      the holder row the instant status becomes 'accepted' for a
--      meeting-context manager invitee. Declining never creates a holder
--      row, but has zero effect on quota/meeting attribution (migrations
--      076/077/107, untouched by this migration) — those two things are
--      independent by design.
--
--   3. decide_client_edit_request() eligibility is WIDENED (not replaced):
--      previously "the requester's team-scoped sales_manager
--      (is_manager_of_profile) OR admin/superadmin" (migration 102). This
--      adds a third arm: "OR any current holder of the client per
--      client_meeting_holders" — ADR-067 decision 5's first-come-first-served
--      rule. 102's body is reproduced verbatim otherwise (per-field
--      base_conflict check, server-side allowlist, `-> v_key ->> 'new'`
--      extraction) — CREATE OR REPLACE is safe here since the OUT-parameter
--      row type (a single `text`) is unchanged, no DROP FUNCTION needed.
--
--   4. New SELECT policies on clients/meetings/client_edit_requests scoped
--      by client_meeting_holders membership — this is what actually
--      delivers ADR-067 decision 2/4's "full client history visibility,
--      independent of meeting attendance" (a holder must see the WHOLE
--      client timeline, not just the one meeting they were invited to —
--      migration 115's tag-along-participant policy only ever covered that
--      one meeting/client pair). Narrow by construction: only rows the
--      caller is an explicit client_meeting_holders row for.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. client_meeting_holders
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

-- No INSERT/UPDATE/DELETE policy for any role, ever (ADR-067 decision 3) --
-- the only write path is the trigger below, which runs as the table owner
-- and bypasses RLS entirely, same discipline as other SECURITY DEFINER
-- write paths in this schema.
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
-- 2. Trigger: accepting a meeting-context manager invite IS the holder
--    decision. No separate button, RPC, or column.
-- ----------------------------------------------------------------------------

create or replace function public.grant_client_holder_on_tagalong_accept()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'accepted'
     and old.status is distinct from 'accepted'
     and new.context = 'meeting'
     and new.invitee_kind = 'manager'
     and new.related_client_id is not null then
    insert into public.client_meeting_holders (client_id, manager_id, granted_via_request_id)
    values (new.related_client_id, new.invitee_id, new.id)
    on conflict (client_id, manager_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_grant_client_holder_on_tagalong_accept on public.tag_along_requests;
create trigger trg_grant_client_holder_on_tagalong_accept
  after update of status on public.tag_along_requests
  for each row
  execute function public.grant_client_holder_on_tagalong_accept();

-- ----------------------------------------------------------------------------
-- 3. decide_client_edit_request(): widen eligibility to include any current
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
-- 4. Full-client-history visibility for current holders (ADR-067 decision 2/4)
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
--   drop trigger if exists trg_grant_client_holder_on_tagalong_accept on public.tag_along_requests;
--   drop function if exists public.grant_client_holder_on_tagalong_accept();
--   drop policy if exists "Holders read their client's holder set" on public.client_meeting_holders;
--   drop table if exists public.client_meeting_holders;
-- ============================================================================
