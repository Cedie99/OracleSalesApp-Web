-- ============================================================================
-- 016 — Agent-ownership RLS policies checked the wrong identity (B-015/ADR-023)
--
-- PROVENANCE: authored by Vince Carter (mobile lead) and applied directly to
-- the shared Supabase project via the SQL Editor on 2026-07-16. Confirmed
-- working by data on 2026-07-21 (clients/meetings/sync_audit_log all carrying
-- mobile-written rows). Committed here retroactively. SQL matches the vault's
-- Migration-016-Report.md.
--
-- ROOT CAUSE: `profiles.id` (the table's own PK, uuid_generate_v4()) and
-- `profiles.user_id` (the FK to auth.users, i.e. what a client receives as
-- session.user.id) are two DIFFERENT values — see 001_initial.sql.
-- `clients.assigned_agent_id` and `meetings.agent_id`/`recorded_by` all
-- REFERENCE profiles(id), NOT profiles.user_id. But the agent policies added
-- earlier on 2026-07-16 compared those columns against auth.uid() directly,
-- so they could only ever match by coincidence. Every agent-side insert/update
-- was rejected — by the policy, or by the FK constraint (23503) if a caller
-- supplied the raw auth uid.
--
-- This repo's own admin policy already did it correctly, and is the pattern
-- being copied:
--   EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND ...)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- clients
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Agents insert own clients" ON public.clients;
CREATE POLICY "Agents insert own clients" ON public.clients FOR INSERT
  WITH CHECK (assigned_agent_id = (SELECT id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Agents update own clients" ON public.clients;
CREATE POLICY "Agents update own clients" ON public.clients FOR UPDATE
  USING (assigned_agent_id = (SELECT id FROM profiles WHERE user_id = auth.uid()))
  WITH CHECK (assigned_agent_id = (SELECT id FROM profiles WHERE user_id = auth.uid()));


-- ----------------------------------------------------------------------------
-- meetings
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Agents insert own meetings" ON public.meetings;
CREATE POLICY "Agents insert own meetings" ON public.meetings FOR INSERT
  WITH CHECK (agent_id = (SELECT id FROM profiles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Agents read own meetings" ON public.meetings;
CREATE POLICY "Agents read own meetings" ON public.meetings FOR SELECT
  USING (agent_id = (SELECT id FROM profiles WHERE user_id = auth.uid()));


-- ----------------------------------------------------------------------------
-- sync_audit_log (migration 015) — same bug, one more table caught by it
-- during the same on-device test: `user_id` there also REFERENCES profiles(id)
-- but its insert policy compared straight to auth.uid().
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS sync_audit_log_insert_own ON public.sync_audit_log;
CREATE POLICY sync_audit_log_insert_own ON public.sync_audit_log FOR INSERT
  WITH CHECK (user_id = (SELECT id FROM profiles WHERE user_id = auth.uid()));


-- ----------------------------------------------------------------------------
-- The broader "Authenticated read clients"/"Authenticated read meetings"
-- policies (added for the duplicate-name check and the Manager dashboard,
-- ADR-018/ADR-021) are unaffected — they never reference
-- assigned_agent_id/agent_id, so there is nothing to change there.
--
-- ⚠ KNOWN GAP, NOT FIXED BY THIS MIGRATION (flagged by web 2026-07-21):
-- 015's OTHER policy, sync_audit_log_select_admin, still reads
--   EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND ...)
-- which is the very same identity bug this file exists to correct — it compares
-- profiles.id against the auth uid. It never matches, so admin/superadmin
-- cannot read sync_audit_log at all. Nothing consumes that table yet, so it is
-- latent rather than broken-in-production, but a future web Sync Audit view
-- will silently return zero rows until it is fixed. Deliberately left as-is
-- here to keep this file faithful to what was actually applied; see the
-- accompanying handoff doc for the proposed follow-up.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- ROLLBACK — restores the original, broken behaviour. Only useful if this fix
-- somehow regresses something; not expected.
--
--   DROP POLICY IF EXISTS "Agents insert own clients" ON public.clients;
--   CREATE POLICY "Agents insert own clients" ON public.clients FOR INSERT
--     WITH CHECK (assigned_agent_id = auth.uid());
--   ... (see Migration-016-Report.md for the full rollback block)
-- ============================================================================
