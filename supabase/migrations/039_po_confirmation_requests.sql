-- ============================================================================
-- 039 - po_confirmation_requests
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
-- projects/OracleSalesApp-Mobile/Migration-039-Report.md
--
-- Deliberately domain-specific rather than a generic polymorphic approval
-- table.
-- ============================================================================

-- Migration 039: PO confirmation requests, domain-specific table.
create table public.po_confirmation_requests (
  id uuid primary key default gen_random_uuid(),  -- client-generated (offline-first outbox)
  client_id uuid not null references public.clients(id),
  cycle_id uuid not null references public.client_cycles(id),
  meeting_id uuid not null references public.meetings(id),  -- the close-deal meeting
  requester_id uuid not null references public.profiles(id),
  po_photo_path text not null,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','cancelled')),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one PENDING request per cycle (a rejected one can be resubmitted,
-- opening a new pending row, since the partial index only blocks pending):
create unique index uq_po_pending_per_cycle
  on public.po_confirmation_requests (cycle_id) where status = 'pending';
create index idx_po_requester on public.po_confirmation_requests (requester_id, status);
create index idx_po_client on public.po_confirmation_requests (client_id);

alter table public.po_confirmation_requests enable row level security;

-- Requester inserts their own, only for a client they currently own:
create policy "Agents create own PO confirmation" on public.po_confirmation_requests
  for insert with check (
    requester_id = public.current_profile_id()
    and exists (select 1 from public.clients c
                 where c.id = client_id and c.assigned_agent_id = public.current_profile_id())
  );

-- Requester or their manager can read:
create policy "Participants read PO confirmation" on public.po_confirmation_requests
  for select using (
    requester_id = public.current_profile_id()
    or public.is_manager_of_profile(requester_id)
  );

-- Requester can cancel their own PENDING request:
create policy "Requester cancels own pending PO confirmation" on public.po_confirmation_requests
  for update using (requester_id = public.current_profile_id() and status = 'pending')
  with check (status = 'cancelled');

-- Decisions go through the RPC below only — no direct manager UPDATE policy,
-- keeps the CAS-decision discipline in one place.

-- Idempotent decision RPC — first valid terminal command wins.
create or replace function public.decide_po_confirmation(
  p_request_id uuid, p_decision text, p_note text default null
) returns jsonb
language plpgsql security definer volatile set search_path = public as $$
declare
  req public.po_confirmation_requests%rowtype;
begin
  if p_decision not in ('approved','rejected') then
    return jsonb_build_object('ok', false, 'code', 'invalid_decision');
  end if;

  select * into req from public.po_confirmation_requests where id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not public.is_manager_of_profile(req.requester_id) then
    return jsonb_build_object('ok', false, 'code', 'role_not_eligible');
  end if;

  update public.po_confirmation_requests
     set status = p_decision, decided_by = public.current_profile_id(),
         decided_at = now(), decision_note = p_note, updated_at = now()
   where id = p_request_id and status = 'pending';

  if not found then
    return jsonb_build_object('ok', false, 'code', 'already_decided');
  end if;

  return jsonb_build_object('ok', true, 'code', p_decision);
end; $$;
revoke execute on function public.decide_po_confirmation(uuid, text, text) from public, anon;
grant execute on function public.decide_po_confirmation(uuid, text, text) to authenticated;
