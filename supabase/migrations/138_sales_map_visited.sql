-- ============================================================================
-- 138 — The Sales map's Visited lens, computed server-side
--
-- WHY: opening Maps downloaded every client and every meeting in the company to
-- draw about twenty pins. The map itself was never the problem — the default
-- view is ONE DAY's visits (`defaultPreset: 'day'`), and a pin is "a client
-- plotted at their most recent located visit" within the active filters. It is
-- the same problem as everywhere else: the whole table read in order to decide
-- which handful to show.
--
-- SCOPE: the Visited lens only. The Needs Attention lens is not here, because
-- its signals rest on `ClientQuotaUsage` folded from the cutoff attribution
-- ledger — the same accounting CutoffQuotaReport runs on. That is deferred, so
-- that lens keeps its client-side data and loads it only when someone opens the
-- tab, rather than on every visit to the page.
--
-- TWO RULES WORTH NAMING, both copied from the component:
--
--   * A pin sits at the most recent PLOTTABLE visit in range, but the row is
--     kept even when none of its visits carry a fix — the account is still
--     listed, just unplotted. Dropping it would hide work that happened.
--
--   * Agent scope means the WHOLE ROSTER, not just clients with a visit in
--     range: "show me where this person works" includes the accounts they have
--     not got to yet. That only applies when an agent is actually selected —
--     unscoped, a client with no visit in range is left out, because listing
--     every client in the database is the old "Not visited" lens that was
--     removed for having nothing actionable in it.
--
-- Tag-alongs count toward an agent's scope: joining another agent's visit is
-- how a manager works an account, and a map that omitted them would disagree
-- with the Meetings page about the same person's fortnight.
--
-- SECURITY: SECURITY DEFINER — the tag-along ledger is invisible to admins
-- under RLS (019). Grants name BOTH anon paths per migration 132.
-- ============================================================================

create or replace function public.get_sales_map_visited(
  p_search    text        default null,
  -- 'all' | a MapStatus ('existing' | 'new' | 'prospect' | 'lost')
  p_status    text        default 'all',
  p_team_id   uuid        default null,
  -- null = all agents; 'unassigned' handled via p_unassigned below.
  p_agent_id  uuid        default null,
  p_unassigned boolean    default false,
  -- 'all' | 'f2f' | 'online'
  p_type      text        default 'all',
  p_from      timestamptz default null,
  p_to        timestamptz default null
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
-- Accounts the scoped agent tagged along on. Accepted and pending both count:
-- the manager was asked either way. Empty unless an agent is selected.
scoped_tagalongs as (
  select distinct t.related_client_id as client_id
  from public.tag_along_requests t
  where p_agent_id is not null
    and t.invitee_id = p_agent_id
    and t.related_client_id is not null
    and t.status in ('accepted', 'pending')
),
candidates as (
  select
    c.id,
    c.company_name,
    -- getMapStatus(): lost wins, and in_progress folds into the prospect
    -- family because one pin colour covers the whole pre-customer stage.
    case
      when c.status = 'lost' then 'lost'
      when coalesce(c.customer_type, 'prospect') = 'in_progress' then 'prospect'
      else coalesce(c.customer_type, 'prospect')
    end as map_status,
    c.assigned_agent_id,
    ag.team_id as agent_team_id,
    (p_agent_id is not null and c.assigned_agent_id is distinct from p_agent_id) as via_tag_along
  from public.clients c
  left join public.profiles ag on ag.id = c.assigned_agent_id
  where c.status <> 'deleted'
    and (p_team_id is null or ag.team_id = p_team_id)
    and (p_unassigned is false or c.assigned_agent_id is null)
    and (
      p_agent_id is null
      or c.assigned_agent_id = p_agent_id
      or c.id in (select client_id from scoped_tagalongs)
    )
    and (
      p_search is null or p_search = ''
      or c.company_name   ilike '%' || p_search || '%'
      or coalesce(c.office_address, '') ilike '%' || p_search || '%'
    )
),
-- The client-level status filter is applied after map_status is derived, so it
-- filters on what the legend actually says rather than on the raw column.
filtered as (
  select * from candidates
  where p_status = 'all' or map_status = p_status
),
-- Meetings in range for those clients, newest first.
in_range as (
  select
    m.client_id,
    m.id,
    m.meeting_date,
    row_number() over (partition by m.client_id order by m.meeting_date desc, m.id desc) as rn,
    -- The pin's meeting: most recent one carrying a fix.
    row_number() over (
      partition by m.client_id
      order by (case when m.gps_lat is not null and m.gps_lng is not null then 0 else 1 end),
               m.meeting_date desc, m.id desc) as plot_rn,
    (m.gps_lat is not null and m.gps_lng is not null) as plottable
  from public.meetings m
  join filtered f on f.id = m.client_id
  where (p_type = 'all' or m.meeting_type = p_type)
    and (p_from is null or m.meeting_date >= p_from)
    and (p_to   is null or m.meeting_date <= p_to)
),
rows_out as (
  select
    f.id,
    f.company_name,
    f.via_tag_along,
    (select ir.meeting_date from in_range ir where ir.client_id = f.id and ir.rn = 1) as last_visit,
    (select ir.id from in_range ir
      where ir.client_id = f.id and ir.plot_rn = 1 and ir.plottable) as plot_meeting_id
  from filtered f
  -- Unscoped, a client with no visit in range is not a row. Agent-scoped, it is
  -- — see the header.
  where p_agent_id is not null
     or exists (select 1 from in_range ir where ir.client_id = f.id)
)
select coalesce((
  select jsonb_agg(jsonb_build_object(
    -- The records themselves, not ids: returning ids would only move the
    -- second fetch somewhere else. Bounded by the date window, which defaults
    -- to a single day.
    'client', jsonb_build_object(
      'id', c.id,
      'company_name', c.company_name,
      'contact_person', c.contact_person,
      'contact_number', c.contact_number,
      'office_address', c.office_address,
      'customer_type', c.customer_type,
      'sales_channel', c.sales_channel,
      'assigned_agent_id', c.assigned_agent_id,
      'status', c.status,
      'city', c.city,
      'province', c.province,
      'office_lat', c.office_lat,
      'office_lng', c.office_lng,
      'created_at', c.created_at,
      'agent', case when ag.id is null then null else jsonb_build_object(
        'id', ag.id, 'user_id', ag.user_id, 'full_name', ag.full_name,
        'email', ag.email, 'role', ag.role, 'team_id', ag.team_id,
        'is_active', ag.is_active, 'avatar_url', ag.avatar_url,
        'created_at', ag.created_at) end),
    'viaTagAlong', r.via_tag_along,
    'lastVisit', r.last_visit,
    'plotMeetingId', r.plot_meeting_id,
    -- Reuses app_private.meeting_row() from 133, so a meeting has exactly the
    -- shape it has on the Meetings page — including its companions, which the
    -- pin popup names.
    'meetings', coalesce((
      select jsonb_agg(app_private.meeting_row(ir.id)
                       order by ir.meeting_date desc, ir.id desc)
      from in_range ir where ir.client_id = r.id), '[]'::jsonb))
    -- Visited-most-recently first. A client with no visit at all (only
    -- possible when agent-scoped) has nothing to rank by time, so those sink
    -- to the bottom, alphabetically.
    order by r.last_visit desc nulls last, r.company_name)
  from rows_out r
  join public.clients c on c.id = r.id
  left join public.profiles ag on ag.id = c.assigned_agent_id), '[]'::jsonb);
$$;

revoke all on function public.get_sales_map_visited(
  text, text, uuid, uuid, boolean, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_sales_map_visited(
  text, text, uuid, uuid, boolean, text, timestamptz, timestamptz) to authenticated;
