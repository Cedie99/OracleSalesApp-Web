-- ============================================================================
-- 082 — a "Lost Opportunity" meeting outcome actually loses the client
--
-- THE GAP: migration 017 gave `outcome = 'successful'` a server-side trigger
-- (promote_client_to_new). `outcome = 'lost_opportunity'` never got the
-- symmetric one. Mobile writes only the meeting row and waits for the server
-- to move the lifecycle (ADR-006: lifecycle automation runs server-side, never
-- on-device — see lib/meeting-service.ts, which explicitly defers), so today a
-- Lost Opportunity meeting changes nothing at all:
--
--   * clients.status stays 'active', so the map keeps drawing a prospect pin
--     and the Lost Opportunities page never sees the row;
--   * client_cycles stays open, so claim_lost_opportunity() (037) — which
--     matches on client_cycles.end_reason = 'lost', NOT on clients.status —
--     can never surface it in mobile's discovery pool.
--
-- Verified live 2026-08-10: three clients ("lei", "Ss", "AGNAT YOLAC RACING
-- TEAM") each have a lost_opportunity meeting and are all still status
-- 'active' / customer_type 'prospect'. The only status='lost' row in the
-- database got there by hand.
--
-- ADR-035 point 1: a client becomes a Lost Opportunity when (a) a Sales user
-- directly declares it lost — which is exactly what mobile's
-- LostOpportunityDialog confirm does — or (b) the fixed six-month deadline
-- (already covered by app/api/cron/lost-opportunity-sweep).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. handle_lost_opportunity() — stop overwriting a caller-supplied anchor
--
-- The 001 body assigned unconditionally:
--     NEW.lost_at         = NOW();
--     NEW.reassignable_at = NOW() + INTERVAL '14 days';
-- so ANY caller that knew the real loss timestamp had it silently replaced
-- with the moment the UPDATE happened to run. That is wrong for the path this
-- migration adds: an offline meeting can sync days after the agent declared
-- the loss, and the cooldown must run from the declaration, not from sync.
--
-- Now coalescing, so the trigger is a DEFAULT rather than an override — it
-- still stamps both columns for any path that doesn't supply them (a plain
-- admin edit that just flips the dropdown to Lost), and gets out of the way of
-- one that does.
--
-- The interval is also pinned to one calendar month here. Migration 036 was
-- supposed to make that edit in place on 2026-07-27, but it was a manual
-- find-and-replace done through the SQL Editor and this repo has never held
-- the resulting body — the only evidence the value is right is 036's data
-- backfill, which is a different statement. Rewriting the whole function makes
-- committed history authoritative instead of hoping.
--
-- `is distinct from` rather than `!=`: a NULL OLD.status made the old
-- comparison NULL, i.e. falsy, silently skipping the stamp.
-- ----------------------------------------------------------------------------
create or replace function public.handle_lost_opportunity()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'lost' and old.status is distinct from 'lost' then
    new.lost_at         := coalesce(new.lost_at, now());
    -- One CALENDAR month per ADR-035 (Jan 31 -> Feb 28, not Mar 2). Not 14
    -- days, which this was until 036, and not 30 days.
    new.reassignable_at := coalesce(new.reassignable_at, new.lost_at + interval '1 month');
  end if;
  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- 2. apply_lost_opportunity() — the whole loss transition, in one place
--
-- SECURITY DEFINER because client_cycles has no write policy for any role by
-- design (035: "rows are written ONLY by SECURITY DEFINER server code"), and
-- because 032 added `status <> 'lost'` guards to the agent/manager UPDATE
-- policies on clients.
-- ----------------------------------------------------------------------------
create or replace function public.apply_lost_opportunity(
  p_client_id uuid,
  p_lost_at   timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reassignable timestamptz := p_lost_at + interval '1 month';
begin
  -- `status = 'active'` guard makes this idempotent: a second lost meeting, or
  -- an offline one syncing in after the fact, must not restart a cooldown that
  -- is already running. handle_lost_opportunity() now honours these values
  -- rather than replacing them with now().
  update public.clients
     set status          = 'lost',
         lost_at         = p_lost_at,
         reassignable_at = v_reassignable,
         -- 035's own loss backfill clears both pointers on loss; match it, or
         -- the client keeps pointing at a cycle that is no longer open.
         current_cycle_id = null,
         cycle_started_at = null,
         updated_at      = now()
   where id = p_client_id
     and status = 'active';

  if not found then return; end if;

  -- Close the open cycle. Without this the record is invisible to mobile's
  -- discovery pool no matter what clients.status says. `assigned_agent_id` is
  -- deliberately left on the client row — the last owner is history, and 037
  -- reads cycle owner_id for the permanent former-owner exclusion.
  --
  -- Safe against 035's uq_client_cycles_claimable (one lost+unclaimed cycle
  -- per client): uq_client_cycles_open already guarantees there is at most one
  -- open cycle to close, and the guard above means we only get here on the
  -- active -> lost edge.
  update public.client_cycles
     set ended_at        = p_lost_at,
         end_reason      = 'lost',
         lost_at         = p_lost_at,
         reassignable_at = v_reassignable
   where client_id = p_client_id
     and ended_at is null;
end;
$$;

revoke execute on function public.apply_lost_opportunity(uuid, timestamptz) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. The trigger 017 never wrote.
--
-- `update of outcome` as well as insert, mirroring promote_on_successful_meeting:
-- a meeting whose outcome is corrected to Lost Opportunity afterwards is the
-- same declaration, just later.
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER, unlike 017's equivalent. 017 could stay invoker-rights
-- because it never revoked anything, so PUBLIC kept the default EXECUTE grant
-- on promote_client_to_new(). apply_lost_opportunity() is revoked from
-- everyone above — it moves ownership of an account and must not be callable
-- directly with an arbitrary client_id — so the caller here is the agent
-- inserting the meeting and would hit "permission denied for function".
-- Running the trigger as its owner keeps the nested call legal without
-- exposing the function to every authenticated user.
create or replace function public.trg_lose_on_lost_meeting()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.outcome = 'lost_opportunity' and new.client_id is not null then
    -- meeting_date, NOT now(): mobile is offline-first and a meeting can reach
    -- the server days after the agent declared the loss. The cooldown belongs
    -- to the declaration. Confirmed with Adrian 2026-08-10.
    perform public.apply_lost_opportunity(new.client_id, coalesce(new.meeting_date, now()));
  end if;
  return new;
end;
$$;

drop trigger if exists lose_on_lost_meeting on public.meetings;
create trigger lose_on_lost_meeting
  after insert or update of outcome on public.meetings
  for each row execute function public.trg_lose_on_lost_meeting();


-- ----------------------------------------------------------------------------
-- 4. Backfill the clients stranded by the missing trigger.
--
-- Earliest lost meeting per client, so a cooldown that should already be part
-- way through is not restarted at today's date.
-- ----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select m.client_id, min(m.meeting_date) as lost_at
      from public.meetings m
      join public.clients c on c.id = m.client_id
     where m.outcome = 'lost_opportunity'
       and c.status = 'active'
     group by m.client_id
  loop
    perform public.apply_lost_opportunity(r.client_id, r.lost_at);
  end loop;
end $$;


-- ============================================================================
-- VERIFICATION
--   -- Expect 0: no client with a lost meeting is still active.
--   select count(*) from public.meetings m
--     join public.clients c on c.id = m.client_id
--    where m.outcome = 'lost_opportunity' and c.status = 'active';
--
--   -- Expect 0: every lost client has a closed, lost cycle.
--   select count(*) from public.clients c
--    where c.status = 'lost'
--      and not exists (select 1 from public.client_cycles cc
--                       where cc.client_id = c.id and cc.end_reason = 'lost');
--
--   -- Expect 0: cooldown is a calendar month from the loss, everywhere.
--   select count(*) from public.clients
--    where status = 'lost' and lost_at is not null
--      and reassignable_at is distinct from lost_at + interval '1 month';
--
-- ROLLBACK
--   drop trigger if exists lose_on_lost_meeting on public.meetings;
--   drop function if exists public.trg_lose_on_lost_meeting();
--   drop function if exists public.apply_lost_opportunity(uuid, timestamptz);
--   -- handle_lost_opportunity() back to an unconditional stamp (keeping the
--   -- one-month interval — reverting that is 036's rollback, not this one):
--   --   new.lost_at := now(); new.reassignable_at := now() + interval '1 month';
--
-- Clients already lost stay lost, same convention as 017. To undo the backfill
-- specifically, reverse status/lost_at/reassignable_at/current_cycle_id on the
-- affected ids and reopen their client_cycles rows (ended_at/end_reason null).
-- ============================================================================
