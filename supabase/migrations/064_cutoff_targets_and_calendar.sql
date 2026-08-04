-- 064 — Real quota targets: Sales per cutoff, RSR per working day.
--
-- (Numbered 063 in an earlier draft; 063 went to an unrelated lifecycle fix.
-- The `comment on column` text below still says "migration 063" — left as-is
-- rather than edited, since changing it here would not update the already-
-- applied comment in the database and would only add file/DB drift.)
--
-- Migration 057 gave every role a single per-PERIOD target. That is right for
-- Sales (35 meetings per cutoff) and wrong for RSR, whose real target is 16
-- visits per WORKING DAY. This adds the daily target, the calendar needed to
-- turn it into a period expectation, one editable home for the standing
-- numbers, and the audit trail ADR-053's Batch 7B list has always required.
--
-- Attribution is deliberately untouched. attribute_meeting_cutoff() (059)
-- reads only a period's status, its dates, and client_meeting_cap — it never
-- reads a target. Changing a target therefore cannot alter a single ledger row,
-- which is what makes the in-place edits below safe. See the note on
-- apply_standing_targets().
--
-- Additive and idempotent throughout: safe to re-run, and it drops nothing.

-- --- Periods: the daily target and a calendar override ----------------------

alter table public.cutoff_periods
  add column if not exists rsr_daily_target integer,
  add column if not exists working_days_override integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cutoff_periods'::regclass
       and conname  = 'cutoff_periods_rsr_daily_target_positive'
  ) then
    alter table public.cutoff_periods
      add constraint cutoff_periods_rsr_daily_target_positive
      check (rsr_daily_target is null or rsr_daily_target > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cutoff_periods'::regclass
       and conname  = 'cutoff_periods_working_days_override_positive'
  ) then
    alter table public.cutoff_periods
      add constraint cutoff_periods_working_days_override_positive
      check (working_days_override is null or working_days_override >= 0);
  end if;
end $$;

-- Carry any existing value across so no period silently loses its RSR number.
update public.cutoff_periods
   set rsr_daily_target = rsr_target
 where rsr_daily_target is null
   and rsr_target is not null;

comment on column public.cutoff_periods.rsr_daily_target is
  'Quota target for the rsr role, per WORKING DAY. The period expectation is this times the working days in the period (weekdays minus public.holidays, or working_days_override). Null = not configured for this role, which must render as such and never as zero (contract O-6).';

comment on column public.cutoff_periods.working_days_override is
  'Explicit working-day count for this period, overriding the weekday-minus-holidays derivation. For an irregular schedule such as a worked Saturday. Null means derive it.';

-- DEPRECATED, deliberately not dropped: the mobile repo still selects this
-- column by name in lib/sync/cutoff-sync-down.ts, and dropping it would break
-- their sync-down the moment this deploys. Web no longer writes it.
comment on column public.cutoff_periods.rsr_target is
  'DEPRECATED as of migration 063 — superseded by rsr_daily_target, which carries the correct per-working-day unit. Retained only because the mobile sync-down still selects it; remove once mobile has migrated. Web no longer reads or writes this column.';

-- --- Standing values: the one place an admin edits --------------------------

-- Single-row by construction: the primary key can only ever hold `true`. A
-- settings table with no such guard grows a second row eventually, and then
-- nothing agrees on which one is live.
create table if not exists public.quota_settings (
  id                  boolean primary key default true check (id),
  sales_target        integer check (sales_target is null or sales_target > 0),
  rsr_daily_target    integer check (rsr_daily_target is null or rsr_daily_target > 0),
  client_meeting_cap  integer not null default 2 check (client_meeting_cap > 0),
  updated_by          uuid references public.profiles(id),
  updated_at          timestamptz not null default now()
);

comment on table public.quota_settings is
  'The standing quota numbers new cutoff periods inherit, and the single surface an admin edits. Periods snapshot these at creation so a later change cannot rewrite what a finished cutoff was measured against; apply_standing_targets() pushes a change forward to the periods that have not ended.';

-- Seeded with no targets on purpose. Nothing may enforce a quota before an
-- admin sets one (Batch-0 items 1-2), so 35 and 16 are defaults the UI offers,
-- never values the database asserts.
insert into public.quota_settings (id, client_meeting_cap)
values (true, 2)
on conflict (id) do nothing;

-- --- Working calendar -------------------------------------------------------

-- A table rather than a rule: Philippine holidays are irregular and declared by
-- proclamation, so they cannot be computed from a date. Per-agent leave is a
-- different problem and is deliberately not modelled here.
create table if not exists public.holidays (
  holiday_date date primary key,
  label        text not null,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);

comment on table public.holidays is
  'Non-working days shared across the company, excluded from the working-day count that turns an RSR daily target into a period expectation. Weekends are derived, not stored.';

-- --- Audit ------------------------------------------------------------------

create table if not exists public.cutoff_period_changes (
  id          uuid primary key default gen_random_uuid(),
  period_id   uuid not null references public.cutoff_periods(id) on delete cascade,
  changed_by  uuid references public.profiles(id),
  changed_at  timestamptz not null default now(),
  field       text not null,
  old_value   text,
  new_value   text
);

create index if not exists idx_cutoff_period_changes_period
  on public.cutoff_period_changes (period_id, changed_at desc);

comment on table public.cutoff_period_changes is
  'Who changed which quota field on which period, and when. Satisfies ADR-053 Batch 7B "view audit history of policy changes". Written only by apply_standing_targets(); no client role may insert.';

-- --- RLS: mirrors cutoff_periods exactly ------------------------------------

alter table public.quota_settings enable row level security;
alter table public.holidays enable row level security;
alter table public.cutoff_period_changes enable row level security;

drop policy if exists "Authenticated read quota settings" on public.quota_settings;
create policy "Authenticated read quota settings" on public.quota_settings
  for select using (auth.role() = 'authenticated');

drop policy if exists "Admin manage quota settings" on public.quota_settings;
create policy "Admin manage quota settings" on public.quota_settings
  for all
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Authenticated read holidays" on public.holidays;
create policy "Authenticated read holidays" on public.holidays
  for select using (auth.role() = 'authenticated');

drop policy if exists "Admin manage holidays" on public.holidays;
create policy "Admin manage holidays" on public.holidays
  for all
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admin read period changes" on public.cutoff_period_changes;
create policy "Admin read period changes" on public.cutoff_period_changes
  for select using (public.is_admin());

-- No INSERT/UPDATE/DELETE policy for any role, matching the attribution ledger:
-- the audit trail is only trustworthy if nothing but the SECURITY DEFINER
-- function below can write to it.

-- --- Applying a standing change --------------------------------------------

/*
 * Push the standing numbers onto the periods they still apply to.
 *
 * Targets are updated IN PLACE rather than superseded. That looks like it
 * contradicts O-8, and does not: O-8 protects a period from being rewritten
 * under meetings that were measured against it, but a target feeds no
 * attribution decision at all. Superseding a running period would mean
 * creating a v2 and then re-pointing every meeting_cutoff_attributions row
 * from v1 to v2, or the current period's report would read zero — a rewrite of
 * the very ledger migration 058's RLS exists to protect, bought for nothing.
 * The audit rows below carry the accountability instead.
 *
 * client_meeting_cap is the exception and is only pushed to periods that have
 * not started. It DOES drive slot allocation, and no amount of superseding can
 * retroactively re-slot meetings the trigger has already attributed.
 *
 * Ended periods are never touched, whatever the field.
 */
create or replace function public.apply_standing_targets(
  p_sales_target       integer,
  p_rsr_daily_target   integer,
  p_client_meeting_cap integer
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
  -- Periods are Manila-local dates. current_date would be the UTC day, which
  -- is the previous one for the first eight hours of every Manila morning.
  v_today   date := (now() at time zone 'Asia/Manila')::date;
  v_actor   uuid := public.current_profile_id();
  v_period  record;
  v_updated integer := 0;
  v_cap     integer := 0;
  v_ended   integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Only an admin may change quota targets';
  end if;

  if p_client_meeting_cap is null or p_client_meeting_cap <= 0 then
    raise exception 'The per-client visit limit must be a positive number';
  end if;

  insert into public.quota_settings (id, sales_target, rsr_daily_target, client_meeting_cap, updated_by, updated_at)
  values (true, p_sales_target, p_rsr_daily_target, p_client_meeting_cap, v_actor, now())
  on conflict (id) do update
    set sales_target       = excluded.sales_target,
        rsr_daily_target   = excluded.rsr_daily_target,
        client_meeting_cap = excluded.client_meeting_cap,
        updated_by         = excluded.updated_by,
        updated_at         = excluded.updated_at;

  select count(*) into v_ended
    from public.cutoff_periods
   where ends_on < v_today;

  for v_period in
    select * from public.cutoff_periods
     where ends_on >= v_today
       and status in ('draft', 'scheduled', 'active')
     order by starts_on
  loop
    -- `is distinct from` rather than <>, so a null-to-value change (a target
    -- configured for the first time) registers instead of being skipped.
    if v_period.sales_target is distinct from p_sales_target then
      insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
      values (v_period.id, v_actor, 'sales_target', v_period.sales_target::text, p_sales_target::text);
    end if;

    if v_period.rsr_daily_target is distinct from p_rsr_daily_target then
      insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
      values (v_period.id, v_actor, 'rsr_daily_target', v_period.rsr_daily_target::text, p_rsr_daily_target::text);
    end if;

    if v_period.sales_target is distinct from p_sales_target
       or v_period.rsr_daily_target is distinct from p_rsr_daily_target then
      update public.cutoff_periods
         set sales_target     = p_sales_target,
             rsr_daily_target = p_rsr_daily_target,
             updated_at       = now()
       where id = v_period.id;
      v_updated := v_updated + 1;
    end if;

    -- Cap: future periods only. A period already running has meetings holding
    -- slots allocated against the old ceiling.
    if v_period.starts_on > v_today
       and v_period.client_meeting_cap is distinct from p_client_meeting_cap then
      insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
      values (v_period.id, v_actor, 'client_meeting_cap',
              v_period.client_meeting_cap::text, p_client_meeting_cap::text);

      update public.cutoff_periods
         set client_meeting_cap = p_client_meeting_cap,
             updated_at         = now()
       where id = v_period.id;
      v_cap := v_cap + 1;
    end if;
  end loop;

  periods_updated := v_updated;
  cap_updated     := v_cap;
  periods_ended   := v_ended;
  return next;
end $$;

revoke all on function public.apply_standing_targets(integer, integer, integer) from public;
grant execute on function public.apply_standing_targets(integer, integer, integer) to authenticated;

comment on function public.apply_standing_targets(integer, integer, integer) is
  'Upserts quota_settings and pushes the change onto every period that has not ended, writing one cutoff_period_changes row per field actually changed. Targets update in place because they feed no attribution decision; client_meeting_cap reaches only periods that have not started, because it does. Admin-only.';
