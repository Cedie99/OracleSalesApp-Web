-- ============================================================================
-- 141 — Scoped data for the cutoff quota report
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not compute the quota.
--
-- The report is twenty-odd derivations over the attribution ledger — pools and
-- ceilings, working days against holidays, credit spread, the disqualification
-- gate, the manager-tag-along arithmetic that 076 introduced. That is the most
-- business-critical maths in the app, it lives in lib/cutoff.ts where it is
-- commented against the migrations that shaped it, and re-expressing it in SQL
-- would be a second implementation to keep in step. Same call as the report
-- EXPORTS in 136/140: bound the data, leave the arithmetic where it is tested.
--
-- WHAT IT DOES: the report is scoped to ONE CUTOFF PERIOD, which the component
-- already knows before it needs any of this. So rather than reading every
-- client, every meeting, the whole tag-along ledger and the entire attribution
-- table on page load, this returns exactly the slice one period touches.
--
-- THE PERIOD SCOPE, copied from periodAttributions() in lib/cutoff.ts:
--
--   * a ledger row whose `period_id` IS this period, or
--   * a row with a NULL `period_id` whose meeting falls inside the period's
--     days — rows that predate the trigger and are placed by date instead.
--
-- The date comparison is MANILA-local, because `manilaDateOf` is: the cutoff's
-- days are business days in the operating timezone, not the viewer's and not
-- UTC. Hardcoded rather than passed in for that reason — this is a property of
-- the business, not of who is looking.
--
-- Callers that want strict matching still get it: `clientQuotaUsage` and
-- `dailyUsage` both skip any row whose `period_id` is not the period's, so the
-- null-period rows returned here reach only the surfaces that want them.
--
-- SECURITY: SECURITY DEFINER — the tag-along ledger is invisible to admins
-- under RLS (019). Grants name BOTH anon paths per migration 132.
-- ============================================================================

create or replace function public.get_cutoff_quota_data(p_period_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
period as (
  select id, starts_on, ends_on from public.cutoff_periods where id = p_period_id
),
scoped as (
  select a.*
  from public.meeting_cutoff_attributions a
  cross join period p
  left join public.meetings m on m.id = a.meeting_id
  where a.period_id = p.id
     or (
       a.period_id is null
       and m.meeting_date is not null
       and (m.meeting_date at time zone 'Asia/Manila')::date between p.starts_on and p.ends_on
     )
),
-- The meetings, clients and companions those rows reference — nothing else.
touched_meetings as (select distinct meeting_id from scoped where meeting_id is not null),
touched_clients  as (select distinct client_id  from scoped where client_id  is not null)
select jsonb_build_object(
  'attributions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'meeting_id', s.meeting_id,
      'period_id', s.period_id,
      'client_id', s.client_id,
      'agent_id', s.agent_id,
      'captured_client_stage', s.captured_client_stage,
      'captured_agent_role', s.captured_agent_role,
      'captured_team_kind', s.captured_team_kind,
      'participation', s.participation,
      'attribution', s.attribution,
      'slot_index', s.slot_index,
      'attributed_at', s.attributed_at))
    from scoped s), '[]'::jsonb),
  -- Only the columns the report reads: the date that places a row in the
  -- period, and the four fields the disqualification gate reconstructs its
  -- reason from (098's rule — outcome, plus evidence via photo or the
  -- start/end capture pair).
  'meetings', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id,
      'meeting_date', m.meeting_date,
      'outcome', m.outcome,
      'photo_url', m.photo_url,
      'end_photo_url', m.end_photo_url,
      'start_captured_at', m.start_captured_at,
      'client_status_at_meeting', m.client_status_at_meeting))
    from public.meetings m
    join touched_meetings t on t.meeting_id = m.id), '[]'::jsonb),
  -- The export names the client and its agent; nothing else reads a client here.
  'clients', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id,
      'company_name', c.company_name,
      'agent', case when ag.id is null then null else jsonb_build_object(
        'id', ag.id, 'full_name', ag.full_name, 'role', ag.role,
        'team_id', ag.team_id) end))
    from public.clients c
    join touched_clients t on t.client_id = c.id
    left join public.profiles ag on ag.id = c.assigned_agent_id), '[]'::jsonb),
  -- Companions on those meetings. The report counts manager attendances the
  -- ledger does not itself hold, which is why this travels with the slice.
  'tagAlongs', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id,
      'context', t.context,
      'requester_id', t.requester_id,
      'invitee_id', t.invitee_id,
      'invitee_kind', t.invitee_kind,
      'invitee_name', iv.full_name,
      'related_client_id', t.related_client_id,
      'related_meeting_id', t.related_meeting_id,
      'status', t.status,
      'created_at', t.created_at,
      'responded_at', t.responded_at))
    from public.tag_along_requests t
    join touched_meetings tm on tm.meeting_id = t.related_meeting_id
    left join public.profiles iv on iv.id = t.invitee_id), '[]'::jsonb),
  -- Meetings the ledger knows nothing about, as a COUNT rather than a list.
  --
  -- Distinct meeting ids, not the ledger's row count: since 076 a manager who
  -- tagged along carries a row of their own, so a row count runs AHEAD of the
  -- meeting total and this subtraction pinned to zero — the warning that exists
  -- to announce missing meetings could no longer fire, and stayed silent
  -- through a hundred-meeting discrepancy.
  'unattributedMeetingCount', greatest(0,
    (select count(*)::int from public.meetings)
    - (select count(distinct a.meeting_id)::int from public.meeting_cutoff_attributions a))
);
$$;

revoke all on function public.get_cutoff_quota_data(uuid) from public, anon;
grant execute on function public.get_cutoff_quota_data(uuid) to authenticated;
