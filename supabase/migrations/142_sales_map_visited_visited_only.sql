-- ============================================================================
-- 142 - The Sales map's Visited lens: an agent-scoped query stays on visited
--
-- WHAT THIS CHANGES: migration 138 omitted the "must have a visit in range"
-- rule when an agent was selected. An agent-scoped query returned the agent's
-- WHOLE ROSTER — every client they own, including ones never visited at all,
-- listed and unplotted so the map could draw nothing for them. That served the
-- "View on map" deep link as "show me everywhere this person works", but the
-- same path is what the toolbar's agent filter rides on, and a filter is
-- supposed to narrow.
--
-- From here the rule is unconditional: a row is a client with at least one
-- meeting inside the active window, whether or not an agent is selected. The
-- tag-along scope survives — a client the scoped agent joined a visit on is
-- still theirs, and still only when a visit actually happened in range.
--
-- SAFETY: recreate of 138's function, same signature and grants, so every
-- existing caller is unchanged.
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
  -- A row is a client with a visit in range — unconditional since 142. An
  -- agent scope narrows which clients can be visited, it does not let a client
  -- with no visit appear.
  where exists (select 1 from in_range ir where ir.client_id = f.id)
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
    -- Visited-most-recently first.
    order by r.last_visit desc nulls last, r.company_name)
  from rows_out r
  join public.clients c on c.id = r.id
  left join public.profiles ag on ag.id = c.assigned_agent_id), '[]'::jsonb);
$$;

revoke all on function public.get_sales_map_visited(
  text, text, uuid, uuid, boolean, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_sales_map_visited(
  text, text, uuid, uuid, boolean, text, timestamptz, timestamptz) to authenticated;