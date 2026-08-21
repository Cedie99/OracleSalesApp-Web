-- ============================================================================
-- 121 — Tag-along participants can read each other's profile (B-131)
--
-- Vince, 2026-08-22 (device-verified on staging): a guest manager's Meeting
-- Detail screen now finds a cross-team tag-along meeting (migration 115) and
-- its client (migration 030's "Tag-along participants read related client"),
-- but the owning agent's NAME still shows blank ("Agent: "). Root cause:
-- migration 031 dropped the broad "Authenticated read profiles" policy,
-- leaving only team-scoped profile reads (migration 030's "Managers read
-- team profiles"-style policies) — a tag-along participant outside the
-- other party's team has no read path to their profile row at all, so
-- `lib/manager-tag-along-meetings.ts::fetchOwningAgentsAndClients()`'s
-- `profiles` query silently returns zero rows for a cross-team owner (RLS
-- filters, no error) and the mobile-side name fallback
-- (`tagAlongOwnerAgentName`) has nothing to fall back to.
--
-- Mirrors migration 030's "Tag-along participants read related client"
-- policy exactly, but for `profiles`, symmetric in both directions (either
-- party of a tag_along_requests row can read the other's profile) —
-- deliberately ungated by `status`, same reasoning as 030/115: a pending or
-- declined invite still identifies two real participants who should be able
-- to see who they're dealing with.
-- ============================================================================

create policy "Tag-along participants read each other's profile" on public.profiles
  for select using (
    exists (
      select 1 from public.tag_along_requests t
      where (t.requester_id = profiles.id and t.invitee_id = public.current_profile_id())
         or (t.invitee_id = profiles.id and t.requester_id = public.current_profile_id())
    )
  );

-- ============================================================================
-- ROLLBACK
--   drop policy if exists "Tag-along participants read each other's profile" on public.profiles;
--
-- Verification (staging):
--   1. As the tag-along invitee (a manager outside the meeting agent's
--      team), select from profiles where id = <the meeting's agent_id> of
--      an accepted meeting-context tag_along_requests row — confirm a row
--      returns (previously: zero rows, RLS-blocked).
--   2. As an unrelated third profile (no tag_along_requests row referencing
--      them at all), confirm the same select still returns zero rows.
--   3. Confirm an ordinary same-team manager profile read (no tag-along
--      involved) is unaffected — the existing team-scoped policy still
--      covers it.
-- ============================================================================
