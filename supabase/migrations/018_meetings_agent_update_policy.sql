-- ============================================================================
-- 018 — Missing UPDATE RLS policy for meetings (agents)
--
-- PROVENANCE: authored by Vince Carter (mobile lead) and applied directly to
-- the shared Supabase project via the SQL Editor on 2026-07-19. Committed here
-- retroactively. SQL matches the vault's Migration-018-Report.md.
--
-- NOT INDEPENDENTLY VERIFIED by web: policy visibility requires pg_catalog
-- access, which PostgREST does not expose. Recorded from the report, which
-- states "APPLIED to Supabase 2026-07-19". The DROP ... IF EXISTS below makes
-- the file safe either way.
--
-- WHY: agents had NO update policy on `meetings` at all — only
-- "Admin full access on meetings" existed. This went unnoticed because mobile
-- always called .upsert(), which presented every update as an insert and so
-- satisfied the INSERT policy instead. That workaround is being removed on the
-- mobile side (it broke differently: .upsert() requires every NOT NULL column
-- to be present even for an update), and removing it exposes the gap.
--
-- The concrete need is Phase C's queued photo uploads: once a photo finishes
-- uploading, the app patches the row via a genuine
-- UPDATE meetings SET photo_url = ... WHERE id = ...
-- Without this policy every such patch fails with 42501.
-- ============================================================================

-- Same identity-resolution pattern as 016's "Agents update own clients":
-- profiles.id resolved via user_id = auth.uid(), never a raw auth.uid()
-- comparison against a profiles(id)-typed column. Scoped to agent_id, matching
-- meetings.agent_id REFERENCES profiles(id).
DROP POLICY IF EXISTS "Agents update own meetings" ON public.meetings;
CREATE POLICY "Agents update own meetings" ON public.meetings FOR UPDATE
  USING (agent_id = (SELECT id FROM profiles WHERE user_id = auth.uid()))
  WITH CHECK (agent_id = (SELECT id FROM profiles WHERE user_id = auth.uid()));


-- ============================================================================
-- ROLLBACK
--   DROP POLICY IF EXISTS "Agents update own meetings" ON public.meetings;
--
-- Meeting photo-URL patches would go back to failing 42501 until re-applied.
-- ============================================================================
