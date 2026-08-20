-- ============================================================================
-- 110 - Prospect-stage PO confirmation (ADR-061)
--
-- Vince, 2026-08-19/20 (mobile session): a PO can now be submitted directly
-- from Prospect, not only In Progress.
--
--   Scenario 1 - prospect + Close deal + PO -> manager approval -> new
--                (Close deal is OPTIONAL to select at prospect)
--   Scenario 2 - prospect, no PO attempt -> in_progress -> (later) new,
--                exactly the existing unchanged flow
--
-- Locked decisions this migration encodes:
--   1. While a Scenario-1 attempt is live for the current cycle, the client
--      stays PROSPECT - it must never flash IN PROGRESS.
--   2. A rejected PO leaves the client at PROSPECT, retryable.
--   3. PO is the ONLY thing tightened at prospect. Nothing else changes.
--
-- ----------------------------------------------------------------------------
-- THE ORDERING PROBLEM THIS DESIGN AVOIDS
--
-- The obvious first design is "withhold prospect->in_progress while a
-- pending/approved po_confirmation_requests row exists for this cycle." That
-- does not work here. Mobile's own outbox (B-127) makes a PO row's push
-- DEPEND on its meeting already being 'synced' (po_confirmation_requests has
-- an FK to meetings, so the row cannot even be INSERTed server-side before
-- the meeting exists). That means `trg_promote_on_successful_meeting` (AFTER
-- INSERT on meetings) ALWAYS fires before that same submission's PO row can
-- possibly exist server-side - an "exists a pending PO" check evaluated at
-- that instant can only ever see an OLDER PO, never today's. It would
-- promote to in_progress on every genuine Scenario-1 attempt, then have
-- nothing to undo it once the PO does land moments later - the exact flash
-- Vince said must not happen, just delayed by one round trip instead of
-- instant.
--
-- Fix: don't wait for the PO to arrive. The signal that a Close-deal attempt
-- is live is already fully present, in the SAME row, at the SAME instant the
-- meeting insert fires: `m.agenda_ids @> array['close_deal']`. Withholding
-- promotion on that alone is deterministic and race-free - no dependency on
-- when (or whether) the PO physically reaches the server.
--
-- If Close deal was selected but the agent never attaches PO evidence at
-- all (a real possibility - Close deal is optional to select, not required
-- to be followed by evidence), the client simply does not advance from that
-- meeting. Nothing is lost or corrupted - it advances normally the moment a
-- later meeting in the same cycle is recorded without Close deal (ordinary
-- Scenario 2), or advances to `new` the moment a Close-deal PO for this
-- cycle is approved. This is the conservative, safe default: never silently
-- promote past a live Close-deal negotiation.
--
-- ----------------------------------------------------------------------------
-- KNOWN PRE-EXISTING GAP (not introduced by this migration, flagged for
-- Vince): 5 live prospect clients currently have `current_cycle_id is null`
-- (migration 051's cycle-opening trigger only covers client INSERTs going
-- forward, not older rows). Both `advance_prospect_to_in_progress()` and the
-- new `advance_prospect_to_new()` join PO evidence through
-- `p.cycle_id = c.current_cycle_id` - a null cycle can never match, so those
-- 5 clients cannot be promoted via either path until they are backfilled a
-- cycle. Out of scope here; same class of gap Migration-051-Report.md
-- already documents for a different symptom.
-- ============================================================================

-- --- 1. Close deal becomes visible at the prospect stage --------------------
-- Mirrors the mobile-side default (lib/policies/agenda-policy.ts's
-- DEFAULT_AGENDA_STAGE_RULES) so a server-driven catalog refresh agrees with
-- the bundled fallback. Only one live policy_version (1) exists today;
-- ON CONFLICT keeps this re-runnable rather than assuming that stays true.
insert into public.agenda_stage_rules (agenda_id, policy_version, stage, is_visible)
select 'close_deal', apv.policy_version, 'prospect', true
  from public.agenda_policy_versions apv
 on conflict (agenda_id, policy_version, stage) do update set is_visible = true;

-- --- 2. Withhold prospect -> in_progress during a live Close-deal attempt ---
-- Identical to the live 049 definition, plus exactly one new guard clause.
create or replace function public.advance_prospect_to_in_progress(p_client_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.clients c
  set customer_type = 'in_progress', in_progress_at = now()
  where c.id = p_client_id
    and (c.customer_type is null or c.customer_type = 'prospect')
    and c.status not in ('lost','deleted')
    and exists (
      select 1 from public.meetings m
      join lateral unnest(m.agenda_ids) as aid on true
      join public.agenda_catalog ac
        on ac.agenda_id = aid
       and ac.policy_version = (select cc.agenda_policy_version
                                  from public.client_cycles cc
                                 where cc.id = c.current_cycle_id)
      join public.agenda_stage_rules asr
        on asr.agenda_id = ac.agenda_id
       and asr.policy_version = ac.policy_version
       and asr.stage = 'prospect'
      where m.client_id = c.id
        and m.cycle_id = c.current_cycle_id
        and m.outcome = 'successful'
        and asr.is_visible
    )
    and not exists (  -- Migration 026 tag-along gate, preserved on this edge
      select 1 from public.tag_along_requests t
      where t.related_client_id = c.id
        and t.invitee_kind = 'manager' and t.context = 'meeting' and t.status = 'pending'
    )
    and not exists (  -- ADR-061: a Close-deal attempt this cycle routes through
                       -- advance_prospect_to_new() below, never here - see the
                       -- header comment for why this must be evaluated from the
                       -- meeting row itself, not from po_confirmation_requests.
      select 1 from public.meetings m
      where m.client_id = c.id
        and m.cycle_id = c.current_cycle_id
        and m.outcome = 'successful'
        and m.agenda_ids @> array['close_deal']
    );
end; $$;

-- --- 3. New: prospect -> new, Scenario 1's direct path -----------------------
-- Mirrors advance_in_progress_to_new()'s shape (063's live version) minus the
-- details_completed_at gate (063 already dropped that for the other edge)
-- and minus the `m.created_at > c.in_progress_at` postdating check, which has
-- no meaning here - this client never entered in_progress on this path.
create or replace function public.advance_prospect_to_new(p_client_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.clients c
  set customer_type = 'new'
  where c.id = p_client_id
    and c.customer_type = 'prospect'   -- this function owns ONLY this edge
    and c.status not in ('lost','deleted')
    and exists (   -- the Close-deal evidence this cycle
      select 1 from public.meetings m
      where m.client_id = c.id
        and m.cycle_id = c.current_cycle_id
        and m.outcome = 'successful'
        and m.agenda_ids @> array['close_deal']
    )
    and exists (   -- Manager-approved PO evidence for THIS cycle
      select 1 from public.po_confirmation_requests p
      where p.client_id = c.id and p.cycle_id = c.current_cycle_id and p.status = 'approved'
    )
    and not exists (   -- Same tag-along gate as every other promotion edge
      select 1 from public.tag_along_requests t
      where t.related_client_id = c.id
        and t.invitee_kind = 'manager' and t.context = 'meeting' and t.status = 'pending'
    );
end; $$;

comment on function public.advance_prospect_to_new(uuid) is
  'ADR-061 (2026-08-19/20, migration 110): Scenario 1 direct promotion, prospect -> new, gated on a Close-deal meeting plus a manager-approved PO for the client''s current cycle. Never fires from in_progress - that edge stays advance_in_progress_to_new().';

-- --- 4. Dispatch the PO-approval re-check by the client's CURRENT stage -----
-- Was unconditional (always advance_in_progress_to_new). Prospect clients
-- can now reach this trigger too (Scenario 1's PO gets approved), so this
-- must route to the correct edge - same stage-dispatch shape
-- trg_promote_on_tagalong_resolved already uses (migration 040).
create or replace function public.trg_promote_on_po_confirmed()
returns trigger language plpgsql security definer as $$
declare stage text;
begin
  if new.status = 'approved' and old.status = 'pending' then
    select customer_type into stage from public.clients where id = new.client_id;
    if stage = 'prospect' then
      perform public.advance_prospect_to_new(new.client_id);
    else
      perform public.advance_in_progress_to_new(new.client_id);
    end if;
  end if;
  return new;
end; $$;

-- Note: a REJECTED PO needs no code here. trg_promote_on_po_confirmed only
-- ever acts on new.status = 'approved' - a rejection changes no customer_type
-- anywhere, so the client is already, structurally, left at PROSPECT and
-- retryable (decision 2) with zero additional logic.

-- ============================================================================
-- Rollback (if ever needed):
--
--   delete from public.agenda_stage_rules
--    where agenda_id = 'close_deal' and stage = 'prospect';
--
--   create or replace function public.advance_prospect_to_in_progress(p_client_id uuid)
--   returns void language plpgsql security definer set search_path = public as $$
--   begin
--     update public.clients c
--     set customer_type = 'in_progress', in_progress_at = now()
--     where c.id = p_client_id
--       and (c.customer_type is null or c.customer_type = 'prospect')
--       and c.status not in ('lost','deleted')
--       and exists (
--         select 1 from public.meetings m
--         join lateral unnest(m.agenda_ids) as aid on true
--         join public.agenda_catalog ac
--           on ac.agenda_id = aid
--          and ac.policy_version = (select cc.agenda_policy_version
--                                     from public.client_cycles cc
--                                    where cc.id = c.current_cycle_id)
--         join public.agenda_stage_rules asr
--           on asr.agenda_id = ac.agenda_id
--          and asr.policy_version = ac.policy_version
--          and asr.stage = 'prospect'
--         where m.client_id = c.id
--           and m.cycle_id = c.current_cycle_id
--           and m.outcome = 'successful'
--           and asr.is_visible
--       )
--       and not exists (
--         select 1 from public.tag_along_requests t
--         where t.related_client_id = c.id
--           and t.invitee_kind = 'manager' and t.context = 'meeting' and t.status = 'pending'
--       );
--   end; $$;
--
--   drop function if exists public.advance_prospect_to_new(uuid);
--
--   create or replace function public.trg_promote_on_po_confirmed()
--   returns trigger language plpgsql security definer as $$
--   begin
--     if new.status = 'approved' and old.status = 'pending' then
--       perform public.advance_in_progress_to_new(new.client_id);
--     end if;
--     return new;
--   end; $$;
--
-- Verification queries to run post-apply (staging first, TEST -- records):
--   1. Prospect client, record a Successful meeting with agenda ['close_deal']
--      and a PO photo. Confirm: customer_type stays 'prospect' immediately
--      after the meeting insert (select customer_type from clients where id=...).
--   2. Approve that PO (decide_po_confirmation). Confirm: customer_type is
--      now 'new'.
--   3. Repeat step 1 with a fresh prospect/cycle, but REJECT the PO instead.
--      Confirm: customer_type is still 'prospect', and a second PO can be
--      submitted for the same cycle (B-125's replaceable-local-evidence path
--      handles the mobile side; this only needs the customer_type to hold).
--   4. Prospect client, record a Successful meeting with agenda
--      ['product_presentation'] only (no close_deal). Confirm: customer_type
--      becomes 'in_progress' immediately - unmodified Scenario 2, proving the
--      new guard clause did not regress the ordinary path.
--   5. Prospect client with a close_deal meeting on record but NO PO ever
--      submitted. Confirm: customer_type stays 'prospect' (does not advance,
--      does not error) - the accepted "does not advance from this meeting"
--      outcome the header comment describes.
-- ============================================================================
