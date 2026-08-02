-- ============================================================================
-- 028 - Quota policy table (RSR only)
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-26, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version is created with `supabase migration repair --status applied`,
-- so `supabase db push` skips it. If a push ever tries to EXECUTE this file,
-- stop and fix the repair rather than letting it run.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-028-Report.md
-- ============================================================================

-- Migration 028: quota_policy table, RSR-only scope for Batch 2.
-- Extensible shape (role/policy_kind enums allow future Sales rows) but only
-- one 'rsr'/'daily_visit_target' row is created this batch — no Sales policy
-- rows, no runtime Sales consumer, no cutoff_calendar (shape still undecided
-- per Batch 0 item 1, reserved via policy_kind='cutoff_target' instead).
create table public.quota_policy (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('rsr','sales_specialist')),
  policy_kind text not null default 'daily_visit_target'
    check (policy_kind in ('daily_visit_target','cutoff_target')),
  target_value integer not null check (target_value > 0),
  timezone text not null default 'Asia/Manila',
  effective_from date not null,
  effective_until date,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quota_policy_window check (effective_until is null or effective_until > effective_from)
);

create unique index uq_quota_policy_active
  on public.quota_policy (role, policy_kind, effective_from) where is_active;

alter table public.quota_policy enable row level security;

-- Broad authenticated read is deliberate: this is non-sensitive config data
-- every future runtime consumer (mobile quota display, manager views) needs.
-- Writes are admin-only.
create policy "Authenticated read quota policies" on public.quota_policy
  for select using (auth.role() = 'authenticated');

create policy "Admin manage quota policies" on public.quota_policy
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- Seed: matches the current live RSR_DAILY_VISIT_QUOTA = 12 constant, so
-- policy data reflects today's reality from day one. Admin flips this to 16
-- (or whatever) once Batch 0 item 2's face-to-face decision lands — no code
-- release needed.
insert into public.quota_policy (role, policy_kind, target_value, timezone, effective_from, is_active)
values ('rsr', 'daily_visit_target', 12, 'Asia/Manila', current_date, true);
