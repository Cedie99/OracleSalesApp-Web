-- ============================================================================
-- 020 — Tag-along: meeting-context FK enforcement (ADR-030 Pass 2.5)
--
-- PROVENANCE: authored by Vince Carter (mobile lead) 2026-07-20. The report is
-- headed "READY TO APPLY" rather than applied, and web could not verify it
-- independently (constraint visibility needs pg_catalog, which PostgREST does
-- not expose). The DROP ... IF EXISTS below makes the file safe whether or not
-- it already ran. SQL matches the vault's Migration-020-Report.md.
--
-- A design amendment moved the companion-selector UI from Complete Info to
-- Record Meeting, which needs the parallel integrity guard to 019's existing
-- client_creation_needs_client CHECK: a meeting-context companion request must
-- never carry a null related_meeting_id.
--
-- Defensive schema design rather than a fix for existing data — mobile's
-- insertMeetingCompanionRequests() always populates the FK before insert, and
-- no meeting-context requests existed at time of writing.
-- ============================================================================

ALTER TABLE public.tag_along_requests
  DROP CONSTRAINT IF EXISTS meeting_needs_meeting_id;

ALTER TABLE public.tag_along_requests
  ADD CONSTRAINT meeting_needs_meeting_id
  CHECK (context <> 'meeting' OR related_meeting_id IS NOT NULL);


-- ============================================================================
-- ROLLBACK
--   ALTER TABLE public.tag_along_requests
--     DROP CONSTRAINT IF EXISTS meeting_needs_meeting_id;
-- ============================================================================
