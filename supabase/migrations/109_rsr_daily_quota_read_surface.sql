-- ============================================================================
-- 109 — Give the RSR read surface back the DAY it is actually measured on
--
-- 105 made every target monthly and, for an RSR, expressed the daily number as
-- a monthly one:
--
--   rsr  ->  rsr_daily_target x working days IN THE MONTH   (16 x 21 = 336)
--
-- That is the right number for the admin report, which compares a month to a
-- month. It is the wrong number for the phone. An RSR's commitment is 16 today;
-- a bar reading "41 / 336" on the 4th is unactionable — it cannot say whether
-- they are behind, because the thing they are behind on is a day, not a month.
-- Sales and Manager are genuinely monthly and keep exactly what 105 gave them.
--
-- So this adds the day alongside the month rather than in place of it. The
-- month stays the reconciling number — mobile still shows it, and it still
-- agrees with the admin report — and the day becomes what an RSR reads first.
--
-- NOT a per-cutoff view. Asked and considered: it would put a third window back
-- on the board for one role, and 105 documents why a per-period
-- working_days_override cannot be honestly applied to a month. Cutoff remains
-- the unit of attribution, slots and the per-client cap; it is nobody's target
-- window any more.
--
-- Attribution is untouched, for the reason 064 and 105 both give:
-- attribute_meeting_cutoff() reads a period's status, its dates and the caps,
-- never a target. No ledger row can move because of anything in this file.
-- ============================================================================

-- --- Mobile read surface ----------------------------------------------------

/*
 * DROP then CREATE, not CREATE OR REPLACE: three columns are being added to the
 * RETURNS TABLE, and Postgres treats that as changing the function's return
 * type, which replace refuses ("cannot change return type of existing
 * function"). Nothing depends on it — no dependent views, and it is called only
 * over PostgREST — so the drop is safe. The three new columns are appended LAST
 * and every 105 column keeps its name, type and position, so a phone running
 * the pre-109 build reads the same eight keys off the JSON and ignores the rest.
 *
 * NEW (all three describe TODAY, in Manila):
 *
 *   daily_target         rsr_daily_target for an RSR, null for every other
 *                        role. This is the flag mobile keys the layout off: a
 *                        non-null value means "this role is measured by the
 *                        day, lead with it."
 *   today_confirmed      the caller's confirmed visits dated today. Returned
 *                        for EVERY role, not just RSR — it is the caller's own
 *                        work either way, it costs the same scan, and keeping
 *                        it unconditional means the one role-shaped decision
 *                        lives in daily_target alone.
 *   today_is_working_day weekday and not a holiday, by the same test the
 *                        monthly working_days count uses.
 *
 * Why the third column exists rather than nulling daily_target on a Sunday:
 * an RSR has no target on a rest day, but the card must not silently change
 * shape on Saturday and back on Monday. Mobile keeps the daily block up all
 * week and swaps "7 to go" for "Rest day" — which is also the honest reading of
 * a Sunday visit, whose count is still returned and simply is not measured
 * against anything.
 *
 * daily_target is read from the SAME period `source` the monthly target is, not
 * from the running cutoff and not from quota_settings. If the two disagreed,
 * the card would show a daily number that does not multiply into the monthly
 * one underneath it. Consistency between the two lines on one card beats
 * freshness of one of them.
 *
 * today_confirmed uses the same attribution set and the same meeting-dating
 * rule as the monthly count — coalesce(start_captured_at, meeting_date) in
 * Manila, so a visit synced late from a phone belongs to the day it happened,
 * exactly as 072 and 105 have it. A late sync therefore lands on yesterday's
 * number rather than today's; that is deliberate, and it matches the month.
 *
 * Still SECURITY DEFINER, for 105's reason: the join to `meetings` is
 * RLS-scoped by agent and team, and a manager's tag-along on a meeting outside
 * their team would otherwise be dropped from the join and undercount them.
 * Every row touched is filtered to current_profile_id(), so it can return
 * nothing that is not the caller's own work.
 */
drop function if exists public.get_my_cutoff_usage_summary();

create function public.get_my_cutoff_usage_summary()
returns table (
  period_id            uuid,
  period_label         text,
  starts_on            date,
  ends_on              date,
  role                 text,
  target               integer,
  confirmed_count      integer,
  remaining            integer,
  daily_target         integer,
  today_confirmed      integer,
  today_is_working_day boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      date_trunc('month', (now() at time zone 'Asia/Manila'))::date as month_start,
      (date_trunc('month', (now() at time zone 'Asia/Manila'))
        + interval '1 month' - interval '1 day')::date as month_end,
      (now() at time zone 'Asia/Manila')::date as today
  ),
  active as (
    select cp.*
    from public.cutoff_periods cp
    where cp.status = 'active'
      and (now() at time zone 'Asia/Manila')::date between cp.starts_on and cp.ends_on
    order by cp.starts_on desc
    limit 1
  ),
  -- Unchanged from 105: the last period ENDING in the month wins, so the most
  -- recently applied number is the month's number. Mirrors
  -- targetSourceForMonth() in lib/cutoff.ts; the two must agree or an agent's
  -- phone and the admin report quote different targets for the same month.
  source as (
    select cp.*
    from public.cutoff_periods cp
    cross join bounds b
    where cp.ends_on between b.month_start and b.month_end
      and cp.status <> 'draft'
    order by cp.ends_on desc
    limit 1
  ),
  caller as (
    select p.role
    from public.profiles p
    where p.id = public.current_profile_id()
  ),
  working_days as (
    select count(*)::integer as days
    from bounds b
    cross join generate_series(b.month_start::timestamp, b.month_end::timestamp, interval '1 day') d
    where extract(isodow from d) < 6
      and not exists (
        select 1 from public.holidays h where h.holiday_date = d::date
      )
  ),
  -- The same weekday-and-not-a-holiday test the monthly count applies to each
  -- of its days, applied to one day. Kept as its own CTE rather than inlined so
  -- the two can never drift apart.
  today_working as (
    select (extract(isodow from b.today) < 6
             and not exists (
               select 1 from public.holidays h where h.holiday_date = b.today
             )) as is_working_day
    from bounds b
  ),
  confirmed as (
    select count(*)::integer as n
    from bounds b
    cross join public.meeting_cutoff_attributions mca
    join public.meetings m on m.id = mca.meeting_id
    where mca.agent_id = public.current_profile_id()
      and mca.attribution in ('counted', 'excluded_uncapped')
      and (coalesce(m.start_captured_at, m.meeting_date) at time zone 'Asia/Manila')::date
            between b.month_start and b.month_end
  ),
  confirmed_today as (
    select count(*)::integer as n
    from bounds b
    cross join public.meeting_cutoff_attributions mca
    join public.meetings m on m.id = mca.meeting_id
    where mca.agent_id = public.current_profile_id()
      and mca.attribution in ('counted', 'excluded_uncapped')
      and (coalesce(m.start_captured_at, m.meeting_date) at time zone 'Asia/Manila')::date
            = b.today
  ),
  usage as (
    select
      a.id as period_id,
      to_char(b.month_start, 'FMMonth YYYY') as period_label,
      b.month_start as starts_on,
      b.month_end   as ends_on,
      c.role,
      case
        when c.role = 'sales_specialist' then s.sales_target
        when c.role = 'sales_manager'    then s.manager_target
        when c.role = 'rsr' then
          case when s.rsr_daily_target is null then null
               else s.rsr_daily_target * wd.days end
        else null
      end as target,
      cf.n as confirmed_count,
      case when c.role = 'rsr' then s.rsr_daily_target else null end as daily_target,
      cft.n as today_confirmed,
      tw.is_working_day as today_is_working_day
    from active a
    cross join bounds b
    cross join caller c
    cross join working_days wd
    cross join today_working tw
    cross join confirmed cf
    cross join confirmed_today cft
    -- LEFT, so a month with no period ending in it still reports the caller's
    -- count against a null target ("not configured") rather than returning no
    -- row at all, which mobile renders as "no quota configured" — the exact
    -- ambiguity fault 4 in this feature's history was about.
    left join source s on true
  )
  select
    period_id,
    period_label,
    starts_on,
    ends_on,
    role,
    target,
    confirmed_count,
    case when target is null then null else greatest(0, target - confirmed_count) end as remaining,
    daily_target,
    today_confirmed,
    today_is_working_day
  from usage;
$$;

-- The drop took the grants with it, so both lines are re-stated. Revoking from
-- public first matters here for 105's reason: this is SECURITY DEFINER, and the
-- default grant would otherwise let the anon role execute it.
revoke all on function public.get_my_cutoff_usage_summary() from public;
grant execute on function public.get_my_cutoff_usage_summary() to authenticated;
