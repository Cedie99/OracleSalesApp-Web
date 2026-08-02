-- ============================================================================
-- 038 - Lifecycle, cycle-scoped meetings, reassignment audit, agenda policy
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
-- projects/OracleSalesApp-Mobile/Migration-038-Report.md
--
-- The largest migration in Batch 3. Applied as Parts A-D, all four confirmed
-- live.
-- ============================================================================

-- ══════════════ Part A: customer_type widening — APPLIED 2026-07-27 ══════════════
alter table public.clients drop constraint clients_customer_type_check;
alter table public.clients add constraint clients_customer_type_check
  check (customer_type in ('prospect','in_progress','new','existing') or customer_type is null);

alter table public.clients add column in_progress_at timestamptz;
-- ^ prevents a single meeting from chaining both stage transitions in one
--   firing: Close-deal evidence must postdate entry into 'in_progress'.

-- ══════════════ Part B: cycle-scoped meeting eligibility ══════════════
alter table public.meetings add column cycle_id uuid references public.client_cycles(id);
alter table public.meetings add column agenda_ids text[];  -- stable ids, additive alongside legacy `agendas` label array
create index idx_meetings_cycle on public.meetings (cycle_id);

-- Backfill existing meetings into their client's current cycle (preserves
-- today's behavior for clients that have never been claimed/reassigned):
update public.meetings m set cycle_id = c.current_cycle_id
  from public.clients c where c.id = m.client_id and c.current_cycle_id is not null;

create or replace function public.trg_stamp_meeting_cycle()
returns trigger language plpgsql security definer as $$
begin
  if new.client_id is not null and new.cycle_id is null then
    select c.current_cycle_id into new.cycle_id
      from public.clients c
      where c.id = new.client_id
        and c.assigned_agent_id = new.agent_id;  -- only the CURRENT owner's meetings join the current cycle
  end if;
  return new;
end; $$;
create trigger stamp_meeting_cycle before insert on public.meetings
  for each row execute function public.trg_stamp_meeting_cycle();

-- ══════════════ Part C: manager reassignment preserves the cycle ══════════════
create table public.client_reassignment_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id),
  cycle_id uuid references public.client_cycles(id),
  previous_owner_id uuid not null references public.profiles(id),
  new_owner_id uuid not null references public.profiles(id),
  actor_id uuid not null references public.profiles(id),
  kind text not null check (kind in ('manager_reassignment','lost_claim')),
  reason text,
  created_at timestamptz not null default now()
);
alter table public.client_reassignment_events enable row level security;
-- Append-only, immutable: no UPDATE/DELETE policy for anyone.
create policy "Admin read reassignment events" on public.client_reassignment_events
  for select using (public.is_admin());

-- Ownership-pointer sync (does NOT close/reopen the cycle — "only ownership changes"):
create or replace function public.trg_sync_cycle_owner_on_reassignment()
returns trigger language plpgsql security definer as $$
begin
  if new.assigned_agent_id is distinct from old.assigned_agent_id then
    update public.client_cycles
       set owner_id = new.assigned_agent_id
     where client_id = new.id and ended_at is null
       and owner_id <> new.assigned_agent_id;
    -- No-op on claims: the claim RPC (Migration 037) inserts the new cycle
    -- with the correct owner in the same transaction before this fires.
  end if;
  return new;
end; $$;
create trigger sync_cycle_owner_on_reassignment
  after update of assigned_agent_id on public.clients
  for each row execute function public.trg_sync_cycle_owner_on_reassignment();

-- Replaces the bare CAS'd UPDATE write path (lib/manager-client-service.ts)
-- with an RPC that captures a mandatory reason and writes the audit event
-- atomically. Migration 025/032's RLS policies remain the authorization layer.
create or replace function public.reassign_team_client(
  p_client_id uuid, p_new_agent_id uuid, p_expected_current_agent_id uuid, p_reason text
) returns jsonb
language plpgsql security definer volatile set search_path = public as $$
declare
  updated_row public.clients%rowtype;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'reason_required');
  end if;

  update public.clients
     set assigned_agent_id = p_new_agent_id
   where id = p_client_id
     and assigned_agent_id = p_expected_current_agent_id
     and status <> 'lost'  -- Migration 032 guard, preserved
  returning * into updated_row;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'stale_or_not_permitted');
  end if;

  insert into public.client_reassignment_events
    (client_id, cycle_id, previous_owner_id, new_owner_id, actor_id, kind, reason)
    values (p_client_id, updated_row.current_cycle_id, p_expected_current_agent_id,
            p_new_agent_id, public.current_profile_id(), 'manager_reassignment', p_reason);

  return jsonb_build_object('ok', true, 'code', 'reassigned', 'client', to_jsonb(updated_row));
end; $$;
revoke execute on function public.reassign_team_client(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.reassign_team_client(uuid, uuid, uuid, text) to authenticated;

-- ══════════════ Part D: versioned agenda-policy system ══════════════
create table public.agenda_policy_versions (
  policy_version int primary key,
  effective_date timestamptz not null default now(),
  is_current boolean not null default false,
  created_by uuid references public.profiles(id),
  notes text
);
create unique index uq_one_current_policy on public.agenda_policy_versions (is_current) where is_current;

create table public.agenda_catalog (
  agenda_id text not null,
  policy_version int not null references public.agenda_policy_versions(policy_version),
  display_label text not null,
  progress_weight numeric not null default 0,
  progress_override numeric,
  is_active boolean not null default true,
  sort_order int not null,
  primary key (agenda_id, policy_version)
);

create table public.agenda_stage_rules (
  agenda_id text not null,
  policy_version int not null,
  stage text not null check (stage in ('prospect','in_progress')),
  is_visible boolean not null default true,
  primary key (agenda_id, policy_version, stage),
  foreign key (agenda_id, policy_version) references public.agenda_catalog (agenda_id, policy_version)
);

alter table public.agenda_policy_versions enable row level security;
alter table public.agenda_catalog enable row level security;
alter table public.agenda_stage_rules enable row level security;
create policy "Authenticated read policy versions" on public.agenda_policy_versions for select using (auth.role() = 'authenticated');
create policy "Admin manage policy versions" on public.agenda_policy_versions for all using (public.is_admin()) with check (public.is_admin());
create policy "Authenticated read agenda catalog" on public.agenda_catalog for select using (auth.role() = 'authenticated');
create policy "Admin manage agenda catalog" on public.agenda_catalog for all using (public.is_admin()) with check (public.is_admin());
create policy "Authenticated read stage rules" on public.agenda_stage_rules for select using (auth.role() = 'authenticated');
create policy "Admin manage stage rules" on public.agenda_stage_rules for all using (public.is_admin()) with check (public.is_admin());

-- Seed policy_version 1 — Vince's final 7-item set (Collection and Complaint
-- resolution explicitly REMOVED from the catalog per his direct instruction,
-- not merely zero-weighted).
insert into public.agenda_policy_versions (policy_version, is_current) values (1, true);
insert into public.agenda_catalog (agenda_id, policy_version, display_label, progress_weight, progress_override, sort_order) values
  ('new_business_opportunity', 1, 'New business opportunity', 15, null, 1),
  ('product_presentation',     1, 'Product / company presentation', 15, null, 2),
  ('price_negotiation',        1, 'Price negotiation / quotation', 15, null, 3),
  ('terms_limit_negotiation',  1, 'Terms & limit negotiation', 15, null, 4),
  ('relationship_building',    1, 'Relationship building', 15, null, 5),
  ('technical_support',        1, 'Technical support', 15, null, 6),
  ('close_deal',               1, 'Close deal', 0, 100, 7);
insert into public.agenda_stage_rules (agenda_id, policy_version, stage, is_visible)
  select agenda_id, 1, 'prospect', true from public.agenda_catalog where policy_version = 1 and agenda_id <> 'close_deal'
  union all
  select agenda_id, 1, 'in_progress', true from public.agenda_catalog where policy_version = 1;

alter table public.client_cycles add column if not exists agenda_policy_version int references public.agenda_policy_versions(policy_version);
update public.client_cycles set agenda_policy_version = 1 where agenda_policy_version is null;

-- Progress computation (server-authoritative; mobile computes only a preview):
create or replace function public.get_client_cycle_progress(p_client_id uuid)
returns numeric
language sql security definer stable set search_path = public as $$
  select case
    when c.customer_type in ('new','existing') then 100
    else least(
      coalesce((
        select sum(ac.progress_weight)
        from (select distinct unnest(m.agenda_ids) as agenda_id
                from public.meetings m
               where m.client_id = p_client_id and m.cycle_id = c.current_cycle_id) sel
        join public.agenda_catalog ac
          on ac.agenda_id = sel.agenda_id and ac.policy_version = cc.agenda_policy_version
      ), 0), 90)
  end
  from public.clients c
  join public.client_cycles cc on cc.id = c.current_cycle_id
  where c.id = p_client_id;
$$;
