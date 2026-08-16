-- ============================================================================
-- 105 — Quota targets become MONTHLY, and a manager gets a target of their own
--
-- Two changes, one decision (supervisor, 2026-08-16):
--
--   Sales    35 per calendar MONTH   (was 35 per cutoff)
--   Manager  20 per calendar MONTH   (was: inherited from the team they run)
--   RSR      16 per working day      (unchanged)
--
-- 1. UNIT. Since 057 a target has been a per-CUTOFF number, and with the
--    company's [8, 23] cycle that is twice a month — so 35 per cutoff was
--    really 70 a month. The supervisor's number is monthly and is NOT to be
--    prorated into 17/18 per cutoff (asked and answered explicitly). The
--    measurement WINDOW for a target therefore becomes the calendar month.
--
--    The cutoff period is untouched as the unit of everything else. It still
--    owns attribution, slot allocation, and the per-client visit cap — those
--    are what 059's trigger reads, and none of them is a target. So: targets
--    are monthly, visit limits are per cutoff, and the two no longer share a
--    window. That is the fact every label on both clients now has to carry.
--
-- 2. MANAGER. 076 gave a manager the target of the team they run — sales_target
--    for a sales team, rsr_daily_target x working days for an RSR team. That is
--    now replaced by one flat admin-editable number that does not depend on
--    team kind at all. A manager on an RSR team and a manager on a sales team
--    are both measured against 20 a month.
--
-- Attribution is again deliberately untouched, for the reason 064 gives:
-- attribute_meeting_cutoff() reads a period's status, its dates, and the caps —
-- never a target. No ledger row can move because of anything in this file.
--
-- CROSS-REPO NOTE: get_my_cutoff_usage_summary() keeps its 8 columns, their
-- names, types, and order, so mobile's lib/sync/cutoff-sync-down.ts needs no
-- change to keep working. What it RETURNS changes meaning: the window is now
-- the month, so period_label reads "August 2026" and starts_on/ends_on are the
-- month's bounds. The agent-facing quota card on mobile will show monthly
-- progress the moment this deploys. period_id still carries the running cutoff,
-- so anything keying a local row off it keeps working.
--
-- Additive and idempotent: safe to re-run, drops nothing.
-- ============================================================================

-- --- The manager's own number ------------------------------------------------

alter table public.quota_settings
  add column if not exists manager_target integer;

alter table public.cutoff_periods
  add column if not exists manager_target integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.quota_settings'::regclass
       and conname  = 'quota_settings_manager_target_positive'
  ) then
    alter table public.quota_settings
      add constraint quota_settings_manager_target_positive
      check (manager_target is null or manager_target > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cutoff_periods'::regclass
       and conname  = 'cutoff_periods_manager_target_positive'
  ) then
    alter table public.cutoff_periods
      add constraint cutoff_periods_manager_target_positive
      check (manager_target is null or manager_target > 0);
  end if;
end $$;

-- Left null on purpose, exactly as 064 seeded the other two: nothing may
-- enforce a quota before an admin has set one (Batch-0 items 1-2). 20 is the
-- number the admin will type, not one this file asserts on their behalf.

comment on column public.quota_settings.manager_target is
  'Standing quota target for sales_manager, in meetings per CALENDAR MONTH. Flat — it does not vary by the kind of team the manager runs, which is what distinguishes it from the inherited target it replaces (076). Null = not configured, which must render as such and never as zero (contract O-6).';

comment on column public.cutoff_periods.manager_target is
  'Snapshot of the manager monthly target in force while this period was open. Per CALENDAR MONTH, not per cutoff — see migration 105. Null = not configured.';

-- The unit changed under these two without their names changing, which is
-- exactly the kind of drift a comment exists to stop.
comment on column public.cutoff_periods.sales_target is
  'Quota target for sales_specialist, in meetings per CALENDAR MONTH as of migration 105 (it was per cutoff from 057 until then). Null = not configured, which must render as such and never as zero (contract O-6).';

comment on column public.quota_settings.sales_target is
  'Standing quota target for sales_specialist, in meetings per CALENDAR MONTH as of migration 105 (per cutoff before that). Null = not configured.';

-- --- Applying a standing change ---------------------------------------------

/*
 * The 5-argument form. Same contract as 074's four: targets update in place on
 * every period that has not ended, the two caps reach only periods that have
 * not STARTED, ended periods are never touched, and one cutoff_period_changes
 * row is written per field that actually moved.
 *
 * manager_target rides with the targets, not with the caps, because it is one:
 * it feeds no attribution decision, so pushing it onto a running period cannot
 * re-slot a meeting. See the note on 064's original.
 */
create or replace function public.apply_standing_targets(
  p_sales_target       integer,
  p_rsr_daily_target   integer,
  p_manager_target     integer,
  p_sales_client_cap   integer,
  p_rsr_client_cap     integer
)
returns table (
  periods_updated integer,
  cap_updated     integer,
  periods_ended   integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today   date := (now() at time zone 'Asia/Manila')::date;
  v_actor   uuid := public.current_profile_id();
  v_period  record;
  v_updated integer := 0;
  v_cap     integer := 0;
  v_ended   integer := 0;
  v_legacy  integer := greatest(p_sales_client_cap, p_rsr_client_cap);
begin
  if not public.is_admin() then
    raise exception 'Only an admin may change quota targets';
  end if;

  if p_sales_client_cap is null or p_sales_client_cap <= 0 then
    raise exception 'The Sales visit limit must be a positive number';
  end if;

  if p_rsr_client_cap is null or p_rsr_client_cap <= 0 then
    raise exception 'The RSR visit limit must be a positive number';
  end if;

  insert into public.quota_settings
    (id, sales_target, rsr_daily_target, manager_target,
     sales_client_meeting_cap, rsr_client_meeting_cap,
     client_meeting_cap, updated_by, updated_at)
  values
    (true, p_sales_target, p_rsr_daily_target, p_manager_target,
     p_sales_client_cap, p_rsr_client_cap,
     v_legacy, v_actor, now())
  on conflict (id) do update
    set sales_target             = excluded.sales_target,
        rsr_daily_target         = excluded.rsr_daily_target,
        manager_target           = excluded.manager_target,
        sales_client_meeting_cap = excluded.sales_client_meeting_cap,
        rsr_client_meeting_cap   = excluded.rsr_client_meeting_cap,
        client_meeting_cap       = excluded.client_meeting_cap,
        updated_by               = excluded.updated_by,
        updated_at               = excluded.updated_at;

  select count(*) into v_ended
    from public.cutoff_periods
   where ends_on < v_today;

  for v_period in
    select * from public.cutoff_periods
     where ends_on >= v_today
       and status in ('draft', 'scheduled', 'active')
     order by starts_on
  loop
    if v_period.sales_target is distinct from p_sales_target then
      insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
      values (v_period.id, v_actor, 'sales_target', v_period.sales_target::text, p_sales_target::text);
    end if;

    if v_period.rsr_daily_target is distinct from p_rsr_daily_target then
      insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
      values (v_period.id, v_actor, 'rsr_daily_target', v_period.rsr_daily_target::text, p_rsr_daily_target::text);
    end if;

    if v_period.manager_target is distinct from p_manager_target then
      insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
      values (v_period.id, v_actor, 'manager_target', v_period.manager_target::text, p_manager_target::text);
    end if;

    if v_period.sales_target     is distinct from p_sales_target
       or v_period.rsr_daily_target is distinct from p_rsr_daily_target
       or v_period.manager_target   is distinct from p_manager_target then
      update public.cutoff_periods
         set sales_target     = p_sales_target,
             rsr_daily_target = p_rsr_daily_target,
             manager_target   = p_manager_target,
             updated_at       = now()
       where id = v_period.id;
      v_updated := v_updated + 1;
    end if;

    if v_period.starts_on > v_today
       and (v_period.sales_client_meeting_cap is distinct from p_sales_client_cap
            or v_period.rsr_client_meeting_cap is distinct from p_rsr_client_cap) then

      if v_period.sales_client_meeting_cap is distinct from p_sales_client_cap then
        insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
        values (v_period.id, v_actor, 'sales_client_meeting_cap',
                v_period.sales_client_meeting_cap::text, p_sales_client_cap::text);
      end if;

      if v_period.rsr_client_meeting_cap is distinct from p_rsr_client_cap then
        insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
        values (v_period.id, v_actor, 'rsr_client_meeting_cap',
                v_period.rsr_client_meeting_cap::text, p_rsr_client_cap::text);
      end if;

      update public.cutoff_periods
         set sales_client_meeting_cap = p_sales_client_cap,
             rsr_client_meeting_cap   = p_rsr_client_cap,
             client_meeting_cap       = v_legacy,
             updated_at               = now()
       where id = v_period.id;
      v_cap := v_cap + 1;
    end if;
  end loop;

  periods_updated := v_updated;
  cap_updated     := v_cap;
  periods_ended   := v_ended;
  return next;
end $$;

revoke all on function public.apply_standing_targets(integer, integer, integer, integer, integer) from public;
grant execute on function public.apply_standing_targets(integer, integer, integer, integer, integer) to authenticated;

comment on function public.apply_standing_targets(integer, integer, integer, integer, integer) is
  'Upserts quota_settings and pushes the change onto every period that has not ended, writing one cutoff_period_changes row per field actually changed. The three targets update in place because they feed no attribution decision; the two per-role visit limits reach only periods that have not started, because they do. Admin-only.';

-- The 4-argument form stays a forwarding shim, for the reason 074 kept the
-- 3-argument one: this schema is shared with a repo that deploys on its own
-- timetable. It forwards the manager target ALREADY STORED rather than null,
-- so a caller that predates this migration cannot silently un-configure a
-- number it has no field for.
create or replace function public.apply_standing_targets(
  p_sales_target       integer,
  p_rsr_daily_target   integer,
  p_sales_client_cap   integer,
  p_rsr_client_cap     integer
)
returns table (
  periods_updated integer,
  cap_updated     integer,
  periods_ended   integer
)
language sql
as $$
  select * from public.apply_standing_targets(
    p_sales_target,
    p_rsr_daily_target,
    (select qs.manager_target from public.quota_settings qs where qs.id),
    p_sales_client_cap,
    p_rsr_client_cap);
$$;

comment on function public.apply_standing_targets(integer, integer, integer, integer) is
  'DEPRECATED as of migration 105 — forwards to the 5-argument form, preserving the stored manager target. Kept only so a caller that has not migrated keeps working; use the 5-argument form.';

-- The 3-argument shim from 074 forwards into the 4-argument one above and so
-- needs no change; it now preserves the manager target for the same reason.

-- --- Mobile read surface ----------------------------------------------------

/*
 * An agent's own quota progress — now measured over the CALENDAR MONTH.
 *
 * Return signature is byte-identical to 076's (same 8 columns, same names,
 * same types, same order), so mobile's sync-down needs no change. The MEANING
 * of four of them moves with the unit:
 *
 *   period_id     still the running cutoff, so anything keyed off it is stable
 *   period_label  the month ("August 2026"), because that is the window below
 *   starts_on     first day of the Manila month
 *   ends_on       last day of the Manila month
 *
 * Targets by role, all monthly:
 *   sales_specialist  sales_target
 *   sales_manager     manager_target  — flat, no longer the team's number (076)
 *   rsr               rsr_daily_target x working days IN THE MONTH
 *
 * The numbers are read from the running period's snapshot, not from
 * quota_settings, so this agrees with what the admin report shows for the same
 * window — apply_standing_targets() keeps every open period carrying the
 * standing values.
 *
 * working_days_override is deliberately NOT consulted here. It is a per-period
 * correction (a worked Saturday in one cutoff) and a month spans two of them,
 * so there is no honest way to apply one to a monthly count. The monthly RSR
 * figure is therefore always weekdays-minus-holidays. If overriding a month
 * ever matters, it needs a row of its own, not a reinterpretation of this one.
 *
 * SECURITY DEFINER, which the pre-105 version did not need. Counting by month
 * means joining `meetings` for the visit's own date, and `meetings` is
 * RLS-scoped by agent and team — so a manager whose tag-along sits on a meeting
 * recorded outside their team would have had that row silently dropped from the
 * join and been shown a count lower than their real one. Safe to define: every
 * row this function touches is filtered to `current_profile_id()`, so it can
 * return nothing that is not the caller's own work.
 *
 * confirmed_count counts every ledger row belonging to the caller in the month,
 * dated by the MEETING (Manila local, coalescing start_captured_at over
 * meeting_date exactly as 072 does) rather than by attributed_at — a meeting
 * synced late from a phone belongs to the day it happened. Participation is not
 * filtered: a manager's tag-along row is their own work and is the whole of
 * what their 20 is measured against.
 */
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
security definer
set search_path = public
as $$
  with bounds as (
    select
      date_trunc('month', (now() at time zone 'Asia/Manila'))::date as month_start,
      (date_trunc('month', (now() at time zone 'Asia/Manila'))
        + interval '1 month' - interval '1 day')::date as month_end
  ),
  active as (
    select cp.*
    from public.cutoff_periods cp
    where cp.status = 'active'
      and (now() at time zone 'Asia/Manila')::date between cp.starts_on and cp.ends_on
    order by cp.starts_on desc
    limit 1
  ),
  -- Where the month's NUMBERS come from, which is not always the running
  -- cutoff. Both of a month's periods end in it, and an admin editing targets
  -- mid-month reaches only the one that has not ended — so the two rows can
  -- carry different numbers and something has to choose deterministically. The
  -- last period ending in the month wins, so the most recently applied number
  -- is the month's number. Mirrors targetSourceForMonth() in lib/cutoff.ts;
  -- the two must agree or an agent's phone and the admin report quote
  -- different targets for the same month.
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
      cf.n as confirmed_count
    from active a
    cross join bounds b
    cross join caller c
    cross join working_days wd
    cross join confirmed cf
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
    case when target is null then null else greatest(0, target - confirmed_count) end as remaining
  from usage;
$$;

-- Revoked from public first, which matters more now it is SECURITY DEFINER:
-- the default grant would otherwise let the anon role execute it.
revoke all on function public.get_my_cutoff_usage_summary() from public;
grant execute on function public.get_my_cutoff_usage_summary() to authenticated;

-- --- Backfill the running and upcoming periods ------------------------------
--
-- So the new column is not null on periods that already exist while the admin
-- has not opened Settings yet. Only where a standing value is already set —
-- null stays null, because "not configured" is a real state here.
update public.cutoff_periods cp
   set manager_target = qs.manager_target,
       updated_at     = now()
  from public.quota_settings qs
 where qs.id
   and qs.manager_target is not null
   and cp.manager_target is null
   and cp.ends_on >= (now() at time zone 'Asia/Manila')::date
   and cp.status in ('draft', 'scheduled', 'active');
