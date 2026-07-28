-- ============================================================================
-- 046 — Claiming a stop: the "On the way" state
--
-- Business rules (Adrian + the business, 2026-07-28). Spec in
-- COLLECTION_DELIVERY_FOR_MOBILE.md §11:
--
--   * HARD LOCK. A claimed stop cannot be worked by anyone else.
--   * EXACTLY ONE active claim per collector/driver. No hoarding.
--   * Claims NEVER EXPIRE.
--   * Cancellable by the claimer and by any admin. Nobody else.
--   * The admin sees who claimed what.
--
-- Why a hard lock does not repeal the shared-list rule: the one-claim limit is
-- what prevents it becoming back-door assignment. You cannot reserve the
-- profitable half of a list, so a claim means only "I am driving to this one
-- stop right now" — which is what mobile's indicator always meant. 043/044's
-- model stands: the admin publishes, whoever gets there works it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Columns
--
-- A NEW claimed_by, deliberately NOT a reuse of collector_id / driver_id.
-- Those mean "who WORKED it", written at the outcome; this means "who is EN
-- ROUTE". Keeping them separate has a concrete payoff: the existing
-- `collection_visits_pending_is_unworked` / `purchase_orders_closed_complete`
-- constraints name collector_id / driver_id and say nothing about claimed_by,
-- so a pending row can carry a claim and NEITHER CONSTRAINT NEEDS RELAXING.
-- (Mobile's WEB_FIXES_NEEDED_FOR_SYNC.md assumed they would.)
-- ----------------------------------------------------------------------------

ALTER TABLE collection_visits ADD COLUMN IF NOT EXISTS claimed_by UUID REFERENCES profiles(id);
ALTER TABLE collection_visits ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
-- Denormalized for the same reason as 045's client_name: a collector can read
-- only their OWN profiles row (migration 003), so the phone cannot resolve
-- another collector's claimed_by to a name. Without this, a locked stop reads
-- "taken by ?". Mobile may ignore it if a bare claimed/not-claimed is enough.
ALTER TABLE collection_visits ADD COLUMN IF NOT EXISTS claimed_by_name TEXT;

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS claimed_by UUID REFERENCES profiles(id);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS claimed_by_name TEXT;

-- A claim is all three columns or none — a claimed_by with no timestamp would
-- make "how long has this been held" unanswerable, which is the one question an
-- admin looking at a stuck claim actually asks.
ALTER TABLE collection_visits DROP CONSTRAINT IF EXISTS collection_visits_claim_complete;
ALTER TABLE collection_visits ADD CONSTRAINT collection_visits_claim_complete CHECK (
  (claimed_by IS NULL AND claimed_at IS NULL AND claimed_by_name IS NULL)
  OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND claimed_by_name IS NOT NULL)
);

ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_claim_complete;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_claim_complete CHECK (
  (claimed_by IS NULL AND claimed_at IS NULL AND claimed_by_name IS NULL)
  OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND claimed_by_name IS NOT NULL)
);

COMMENT ON COLUMN collection_visits.claimed_by IS
  'Collector currently en route to this store. NOT who worked it — that is collector_id, written at the outcome. One active claim per collector, enforced by the partial unique index below. Never expires; cleared by the claimer or an admin.';
COMMENT ON COLUMN purchase_orders.claimed_by IS
  'Driver currently en route to this stop. NOT who ran it — that is driver_id. Same one-claim rule as collection_visits.claimed_by.';

-- ----------------------------------------------------------------------------
-- 2. One active claim per person — enforced by the database, not app logic
--
-- Scoped to status = 'pending' on purpose, and two useful things fall out:
--
--   * Completion frees the slot automatically. The moment status becomes
--     collected/rescheduled/delivered/failed the row leaves the index, so there
--     is no release step on the happy path and no trigger to maintain.
--   * Races resolve correctly WITHOUT realtime. Two phones claiming the same
--     stop: one wins, the other gets a unique violation (23505) to handle. The
--     lock is correct even if the loser's list is seconds stale. There is no
--     realtime anywhere in the web repo today, and this means we don't need to
--     build it to ship claiming.
--
-- NOTE: a claim deliberately SURVIVES completion in the data (claimed_by is not
-- nulled) — it is useful history, and the index predicate already frees the
-- slot. Do not add a trigger to clear it.
-- ----------------------------------------------------------------------------

DROP INDEX IF EXISTS collection_visits_one_active_claim;
CREATE UNIQUE INDEX collection_visits_one_active_claim
  ON collection_visits (claimed_by)
  WHERE claimed_by IS NOT NULL AND status = 'pending';

DROP INDEX IF EXISTS purchase_orders_one_active_claim;
CREATE UNIQUE INDEX purchase_orders_one_active_claim
  ON purchase_orders (claimed_by)
  WHERE claimed_by IS NOT NULL AND status = 'pending';

-- ----------------------------------------------------------------------------
-- 3. RLS — the hard lock itself
--
-- ⚠️ The UPDATE policies from 043/044 are REPLACED, not extended, and the old
-- WITH CHECK could not have survived claiming anyway. It required
-- `collector_id = current_profile_id()` on every update, while
-- `collection_visits_pending_is_unworked` requires collector_id IS NULL while
-- pending — so the only update those policies ever permitted was one that
-- flipped status and set collector_id in the same statement. That happened to
-- be the only thing a collector did before now. Claiming is an intermediate
-- write on a still-pending row, so the check has to allow collector_id to stay
-- NULL. This is the bug that would have made "claim" fail with an RLS denial
-- rather than anything legible.
--
-- The lock is the `claimed_by IS NULL OR claimed_by = me` term in USING:
-- a row claimed by someone else is simply not visible to your UPDATE.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "Collectors work the list" ON collection_visits;
CREATE POLICY "Collectors work the list" ON collection_visits
  FOR UPDATE TO authenticated
  USING (
    public.current_user_role() = 'collector'
    -- The hard lock. Unclaimed rows stay workable directly: nobody holds a
    -- lock on them, so claiming first is a mobile UX convention, not a rule
    -- the database needs to force.
    AND (claimed_by IS NULL OR claimed_by = public.current_profile_id())
    AND (collector_id IS NULL OR collector_id = public.current_profile_id())
  )
  WITH CHECK (
    public.current_user_role() = 'collector'
    -- Claim for yourself or release (NULL) — never claim on someone's behalf.
    AND (claimed_by IS NULL OR claimed_by = public.current_profile_id())
    -- Credit the work to yourself or leave it unworked — never to someone else.
    AND (collector_id IS NULL OR collector_id = public.current_profile_id())
  );

DROP POLICY IF EXISTS "Drivers run the trip list" ON purchase_orders;
CREATE POLICY "Drivers run the trip list" ON purchase_orders
  FOR UPDATE TO authenticated
  USING (
    public.current_user_role() = 'delivery'
    AND (claimed_by IS NULL OR claimed_by = public.current_profile_id())
    AND (driver_id IS NULL OR driver_id = public.current_profile_id())
  )
  WITH CHECK (
    public.current_user_role() = 'delivery'
    AND (claimed_by IS NULL OR claimed_by = public.current_profile_id())
    AND (driver_id IS NULL OR driver_id = public.current_profile_id())
  );

-- Admin cancellation needs NO new policy: "Collection admins manage visits" and
-- "Delivery admins manage POs" are already FOR ALL under admin_manages_module(),
-- so an admin can clear anyone's claim from the web board today. That is the
-- documented escape hatch for a claim left on an unworked row overnight — see
-- the note on the whole-day rule in §11.
