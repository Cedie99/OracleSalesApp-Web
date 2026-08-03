-- ============================================================================
-- 063 - Drops the details_completed_at gate from advance_in_progress_to_new().
--
-- Business rule change (Vince, 2026-08-04, mobile session): In Progress ->
-- New promotion previously required FIVE conditions simultaneously
-- (migration 040): customer_type='in_progress', status not lost/deleted,
-- details_completed_at not null, a postdating successful close-deal
-- meeting, a manager-approved PO confirmation for the current cycle, and no
-- pending manager tag-along. In practice this meant an agent could get PO
-- confirmation approved (100% "progress" per the mobile Client screen's
-- ring) and the client would still be stuck at "In Progress" because the
-- separate Info Completion checklist (Contact person / Contact number /
-- Office address - a 1-month data-quality nudge, see B-001 in the mobile
-- vault's Bugs.md, deliberately decoupled from the progress % display) had
-- not been finished. Vince decided PO approval + close-deal evidence alone
-- should be sufficient - Info Completion should no longer block promotion.
--
-- Scope: removes exactly one AND clause (details_completed_at is not null)
-- from advance_in_progress_to_new(). Every other gate is unchanged: still
-- requires the postdating successful close-deal meeting for the current
-- cycle, still requires a manager-approved PO confirmation for the current
-- cycle, still respects the lost/deleted status guard, still respects the
-- pending-manager-tag-along guard.
--
-- Note: the `promote_on_details_completed` trigger (migration 040, fires
-- `advance_in_progress_to_new()` after `clients.details_completed_at`
-- changes) is left in place - harmless no-op re-evaluation now that the
-- gate it used to matter for is gone, not worth an extra trigger-drop/
-- re-add for this change.
-- ============================================================================

-- Idempotent per the 2026-07-29 standing convention (Migration-052-Report):
-- CI must be able to re-run this file safely. CREATE OR REPLACE FUNCTION is
-- naturally idempotent, same shape as the original migration 040 definition.
create or replace function public.advance_in_progress_to_new(p_client_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.clients c
  set customer_type = 'new'
  where c.id = p_client_id
    and c.customer_type = 'in_progress'   -- NEVER from 'prospect': no direct hop
    and c.status not in ('lost','deleted')
    and exists (   -- Close-deal evidence must postdate entry into in_progress
      select 1 from public.meetings m
      where m.client_id = c.id
        and m.cycle_id = c.current_cycle_id
        and m.outcome = 'successful'
        and m.agenda_ids @> array['close_deal']
        and m.created_at > c.in_progress_at
    )
    and exists (   -- Manager-approved PO evidence for THIS cycle
      select 1 from public.po_confirmation_requests p
      where p.client_id = c.id and p.cycle_id = c.current_cycle_id and p.status = 'approved'
    )
    and not exists (   -- Both-edge tag-along gate (Vince's explicit decision, migration 040)
      select 1 from public.tag_along_requests t
      where t.related_client_id = c.id
        and t.invitee_kind = 'manager' and t.context = 'meeting' and t.status = 'pending'
    );
end; $$;

comment on function public.advance_in_progress_to_new(uuid) is
  'In Progress -> New promotion (four-stage lifecycle, migration 040), amended 2026-08-04 (migration 063) to drop the details_completed_at gate per Vince''s explicit decision: PO approval + close-deal meeting evidence is now sufficient on its own, Info Completion no longer blocks this edge.';

-- ============================================================================
-- Rollback (if ever needed): restores the details_completed_at gate exactly
-- as migration 040 defined it.
--   create or replace function public.advance_in_progress_to_new(p_client_id uuid)
--   returns void language plpgsql security definer set search_path = public as $$
--   begin
--     update public.clients c
--     set customer_type = 'new'
--     where c.id = p_client_id
--       and c.customer_type = 'in_progress'
--       and c.status not in ('lost','deleted')
--       and c.details_completed_at is not null
--       and exists (
--         select 1 from public.meetings m
--         where m.client_id = c.id
--           and m.cycle_id = c.current_cycle_id
--           and m.outcome = 'successful'
--           and m.agenda_ids @> array['close_deal']
--           and m.created_at > c.in_progress_at
--       )
--       and exists (
--         select 1 from public.po_confirmation_requests p
--         where p.client_id = c.id and p.cycle_id = c.current_cycle_id and p.status = 'approved'
--       )
--       and not exists (
--         select 1 from public.tag_along_requests t
--         where t.related_client_id = c.id
--           and t.invitee_kind = 'manager' and t.context = 'meeting' and t.status = 'pending'
--       );
--   end; $$;
--
-- Verification queries to run post-apply:
--   1. Pick a client stuck at customer_type='in_progress' with an approved
--      po_confirmation_requests row for its current_cycle_id and a
--      qualifying close-deal meeting, but details_completed_at still null.
--      Run: select public.advance_in_progress_to_new('<client_id>');
--      then: select customer_type from public.clients where id = '<client_id>';
--      -> must now read 'new'.
--   2. Confirm a client that does NOT have an approved PO / qualifying
--      meeting is NOT promoted by a no-op call (still 'in_progress').
--   3. Confirm a client with a PENDING manager tag-along is still correctly
--      blocked (tag-along gate unchanged).
-- ============================================================================
