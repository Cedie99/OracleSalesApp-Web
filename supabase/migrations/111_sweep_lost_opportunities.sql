-- ============================================================================
-- 111 — sweep_lost_opportunities(): the 6-month auto-loss, done correctly
--
-- THE DEFECT. app/api/cron/lost-opportunity-sweep has, since it was written,
-- performed the loss transition as a raw UPDATE on public.clients:
--
--   .update({ status: 'lost', lost_at, reassignable_at, inactive_reason })
--
-- That is only half of a loss. 082 exists precisely because the other half
-- lives in client_cycles, and its header states the consequence outright:
--
--   "client_cycles stays open, so claim_lost_opportunity() (037) — which
--    matches on client_cycles.end_reason = 'lost', NOT on clients.status —
--    can never surface it in mobile's discovery pool."
--
-- 082 then lists the six-month deadline as "already covered by
-- app/api/cron/lost-opportunity-sweep". It was not; the cron predates
-- apply_lost_opportunity() and was never moved onto it. 088 got this right and
-- says so in its own header ("do NOT re-derive that formula here"). This
-- migration finishes the job 082 assumed was done.
--
-- WHAT THE USER ACTUALLY SEES, which is worse than invisibility. Mobile's list
-- (lib/lost-opportunity-read-service.ts) reads `clients`, not cycles:
--
--   .eq('status','lost').lte('reassignable_at', now).neq('assigned_agent_id', me)
--
-- so a cron-lost client DOES appear, and looks claimable. The claim then runs
-- 037's compare-and-swap, which needs cc.end_reason = 'lost' and finds nothing.
-- Trace 037's diagnosis block for such a row: status IS 'lost' (skips
-- not_found_or_not_lost), caller is not a former owner (skips
-- former_owner_excluded), reassignable_at has passed (skips cooling_down) — and
-- it falls through to the final `return ... 'already_claimed'`, which mobile
-- renders as "Another agent already claimed this client."
--
-- Nobody claimed it. Every eligible agent gets that message, permanently. The
-- timing hides it too: for the first month the row honestly reports
-- cooling_down, so the fault only appears a month after the sweep runs.
--
-- NOT YET TRIGGERED. Verified on production 2026-08-20: all 4 status='lost'
-- clients have a closed cycle (end_reason='lost') and current_cycle_id null,
-- and all 4 carry inactive_reason IS NULL — the signature of 082's meeting
-- trigger, which is the only loss path that has ever fired here. There are no
-- damaged rows, so this migration has NO backfill. The oldest active client
-- dates to 2026-08-05, so the sweep could not have caught anything yet.
--
-- ----------------------------------------------------------------------------
-- SCOPE CHANGE: new/existing customers are no longer swept.
--
-- The route had no customer_type filter at all — every active client was in
-- range, including won accounts. That is wrong on its own terms: "Lost
-- Opportunity" means a deal that did not close, and its downstream mechanic is
-- a pool where a DIFFERENT agent claims the client. Applied to an existing
-- customer, six quiet months would silently transfer a real account away from
-- the agent who owns it.
--
-- ADR-035 agrees ("6 months max as prospect"; promotion to New "exits the
-- prospect auto-lifecycle permanently"), but the deciding argument is the
-- mechanic, not the note. in_progress IS included: ADR-035 predates 040's
-- four-stage split, and under the two-stage model it described, "prospect"
-- covered everything before New.
--
-- An existing customer can still be lost — by a lost_opportunity meeting (082),
-- by declare_client_lost (088), or by an admin. Losing a won account stays a
-- human decision, which is the point.
--
-- customer_type is NOT NULL (001) and production holds zero nulls, so the IN
-- list needs no null arm.
--
-- ----------------------------------------------------------------------------
-- UNCHANGED: the rolling clock. Eligibility is still "no meeting in the last
-- six months", anchored on the most recent meeting_date and falling back to
-- created_at, and it still re-arms on every meeting. That is what the running
-- code does and what mobile promises its users on the Lost Opportunities screen
-- ("either declared lost, or with no meeting for 6 months"). ADR-035's fixed
-- details_completed_at anchor was never built anywhere in either repo; adopting
-- it would be a behaviour change, and is deliberately not bundled here.
--
-- 180 days -> interval '6 months'. The route used 1000*60*60*24*30*6, i.e. six
-- 30-day months. Calendar months are this codebase's convention for exactly
-- this kind of interval — see lib/lost-opportunity.ts, which argues it at
-- length, and 036/082, which pin the cooldown to interval '1 month'. Worth ~3
-- days, and it stops the sweep disagreeing with the cooldown it hands out.
--
-- ----------------------------------------------------------------------------
-- WHY A FUNCTION AND NOT A FIXED ROUTE. 082 sealed the primitive:
--
--   revoke execute on function apply_lost_opportunity(uuid, timestamptz)
--     from public, anon, authenticated;
--
-- "it moves ownership of an account and must not be callable directly with an
-- arbitrary client_id". Granting it to the cron would undo that. Instead this
-- wrapper chooses its own targets and takes no client argument, so the sealed
-- function stays sealed and the caller cannot aim it.
--
-- Selecting inside the database also retires three hazards the route carried:
-- an unpaginated select of every active client, a second unpaginated select of
-- their meetings passed as one `IN` list (24,263 characters at today's 653
-- clients — it still returns 200, but it is a wall being walked toward), and a
-- read-then-write with no transaction around it.
--
-- NO AUDIT ROW, deliberately. client_reassignment_events.actor_id is NOT NULL
-- and references profiles(id) (038). An automated sweep has no actor, and
-- writing the outgoing owner there would record a machine decision as that
-- agent's own. A system-actor concept is a larger change than this migration
-- should smuggle in.
-- ============================================================================

create or replace function public.sweep_lost_opportunities()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_ids       uuid[] := '{}';
  -- One timestamp for the whole sweep, so every client lost in this pass shares
  -- an anchor and therefore an identical cooldown expiry. Taking now() per
  -- iteration would fan the batch out across the loop's own runtime.
  v_now       timestamptz := now();
begin
  for v_client_id in
    select c.id
      from public.clients c
     where c.status = 'active'
       and c.customer_type in ('prospect', 'in_progress')
       and coalesce(
             (select max(m.meeting_date)
                from public.meetings m
               where m.client_id = c.id),
             c.created_at
           ) < v_now - interval '6 months'
     -- Oldest first: purely so a partial failure leaves the most overdue
     -- clients handled rather than an arbitrary subset.
     order by c.created_at
  loop
    -- The whole clients/client_cycles transition — status, lost_at,
    -- reassignable_at, current_cycle_id/cycle_started_at, and closing the open
    -- cycle — belongs to 082. Do not re-derive it here (088's warning).
    -- Idempotent on status = 'active', which the WHERE above guarantees.
    perform public.apply_lost_opportunity(v_client_id, v_now);

    -- apply_lost_opportunity() does not set inactive_reason; 088 stamps it
    -- separately for the same reason. The status guard means a client the
    -- transition declined to move is not labelled as though it had moved.
    update public.clients
       set inactive_reason = 'Auto-lost: no meeting activity for 6+ months'
     where id = v_client_id
       and status = 'lost';

    v_ids := v_ids || v_client_id;
  end loop;

  return jsonb_build_object(
    'ok',    true,
    'swept', coalesce(array_length(v_ids, 1), 0),
    'ids',   to_jsonb(v_ids)
  );
end; $$;

-- Same posture as the function it wraps: no agent, manager or anonymous caller
-- may run a batch that reassigns accounts. Only the cron's admin client, which
-- authenticates to PostgREST as service_role, can.
revoke all on function public.sweep_lost_opportunities() from public, anon, authenticated;
grant execute on function public.sweep_lost_opportunities() to service_role;

-- ============================================================================
-- VERIFICATION
--   -- 1. Dry run of the selection, mutating nothing. Should be 0 today
--   --    (oldest active client is 2026-08-05).
--   select c.id, c.company_name, c.customer_type,
--          coalesce((select max(m.meeting_date) from public.meetings m
--                     where m.client_id = c.id), c.created_at) as last_activity
--     from public.clients c
--    where c.status = 'active'
--      and c.customer_type in ('prospect', 'in_progress')
--      and coalesce((select max(m.meeting_date) from public.meetings m
--                     where m.client_id = c.id), c.created_at)
--          < now() - interval '6 months'
--    order by c.created_at;
--
--   -- 2. Every active client must own exactly one open cycle. This is the
--   --    invariant the old route broke; it must hold before and after a sweep.
--   select count(*) from public.clients c
--    where c.status = 'active'
--      and not exists (select 1 from public.client_cycles cc
--                       where cc.client_id = c.id and cc.ended_at is null);
--   -- expect 0
--
--   -- 3. After a sweep that moved rows: every client it touched is claimable
--   --    in the sense 037 actually tests.
--   select c.id, c.status, c.current_cycle_id,
--          cc.ended_at, cc.end_reason, cc.reassignable_at
--     from public.clients c
--     join public.client_cycles cc on cc.client_id = c.id
--    where c.inactive_reason = 'Auto-lost: no meeting activity for 6+ months';
--   -- expect status='lost', current_cycle_id null,
--   --        ended_at set, end_reason='lost', reassignable_at = lost_at + 1 month
--
-- ROLLBACK
--   revoke execute on function public.sweep_lost_opportunities() from service_role;
--   drop function if exists public.sweep_lost_opportunities();
--   -- Clients already swept are NOT reverted: they are correctly-formed lost
--   -- rows, indistinguishable from a declared loss, and un-losing them would
--   -- need a cycle-reopening path that does not exist (see the restore-path
--   -- note in app/(admin)/clients/page.tsx).
-- ============================================================================
