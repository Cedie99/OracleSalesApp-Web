-- ============================================================================
-- 019 — Tag-along / companion selector: tag_along_requests (ADR-030)
--
-- PROVENANCE: authored by Vince Carter (mobile lead) 2026-07-20 and applied
-- directly to the shared Supabase project via the SQL Editor. Verified live
-- 2026-07-21 (table present, 3 rows). Committed here retroactively. SQL matches
-- the vault's Migration-019-Report.md.
--
-- IDEMPOTENCY: IF NOT EXISTS guards and drop-before-create on policies added
-- when committing (the original was a bare CREATE TABLE / CREATE POLICY set,
-- which would fail on a CI re-run).
--
-- Agents select companions locally; synced requests land in invitees'
-- notification feeds; accept/decline answers sync back. Fully offline-first and
-- non-blocking — save proceeds immediately, companions are accepted
-- asynchronously. Real push notifications are explicitly descoped for v1
-- (feed-on-sync only).
--
-- Nothing in the web UI consumes this yet — mobile-specific for now.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tag_along_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context text NOT NULL CHECK (context IN ('client_creation','meeting')),
  requester_id uuid NOT NULL REFERENCES profiles(id),
  invitee_id uuid NOT NULL REFERENCES profiles(id),
  invitee_kind text NOT NULL CHECK (invitee_kind IN ('manager','teammate')),
  related_client_id uuid REFERENCES clients(id),
  related_meeting_id uuid REFERENCES meetings(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_creation_needs_client
    CHECK (context <> 'client_creation' OR related_client_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_tar_invitee ON public.tag_along_requests (invitee_id, status);
CREATE INDEX IF NOT EXISTS idx_tar_requester ON public.tag_along_requests (requester_id);

ALTER TABLE public.tag_along_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Requester inserts own requests" ON public.tag_along_requests;
CREATE POLICY "Requester inserts own requests" ON public.tag_along_requests
  FOR INSERT WITH CHECK (requester_id = (SELECT id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Participants read own requests" ON public.tag_along_requests;
CREATE POLICY "Participants read own requests" ON public.tag_along_requests
  FOR SELECT USING (
    requester_id = (SELECT id FROM profiles WHERE user_id = auth.uid())
    OR invitee_id = (SELECT id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Invitee responds to pending" ON public.tag_along_requests;
CREATE POLICY "Invitee responds to pending" ON public.tag_along_requests
  FOR UPDATE USING (invitee_id = (SELECT id FROM profiles WHERE user_id = auth.uid()) AND status = 'pending')
  WITH CHECK (status IN ('accepted','declined'));

DROP POLICY IF EXISTS "Requester cancels pending" ON public.tag_along_requests;
CREATE POLICY "Requester cancels pending" ON public.tag_along_requests
  FOR UPDATE USING (requester_id = (SELECT id FROM profiles WHERE user_id = auth.uid()) AND status = 'pending')
  WITH CHECK (status = 'cancelled');


-- ----------------------------------------------------------------------------
-- Deliberately NOT included (Vince, 2026-07-20):
--
--  * No duplicate-pending-request guard / unique index. Re-requesting the same
--    person for the same client while a prior request is still pending is
--    intentionally allowed — simpler, no extra index.
--
--  * No new `profiles` SELECT policy or current_team_id() helper. An earlier
--    draft proposed both, so an agent could read their manager + teammates for
--    the companion picker. Live check found them unnecessary: the existing
--    "Authenticated read profiles" policy is `using (auth.role() =
--    'authenticated')` with no row scoping, so any signed-in user can already
--    read every profiles row. Mobile still scopes its sync-down query with
--    .eq('team_id', myTeamId) for UX correctness, but that is application-level
--    filtering, not an RLS guarantee.
--
--    ⚠ Vince flagged that permissiveness as a pre-existing condition worth a
--    security review "someday" — it means any authenticated mobile user can
--    read every profile row company-wide. That is a web-side decision; not
--    changed here.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- ROLLBACK
--   DROP TABLE IF EXISTS public.tag_along_requests;
--
-- No app-side data loss — mobile has not shipped the companion picker yet, and
-- its sync-down pullEntity() call is wrapped in try/catch specifically to
-- tolerate this table being absent.
-- ============================================================================
