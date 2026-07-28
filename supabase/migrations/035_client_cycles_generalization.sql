-- ============================================================================
-- 035 - client_cycles - generalized ownership-cycle history
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-27, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version is created with `supabase migration repair --status applied`,
-- so `supabase db push` skips it. If a push ever tries to EXECUTE this file,
-- stop and fix the repair rather than letting it run.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-035-Report.md
-- ============================================================================

-- Migration 035: generalized ownership-cycle history for every client.
create table public.client_cycles (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id),
  owner_id        uuid not null references public.profiles(id),
  started_at      timestamptz not null,
  ended_at        timestamptz,
  end_reason      text check (end_reason in ('lost','superseded','deleted')),
  -- loss-claim metadata, populated only when end_reason = 'lost':
  lost_at         timestamptz,
  reassignable_at timestamptz,
  claimed_by      uuid references public.profiles(id),
  claimed_at      timestamptz,
  agenda_policy_version int,  -- stamped by Migration 038's agenda policy system
  created_at      timestamptz not null default now()
);

-- At most one OPEN tenure per client:
create unique index uq_client_cycles_open on public.client_cycles (client_id)
  where ended_at is null;
-- At most one CLAIMABLE (lost, unclaimed) cycle per client:
create unique index uq_client_cycles_claimable on public.client_cycles (client_id)
  where end_reason = 'lost' and claimed_by is null;
create index idx_client_cycles_client on public.client_cycles (client_id);

alter table public.client_cycles enable row level security;
-- No INSERT/UPDATE/DELETE policy for any role — rows are written ONLY by
-- SECURITY DEFINER server code (claim RPC, loss job, reassignment trigger).
create policy "Admin read client cycles" on public.client_cycles
  for select using (public.is_admin());

-- Denormalized current-cycle pointers on clients (server-maintained only):
alter table public.clients
  add column current_cycle_id uuid references public.client_cycles(id),
  add column cycle_started_at timestamptz;

-- Backfill: every client with an owner gets cycle 1, anchored at creation.
insert into public.client_cycles (client_id, owner_id, started_at)
  select id, assigned_agent_id, created_at from public.clients
  where assigned_agent_id is not null;
update public.clients c set
  current_cycle_id = cc.id, cycle_started_at = cc.started_at
  from public.client_cycles cc
  where cc.client_id = c.id and cc.ended_at is null;

-- Currently-lost clients: close their cycle 1 using clients' own recorded
-- lost_at/reassignable_at (Migration 013 columns), mark it claimable.
update public.client_cycles cc set
  ended_at = c.lost_at, end_reason = 'lost',
  lost_at = c.lost_at, reassignable_at = c.reassignable_at
  from public.clients c
  where c.id = cc.client_id and c.status = 'lost' and cc.ended_at is null;
update public.clients set current_cycle_id = null, cycle_started_at = null
  where status = 'lost';
-- Rows that would be skipped by the backfill (unanchored — flag for triage):
select count(*) from public.clients
 where status = 'lost'
   and (lost_at is null or reassignable_at is null or assigned_agent_id is null);
