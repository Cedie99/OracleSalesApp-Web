-- ============================================================================
-- 067 - Adds meetings.client_status_at_meeting: freezes the client's
-- lifecycle status at the moment each meeting was recorded.
--
-- Bug (Vince, 2026-08-08, mobile screenshot): every meeting card for the
-- same client on the two list screens (Sales "My Meetings",
-- Manager "Meeting Details") showed the same lifecycle-status badge, and
-- that badge retroactively changed on OLD meeting cards whenever the
-- client's current status changed later - the badge was computed live from
-- the CLIENT's current row (`getClientStatus(client)` mobile-side /
-- `statusBadge(c.status)` in the wireframe), not anything stored on the
-- meeting itself. This is also literally what the wireframe spec-of-record
-- does (Wireframe-Sales-BizLink.html), so it was a spec-level flaw, not
-- just an app bug.
--
-- Fix: a new nullable column on `meetings`, written once by the mobile app
-- (lib/meeting-service.ts::createMeeting()) with the client's status read
-- from local SQLite immediately before the meeting insert - frozen forever,
-- never recomputed. Legacy meetings (recorded before this column existed)
-- have no such record; Vince approved leaving their badge blank rather than
-- guessing (no backfill in this migration).
--
-- Scope: additive, nullable, no RLS/trigger change needed - `meetings`'
-- existing RLS policies already govern reads/writes of this column the same
-- as every other meetings column.
--
-- Mirrors OracleSalesApp-Mobile's lib/db.ts Migration v26
-- (ALTER TABLE meetings ADD COLUMN client_status_at_meeting TEXT).
-- ============================================================================

alter table public.meetings
  add column if not exists client_status_at_meeting text;

comment on column public.meetings.client_status_at_meeting is
  'Client''s lifecycle status (prospect/in_progress/new/existing/inactive) frozen at the moment this meeting was recorded by the mobile app - never recomputed from the client''s current status. Null for meetings recorded before this column existed (migration 067, 2026-08-08) or with no client_id.';

-- ============================================================================
-- Rollback (if ever needed):
--   alter table public.meetings drop column if exists client_status_at_meeting;
-- ============================================================================
