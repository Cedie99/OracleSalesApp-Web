-- ============================================================================
-- 115 - Cross-team meeting read access for tag-along participants (B-119)
--
-- Vince, 2026-08-20: a manager who tagged along on a meeting owned by an
-- agent outside their own team (e.g. Team South's Sales tags along Team
-- North's Manager) currently cannot see that meeting record at all. This is
-- NOT a missing feature on the mobile side -
-- lib/manager-attendance-history-service.ts's getManagerAttendanceHistory()
-- already reads local tag_along_requests JOIN meetings for exactly this
-- case, and app/(manager)/tag-along-history.tsx already renders it
-- (its own comment explicitly names this migration as the blocker). The gap
-- is entirely server + sync:
--
--   1. `meetings` RLS has no policy granting a tag-along participant read
--      access to a meeting outside their own team - "Managers read team
--      meetings" (030) only covers is_manager_of_profile(agent_id).
--   2. Mobile's sync-down never pulls a meeting the local device isn't
--      already scoped to see (lib/sync-down.ts's `meetings` pull is a plain
--      `.eq('agent_id', agentId)`), so even once (1) is fixed, the row would
--      still never reach the manager's device on its own.
--
-- This migration fixes (1), mirroring Migration 030's existing
-- "Tag-along participants read related client" policy exactly, but for
-- `meetings`. (2) is fixed alongside this on the mobile side
-- (lib/sync-down.ts::pullTagAlongMeetingContext), not schema.
--
-- Deliberately ungated by tag_along_requests.status (same as 030's clients
-- policy) - a manager who is a pending or declined invitee can still open
-- the meeting record; the attendance history screen already renders
-- pending/declined rows distinctly by decisionStatus, not by hiding them.
--
-- RENUMBERED 111 -> 115 (2026-08-20): Adrian Guañez took 111-114
-- (guanez-feature-collection / feature/mobile-store-locations, merged to
-- staging while this file sat unpushed) before this was pushed. No content
-- change, number only.
-- ============================================================================

create policy "Tag-along participants read related meeting" on public.meetings
  for select using (
    exists (
      select 1 from public.tag_along_requests t
      where t.related_meeting_id = meetings.id
        and t.context = 'meeting'
        and (t.requester_id = public.current_profile_id()
             or t.invitee_id = public.current_profile_id())
    )
  );

-- ============================================================================
-- ROLLBACK
--   drop policy if exists "Tag-along participants read related meeting" on public.meetings;
--
-- Verification (staging):
--   1. As the tag-along invitee (a manager outside the meeting agent's
--      team), select from meetings where id = <related_meeting_id> of an
--      accepted meeting-context tag_along_requests row - confirm a row
--      returns (previously: zero rows, RLS-blocked).
--   2. As an unrelated third profile (no tag_along_requests row referencing
--      them at all), confirm the same select still returns zero rows.
--   3. Confirm an ordinary same-team manager read (no tag-along involved)
--      is unaffected - "Managers read team meetings" still covers it.
-- ============================================================================
