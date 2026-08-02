-- ============================================================================
-- 022 — Capture the never-numbered ad-hoc changes of 2026-07-16
--
-- PROVENANCE: these were applied to the shared Supabase project directly via
-- the SQL Editor on 2026-07-16 while debugging on-device meeting saves, and
-- were written up in the vault as
-- "Supabase-Changes-2026-07-16-Meetings-RLS-Storage.md" — but unlike 013-021
-- they never got a migration number at all. This file exists so a rebuild from
-- this repo reproduces them.
--
-- Every statement below was transcribed from a live pg_policies /
-- storage.buckets dump taken 2026-07-21, NOT from the prose write-up, so the
-- expressions match production exactly.
--
-- NOTE ON ORDERING: these were applied BEFORE 016, but 016 already re-creates
-- the agent ownership policies with the corrected identity resolution, so only
-- the parts 016 does not touch are captured here. Applying this file after 016
-- is therefore correct and non-destructive — nothing here overwrites 016.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Broad authenticated-read policies (ADR-018 / ADR-021)
--
-- These are deliberately NOT scoped to "own rows only":
--   * clients  — the global duplicate-company-name check (014) must see other
--                agents' company names, or every name reads as "available".
--   * profiles — a Manager must see their team's agent profiles; also what
--                makes 019's companion picker work without a bespoke policy.
--   * meetings — the Manager Dashboard aggregates across the team.
--
-- ⚠ Vince flagged the profiles one for a future security review: as written,
-- ANY authenticated user (any role, including every mobile agent) can read
-- EVERY profile row company-wide. That is a web-side decision and is captured
-- here as-is rather than silently tightened — changing it needs a check that
-- the Manager Dashboard and companion picker still work.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated read clients" ON public.clients;
CREATE POLICY "Authenticated read clients" ON public.clients
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read meetings" ON public.meetings;
CREATE POLICY "Authenticated read meetings" ON public.meetings
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Authenticated read profiles" ON public.profiles;
CREATE POLICY "Authenticated read profiles" ON public.profiles
  FOR SELECT USING (auth.role() = 'authenticated');


-- ----------------------------------------------------------------------------
-- 2. meeting-photos storage bucket
--
-- Referenced by mobile's lib/meeting-service.ts (MEETING_PHOTO_BUCKET) but it
-- had never actually been created — meeting photo upload failed outright until
-- 2026-07-16.
--
-- Gotcha worth keeping written down: marking a bucket "Public" grants READ
-- only. Uploads still failed with "new row violates row-level security policy"
-- until the INSERT policy below was added separately.
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('meeting-photos', 'meeting-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Not scoped to a per-user folder, unlike the avatars bucket (012), which is
-- restricted to {auth.uid()}/avatar.jpg. Any authenticated user may upload
-- anywhere in this bucket. Acceptable while meeting photos are not read back
-- per-user, but worth tightening if that changes.
DROP POLICY IF EXISTS "Agents upload meeting photos" ON storage.objects;
CREATE POLICY "Agents upload meeting photos" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'meeting-photos');


-- ============================================================================
-- DELIBERATELY NOT CAPTURED HERE — two open items, both needing a decision
-- rather than a transcription. See the handoff doc for both.
--
-- 1. public.is_admin()  (Vince's 2026-07-14 RLS-recursion hotfix)
--    Still exists live, but the 2026-07-21 dump shows NOTHING REFERENCES IT:
--    "Admin full access on profiles" resolves through this repo's own
--    current_user_role() helper (011) instead. The two fixes raced and 011's
--    won. is_admin() is therefore orphaned code on production.
--    Not recreated here because it should probably be dropped rather than
--    reproduced — but dropping is a live change, so it is left for the team
--    (this is Bugs#B-048 on the mobile side). If the decision is to keep it,
--    capture its exact body via pg_get_functiondef rather than re-deriving it.
--
-- 2. sync_audit_log admin read access
--    015's report specifies a sync_audit_log_select_admin policy, but the live
--    dump shows it DOES NOT EXIST — the table has RLS enabled and exactly one
--    policy (INSERT). So no role can SELECT it through the API at all; the 90
--    rows currently there are reachable only via the service role, which
--    bypasses RLS. Since this table exists precisely so the WEB dashboard can
--    show sync history, that view would silently render empty.
--    Adding the policy is a real behavioural change, not a back-fill, so it
--    belongs in its own migration once the team agrees on the fix. Note the
--    report's own version of that policy carries the B-015 identity bug
--    (profiles.id = auth.uid()); the correct form resolves via
--    profiles.user_id = auth.uid(), matching 016.
-- ============================================================================
