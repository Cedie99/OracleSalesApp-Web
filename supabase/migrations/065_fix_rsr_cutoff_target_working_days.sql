-- ============================================================================
-- 065 - Fix RSR cutoff target: read rsr_daily_target x working days, not the
-- deprecated flat rsr_target (Batch 7C follow-up to 064)
--
-- 060 defined get_my_cutoff_usage_summary() reading cp.rsr_target directly.
-- 064 moved the admin-editable source of truth to quota_settings /
-- apply_standing_targets(), which writes cp.rsr_daily_target (a PER WORKING
-- DAY figure) and stopped writing cp.rsr_target entirely (see 064's column
-- comment). Any RSR target change made through the new Settings UI since 064
-- shipped never reached this function - mobile kept reading a frozen value.
--
-- Corrected algorithm, mirroring web's own lib/cutoff.ts (workingDaysIn() /
-- periodTargetFor()) server-side: if cp.working_days_override is set it wins
-- outright (does NOT additionally subtract holidays); otherwise working days
-- = count of calendar days in [starts_on, ends_on] inclusive that are not a
-- Sat/Sun and not in public.holidays. rsr target = rsr_daily_target *
-- working_days, propagating null (never coalesced to 0 - unconfigured must
-- never render as zero, contract O-6). sales_specialist target is unchanged
-- - cp.sales_target directly, no multiplication.
--
-- remaining is now derived from the single computed target instead of
-- re-deriving the role case a second time, so target and remaining can no
-- longer disagree; a null target now correctly yields a null remaining
-- instead of the previous function's `else 0` fallback.
--
-- Return signature is byte-identical to 060's (same 8 columns, same names,
-- same types) - mobile's lib/sync/cutoff-sync-down.ts requires no change.
-- ============================================================================

create or replace function public.get_my_cutoff_usage_summary()
returns table (
  period_id       uuid,
  period_label    text,
  starts_on       date,
  ends_on         date,
  role            text,
  target          integer,
  confirmed_count integer,
  remaining       integer
)
language sql
stable
as $$
  with active as (
    select cp.*
    from public.cutoff_periods cp
    where cp.status = 'active'
    order by cp.starts_on desc
    limit 1
  ),
  caller as (
    select p.role
    from public.profiles p
    where p.id = public.current_profile_id()
  ),
  working_days as (
    select
      case
        when a.working_days_override is not null then a.working_days_override
        else (
          select count(*)::integer
          from generate_series(a.starts_on::timestamp, a.ends_on::timestamp, interval '1 day') d
          where extract(isodow from d) < 6
            and not exists (
              select 1 from public.holidays h where h.holiday_date = d::date
            )
        )
      end as days
    from active a
  ),
  usage as (
    select
      a.id as period_id,
      a.label as period_label,
      a.starts_on,
      a.ends_on,
      c.role,
      case c.role
        when 'sales_specialist' then a.sales_target
        when 'rsr' then case when a.rsr_daily_target is null then null else a.rsr_daily_target * wd.days end
        else null
      end as target,
      coalesce(count(mca.meeting_id) filter (
        where mca.attribution in ('counted', 'excluded_uncapped')
      ), 0)::integer as confirmed_count
    from active a
    cross join caller c
    cross join working_days wd
    left join public.meeting_cutoff_attributions mca
      on mca.period_id = a.id and mca.agent_id = public.current_profile_id()
    group by a.id, a.label, a.starts_on, a.ends_on, c.role, a.sales_target, a.rsr_daily_target, wd.days
  )
  select
    period_id,
    period_label,
    starts_on,
    ends_on,
    role,
    target,
    confirmed_count,
    case when target is null then null else greatest(0, target - confirmed_count) end as remaining
  from usage;
$$;

grant execute on function public.get_my_cutoff_usage_summary() to authenticated;
