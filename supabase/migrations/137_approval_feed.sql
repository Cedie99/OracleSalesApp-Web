-- ============================================================================
-- 137 — One paged feed for the Approvals queue
--
-- WHY: the page merges TWO record types from TWO different transports and then
-- sorts and pages the merge. `client_edit_requests` is read from the browser;
-- PO confirmations go through a Server Function because migration 039 scopes
-- that table to the requester and their manager, so an admin's own query
-- matches zero rows. A merge cannot be paged server-side without a union in the
-- database, which is what this is.
--
-- Both hooks previously fetched EVERY row of their table — every historically
-- decided request, three joins each — so the page could show nine cards.
--
-- FOUR THINGS COME BACK, and the last two are the reason this is one call
-- rather than a query per list:
--
--   pending / resolved   — a window of each, with its own total. Both tabs are
--       rendered with independent pagination and both trigger labels print a
--       count, so both are needed on every render regardless of which tab is
--       open.
--
--   pendingEditIndex     — id, requester and requester name for EVERY filtered
--       pending edit, not just the visible page. Load-bearing: the bulk
--       selection is deliberately scoped to the whole filtered set, because
--       "select all 12 from this agent" has to mean all twelve including the
--       three on page two. Pagination is a viewport there, not a scope. The
--       payload is bounded by the PENDING BACKLOG rather than by history, which
--       is what keeps it small.
--
--   requesters           — the agent picker's options, built from people who
--       have actually filed something rather than from every profile, because
--       offering the rest would be offering guaranteed-empty results.
--       Deliberately NOT narrowed by the current filters: the picker must still
--       list the person you are about to filter to.
--
-- SORT ORDERS DIFFER, and both are intentional. Pending is OLDEST FIRST — it is
-- a backlog, and the oldest item is the one most in need of a decision.
-- Resolved is NEWEST FIRST, dated by when it was decided, falling back to when
-- it was filed for rows decided before that column existed.
--
-- p_field_labels carries FIELD_LABEL from lib/status-styles.ts. The search box
-- matches the HUMAN label of a changed field ("Contact Number"), not the column
-- name, because that is what an admin scans these cards for. Passed in rather
-- than duplicated here, the same way p_milestones (131) and p_outcome_order
-- (133) are.
--
-- SECURITY: SECURITY DEFINER — that is the whole point for the PO half, which
-- RLS hides from admins. Grants name BOTH anon paths per migration 132.
-- ============================================================================

create or replace function public.get_approval_feed(
  p_search           text        default null,
  -- 'all' | 'edit' | 'po'
  p_kind             text        default 'all',
  p_agent_id         uuid        default null,
  p_from             timestamptz default null,
  p_to               timestamptz default null,
  p_field_labels     jsonb       default '{}'::jsonb,
  p_pending_limit    int         default 9,
  p_pending_offset   int         default 0,
  p_resolved_limit   int         default 9,
  p_resolved_offset  int         default 0
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
edits as (
  select
    r.id, r.created_at, r.status,
    r.requested_by,
    coalesce(r.reviewed_at, r.created_at) as decided_sort,
    jsonb_build_object(
      'id', r.id,
      'client_id', r.client_id,
      'requested_by', r.requested_by,
      'changes', r.changes,
      'status', r.status,
      'reviewed_by', r.reviewed_by,
      'reviewed_at', r.reviewed_at,
      'review_note', r.review_note,
      'created_at', r.created_at,
      'client', case when c.id is null then null else jsonb_build_object(
        'id', c.id, 'company_name', c.company_name, 'customer_type', c.customer_type,
        'sales_channel', c.sales_channel, 'status', c.status) end,
      'requester', case when rq.id is null then null else jsonb_build_object(
        'id', rq.id, 'user_id', rq.user_id, 'full_name', rq.full_name, 'role', rq.role,
        'team_id', rq.team_id, 'avatar_url', rq.avatar_url, 'created_at', rq.created_at) end,
      'reviewer', case when rv.id is null then null else jsonb_build_object(
        'id', rv.id, 'user_id', rv.user_id, 'full_name', rv.full_name, 'role', rv.role,
        'team_id', rv.team_id, 'avatar_url', rv.avatar_url, 'created_at', rv.created_at) end,
      -- A close-deal PO waiting on the SAME client, when this request is the
      -- one kind a promotion can invalidate (customer_type -> existing). The
      -- card warns on it, and it used to be answered by scanning the whole PO
      -- list in the browser.
      --
      -- Scoped to pending-vs-pending: a decided PO has already had its effect,
      -- and 129's trigger has already superseded this request if it was going
      -- to. Deliberately NOT narrowed by the page's filters — a competing PO is
      -- a fact about the client, not about the current search.
      'competing_po', (
        r.status = 'pending'
        and r.changes -> 'customer_type' ->> 'new' = 'existing'
        and exists (
          select 1 from public.po_confirmation_requests cp
          where cp.client_id = r.client_id and cp.status = 'pending'))
    ) as payload,
    rq.full_name as requester_name,
    c.company_name as client_name,
    r.changes as changes
  from public.client_edit_requests r
  left join public.clients  c  on c.id  = r.client_id
  left join public.profiles rq on rq.id = r.requested_by
  left join public.profiles rv on rv.id = r.reviewed_by
  where (p_kind = 'all' or p_kind = 'edit')
    and (p_agent_id is null or r.requested_by = p_agent_id)
    and (p_from is null or r.created_at >= p_from)
    and (p_to   is null or r.created_at <= p_to)
    and (
      p_search is null or p_search = ''
      or coalesce(c.company_name, '') ilike '%' || p_search || '%'
      or coalesce(rq.full_name, '')   ilike '%' || p_search || '%'
      -- The FIELD being changed is what an admin scans these for, by its human
      -- label rather than its column name.
      or exists (
        select 1 from jsonb_object_keys(r.changes) as k
        where coalesce(p_field_labels->>k, k) ilike '%' || p_search || '%'
      )
    )
),
pos as (
  select
    po.id, po.created_at, po.status,
    po.requester_id as requested_by,
    coalesce(po.decided_at, po.created_at) as decided_sort,
    jsonb_build_object(
      'id', po.id,
      'client_id', po.client_id,
      'cycle_id', po.cycle_id,
      'meeting_id', po.meeting_id,
      'requester_id', po.requester_id,
      'po_photo_path', po.po_photo_path,
      'status', po.status,
      'decided_by', po.decided_by,
      'decided_at', po.decided_at,
      'decision_note', po.decision_note,
      'created_at', po.created_at,
      'updated_at', po.updated_at,
      'requester_name', rq.full_name,
      'requester_role', rq.role,
      'requester_team_id', rq.team_id,
      -- The only cross-platform record of who decided: a manager approving on
      -- mobile writes decided_by but never reaches admin_audit_logs, which is
      -- web-only by design.
      'decider_name', dc.full_name,
      'decider_role', dc.role,
      'company_name', c.company_name,
      'customer_type', c.customer_type,
      'office_address', c.office_address,
      'meeting_date', m.meeting_date,
      'meeting_outcome', m.outcome,
      'meeting_contact_person', m.contact_person,
      -- The client's stage FROZEN at the meeting (067). The card's before/after
      -- needs this rather than clients.customer_type, which is the live value
      -- and has already advanced by the time anyone looks at a decided request.
      'stage_at_meeting', m.client_status_at_meeting
    ) as payload,
    rq.full_name as requester_name
  from public.po_confirmation_requests po
  left join public.profiles rq on rq.id = po.requester_id
  left join public.profiles dc on dc.id = po.decided_by
  left join public.clients  c  on c.id  = po.client_id
  left join public.meetings m  on m.id  = po.meeting_id
  where (p_kind = 'all' or p_kind = 'po')
    and (p_agent_id is null or po.requester_id = p_agent_id)
    and (p_from is null or po.created_at >= p_from)
    and (p_to   is null or po.created_at <= p_to)
    and (
      p_search is null or p_search = ''
      or coalesce(c.company_name, '') ilike '%' || p_search || '%'
      or coalesce(rq.full_name, '')   ilike '%' || p_search || '%'
    )
),
feed as (
  select 'edit' as kind, 'edit-' || id::text as key, id, created_at, status, requested_by,
         decided_sort, payload
  from edits
  union all
  select 'po', 'po-' || id::text, id, created_at, status, requested_by,
         decided_sort, payload
  from pos
),
pending as (select * from feed where status = 'pending'),
resolved as (select * from feed where status <> 'pending')
select jsonb_build_object(
  'pending', jsonb_build_object(
    'total', (select count(*)::int from pending),
    'rows', coalesce((
      -- Oldest first: a backlog, and the oldest item is the one most in need
      -- of a decision. `id` appended as a total order, which server-side paging
      -- needs and the in-memory sort did not.
      select jsonb_agg(jsonb_build_object('kind', p.kind, 'key', p.key, 'item', p.payload)
                       order by p.created_at asc, p.id asc)
      from (
        select * from pending order by created_at asc, id asc
        limit greatest(p_pending_limit, 0) offset greatest(p_pending_offset, 0)
      ) p), '[]'::jsonb)),
  'resolved', jsonb_build_object(
    'total', (select count(*)::int from resolved),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('kind', r.kind, 'key', r.key, 'item', r.payload)
                       order by r.decided_sort desc, r.id desc)
      from (
        select * from resolved order by decided_sort desc, id desc
        limit greatest(p_resolved_limit, 0) offset greatest(p_resolved_offset, 0)
      ) r), '[]'::jsonb)),
  -- The bulk-selection scope. Edits only — PO confirmations are never
  -- selectable, because approving one fires promote_on_po_confirmed (040) and
  -- promotes the client in the same transaction, and nothing on this page
  -- undoes that. See the note on `selected` in the page.
  --
  -- Carries the client name and the field diff as well as the ids, because a
  -- bulk approval writes ONE AUDIT ENTRY PER REQUEST and each entry names the
  -- client and renders the change it approved. A bulk approve is N decisions,
  -- and an audit trail that collapsed them into one row could not answer "was
  -- THIS client's change approved?".
  'pendingEditIndex', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', e.id,
      'requestedBy', e.requested_by,
      'requesterName', e.requester_name,
      'clientName', e.client_name,
      'changes', e.changes)
      order by e.created_at asc, e.id asc)
    from edits e where e.status = 'pending'), '[]'::jsonb),
  -- Everyone who has filed something, whatever the current filters say.
  'requesters', coalesce((
    select jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name, 'teamId', q.team_id)
                     order by q.name)
    from (
      select distinct p.id, p.full_name as name, p.team_id
      from public.profiles p
      where exists (select 1 from public.client_edit_requests r where r.requested_by = p.id)
         or exists (select 1 from public.po_confirmation_requests po where po.requester_id = p.id)
    ) q), '[]'::jsonb)
);
$$;

revoke all on function public.get_approval_feed(
  text, text, uuid, timestamptz, timestamptz, jsonb, int, int, int, int) from public, anon;
grant execute on function public.get_approval_feed(
  text, text, uuid, timestamptz, timestamptz, jsonb, int, int, int, int) to authenticated;
