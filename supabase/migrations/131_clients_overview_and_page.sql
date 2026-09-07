-- ============================================================================
-- 131 — Server-side hierarchy and paging for the web Clients page
--
-- WHY: the Clients page is a drill-down — manager buckets, then the agents
-- under one manager, then a page of nine client cards. To render that it used
-- to download EVERY client (with the assigned agent joined) AND every meeting
-- in the company (with three joins), then group, filter, count and paginate all
-- of it in JavaScript. Nine cards, two whole tables. That is affordable at the
-- four thousand rows a month of operation produced and is not affordable at the
-- twenty to fifty thousand this is being built for.
--
-- This migration moves the two things the browser cannot do cheaply into
-- Postgres:
--
--   get_clients_overview() — the hierarchy and its counts. Returns a few dozen
--     rows (one per manager, one per agent) regardless of table size.
--   get_clients_page()     — one screen of client rows, plus the total behind
--     them and the stat-row breakdown for that scope.
--
-- Between them the page's cost stops scaling with the table.
--
-- WHY SECURITY DEFINER RATHER THAN A PLAIN VIEW OR POSTGREST QUERY:
--
--   1. A manager's own client set is a UNION across three unrelated sources —
--      clients they hold meetings for (`meetings.agent_id`/`recorded_by`), the
--      tag-along ledger, and direct assignment. PostgREST cannot express it.
--   2. `tag_along_requests` is invisible to admins under RLS: migration 019
--      scopes SELECT to the requester and the invitee, and an admin is neither.
--      A read of it from an admin's session returns an empty set — not an
--      error — so any aggregate touching it MUST run as definer. This is the
--      same reason lib/tag-along/actions.ts goes through the service role.
--
-- Follows the shape of get_company_directory() (030): security definer, stable,
-- pinned search_path, execute granted to `authenticated` only. The web is
-- superadmin/admin-only at the route layer (proxy.ts), which is what makes an
-- unscoped read here appropriate.
--
-- FIDELITY IS THE POINT. Every count below reproduces a specific rule that the
-- TypeScript already implements, several of which are documented there as bugs
-- that were fixed once already. The rules, and where they come from:
--
--   * `status = 'deleted'` is excluded everywhere. The Status filter has no
--     "Deleted" option, so "All Status" must not quietly include them.
--   * A NULL `customer_type` reads as 'prospect'. Mobile's two-phase create
--     (013) inserts a company name and fills the rest later, and 040 treats
--     null and 'prospect' as one stage.
--   * The 'prospect' type filter is a FAMILY: it returns 'in_progress' rows
--     too. The 'in_progress' option isolates the subset.
--   * A manager who is directly `assigned_agent_id` on a client (legacy
--     "manager as agent" data) is NOT listed as an agent under themselves.
--     Those clients land in the manager's own bucket instead.
--   * `recorded_by` is NOT "tagged along". A manager invited along on twenty
--     agent visits records none of them; real tag-alongs come from the ledger.
--     The two are counted separately and must stay separate.
--   * A manager's team total CONCATENATES their own clients with their agents'
--     rather than deduplicating, so the bucket's number always equals the
--     manager's own count plus each agent group's count shown beneath it. A
--     client both assigned to an agent and tagged along on by the manager is
--     deliberately counted twice.
--
-- MOBILE, PLEASE NOTE: additive only. Three new read-only functions, no schema
-- change, no policy change, nothing dropped or altered.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The filtered client set, shared by both entry points
--
-- Extracted into app_private rather than repeated in each function: the two
-- RPCs must apply IDENTICAL filter semantics or the overview's counts stop
-- matching the rows the page returns, which is the single most damaging way
-- this can go wrong. One definition, two callers, no drift.
--
-- Returns the columns the grouping and counting need — not the full client row.
-- get_clients_page() joins back to `clients` for the rest.
-- ----------------------------------------------------------------------------
create or replace function app_private.filtered_clients(
  p_search  text default null,
  p_type    text default 'all',
  p_channel text default 'all',
  p_status  text default 'all',
  p_source  text default 'all'
)
returns table (
  id                uuid,
  customer_type     text,
  status            text,
  assigned_agent_id uuid,
  agent_team_id     uuid,
  created_at        timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select
    c.id,
    -- Null reads as 'prospect' — see the header.
    coalesce(c.customer_type, 'prospect') as customer_type,
    c.status,
    c.assigned_agent_id,
    ag.team_id as agent_team_id,
    c.created_at
  from public.clients c
  left join public.profiles ag on ag.id = c.assigned_agent_id
  where c.status <> 'deleted'
    -- Search spans the client and the agent who holds them, matching the three
    -- fields the page's own search box reads.
    and (
      p_search is null or p_search = ''
      or c.company_name    ilike '%' || p_search || '%'
      or c.contact_person  ilike '%' || p_search || '%'
      or coalesce(ag.full_name, '') ilike '%' || p_search || '%'
    )
    and (
      p_type = 'all'
      or coalesce(c.customer_type, 'prospect') = p_type
      -- 'Prospect' is the family, not the single value.
      or (p_type = 'prospect' and coalesce(c.customer_type, 'prospect') = 'in_progress')
    )
    and (p_channel = 'all' or c.sales_channel = p_channel)
    and (p_status  = 'all' or c.status = p_status)
    and (
      p_source = 'all'
      -- 'unknown' is its own option, not a catch-all: a null created_source
      -- means the row predates 127 or came from mobile, which is genuinely
      -- different from "a person typed it in here".
      or (p_source = 'unknown' and c.created_source is null)
      or (p_source <> 'unknown' and c.created_source = p_source)
    );
$$;

revoke all on function app_private.filtered_clients(text, text, text, text, text) from public;


-- ----------------------------------------------------------------------------
-- 2. get_clients_overview — the hierarchy and every count on it
--
-- Shape of the returned jsonb:
--
--   {
--     "stats":    { total, existing, new, inProgress, prospect, active, lost },
--     "managers": [ { key, label, agentCount, clientCount, ownClientCount,
--                     tagAlongCount, managerClientCount, stats {…} } ],
--     "agents":   [ { agentId, agentName, managerKey, clientCount } ]
--   }
--
-- `stats` at the top level is computed over EVERY visible client, deliberately
-- ignoring the filters — it is what the page shows when nothing is selected,
-- and the TypeScript reads `visibleClients` there rather than `filtered`.
-- Each manager carries its own `stats` for the case where their bucket is
-- expanded but not drilled into.
-- ----------------------------------------------------------------------------
create or replace function public.get_clients_overview(
  p_search  text default null,
  p_type    text default 'all',
  p_channel text default 'all',
  p_status  text default 'all',
  p_source  text default 'all'
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
-- Active sales managers, alphabetical — the top level of the hierarchy.
managers as (
  select p.id, p.full_name, p.team_id
  from public.profiles p
  where p.role = 'sales_manager'
    and p.is_active is distinct from false
),
-- Which manager leads each team. A team's manager is not a separate role, just
-- the active sales_manager sharing its team_id (010). `distinct on` with the
-- full_name ordering picks the same one lib/teams.ts's managerForTeam() does,
-- which scans an alphabetically sorted manager list and takes the first match.
team_manager as (
  select distinct on (team_id) team_id, id as manager_id
  from managers
  where team_id is not null
  order by team_id, full_name, id
),
filtered as (
  select * from app_private.filtered_clients(p_search, p_type, p_channel, p_status, p_source)
),
-- Clients that belong to an AGENT group: everything except those held directly
-- by a manager, who is never listed as an agent under themselves.
agent_clients as (
  select
    f.*,
    coalesce(f.assigned_agent_id::text, 'unassigned') as agent_key,
    coalesce(tm.manager_id::text, 'unassigned')       as manager_key
  from filtered f
  left join team_manager tm on tm.team_id = f.agent_team_id
  where f.assigned_agent_id is null
     or not exists (select 1 from managers m where m.id = f.assigned_agent_id)
),
agent_groups as (
  select
    ac.agent_key,
    coalesce(max(ag.full_name), 'Unassigned') as agent_name,
    ac.manager_key,
    count(*)::int as client_count
  from agent_clients ac
  left join public.profiles ag on ag.id = ac.assigned_agent_id
  group by ac.agent_key, ac.manager_key
),
-- A manager's own clients arrive three ways. Built as three indexed lookups
-- unioned together rather than one correlated EXISTS per manager per client:
-- the latter is a cross join, which is exactly the shape that stops working at
-- fifty thousand rows.
own_by_meeting as (
  select distinct manager_id, client_id from (
    select m.id as manager_id, mt.client_id
    from managers m join public.meetings mt on mt.agent_id = m.id
    union
    select m.id, mt.client_id
    from managers m join public.meetings mt on mt.recorded_by = m.id
  ) s
),
own_by_tagalong as (
  select distinct m.id as manager_id, t.related_client_id as client_id
  from managers m
  join public.tag_along_requests t on t.invitee_id = m.id
  where t.related_client_id is not null
    -- Accepted and pending both count: the manager was asked either way, and a
    -- pending invite is precisely the one worth seeing. Declined and cancelled
    -- do not — nobody attended those.
    and t.status in ('accepted', 'pending')
),
own_by_assignment as (
  select m.id as manager_id, f.id as client_id
  from managers m join filtered f on f.assigned_agent_id = m.id
),
-- One row per (manager, client) they own, carrying WHICH of the three routes
-- claimed it. The flags stay separate because the UI reports "own records" and
-- "tagged along" as two distinct figures.
manager_clients as (
  select
    s.manager_id,
    s.client_id,
    max(s.by_meeting)  as by_meeting,
    max(s.by_tagalong) as by_tagalong
  from (
    select manager_id, client_id, 1 as by_meeting, 0 as by_tagalong from own_by_meeting
    union all
    select manager_id, client_id, 0, 1 from own_by_tagalong
    union all
    select manager_id, client_id, 0, 0 from own_by_assignment
  ) s
  -- Restricted to the filtered set: an owned client that the current filters
  -- exclude must not be counted.
  join filtered f on f.id = s.client_id
  group by s.manager_id, s.client_id
),
manager_client_rows as (
  select mc.manager_id, mc.by_meeting, mc.by_tagalong, f.customer_type, f.status
  from manager_clients mc
  join filtered f on f.id = mc.client_id
),
-- The team multiset: a manager's own clients CONCATENATED with their agents',
-- not deduplicated. See the header.
team_rows as (
  select manager_id, customer_type, status from manager_client_rows
  union all
  select (ac.manager_key)::uuid, ac.customer_type, ac.status
  from agent_clients ac
  where ac.manager_key <> 'unassigned'
),
manager_rows as (
  select
    m.id,
    m.full_name,
    (select count(*)::int from agent_groups g where g.manager_key = m.id::text) as agent_count,
    (select count(*)::int from manager_client_rows r
      where r.manager_id = m.id and r.by_meeting = 1)                            as own_client_count,
    (select count(*)::int from manager_client_rows r
      where r.manager_id = m.id and r.by_tagalong = 1)                           as tag_along_count,
    (select count(*)::int from manager_client_rows r where r.manager_id = m.id)  as manager_client_count,
    (select count(*)::int from team_rows t where t.manager_id = m.id)            as client_count,
    (select jsonb_build_object(
        'total',      count(*),
        'existing',   count(*) filter (where t.customer_type = 'existing'),
        'new',        count(*) filter (where t.customer_type = 'new'),
        'inProgress', count(*) filter (where t.customer_type = 'in_progress'),
        'prospect',   count(*) filter (where t.customer_type = 'prospect'),
        'active',     count(*) filter (where t.status = 'active'),
        'lost',       count(*) filter (where t.status = 'lost'))
      from team_rows t where t.manager_id = m.id)                                as stats
  from managers m
),
-- The Unassigned bucket exists only when something is actually in it.
unassigned_rows as (
  select
    count(distinct g.agent_key)::int as agent_count,
    coalesce(sum(g.client_count), 0)::int as client_count
  from agent_groups g
  where g.manager_key = 'unassigned'
),
-- The default stat row: every visible client, ignoring the page's filters.
global_stats as (
  select jsonb_build_object(
    'total',      count(*),
    'existing',   count(*) filter (where coalesce(c.customer_type, 'prospect') = 'existing'),
    'new',        count(*) filter (where coalesce(c.customer_type, 'prospect') = 'new'),
    'inProgress', count(*) filter (where coalesce(c.customer_type, 'prospect') = 'in_progress'),
    'prospect',   count(*) filter (where coalesce(c.customer_type, 'prospect') = 'prospect'),
    'active',     count(*) filter (where c.status = 'active'),
    'lost',       count(*) filter (where c.status = 'lost')) as stats
  from public.clients c
  where c.status <> 'deleted'
)
select jsonb_build_object(
  'stats', (select stats from global_stats),
  -- The header reads "<filtered> of <visible> clients", so both totals travel
  -- with the hierarchy rather than being inferred from the page window.
  'filteredTotal', (select count(*)::int from filtered),
  'visibleTotal',  (select (stats->>'total')::int from global_stats),
  'managers',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',                mr.id,
        'label',              mr.full_name,
        'agentCount',         mr.agent_count,
        'clientCount',        mr.client_count,
        'ownClientCount',     mr.own_client_count,
        'tagAlongCount',      mr.tag_along_count,
        'managerClientCount', mr.manager_client_count,
        'stats',              mr.stats
      ) order by mr.full_name)
      from manager_rows mr
    ), '[]'::jsonb)
    ||
    coalesce((
      select case when u.agent_count > 0 then jsonb_build_array(jsonb_build_object(
        'key',                'unassigned',
        'label',              'Unassigned',
        'agentCount',         u.agent_count,
        'clientCount',        u.client_count,
        'ownClientCount',     0,
        'tagAlongCount',      0,
        'managerClientCount', 0,
        'stats',              (
          select jsonb_build_object(
            'total',      count(*),
            'existing',   count(*) filter (where ac.customer_type = 'existing'),
            'new',        count(*) filter (where ac.customer_type = 'new'),
            'inProgress', count(*) filter (where ac.customer_type = 'in_progress'),
            'prospect',   count(*) filter (where ac.customer_type = 'prospect'),
            'active',     count(*) filter (where ac.status = 'active'),
            'lost',       count(*) filter (where ac.status = 'lost'))
          from agent_clients ac where ac.manager_key = 'unassigned')
      )) else '[]'::jsonb end
      from unassigned_rows u
    ), '[]'::jsonb),
  'agents',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'agentId',     g.agent_key,
        'agentName',   g.agent_name,
        'managerKey',  g.manager_key,
        'clientCount', g.client_count
      ) order by g.agent_name)
      from agent_groups g
    ), '[]'::jsonb)
);
$$;

revoke all on function public.get_clients_overview(text, text, text, text, text) from public;
grant execute on function public.get_clients_overview(text, text, text, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 3. get_clients_page — one screen of rows
--
-- Returns { rows, total, stats }: the window, the count behind it for the
-- pager, and the stat-row breakdown for this exact scope so the numbers above
-- the table always describe the table.
--
-- `p_scope_kind` is 'agent' or 'manager'. There is no unscoped mode because the
-- page has none — the table only ever appears once an agent or a manager has
-- been drilled into.
--
-- THE PROGRESS RING: `p_milestones` carries the six agenda topics from
-- lib/client-progress.ts. They are passed IN rather than hardcoded here on
-- purpose. Web's ring mirrors mobile's unweighted "qualified agenda progress"
-- (6 topics, coverage across a client's meetings); the database's own
-- get_client_cycle_progress() (038) computes something different — weighted by
-- agenda_catalog and capped at 90. Swapping one for the other would silently
-- change every number on the page. Keeping the list in TypeScript keeps one
-- source of truth and makes it impossible for this SQL to drift from it.
-- ----------------------------------------------------------------------------
create or replace function public.get_clients_page(
  p_search     text    default null,
  p_type       text    default 'all',
  p_channel    text    default 'all',
  p_status     text    default 'all',
  p_source     text    default 'all',
  p_scope_kind text    default 'agent',
  p_scope_id   text    default null,
  p_milestones text[]  default '{}',
  p_limit      int     default 9,
  p_offset     int     default 0
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
  where p.role = 'sales_manager'
    and p.is_active is distinct from false
),
filtered as (
  select * from app_private.filtered_clients(p_search, p_type, p_channel, p_status, p_source)
),
-- The scope id as a uuid, or null when it is not one.
--
-- Both bucket keys and agent keys carry an 'unassigned' sentinel rather than a
-- uuid, so a bare `p_scope_id::uuid` would raise 22P02 the moment someone
-- opened that bucket. Parsing once here also means every comparison below is
-- uuid = uuid: casting the COLUMN instead (`agent_id::text = p_scope_id`) is
-- silently disastrous, because it makes the predicate unindexable and throws
-- away exactly the indexes migration 130 added for it.
scope as (
  select case
    when p_scope_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then p_scope_id::uuid
  end as id
),
-- The rows in scope, before windowing. Both arms mirror the corresponding
-- selection in get_clients_overview exactly.
scoped as (
  select f.*
  from filtered f, scope s
  where
    case
      when p_scope_kind = 'agent' then
        (
          case when s.id is null then f.assigned_agent_id is null
               else f.assigned_agent_id = s.id end
        )
        and (
          f.assigned_agent_id is null
          or not exists (select 1 from managers m where m.id = f.assigned_agent_id)
        )
      when p_scope_kind = 'manager' then
        s.id is not null
        and (
          f.assigned_agent_id = s.id
          or exists (
            select 1 from public.meetings mt
            where mt.client_id = f.id
              and (mt.agent_id = s.id or mt.recorded_by = s.id)
          )
          or exists (
            select 1 from public.tag_along_requests t
            where t.related_client_id = f.id
              and t.invitee_id = s.id
              and t.status in ('accepted', 'pending')
          )
        )
      else false
    end
),
-- Newest first with `id` as the tiebreaker, matching the order the page's own
-- list arrived in. The tiebreaker is load-bearing: the bulk import stamps 200
-- rows per statement with an identical created_at, and a page boundary landing
-- inside such a tie repeats one row while dropping another.
windowed as (
  select s.id
  from scoped s
  order by s.created_at desc, s.id desc
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
),
-- Columns are named explicitly rather than taken with `to_jsonb(c)`, for the
-- same reason lib/hooks/use-clients.ts names them instead of selecting `*`:
-- this database is shared with the mobile repo, which adds columns without a
-- migration landing here first. A whole-row projection would quietly widen
-- every payload and let unmodelled fields reach the UI untyped. Keep this list
-- in step with CLIENT_COLUMNS there.
rows_out as (
  select
    c.created_at,
    c.id,
    jsonb_build_object(
      'id', c.id,
      'company_name', c.company_name,
      'contact_person', c.contact_person,
      'contact_position', c.contact_position,
      'contact_number', c.contact_number,
      'office_address', c.office_address,
      'customer_type', c.customer_type,
      'sales_channel', c.sales_channel,
      'assigned_agent_id', c.assigned_agent_id,
      'status', c.status,
      'lost_at', c.lost_at,
      'reassignable_at', c.reassignable_at,
      'created_at', c.created_at,
      'updated_at', c.updated_at,
      'address_line1', c.address_line1,
      'address_line2', c.address_line2,
      'landmark', c.landmark,
      'province', c.province,
      'city', c.city,
      'details_deadline_at', c.details_deadline_at,
      'details_completed_at', c.details_completed_at,
      'inactive_reason', c.inactive_reason,
      'office_lat', c.office_lat,
      'office_lng', c.office_lng,
      'office_pin_source', c.office_pin_source,
      'office_pin_updated_at', c.office_pin_updated_at,
      'created_source', c.created_source,
      'credit_balance', c.credit_balance,
      'agent',
      case when ag.id is null then null else jsonb_build_object(
        'id', ag.id, 'user_id', ag.user_id, 'full_name', ag.full_name,
        'email', ag.email, 'role', ag.role, 'team_id', ag.team_id,
        'is_active', ag.is_active, 'avatar_url', ag.avatar_url,
        'created_at', ag.created_at) end,
      -- Coverage of the six milestone topics across every meeting this client
      -- has, as a percentage. `distinct` because two meetings covering the same
      -- topic is still one milestone.
      'progressPercent',
      (select round(count(distinct a) * 100.0 / greatest(array_length(p_milestones, 1), 1))
       from public.meetings mt
       cross join lateral unnest(mt.agenda) as a
       where mt.client_id = c.id and a = any(p_milestones))
    ) as obj
  from windowed w
  join public.clients c on c.id = w.id
  left join public.profiles ag on ag.id = c.assigned_agent_id
)
select jsonb_build_object(
  -- Ordered inside the aggregate: a CTE's own ORDER BY is not carried through
  -- jsonb_agg, so sorting `rows_out` alone would leave the page's order to the
  -- planner's discretion.
  'rows',  coalesce((select jsonb_agg(r.obj order by r.created_at desc, r.id desc) from rows_out r), '[]'::jsonb),
  'total', (select count(*)::int from scoped),
  'stats', (
    select jsonb_build_object(
      'total',      count(*),
      'existing',   count(*) filter (where s.customer_type = 'existing'),
      'new',        count(*) filter (where s.customer_type = 'new'),
      'inProgress', count(*) filter (where s.customer_type = 'in_progress'),
      'prospect',   count(*) filter (where s.customer_type = 'prospect'),
      'active',     count(*) filter (where s.status = 'active'),
      'lost',       count(*) filter (where s.status = 'lost'))
    from scoped s
  )
);
$$;

revoke all on function public.get_clients_page(text, text, text, text, text, text, text, text[], int, int) from public;
grant execute on function public.get_clients_page(text, text, text, text, text, text, text, text[], int, int) to authenticated;
