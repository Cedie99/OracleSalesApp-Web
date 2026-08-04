-- ============================================================================
-- 066 - Resolve the CURRENT cutoff in both mobile-facing RPCs, not the last
-- one in the table.
--
-- The bug. Periods are generated ahead as `status = 'active'` on purpose (see
-- app/(admin)/settings/page.tsx and the note on lib/cutoff.ts's periodPhase):
-- migration 059 attributes a meeting only when the period is active AND the
-- meeting's date falls inside it, so generating a year ahead as `scheduled`
-- would just move a twice-a-month chore from creating rows to activating them.
-- The exclusion constraint permits it because generated periods are contiguous,
-- never overlapping.
--
-- The consequence is that a dozen or two rows carry status = 'active' at once
-- -- as of 2026-08-04 there are 24, covering Jul 2026 through Aug 2027. Both
-- functions below selected on status alone:
--
--     where cp.status = 'active' order by cp.starts_on desc limit 1
--
-- which resolves to the period with the LATEST start date -- the furthest one
-- in the future -- rather than the one running today. The attribution ledger
-- meanwhile keys every row to the correct period (059 filters on the date), so
-- the left join matched nothing and an agent saw a future cutoff's label with a
-- confirmed count of 0 and their full target still remaining.
--
-- Web's own surfaces never showed this because lib/cutoff.ts's activePeriod()
-- has always applied the date test. This was a defect only on the read path we
-- built for mobile, which is why it went unseen on the admin side.
--
-- The fix is the date predicate 059 already uses, applied to both functions.
-- `order by starts_on desc limit 1` is kept as the tie-break rather than
-- removed: it mirrors 059 exactly, so what mobile displays and what the trigger
-- attributes can never disagree, even if overlapping rows are somehow created.
--
-- get_client_cutoff_allowance additionally had NO limit at all, so it returned
-- one row per active period and mobile's rows[0] picked from an unordered
-- result. It is now single-row by construction.
--
-- Manila-local, not current_date: periods are Manila-local dates, and the UTC
-- day is the previous one for the first eight hours of every Manila morning --
-- which would show yesterday's cutoff as live across a boundary. Matches
-- apply_standing_targets() (064), which made the same choice for the same
-- reason.
--
-- Return signatures are byte-identical to 060/065 -- same columns, names,
-- types, and ordering. The mobile repo's lib/sync/cutoff-sync-down.ts needs no
-- change.
-- ============================================================================

-- Unchanged from 065 apart from the `active` CTE's where clause: RSR target is
-- still rsr_daily_target x working days, sales_specialist still reads
-- sales_target flat, a null target still propagates to a null remaining rather
-- than rendering as zero (contract O-6).
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
      and (now() at time zone 'Asia/Manila')::date between cp.starts_on and cp.ends_on
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

-- Same date predicate, plus the single-row guarantee the original lacked.
-- Still SECURITY INVOKER: the clients join means the caller cannot see an
-- allowance for a client their own RLS would not let them select directly.
-- prospect/in_progress clients still get no row at all -- that is the contract
-- (item 3), not an omission.
create or replace function public.get_client_cutoff_allowance(p_client_id uuid)
returns table (
  period_id  uuid,
  period_label text,
  starts_on  date,
  ends_on    date,
  used       integer,
  cap        integer,
  remaining  integer
)
language sql
stable
as $$
  with active as (
    select cp.*
    from public.cutoff_periods cp
    where cp.status = 'active'
      and (now() at time zone 'Asia/Manila')::date between cp.starts_on and cp.ends_on
    order by cp.starts_on desc
    limit 1
  )
  select
    a.id,
    a.label,
    a.starts_on,
    a.ends_on,
    coalesce(count(mca.meeting_id) filter (where mca.attribution = 'counted'), 0)::integer as used,
    a.client_meeting_cap,
    greatest(0, a.client_meeting_cap - coalesce(count(mca.meeting_id) filter (where mca.attribution = 'counted'), 0))::integer as remaining
  from public.clients c
  cross join active a
  left join public.meeting_cutoff_attributions mca
    on mca.period_id = a.id and mca.client_id = c.id
  where c.id = p_client_id
    and c.customer_type in ('new', 'existing')
  group by a.id, a.label, a.starts_on, a.ends_on, a.client_meeting_cap;
$$;

grant execute on function public.get_client_cutoff_allowance(uuid) to authenticated;
