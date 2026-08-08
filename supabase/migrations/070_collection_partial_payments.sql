-- ============================================================================
-- 070 — Collection: partial payments (a store pays down its balance over time)
--
-- Cross-repo feature. The mobile repo (OracleSalesApp-Mobile) owns the contract
-- in PARTIAL_COLLECTION_CONTRACT.md and built its Phase A (a "Partial" badge +
-- remaining balance, inert until web ships this). This migration is web's half.
--
-- THE MODEL (owner decision, 2026-08-08): a customer can hand over only PART of
-- what a store owes. The visit does NOT close — it becomes `partial` and keeps
-- appearing on its day's list until the running total reaches `amount_due`, at
-- which point it flips to `collected`. `amount_due` is the admin's original
-- number and is NEVER mutated by a payment, so the record of what was owed
-- survives every installment.
--
-- Two owner rulings baked in here:
--   * SAME-DAY, STAYS OPEN — a partial keeps its `scheduled_for`; the trigger
--     never moves the day. A collector can take another installment the same day.
--     Carrying an unpaid store to a later day stays the admin's manual re-list,
--     exactly as an over-listed pending store is today.
--   * OVERPAYMENT ALLOWED — if the last installment exceeds the balance the
--     visit still flips to `collected`; the overage surfaces as a positive
--     variance (collected > due), the mirror of the shortfall the board already
--     renders. The trigger does not reject it.
--
-- WHY A CHILD TABLE, not more columns on the visit: every cash handover already
-- needs its own photo + signature + GPS + timestamp. Two installments = two
-- proofs, and the visit's single payment_photo_url/amount_collected can hold only
-- one outcome — a second payment would overwrite the first's proof. So each
-- payment is its own row in `collection_payments`, and the visit's collected
-- total is their SUM, kept in step by a trigger.
--
-- Purely additive: one widened CHECK, one new table, one trigger + function, its
-- RLS. Nothing existing is dropped or narrowed. Reuses the `collection-proofs`
-- storage bucket (043) — no new bucket.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The 'partial' status
--
-- collection_visits.status is a TEXT column with an inline CHECK (migration
-- 043), NOT a Postgres enum — so this widens the CHECK rather than ALTER TYPE
-- (the contract's SQL assumed an enum we don't have). The inline check from 043
-- is auto-named `collection_visits_status_check`; drop it by that name and
-- re-add a named one carrying the fourth value.
--
-- Existing rows are only pending/collected/rescheduled, so `status <> 'partial'`
-- holds for all of them and the new constraint validates against live data
-- without a rewrite.
-- ----------------------------------------------------------------------------
ALTER TABLE collection_visits DROP CONSTRAINT IF EXISTS collection_visits_status_check;
ALTER TABLE collection_visits
  ADD CONSTRAINT collection_visits_status_check
  CHECK (status IN ('collected', 'rescheduled', 'pending', 'partial'));

-- A partial row is a WORKED row: it has a collector, a running total, a method,
-- and a time — the same shape as `collected` minus the "fully paid" part. This
-- mirrors collection_visits_collected_complete and keeps a hand-written admin
-- update from inventing a partial with no money on it. The trigger below always
-- sets these together, so a legitimate roll-up never trips it.
ALTER TABLE collection_visits DROP CONSTRAINT IF EXISTS collection_visits_partial_is_worked;
ALTER TABLE collection_visits
  ADD CONSTRAINT collection_visits_partial_is_worked CHECK (
    status <> 'partial'
    OR (collector_id IS NOT NULL AND amount_collected IS NOT NULL
        AND amount_collected > 0 AND payment_method IS NOT NULL
        AND visited_at IS NOT NULL)
  );


-- ----------------------------------------------------------------------------
-- 2. collection_payments — one row per cash handover
--
-- Shape is straight from PARTIAL_COLLECTION_CONTRACT.md §2. Each row is a
-- proof-bearing installment: its own amount, method, photo(s), GPS, and time.
-- The parent visit's amount_collected is the SUM of these (kept by the trigger),
-- never written directly once payments exist.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_payments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  visit_id      UUID NOT NULL REFERENCES collection_visits(id) ON DELETE CASCADE,
  -- Who handed the money in. NOT NULL — a payment always has an author, unlike
  -- the visit's collector_id which is null until worked.
  collector_id  UUID NOT NULL REFERENCES profiles(id),
  amount        NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL
    CHECK (payment_method IN ('cash', 'check', 'gcash', 'counter', 'delivery_receipt')),
  -- One photo slot whose meaning follows payment_method, same as the visit
  -- (043). Nullable for the same offline reason: the business row syncs before
  -- the image lands.
  payment_photo_url          TEXT,
  delivery_receipt_photo_url TEXT,
  gps_lat DOUBLE PRECISION,
  gps_lng DOUBLE PRECISION,
  remarks TEXT,
  -- When the money changed hands, per the phone. Drives the visit's visited_at.
  paid_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collection_payments_visit
  ON collection_payments (visit_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_collection_payments_collector
  ON collection_payments (collector_id, paid_at DESC);


-- ----------------------------------------------------------------------------
-- 3. Roll-up trigger — the visit is always the SUM of its payments
--
-- SECURITY DEFINER so the roll-up isn't blocked by the collector's narrow
-- column permissions on collection_visits (they may claim/work a row, but this
-- writes status + collector_id + amount_collected in one shot, as owner).
--
-- The latest payment (by paid_at) is denormalized onto the visit — method,
-- proof photos, GPS, and visited_at — so a store paid off through installments
-- looks to the rest of the app exactly like one paid in a single visit. That is
-- deliberate: it keeps `collection_visits_collected_complete` satisfied and
-- keeps web's existing proof/summary logic working unchanged, while the full
-- per-installment history lives in collection_payments.
--
-- Fires on DELETE/UPDATE too, so correcting or removing a payment re-derives the
-- visit rather than leaving a stale total. Removing every payment returns the
-- visit to an unworked `pending` row.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rollup_collection_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_visit_id UUID := COALESCE(NEW.visit_id, OLD.visit_id);
  v_sum      NUMERIC;
  v_latest   collection_payments%ROWTYPE;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM collection_payments WHERE visit_id = v_visit_id;

  SELECT * INTO v_latest
    FROM collection_payments
   WHERE visit_id = v_visit_id
   ORDER BY paid_at DESC, created_at DESC
   LIMIT 1;

  IF v_sum <= 0 THEN
    -- Every payment removed: hand the row back to the shared pool as unworked,
    -- nulling the collector-side fields so collection_visits_pending_is_unworked
    -- holds. remarks is left alone — an admin note isn't payment data.
    UPDATE collection_visits SET
      status = 'pending',
      amount_collected = NULL,
      collector_id = NULL,
      payment_method = NULL,
      payment_photo_url = NULL,
      delivery_receipt_photo_url = NULL,
      gps_lat = NULL,
      gps_lng = NULL,
      visited_at = NULL
    WHERE id = v_visit_id;
  ELSE
    UPDATE collection_visits SET
      amount_collected = v_sum,
      -- >= not > : overpayment still counts as fully paid (owner ruling).
      status = CASE WHEN v_sum >= amount_due THEN 'collected' ELSE 'partial' END,
      collector_id = v_latest.collector_id,
      payment_method = v_latest.payment_method,
      payment_photo_url = v_latest.payment_photo_url,
      delivery_receipt_photo_url = v_latest.delivery_receipt_photo_url,
      gps_lat = v_latest.gps_lat,
      gps_lng = v_latest.gps_lng,
      visited_at = v_latest.paid_at
    WHERE id = v_visit_id;
  END IF;

  RETURN NULL; -- AFTER trigger: return value is ignored.
END;
$$;

DROP TRIGGER IF EXISTS collection_payments_rollup ON collection_payments;
CREATE TRIGGER collection_payments_rollup
  AFTER INSERT OR UPDATE OR DELETE ON collection_payments
  FOR EACH ROW EXECUTE FUNCTION public.rollup_collection_payment();


-- ----------------------------------------------------------------------------
-- 4. RLS
--
-- Mirrors the collection_visits split (043): admins who run Collection get
-- everything; a collector may add a payment to a store that is on the list and
-- read back their own. The collector never UPDATEs the visit's money directly —
-- the trigger does, as owner — which is the whole reason amount_due stays
-- admin-only and can't be drawn down by the field.
-- ----------------------------------------------------------------------------
ALTER TABLE collection_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Collection admins manage payments" ON collection_payments;
CREATE POLICY "Collection admins manage payments" ON collection_payments
  FOR ALL TO authenticated
  USING (public.admin_manages_module('collection'))
  WITH CHECK (public.admin_manages_module('collection'));

-- A collector records a handover against a store still open on the list
-- (pending or partial), stamping themselves as the payer. They cannot backdate
-- one onto a collected/rescheduled row, and cannot attribute it to someone else.
DROP POLICY IF EXISTS "Collectors add payments" ON collection_payments;
CREATE POLICY "Collectors add payments" ON collection_payments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() = 'collector'
    AND collector_id = public.current_profile_id()
    AND EXISTS (
      SELECT 1 FROM collection_visits v
      WHERE v.id = visit_id AND v.status IN ('pending', 'partial')
    )
  );

DROP POLICY IF EXISTS "Collectors read own payments" ON collection_payments;
CREATE POLICY "Collectors read own payments" ON collection_payments
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'collector'
    AND collector_id = public.current_profile_id()
  );

-- Collectors get no UPDATE or DELETE: a handover, once recorded with its proof,
-- is a fact. Corrections are an admin action through the FOR ALL policy above.

COMMENT ON TABLE collection_payments IS
  'One row per cash handover toward a collection_visit. The visit''s amount_collected is the SUM of these (rollup_collection_payment trigger); status flips to partial while 0 < sum < amount_due and collected at sum >= amount_due. amount_due is never mutated. See migration 070 + the mobile PARTIAL_COLLECTION_CONTRACT.md.';
