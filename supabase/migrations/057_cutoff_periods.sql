-- ============================================================================
-- 057 - Cutoff periods (Batch 7A/7B, Client Meeting Cutoff and Quota)
--
-- Contract: vault's projects/OracleSalesApp-Mobile/Meeting-2026-07-31-Cutoff-Quota.md
-- ("Vince's resolved contract - 2026-08-02") and Decisions.md ADR-053.
--
-- Admin-owned, immutable-once-active config. O-6 (revised): targets are
-- PER ROLE (sales_specialist / rsr independently configurable), never one
-- shared global number. The per-client New/Existing meeting cap is a
-- separate, shared/global axis (O-6). O-8: Admin may only version/supersede
-- an active/closed period, never edit it in place (item #8) - enforced by
-- convention here (no UPDATE policy for non-admin, and application code is
-- expected to insert a new row with supersedes_period_id rather than update
-- dates/targets on an active row). Non-overlap for concurrently-active
-- periods is enforced by a database exclusion constraint, not app code.
--
-- Deliberately NOT reusing migration 028's quota_policy table/row - that
-- stays untouched, RSR-only, daily-target legacy shape, read only by the
-- old app behavior while feature flag cutoff_quota_v1 is OFF.
-- ============================================================================

create extension if not exists btree_gist;

create table if not exists public.cutoff_periods (
  id                  uuid primary key default gen_random_uuid(),
  label               text not null,
  starts_on           date not null,
  ends_on             date not null,
  sales_target        integer check (sales_target is null or sales_target > 0),
  rsr_target          integer check (rsr_target is null or rsr_target > 0),
  client_meeting_cap  integer not null check (client_meeting_cap > 0),
  status              text not null default 'scheduled'
                        check (status in ('draft','scheduled','active','closed','superseded')),
  supersedes_period_id uuid references public.cutoff_periods(id),
  version             integer not null default 1,
  created_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint cutoff_periods_window check (ends_on >= starts_on)
);

comment on table public.cutoff_periods is
  'Admin-configured cutoff periods. Per-role quota targets (sales_target, rsr_target) are independent - a role with a null target renders "No quota configured" on mobile, never a hardcoded fallback (contract O-6). client_meeting_cap is the shared New/Existing per-client cap for the period unless a future revision splits it per role.';
comment on column public.cutoff_periods.sales_target is 'Period quota target for sales_specialist role. Null = not configured for this role.';
comment on column public.cutoff_periods.rsr_target is 'Period quota target for rsr role. Null = not configured for this role.';
comment on column public.cutoff_periods.client_meeting_cap is 'Shared New/Existing per-client meeting cap for this period (contract #1: one pool across new+existing).';

-- Non-overlap for concurrently-live periods (scheduled or active) - contract
-- item #8: "no overlapping periods for the same scope." Scope is global in
-- 7A-7D (no team/role partition on the period row itself), so any two
-- scheduled/active periods' date ranges must not intersect.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cutoff_periods'::regclass
       and conname  = 'cutoff_periods_no_overlap'
  ) then
    alter table public.cutoff_periods
      add constraint cutoff_periods_no_overlap
      exclude using gist (
        daterange(starts_on, ends_on, '[]') with &&
      )
      where (status in ('scheduled','active'));
  end if;
end $$;

create index if not exists idx_cutoff_periods_status on public.cutoff_periods (status);
create index if not exists idx_cutoff_periods_active_range on public.cutoff_periods (starts_on, ends_on) where status = 'active';

alter table public.cutoff_periods enable row level security;

drop policy if exists "Authenticated read cutoff periods" on public.cutoff_periods;
create policy "Authenticated read cutoff periods" on public.cutoff_periods
  for select using (auth.role() = 'authenticated');

drop policy if exists "Admin manage cutoff periods" on public.cutoff_periods;
create policy "Admin manage cutoff periods" on public.cutoff_periods
  for all
  using (public.is_admin())
  with check (public.is_admin());
