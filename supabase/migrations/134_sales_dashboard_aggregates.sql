-- ============================================================================
-- 134 — Server-side aggregates for the Sales dashboard
--
-- WHY: the dashboard shows metric cards, a twelve-month trend, a per-agent
-- performance table and five recent meetings. Every one of those is a COUNT or
-- a GROUP BY, and the page computed all of them in JavaScript over every
-- meeting in the company — downloading the whole table to display about thirty
-- numbers. This is the clearest case in the app for aggregating in Postgres:
-- the page wants totals, not rows.
--
-- TIMEZONE. This is the subtle part, and the reason `p_tz` exists.
--
-- The component buckets months with date-fns' `isSameMonth(new Date(...),
-- new Date())`, which resolves in the BROWSER's local zone. A bare
-- `date_trunc('month', meeting_date)` here would resolve in the database's
-- zone, which is UTC. At UTC+8 (Manila) every meeting logged after 16:00 UTC
-- on the last day of a month would move into the next month, and the card would
-- disagree with the Meetings page for no visible reason. So the caller passes
-- its IANA zone and every bucket boundary is computed in it.
--
-- SCOPES. Three different sets, and mixing them up is the easy mistake:
--
--   team_meetings   — team filter only. Drives the metric cards, the trend,
--                     the outcome breakdown and the recent list. Deliberately
--                     NOT affected by the performance table's own agent and
--                     date filters.
--   month_meetings  — team_meetings narrowed to the current calendar month.
--                     The metric cards are "this month" figures.
--   scoped_meetings — team_meetings plus the agent and date filters. Drives
--                     the Agent Performance table alone.
--
-- SECURITY: SECURITY DEFINER, and the grant block names BOTH anon paths per
-- migration 132 — `revoke ... from public` alone does not close anon access,
-- because Supabase's default privileges also issue a direct grant.
-- ============================================================================

create or replace function public.get_sales_dashboard(
  p_team_id  uuid        default null,
  p_agent_id uuid        default null,
  p_from     timestamptz default null,
  p_to       timestamptz default null,
  -- IANA zone of the caller, e.g. 'Asia/Manila'. See the header.
  p_tz       text        default 'UTC',
  -- Roles that appear in the Agent Performance table, passed in from the
  -- component's FIELD_AGENT_ROLES so that stays the single definition.
  p_agent_roles text[]   default array['sales_specialist', 'rsr']
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
-- Every meeting in the team scope, with the agent's team resolved.
team_meetings as (
  select
    m.id, m.agent_id, m.outcome, m.meeting_date,
    ag.team_id as agent_team_id,
    c.customer_type
  from public.meetings m
  left join public.profiles ag on ag.id = m.agent_id
  left join public.clients  c  on c.id  = m.client_id
  where p_team_id is null or ag.team_id = p_team_id
),
-- "This month" in the CALLER's zone, not the server's.
month_meetings as (
  select * from team_meetings
  where date_trunc('month', meeting_date at time zone p_tz)
      = date_trunc('month', now() at time zone p_tz)
),
-- The Agent Performance table's own scope.
scoped_meetings as (
  select * from team_meetings
  where (p_agent_id is null or agent_id = p_agent_id)
    and (p_from is null or meeting_date >= p_from)
    and (p_to   is null or meeting_date <= p_to)
),
scoped_agents as (
  select p.id, p.full_name, p.role, p.team_id
  from public.profiles p
  where p.role = any(p_agent_roles)
    and (p_team_id is null or p.team_id = p_team_id)
),
-- Twelve buckets — this month and the trailing eleven — zero-filled, so the
-- chart shows a real year however the data is distributed. Generated rather
-- than derived from the rows present, which is what the component does.
trend_months as (
  select generate_series(
    date_trunc('month', now() at time zone p_tz) - interval '11 months',
    date_trunc('month', now() at time zone p_tz),
    interval '1 month'
  ) as month_start
),
monthly_trend as (
  select
    tm.month_start,
    count(t.id)::int                                            as total,
    count(t.id) filter (where t.outcome = 'successful')::int    as successful
  from trend_months tm
  left join team_meetings t
    on date_trunc('month', t.meeting_date at time zone p_tz) = tm.month_start
  group by tm.month_start
),
agent_performance as (
  select
    a.id, a.full_name, a.role, a.team_id,
    count(s.id)::int                                          as total,
    count(s.id) filter (where s.outcome = 'successful')::int   as successful,
    count(s.id) filter (where s.outcome = 'follow_up')::int    as follow_up,
    count(s.id) filter (where s.outcome = 'no_decision')::int  as no_decision,
    count(s.id) filter (where s.outcome = 'lost_opportunity')::int as lost
  from scoped_agents a
  left join scoped_meetings s on s.agent_id = a.id
  group by a.id, a.full_name, a.role, a.team_id
),
-- Pending edit requests, scoped by the REQUESTER's team — matching the
-- component, which reads `r.requester?.team_id`.
pending_approvals as (
  select count(*)::int as n
  from public.client_edit_requests r
  left join public.profiles rq on rq.id = r.requested_by
  where r.status = 'pending'
    and (p_team_id is null or rq.team_id = p_team_id)
)
select jsonb_build_object(
  'metrics', jsonb_build_object(
    'monthTotal',  (select count(*)::int from month_meetings),
    'closedDeals', (select count(*)::int from month_meetings where outcome = 'successful'),
    'pending',     (select n from pending_approvals),
    -- A meeting on a client whose type is still unset (mobile's Phase-A
    -- insert) counts toward the total but no stage — the component's
    -- `if (type)` guard drops it rather than guessing, and so does this.
    'byType', (
      select jsonb_build_object(
        'existing',    count(*) filter (where customer_type = 'existing'),
        'new',         count(*) filter (where customer_type = 'new'),
        'in_progress', count(*) filter (where customer_type = 'in_progress'),
        'prospect',    count(*) filter (where customer_type = 'prospect'))
      from month_meetings),
    'successfulByType', (
      select jsonb_build_object(
        'existing',    count(*) filter (where customer_type = 'existing'),
        'new',         count(*) filter (where customer_type = 'new'),
        'in_progress', count(*) filter (where customer_type = 'in_progress'),
        'prospect',    count(*) filter (where customer_type = 'prospect'))
      from month_meetings where outcome = 'successful'),
    'outcomes', (
      select jsonb_build_object(
        'successful',       count(*) filter (where outcome = 'successful'),
        'follow_up',        count(*) filter (where outcome = 'follow_up'),
        'no_decision',      count(*) filter (where outcome = 'no_decision'),
        'lost_opportunity', count(*) filter (where outcome = 'lost_opportunity'))
      from month_meetings)
  ),
  'monthlyTrend', coalesce((
    -- The month LABEL is not built here on purpose: formatting stays in the
    -- component, which already renders dates through date-fns everywhere else.
    select jsonb_agg(jsonb_build_object(
      'monthStart', mt.month_start,
      'total', mt.total,
      'successful', mt.successful) order by mt.month_start)
    from monthly_trend mt), '[]'::jsonb),
  'agentPerformance', coalesce((
    select jsonb_agg(jsonb_build_object(
      'agentId', ap.id,
      'agentName', ap.full_name,
      'agentRole', ap.role,
      'teamId', ap.team_id,
      'total', ap.total,
      'successful', ap.successful,
      'followUp', ap.follow_up,
      'noDecision', ap.no_decision,
      'lost', ap.lost,
      -- Integer percent, rounded, and 0 for an agent with no meetings rather
      -- than a division by zero.
      'rate', case when ap.total > 0
                   then round(ap.successful * 100.0 / ap.total)::int
                   else 0 end)
      -- Busiest first, matching the component's own sort.
      order by ap.total desc, ap.full_name)
    from agent_performance ap), '[]'::jsonb),
  'recentMeetings', coalesce((
    -- Reuses the row projection from 133, so a meeting rendered here has
    -- exactly the shape it has on the Meetings page.
    select jsonb_agg(app_private.meeting_row(r.id) order by r.meeting_date desc, r.id desc)
    from (
      select id, meeting_date from team_meetings
      order by meeting_date desc, id desc
      limit 5
    ) r), '[]'::jsonb)
);
$$;

revoke all on function public.get_sales_dashboard(uuid, uuid, timestamptz, timestamptz, text, text[])
  from public, anon;
grant execute on function public.get_sales_dashboard(uuid, uuid, timestamptz, timestamptz, text, text[])
  to authenticated;
