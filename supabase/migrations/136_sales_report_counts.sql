-- ============================================================================
-- 136 — Card counts for the Sales lens on Reports
--
-- WHY, and what this deliberately does NOT do.
--
-- The Reports page mounted six full-table hooks — meetings, clients, clock
-- records, tag-alongs, profiles, teams — on open. It did that for two separate
-- reasons, and only one of them is worth fixing this way:
--
--   1. To print three numbers and nine stat tiles on the cards. That is pure
--      aggregation and belongs here.
--   2. So the Download buttons COULD work if pressed. That is not aggregation —
--      an export is every row by definition, and no amount of SQL removes that.
--
-- So the cards get this function, and the DOWNLOADS now fetch their rows when
-- the button is pressed rather than on mount. The row-shaping stays in
-- TypeScript: those handlers carry a couple of hundred lines of formatting
-- (agenda joins, GPS pairs, manager-gate labels, companion participants) that a
-- reader diffs against the spreadsheet, not against a migration. Re-expressing
-- it in SQL would risk silent drift in a file nobody checks.
--
-- THE MEETINGS COUNT IS PARTICIPANTS, NOT MEETINGS. This is the subtle one and
-- the reason the card exists in its current form. A meeting with a manager
-- along is TWO records, because two people worked it — the same reading the
-- quota ledger takes (076), and the reason a manager's monthly target is
-- reachable at all. Which companions become a record is 076's rule copied
-- exactly: `invitee_kind = 'manager'`, `status = 'accepted'`, and never the
-- meeting's own agent. Anything looser and this card stops agreeing with the
-- quota panel, which is the whole point of counting attendances.
--
-- Three kinds of companion are therefore NOT records, deliberately: a teammate
-- (no manager quota exists for them to earn), a manager whose request is still
-- pending (076 waits for the answer before crediting anyone), and a declined or
-- cancelled request (nobody attended).
--
-- The outcome tiles are counted over RECORDS for the same reason the total is.
-- Tiles that sum to something other than the number above them is the original
-- bug — 561 meetings once read as 381 + 74 + 4 because 'no_decision' was
-- missing from the tile row entirely.
--
-- SECURITY: SECURITY DEFINER (the tag-along ledger is invisible to admins under
-- RLS), with grants naming BOTH anon paths per migration 132.
-- ============================================================================

create or replace function public.get_sales_report_counts(
  -- null = all agents. A named agent also picks up what they TAGGED ALONG on:
  -- joining an agent's visit is how a manager works an account, and filtering
  -- by ownership alone understated every manager's fortnight.
  p_agent_id uuid        default null,
  -- null = all teams.
  p_team_id  uuid        default null,
  p_from     timestamptz default null,
  p_to       timestamptz default null,
  -- Roles the team filter resolves membership from, mirroring the component's
  -- own agent list.
  p_agent_roles text[]   default array['sales_specialist','sales_manager','rsr']
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
-- Team membership is resolved from `profiles`, not from each row's embedded
-- agent: clock records carry no join and a client's agent may be absent, so one
-- membership set keeps the three reports agreeing on what a team means.
team_agents as (
  select p.id
  from public.profiles p
  where p_team_id is not null
    and p.team_id = p_team_id
    and p.role = any(p_agent_roles)
),
-- What the selected agent reached by tagging along. Empty when no agent is
-- selected, which is what makes the filters below collapse to "everything".
tagged_meetings as (
  select distinct t.related_meeting_id as id
  from public.tag_along_requests t
  where p_agent_id is not null
    and t.invitee_id = p_agent_id
    and t.related_meeting_id is not null
    and t.status in ('accepted', 'pending')
),
tagged_clients as (
  select distinct t.related_client_id as id
  from public.tag_along_requests t
  where p_agent_id is not null
    and t.invitee_id = p_agent_id
    and t.related_client_id is not null
    and t.status in ('accepted', 'pending')
),
filtered_meetings as (
  select m.id, m.agent_id, m.outcome
  from public.meetings m
  where (p_agent_id is null
         or m.agent_id = p_agent_id
         or m.id in (select id from tagged_meetings))
    -- A tagged-along meeting belongs to the agent who logged it, so the team
    -- test stays on agent_id — the row is still that team's work.
    and (p_team_id is null
         or m.agent_id in (select id from team_agents)
         or m.id in (select id from tagged_meetings))
    and (p_from is null or m.meeting_date >= p_from)
    and (p_to   is null or m.meeting_date <= p_to)
),
-- One row per person who was at a meeting. See the header.
meeting_participants as (
  select fm.id, fm.outcome from filtered_meetings fm
  union all
  select fm.id, fm.outcome
  from filtered_meetings fm
  join public.tag_along_requests t
    on t.related_meeting_id = fm.id
   and t.invitee_kind = 'manager'
   and t.status = 'accepted'
   and t.invitee_id is distinct from fm.agent_id
),
filtered_clients as (
  select c.id, c.status, coalesce(c.customer_type, 'prospect') as customer_type
  from public.clients c
  where (p_agent_id is null
         or c.assigned_agent_id = p_agent_id
         or c.id in (select id from tagged_clients))
    and (p_team_id is null
         or c.assigned_agent_id in (select id from team_agents)
         or c.id in (select id from tagged_clients))
    and (p_from is null or c.created_at >= p_from)
    and (p_to   is null or c.created_at <= p_to)
),
-- Clock records have no tag-along dimension: you cannot clock in on someone
-- else's behalf, so the agent and team tests are plain.
filtered_clock as (
  select r.id, r.type, r.action
  from public.clock_records r
  where (p_agent_id is null or r.agent_id = p_agent_id)
    and (p_team_id is null or r.agent_id in (select id from team_agents))
    and (p_from is null or r.timestamp >= p_from)
    and (p_to   is null or r.timestamp <= p_to)
)
select jsonb_build_object(
  'meetings', (
    select jsonb_build_object(
      'count',      count(*)::int,
      'successful', count(*) filter (where outcome = 'successful')::int,
      'followUp',   count(*) filter (where outcome = 'follow_up')::int,
      'noDecision', count(*) filter (where outcome = 'no_decision')::int,
      'lost',       count(*) filter (where outcome = 'lost_opportunity')::int)
    from meeting_participants),
  'clients', (
    select jsonb_build_object(
      'count',  count(*)::int,
      'active', count(*) filter (where status = 'active')::int,
      'lost',   count(*) filter (where status = 'lost')::int,
      -- The prospect FAMILY, in-progress included — the same reading the
      -- Clients page filter takes. The export's per-row Customer Type column
      -- stays precise.
      'prospects', count(*) filter (
        where customer_type in ('prospect', 'in_progress'))::int)
    from filtered_clients),
  'clock', (
    select jsonb_build_object(
      'count',   count(*)::int,
      'office',  count(*) filter (where type = 'office')::int,
      'event',   count(*) filter (where type = 'event')::int,
      'clockIn', count(*) filter (where action = 'in')::int)
    from filtered_clock)
);
$$;

revoke all on function public.get_sales_report_counts(uuid, uuid, timestamptz, timestamptz, text[])
  from public, anon;
grant execute on function public.get_sales_report_counts(uuid, uuid, timestamptz, timestamptz, text[])
  to authenticated;
