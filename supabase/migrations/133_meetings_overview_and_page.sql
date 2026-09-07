-- ============================================================================
-- 133 — Server-side hierarchy and paging for the web Meetings page
--
-- WHY: the same problem 131 solved for Clients. The Meetings page is a
-- drill-down — manager buckets, the agents under one manager, then a page of
-- ten rows — and to render it the browser downloaded EVERY meeting in the
-- company with three joins (client, agent, recorder) plus the entire tag-along
-- ledger, then filtered, grouped, sorted and paginated all of it in JavaScript.
--
-- Worse than Clients, in fact: `useMeetings()` had no paging at all, so
-- PostgREST silently capped it at db-max-rows and the page was computing on the
-- newest 1,000 meetings while reporting totals as if it had them all.
--
--   get_meetings_overview() — the hierarchy and its counts, a few dozen rows.
--   get_meetings_page()     — one screen, its total, its stat breakdown.
--
-- SECURITY — read migration 132 before adding anything here. These are
-- SECURITY DEFINER because the tag-along ledger is invisible to admins under
-- RLS (019 scopes SELECT to requester and invitee), so the counts cannot be
-- computed any other way. That makes the grant block below load-bearing, not
-- boilerplate: `revoke ... from public` alone does NOT close anon access,
-- because Supabase's default privileges also issue a DIRECT grant to anon.
-- Both paths have to go. 132 closed the default for future functions, and
-- these lines are belt and braces on top of it.
--
-- FIDELITY. Every count reproduces a rule the TypeScript already implements,
-- and several of those rules are documented there as bugs fixed once already:
--
--   * `recorded_by` is NOT "tagged along". A manager invited along on twenty
--     agent visits records none of them and would read as zero. The two are
--     separate figures and must stay separate.
--   * A manager's team total is a UNION, deduplicated — unlike the Clients
--     page, whose team total deliberately concatenates. A meeting that is both
--     an agent's and the manager's own counts ONCE here. Do not "make them
--     consistent"; they are different on purpose.
--   * A manager who personally conducted a meeting is not listed as an agent
--     under themselves.
--   * The per-manager stat row is computed over UNFILTERED meetings, so
--     scoping the stats to a manager does not inherit the page's own search /
--     outcome / type / date filters. The bucket COUNTS above it are filtered.
--     That difference is intentional and is why two separate sets are built
--     below.
--   * "Google Meet" means online and not Zoom, matching the row's own fallback
--     — `online_platform` is frequently null on live rows and the page already
--     treats "online, not Zoom" as Google Meet.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The filtered meeting set, shared by both entry points
--
-- Extracted for the same reason as app_private.filtered_clients: if the
-- overview's counts and the page's rows can disagree about what "filtered"
-- means, every number on the screen becomes untrustworthy. One definition.
-- ----------------------------------------------------------------------------
create or replace function app_private.filtered_meetings(
  p_search  text        default null,
  p_outcome text        default 'all',
  p_type    text        default 'all',
  p_from    timestamptz default null,
  p_to      timestamptz default null
)
returns table (
  id            uuid,
  client_id     uuid,
  agent_id      uuid,
  recorded_by   uuid,
  meeting_type  text,
  online_platform text,
  outcome       text,
  meeting_date  timestamptz,
  agent_team_id uuid
)
language sql
security definer
stable
set search_path = public
as $$
  select
    m.id, m.client_id, m.agent_id, m.recorded_by,
    m.meeting_type, m.online_platform, m.outcome, m.meeting_date,
    ag.team_id as agent_team_id
  from public.meetings m
  left join public.clients  c  on c.id  = m.client_id
  left join public.profiles ag on ag.id = m.agent_id
  where
    -- The three fields the page's own search box reads.
    (
      p_search is null or p_search = ''
      or coalesce(c.company_name, '') ilike '%' || p_search || '%'
      or coalesce(ag.full_name, '')   ilike '%' || p_search || '%'
      or coalesce(m.contact_person, '') ilike '%' || p_search || '%'
    )
    and (p_outcome = 'all' or m.outcome = p_outcome)
    and (p_type    = 'all' or m.meeting_type = p_type)
    -- Null bounds mean "all time", matching useDateRangeFilter's `range: null`.
    and (p_from is null or m.meeting_date >= p_from)
    and (p_to   is null or m.meeting_date <= p_to);
$$;

revoke all on function app_private.filtered_meetings(text, text, text, timestamptz, timestamptz)
  from public, anon;


-- ----------------------------------------------------------------------------
-- 2. get_meetings_overview
--
--   {
--     "stats": {…}, "filteredTotal": n, "allTotal": n,
--     "managers": [ { key,label,agentCount,meetingCount,ownMeetingCount,
--                     tagAlongCount, stats {…} } ],
--     "agents":   [ { agentId,agentName,managerKey,meetingCount,tagAlongCount } ]
--   }
--
-- `stats` at the top level, and each manager's `stats`, are UNFILTERED. The
-- counts beside them are filtered. See the header.
-- ----------------------------------------------------------------------------
create or replace function public.get_meetings_overview(
  p_search  text        default null,
  p_outcome text        default 'all',
  p_type    text        default 'all',
  p_from    timestamptz default null,
  p_to      timestamptz default null
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
managers as (
  select p.id, p.full_name, p.team_id
  from public.profiles p
  where p.role = 'sales_manager' and p.is_active is distinct from false
),
-- A team's manager is the active sales_manager sharing its team_id (010).
-- `distinct on` with the full_name ordering picks the same one lib/teams.ts's
-- managerForTeam() does, scanning an alphabetically sorted list.
team_manager as (
  select distinct on (team_id) team_id, id as manager_id
  from managers where team_id is not null
  order by team_id, full_name, id
),
filtered as (
  select * from app_private.filtered_meetings(p_search, p_outcome, p_type, p_from, p_to)
),
-- Every meeting with its manager key, UNFILTERED — the per-manager stat row.
all_meetings as (
  select m.id, m.agent_id, m.recorded_by, m.meeting_type, m.online_platform, m.outcome,
         coalesce(tm.manager_id::text, 'unassigned') as manager_key
  from public.meetings m
  left join public.profiles ag on ag.id = m.agent_id
  left join team_manager tm on tm.team_id = ag.team_id
),
-- Companions, by meeting. 'cancelled' never counts — nobody attended those.
live_companions as (
  select distinct t.related_meeting_id as meeting_id
  from public.tag_along_requests t
  where t.related_meeting_id is not null and t.status <> 'cancelled'
),
-- Who was invited along to what. Accepted and pending both count: the manager
-- was asked either way, and a pending invite is the one worth seeing.
invited as (
  select distinct t.invitee_id, t.related_meeting_id as meeting_id
  from public.tag_along_requests t
  where t.related_meeting_id is not null and t.status in ('accepted', 'pending')
),
-- Agent groups, from the filtered set, excluding manager-as-agent.
agent_rows as (
  select f.*,
         coalesce(f.agent_id::text, 'unassigned')      as agent_key,
         coalesce(tm.manager_id::text, 'unassigned')   as manager_key
  from filtered f
  left join team_manager tm on tm.team_id = f.agent_team_id
  where f.agent_id is null
     or not exists (select 1 from managers m where m.id = f.agent_id)
),
agent_groups as (
  select
    ar.agent_key,
    coalesce(max(ag.full_name), 'Unassigned') as agent_name,
    ar.manager_key,
    count(*)::int as meeting_count,
    count(*) filter (where lc.meeting_id is not null)::int as tag_along_count
  from agent_rows ar
  left join public.profiles ag on ag.id = ar.agent_id
  left join live_companions lc on lc.meeting_id = ar.id
  group by ar.agent_key, ar.manager_key
),
-- A manager's filtered meetings, by route. Unioned and DEDUPLICATED for the
-- team total; the individual flags stay separate for the two reported figures.
manager_meeting as (
  select
    s.manager_id,
    s.meeting_id,
    max(s.by_own)  as by_own,
    max(s.by_tag)  as by_tag,
    max(s.by_team) as by_team
  from (
    -- Held or recorded by the manager themselves.
    select m.id as manager_id, f.id as meeting_id, 1 as by_own, 0 as by_tag, 0 as by_team
    from managers m join filtered f on f.agent_id = m.id or f.recorded_by = m.id
    union all
    -- Invited along.
    select m.id, i.meeting_id, 0, 1, 0
    from managers m
    join invited i on i.invitee_id = m.id
    join filtered f on f.id = i.meeting_id
    union all
    -- Reached through an agent on their team.
    select (ar.manager_key)::uuid, ar.id, 0, 0, 1
    from agent_rows ar where ar.manager_key <> 'unassigned'
  ) s
  group by s.manager_id, s.meeting_id
),
manager_rows as (
  select
    m.id,
    m.full_name,
    (select count(*)::int from agent_groups g where g.manager_key = m.id::text) as agent_count,
    (select count(*)::int from manager_meeting mm
      where mm.manager_id = m.id and mm.by_own = 1)                              as own_meeting_count,
    (select count(*)::int from manager_meeting mm
      where mm.manager_id = m.id and mm.by_tag = 1)                              as tag_along_count,
    -- The union, deduplicated — one row per meeting however many routes reach it.
    (select count(*)::int from manager_meeting mm where mm.manager_id = m.id)    as meeting_count,
    (select jsonb_build_object(
        'total',      count(*),
        'f2f',        count(*) filter (where am.meeting_type = 'f2f'),
        'googleMeet', count(*) filter (where am.meeting_type = 'online'
                                         and am.online_platform is distinct from 'zoom'),
        'successful', count(*) filter (where am.outcome = 'successful'),
        'followUp',   count(*) filter (where am.outcome = 'follow_up'),
        'noDecision', count(*) filter (where am.outcome = 'no_decision'),
        'lost',       count(*) filter (where am.outcome = 'lost_opportunity'))
     from all_meetings am
     where am.manager_key = m.id::text
        or am.agent_id = m.id
        or am.recorded_by = m.id
        or exists (select 1 from invited i where i.invitee_id = m.id and i.meeting_id = am.id)
    ) as stats
  from managers m
),
unassigned_rows as (
  select
    count(*)::int                             as agent_count,
    coalesce(sum(g.meeting_count), 0)::int    as meeting_count
  from agent_groups g where g.manager_key = 'unassigned'
),
global_stats as (
  select jsonb_build_object(
    'total',      count(*),
    'f2f',        count(*) filter (where am.meeting_type = 'f2f'),
    'googleMeet', count(*) filter (where am.meeting_type = 'online'
                                     and am.online_platform is distinct from 'zoom'),
    'successful', count(*) filter (where am.outcome = 'successful'),
    'followUp',   count(*) filter (where am.outcome = 'follow_up'),
    'noDecision', count(*) filter (where am.outcome = 'no_decision'),
    'lost',       count(*) filter (where am.outcome = 'lost_opportunity')) as stats,
    count(*)::int as total
  from all_meetings am
)
select jsonb_build_object(
  'stats',         (select stats from global_stats),
  'filteredTotal', (select count(*)::int from filtered),
  'allTotal',      (select total from global_stats),
  'managers',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', mr.id, 'label', mr.full_name,
        'agentCount', mr.agent_count,
        'meetingCount', mr.meeting_count,
        'ownMeetingCount', mr.own_meeting_count,
        'tagAlongCount', mr.tag_along_count,
        'stats', mr.stats
      ) order by mr.full_name)
      from manager_rows mr
    ), '[]'::jsonb)
    ||
    coalesce((
      select case when u.agent_count > 0 then jsonb_build_array(jsonb_build_object(
        'key', 'unassigned', 'label', 'Unassigned',
        'agentCount', u.agent_count,
        'meetingCount', u.meeting_count,
        'ownMeetingCount', 0,
        'tagAlongCount', 0,
        'stats', (
          select jsonb_build_object(
            'total',      count(*),
            'f2f',        count(*) filter (where am.meeting_type = 'f2f'),
            'googleMeet', count(*) filter (where am.meeting_type = 'online'
                                             and am.online_platform is distinct from 'zoom'),
            'successful', count(*) filter (where am.outcome = 'successful'),
            'followUp',   count(*) filter (where am.outcome = 'follow_up'),
            'noDecision', count(*) filter (where am.outcome = 'no_decision'),
            'lost',       count(*) filter (where am.outcome = 'lost_opportunity'))
          from all_meetings am where am.manager_key = 'unassigned')
      )) else '[]'::jsonb end
      from unassigned_rows u
    ), '[]'::jsonb),
  'agents',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'agentId', g.agent_key, 'agentName', g.agent_name,
        'managerKey', g.manager_key,
        'meetingCount', g.meeting_count,
        'tagAlongCount', g.tag_along_count
      ) order by g.agent_name)
      from agent_groups g
    ), '[]'::jsonb)
);
$$;

revoke all on function public.get_meetings_overview(text, text, text, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.get_meetings_overview(text, text, text, timestamptz, timestamptz)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 2b. One meeting as the page renders it
--
-- Factored out so the paged list and the deep-link lookup below cannot drift
-- into returning differently shaped rows — the detail dialog is opened from
-- both, and a field present on one path and absent on the other would surface
-- as an empty cell only when you arrived via a link.
--
-- Columns are named explicitly rather than taken with to_jsonb(m), for the same
-- reason use-meetings.ts names them instead of selecting *: this database is
-- shared with the mobile repo, which adds columns without a migration landing
-- here first. Keep in step with MEETING_COLUMNS there.
-- ----------------------------------------------------------------------------
create or replace function app_private.meeting_row(p_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', m.id,
    'client_id', m.client_id,
    'agent_id', m.agent_id,
    'recorded_by', m.recorded_by,
    'meeting_type', m.meeting_type,
    'online_platform', m.online_platform,
    'location_type', m.location_type,
    'location_name', m.location_name,
    'gps_lat', m.gps_lat,
    'gps_lng', m.gps_lng,
    'photo_url', m.photo_url,
    'agenda', m.agenda,
    'remarks', m.remarks,
    'outcome', m.outcome,
    'contact_person', m.contact_person,
    'contact_position', m.contact_position,
    'meeting_date', m.meeting_date,
    'created_at', m.created_at,
    'start_photo_url', m.start_photo_url,
    'start_captured_at', m.start_captured_at,
    'end_photo_url', m.end_photo_url,
    'end_captured_at', m.end_captured_at,
    'end_gps_lat', m.end_gps_lat,
    'end_gps_lng', m.end_gps_lng,
    'client_status_at_meeting', m.client_status_at_meeting,
    'client', case when c.id is null then null else jsonb_build_object(
      'id', c.id, 'company_name', c.company_name, 'office_address', c.office_address,
      'city', c.city, 'province', c.province, 'customer_type', c.customer_type,
      'status', c.status) end,
    'agent', case when ag.id is null then null else jsonb_build_object(
      'id', ag.id, 'user_id', ag.user_id, 'full_name', ag.full_name, 'role', ag.role,
      'team_id', ag.team_id, 'avatar_url', ag.avatar_url, 'created_at', ag.created_at) end,
    'recorder', case when rc.id is null then null else jsonb_build_object(
      'id', rc.id, 'user_id', rc.user_id, 'full_name', rc.full_name, 'role', rc.role,
      'team_id', rc.team_id, 'avatar_url', rc.avatar_url, 'created_at', rc.created_at) end,
    -- Companions travel WITH the row. The page previously loaded the whole
    -- ledger once and looked each meeting up in it; carrying them per row is
    -- what lets that entire fetch go away.
    'companions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'invitee_id', t.invitee_id,
        'invitee_name', iv.full_name,
        'invitee_kind', t.invitee_kind,
        'requester_id', t.requester_id,
        'requester_name', rq.full_name,
        'status', t.status,
        'context', t.context,
        'related_meeting_id', t.related_meeting_id,
        'created_at', t.created_at,
        'responded_at', t.responded_at
      ) order by iv.full_name)
      from public.tag_along_requests t
      left join public.profiles iv on iv.id = t.invitee_id
      left join public.profiles rq on rq.id = t.requester_id
      where t.related_meeting_id = m.id
    ), '[]'::jsonb)
  )
  from public.meetings m
  left join public.clients  c  on c.id  = m.client_id
  left join public.profiles ag on ag.id = m.agent_id
  left join public.profiles rc on rc.id = m.recorded_by
  where m.id = p_id;
$$;

revoke all on function app_private.meeting_row(uuid) from public, anon;


-- ----------------------------------------------------------------------------
-- 3. get_meetings_page
--
-- Returns { rows, total, stats, tagAlongCount }.
--
-- SORTING: the six sort keys move into SQL here. Rather than dynamic SQL, each
-- row is given ONE sortable text value chosen by `p_sort_key`, and the whole
-- result is ordered by that. This keeps the ordering a plain expression — no
-- `format()`, no identifier interpolation, so an unrecognised sort key can only
-- yield a null sort value, never an injection.
--
-- The date key is rendered as a sortable ISO timestamp so lexical ordering is
-- chronological; the outcome key as a zero-padded rank so it follows the
-- page's own OUTCOME_ORDER rather than alphabetical.
--
-- The tiebreak is the client name ASCENDING regardless of direction, matching
-- the TypeScript exactly (`return x ? dir * x : byClient` — the fallback never
-- has `dir` applied). `id` is appended as a final total order, which the
-- client-side sort did not need but server-side paging does: without it, rows
-- equal on both keys could reshuffle between pages.
-- ----------------------------------------------------------------------------
create or replace function public.get_meetings_page(
  p_search    text        default null,
  p_outcome   text        default 'all',
  p_type      text        default 'all',
  p_from      timestamptz default null,
  p_to        timestamptz default null,
  p_scope_kind text       default 'agent',
  p_scope_id  text        default null,
  p_sort_key  text        default 'date',
  p_sort_dir  text        default 'desc',
  -- The outcome ranking, passed IN rather than hardcoded here, so the page's
  -- OUTCOME_ORDER stays the single definition and this SQL cannot drift from
  -- it. Same reasoning as p_milestones on get_clients_page (131). The default
  -- is a safety net for a direct call, not the source of truth.
  p_outcome_order text[]  default array['successful','follow_up','no_decision','lost_opportunity'],
  p_limit     int         default 10,
  p_offset    int         default 0
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
managers as (
  select p.id from public.profiles p
  where p.role = 'sales_manager' and p.is_active is distinct from false
),
-- The scope id as a uuid, or null when it is not one. Bucket and agent keys
-- carry an 'unassigned' sentinel, so a bare cast would raise 22P02. Parsing
-- once also keeps every comparison uuid = uuid, which is what lets the
-- indexes from 130 be used at all.
scope as (
  select case
    when p_scope_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then p_scope_id::uuid
  end as id
),
filtered as (
  select * from app_private.filtered_meetings(p_search, p_outcome, p_type, p_from, p_to)
),
scoped as (
  select f.*
  from filtered f, scope s
  where case
    when p_scope_kind = 'agent' then
      (case when s.id is null then f.agent_id is null else f.agent_id = s.id end)
      and (f.agent_id is null or not exists (select 1 from managers m where m.id = f.agent_id))
    when p_scope_kind = 'manager' then
      s.id is not null and (
        f.agent_id = s.id
        or f.recorded_by = s.id
        or exists (
          select 1 from public.tag_along_requests t
          where t.related_meeting_id = f.id
            and t.invitee_id = s.id
            and t.status in ('accepted', 'pending')
        )
      )
    else false
  end
),
-- One sortable value per row, chosen by p_sort_key.
sortable as (
  select
    sc.id,
    sc.meeting_date,
    lower(coalesce(c.company_name, '')) as client_sort,
    case p_sort_key
      when 'client'   then lower(coalesce(c.company_name, ''))
      when 'agent'    then lower(coalesce(ag.full_name, ''))
      when 'type'     then sc.meeting_type
      when 'location' then lower(case when m.location_type = 'client_office'
                                      then 'client office'
                                      else coalesce(m.location_name, '') end)
      when 'date'     then to_char(sc.meeting_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')
      when 'outcome'  then lpad(coalesce(array_position(p_outcome_order, sc.outcome), 99)::text, 2, '0')
    end as sort_value
  from scoped sc
  join public.meetings m on m.id = sc.id
  left join public.clients  c  on c.id  = sc.client_id
  left join public.profiles ag on ag.id = sc.agent_id
),
windowed as (
  select s.id
  from sortable s
  order by
    case when p_sort_dir = 'asc'  then s.sort_value end asc  nulls last,
    case when p_sort_dir <> 'asc' then s.sort_value end desc nulls last,
    s.client_sort asc,
    s.id asc
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
),
rows_out as (
  select w.id, s.sort_value, s.client_sort, app_private.meeting_row(w.id) as obj
  from windowed w
  join sortable s on s.id = w.id
)
select jsonb_build_object(
  -- Ordered inside the aggregate: a CTE's own ORDER BY is not carried through
  -- jsonb_agg, so the window would otherwise arrive in planner order.
  'rows', coalesce((
    select jsonb_agg(r.obj order by
      case when p_sort_dir = 'asc'  then r.sort_value end asc  nulls last,
      case when p_sort_dir <> 'asc' then r.sort_value end desc nulls last,
      r.client_sort asc,
      r.id asc)
    from rows_out r), '[]'::jsonb),
  'total', (select count(*)::int from scoped),
  'stats', (
    select jsonb_build_object(
      'total',      count(*),
      'f2f',        count(*) filter (where sc.meeting_type = 'f2f'),
      'googleMeet', count(*) filter (where sc.meeting_type = 'online'
                                       and sc.online_platform is distinct from 'zoom'),
      'successful', count(*) filter (where sc.outcome = 'successful'),
      'followUp',   count(*) filter (where sc.outcome = 'follow_up'),
      'noDecision', count(*) filter (where sc.outcome = 'no_decision'),
      'lost',       count(*) filter (where sc.outcome = 'lost_opportunity'))
    from scoped sc),
  -- "How many of these meetings had a companion" — the reverse direction from
  -- a manager bucket's tagAlongCount, which counts meetings they were invited
  -- TO. For an agent group this is "had someone along", not "was someone along".
  'tagAlongCount', (
    select count(*)::int from scoped sc
    where exists (
      select 1 from public.tag_along_requests t
      where t.related_meeting_id = sc.id and t.status <> 'cancelled'))
);
$$;

revoke all on function public.get_meetings_page(text, text, text, timestamptz, timestamptz, text, text, text, text, text[], int, int)
  from public, anon;
grant execute on function public.get_meetings_page(text, text, text, timestamptz, timestamptz, text, text, text, text, text[], int, int)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 4. get_meeting_detail — one meeting by id, for the ?meeting=<id> deep link
--
-- The Maps meeting-history panel links straight to a single record, and the
-- page used to resolve that against the full in-memory list. With the list
-- paged server-side the linked meeting is usually not in the current window,
-- so it is fetched on its own.
--
-- Deliberately unfiltered and unscoped: the admin followed a link to one
-- record, not to a search, so it must resolve whatever the filters or the
-- current drill-down happen to say. That mirrors the old behaviour, which
-- looked the id up in `meetings` rather than in `filtered`.
-- ----------------------------------------------------------------------------
create or replace function public.get_meeting_detail(p_meeting_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select app_private.meeting_row(p_meeting_id);
$$;

revoke all on function public.get_meeting_detail(uuid) from public, anon;
grant execute on function public.get_meeting_detail(uuid) to authenticated;
