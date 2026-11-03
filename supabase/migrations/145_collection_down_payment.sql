-- ============================================================================
-- 145 — Collection: mark a listing as a down payment
--
-- The Add Store dialog has a per-store "Down payment" tick: the customer decides
-- how much to put down, so the store is listed with amount_due = 0 instead of
-- its credit balance (with nothing due, 070's roll-up marks the visit collected
-- on whatever the collector records). Until now the tick only labelled the
-- audit entry — nothing on the row said it was a down payment, so neither the
-- board nor the collector's app could show it.
--
-- Scope is PER LISTING, like 143's designated_payment_method: it is ticked in
-- the Add Store dialog and describes that day's listing only.
--
-- ── ⚠️ MOBILE CONTRACT ──────────────────────────────────────────────────────
-- When `is_down_payment` is true, mobile shows the collector a "Down payment"
-- indicator on the store — the customer decides the amount. It does NOT reveal
-- amount_due (the 2026-07-25 anchoring-bias rule still holds); the flag says
-- what kind of collection this is, not how much. Mobile must not infer it from
-- amount_due = 0.
--
-- Purely additive: one boolean defaulting to false (every existing row = not a
-- down payment, behaviour unchanged). Admin writes go through 043's existing
-- "Collection admins manage visits" FOR ALL policy, and collectors already read
-- every column on rows they can see; no RLS change.
-- ============================================================================

ALTER TABLE collection_visits
  ADD COLUMN IF NOT EXISTS is_down_payment BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN collection_visits.is_down_payment IS
  'Admin-set when listing: a down payment whose amount the customer decides. amount_due is 0 on these rows. Mobile shows the collector a "Down payment" indicator (never the amount). See migration 145.';
