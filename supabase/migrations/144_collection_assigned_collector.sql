-- ============================================================================
-- 144 — Collection: assign each listed store to a collector
--
-- Until now the day's list was a shared pool (043): the admin published stores
-- and whichever collector reached one first took it. The owner has changed that
-- (approved 2026-10-28, superseding the 2026-07-27 "nobody assigns" decision):
-- the admin now names the collector when listing a store, and each collector's
-- app shows only the stores assigned to them.
--
-- `assigned_collector_id` is the INSTRUCTION — who should go. It is distinct
-- from the two columns already on the row:
--   * `claimed_by`   (046) — who is on their way right now, a live lock.
--   * `collector_id` (043) — who actually worked it, written on collection.
-- Normally all three name the same person, but nothing forces that: an admin
-- can reassign a store, and history must still say who really collected.
--
-- ── ⚠️ MOBILE CONTRACT ──────────────────────────────────────────────────────
-- Mobile must show a collector ONLY the rows where
--     assigned_collector_id = <their profiles.id>
-- Rows with a NULL assignee are HIDDEN from every collector ("hidden until
-- assigned" — owner's call, 2026-10-28). The web admin requires a collector on
-- every new listing and can (re)assign any still-pending store from its detail
-- dialog, so a NULL is only ever a store listed before this migration.
--
-- Visibility is enforced by the APP, not by RLS — owner's call. 043's
-- "Collectors read the list" policy still lets any collector READ every row, and
-- "Collectors work the list" still lets them claim any unclaimed one. This is a
-- filter, not a security boundary; tighten the policies in a later migration if
-- that ever needs to be one.
--
-- ⚠️ Rollout: once mobile ships the filter, every PENDING store listed before
-- this migration (assignee NULL) disappears from the phones until an admin
-- assigns it. The web board badges those rows "Unassigned" — assign them before
-- the mobile build goes out.
--
-- Purely additive: one nullable column and an index. Admin writes go through
-- 043's "Collection admins manage visits" FOR ALL policy; no RLS change.
-- ============================================================================

ALTER TABLE collection_visits
  ADD COLUMN IF NOT EXISTS assigned_collector_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN collection_visits.assigned_collector_id IS
  'Admin-set: the collector this listing is for. Mobile shows a collector only rows assigned to them; NULL = hidden from every collector. Distinct from claimed_by (en route) and collector_id (who actually worked it). See migration 144.';

-- The phone's read is "my stores, newest day first" — the same shape as 043's
-- (collector_id, scheduled_for DESC) index.
CREATE INDEX IF NOT EXISTS collection_visits_assigned_collector_idx
  ON collection_visits (assigned_collector_id, scheduled_for DESC);
