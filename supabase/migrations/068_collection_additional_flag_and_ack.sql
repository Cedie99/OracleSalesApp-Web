-- ============================================================================
-- 068 — Collection: the 'Additional' store flag + delivery/seen acknowledgment
--
-- Half of the cross-repo "Additional Collection" feature. The mobile repo
-- (OracleSalesApp-Mobile) built Phase A and left ADDITIONAL_COLLECTION_CONTRACT.md
-- for the web side. The scenario: after a collector's day list is already live,
-- the admin urgently needs them to also hit a store that wasn't on today's list.
-- Mobile badges such a store "Additional" and floats it to the top so it can't
-- be missed — but only once web sets a flag on the row.
--
-- This migration adds the three columns that contract hands to web. Purely
-- additive: three new columns, nothing dropped or narrowed, and every deployed
-- row gets a correct default (is_additional = false; the two timestamps NULL).
--
-- Scope is deliberately COLUMNS ONLY:
--   * is_additional is readable/writable by the admin under 043's existing
--     "Collection admins manage visits" FOR ALL policy — no RLS change needed to
--     start setting it. Shipping this alone lights up mobile's badge immediately,
--     because the column defaults false and the app reads it verbatim.
--   * The two ack columns are written by the COLLECTOR's phone, which 043's
--     policies do NOT yet permit for the case that matters (see below). That RLS
--     work is a separate migration (069) so this one can deploy risk-free ahead
--     of it. Until 069 lands the columns simply stay NULL — inert, not wrong.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. is_additional — "added after the list was published"
--
-- Set true ONLY when the admin deliberately marks a store as additional in the
-- Add Store dialog ("Mark as additional — notify collector"). It is NOT inferred
-- from the date: marking a store additional also fires an urgent SMS + an
-- unmissable in-app alert, so it must be an explicit admin decision, never a
-- side effect of which day the store lands on. Every normally-scheduled row
-- stays false.
--
-- The mobile app reads this verbatim — a JSON boolean from PostgREST maps to its
-- local 0/1. No other value or vocabulary is expected.
-- ----------------------------------------------------------------------------

ALTER TABLE collection_visits
  ADD COLUMN IF NOT EXISTS is_additional BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN collection_visits.is_additional IS
  'True when the admin added this store to an already-live day list and chose to notify the collector (Add Store dialog checkbox). Drives the mobile "Additional" badge + float-to-top and the BusyBee SMS. Deliberately admin-set, never inferred from the date. False for every normally-scheduled row.';

-- ----------------------------------------------------------------------------
-- 2 & 3. The two acknowledgment timestamps — DELIVERED vs VIEWED
--
-- Because you cannot push data to a phone with no signal (physics), an additional
-- store might not reach the collector for a while. The admin needs to know
-- whether it actually landed. The contract's decision (2026-08-07) is to track
-- TWO separate signals rather than one:
--
--   * additional_received_at — the row synced DOWN to the collector's phone.
--     Admin board reads this as "Delivered ✓".
--   * additional_seen_at     — the collector actually OPENED the store's visit
--     screen. Admin board reads this as "Viewed".
--
-- If a row stays Delivered-but-not-Viewed, or stays Pending too long, the admin
-- knows to phone the collector — the system stops pretending it arrived.
--
-- NULLABLE, and left NULL on every existing row: those visits predate the
-- feature and were never "delivered as additional". Mobile writes each timestamp
-- ONCE and never overwrites (its own promise — the DB does not enforce single-
-- write here; a trigger could later if we want the guarantee).
--
-- ⚠️ These are written by the COLLECTOR, not the admin, and the write path is
-- NOT open yet. 043's "Collectors work the list" UPDATE policy has
-- WITH CHECK (collector_id = current_profile_id()), but additional_received_at
-- is stamped the moment the row syncs down — BEFORE anyone claims it, while
-- collector_id is still NULL — so that policy would reject the write. Migration
-- 069 adds a collector UPDATE path scoped to just these two columns, including
-- the unclaimed case. Until then these columns exist but stay NULL.
-- ----------------------------------------------------------------------------

ALTER TABLE collection_visits
  ADD COLUMN IF NOT EXISTS additional_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS additional_seen_at     TIMESTAMPTZ;

COMMENT ON COLUMN collection_visits.additional_received_at IS
  'When an is_additional row first synced down to the collector''s phone. Admin board "Delivered ✓". Written once by mobile, before the store is claimed. NULL until the phone confirms receipt (or on non-additional rows).';

COMMENT ON COLUMN collection_visits.additional_seen_at IS
  'When the collector opened the visit screen for an is_additional store. Admin board "Viewed". Written once by mobile. NULL until seen (or on non-additional rows).';

-- Partial index: the admin board's "additional stores awaiting acknowledgment"
-- view scans only the handful of additional rows, never the full table.
CREATE INDEX IF NOT EXISTS idx_collection_visits_additional
  ON collection_visits (scheduled_for DESC)
  WHERE is_additional;
