-- ============================================================================
-- 073 — Delivery: partial COD payments (a customer pays the COD down over time)
--
-- Cross-repo feature. The mobile repo (OracleSalesApp-Mobile) owns the contract
-- in PARTIAL_COD_CONTRACT.md and will build its Phase A/B once this is live; this
-- migration is web's half. It is the delivery-COD twin of 070's partial
-- collection — same model, same shape of trigger — so read that file first; the
-- notes below only cover where DELIVERY genuinely differs.
--
-- THE MODEL (owner decision, 2026-08-09, mirror of the 2026-08-08 collection
-- ruling): a COD customer can hand over only PART of the COD due (₱4,000 of a
-- ₱10,000 PO). The PO does NOT close — it becomes `partial` and keeps appearing
-- on its day's trip list until the running total reaches `cod_due`, at which
-- point it flips to `delivered`. `cod_due` is the admin's original number and is
-- NEVER mutated by a payment, so the record of what was owed survives every
-- installment. Same two rulings baked in as 070: SAME-DAY / STAYS OPEN, and
-- OVERPAYMENT ALLOWED (the last installment may exceed the balance; the PO still
-- flips to delivered and the overage surfaces as a positive variance).
--
-- ⚠️ THE ONE THING THAT IS NOT LIKE COLLECTION — a collection *is* the payment,
-- but a delivery is not. The goods are physically handed over ONCE (the deliver
-- action writes driver_id, truck_plate, proof_url, receiver, time_in/out, gps).
-- A `partial` PO re-appears for a COD TOP-UP ONLY, not re-delivery. So unlike
-- 070's trigger — which owns every worked field on the visit — this trigger owns
-- ONLY the COD money (cod_amount) + its denormalized proof (cod_method,
-- cod_photo_url) + the status. It must never touch the handover fields, because
-- those belong to the one delivery, not to the installment. `status='delivered'`
-- therefore means "handed over AND COD fully paid".
--
-- ⚠️ ORDERING CONTRACT FOR MOBILE (Phase B): because status can only legally be
-- `partial`/`delivered` on a handed-over row (purchase_orders_closed_complete
-- requires driver_id + time_out), the deliver action MUST write the handover
-- fields WITH or BEFORE the cod_payments INSERT — exactly as the current deliver
-- form already captures both together. If the payment somehow lands on a row with
-- no driver_id/time_out yet, the trigger leaves status as `pending` and only
-- records the money; it flips once a payment lands on the handed-over row. The
-- deliver flow never splits them, so this is a guard, not a normal path.
--
-- Purely additive: one widened CHECK, one new "partial is a handed-over COD row"
-- CHECK, one new table, one trigger + function, its RLS. Nothing existing is
-- dropped or narrowed. Reuses the `delivery-proofs` storage bucket (044).
--
-- ⚠️ Merging this to main triggers .github/workflows/deploy-migrations.yml,
-- which runs `supabase db push` against the shared project the mobile app also
-- uses. Tell the mobile team before merging (same as 044/070).
--
-- Depends on 044 (purchase_orders) and 043 for public.admin_manages_module(),
-- current_user_role(), current_profile_id().
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The 'partial' status
--
-- purchase_orders.status is a TEXT column with an inline CHECK (migration 044),
-- NOT a Postgres enum — so this widens the CHECK rather than ALTER TYPE (the
-- contract's SQL assumed an enum we don't have, exactly as 070 found for
-- collection). The inline check from 044 is auto-named
-- `purchase_orders_status_check`; drop it by that name and re-add a named one
-- carrying the fourth value.
--
-- Existing rows are only pending/delivered/failed, so `status <> 'partial'`
-- holds for all of them and the new constraint validates against live data
-- without a rewrite.
-- ----------------------------------------------------------------------------
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('pending', 'delivered', 'failed', 'partial'));

-- A `partial` PO is a HANDED-OVER COD row with money on it but a balance still
-- out. purchase_orders_closed_complete (044) already forces driver_id + time_out
-- on any non-pending row, so the handover half is covered there; this adds the
-- COD half — a partial must be COD and carry a positive running total and a
-- method. The trigger below always sets these together, so a legitimate roll-up
-- never trips it, and a hand-written admin update can't invent a partial with no
-- money on it. Mirrors collection_visits_partial_is_worked (070).
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_partial_is_cod;
ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_partial_is_cod CHECK (
    status <> 'partial'
    OR (cod AND cod_amount IS NOT NULL AND cod_amount > 0 AND cod_method IS NOT NULL)
  );


-- ----------------------------------------------------------------------------
-- 2. cod_payments — one row per COD handover
--
-- Shape is straight from PARTIAL_COD_CONTRACT.md §2. Each row is a proof-bearing
-- installment toward one PO's COD: its own amount, method, photo, GPS, and time.
-- The parent PO's cod_amount is the SUM of these (kept by the trigger), never
-- written directly once payments exist. This is the delivery twin of
-- collection_payments (070).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cod_payments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id         UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  -- Who took the money in. NOT NULL — a payment always has an author, unlike the
  -- PO's driver_id which is null until the stop is run.
  driver_id     UUID NOT NULL REFERENCES profiles(id),
  amount        NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  -- 'counter' is deliberately absent, same as the PO's cod_method (044): that
  -- method means a store paying at its own counter, which has no meaning on a
  -- delivery. Matches the COD_METHODS tiles the driver sees.
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'check', 'gcash')),
  -- One photo slot for however the COD arrived. Nullable for the same offline
  -- reason as the PO's capture columns (044): the business row syncs through the
  -- outbox before the image lands via the deferred upload lane.
  payment_photo_url TEXT,
  gps_lat DOUBLE PRECISION,
  gps_lng DOUBLE PRECISION,
  remarks TEXT,
  -- When the money changed hands, per the phone. Drives the PO's cod ordering.
  paid_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cod_payments_po
  ON cod_payments (po_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_cod_payments_driver
  ON cod_payments (driver_id, paid_at DESC);


-- ----------------------------------------------------------------------------
-- 3. Roll-up trigger — the PO's COD is always the SUM of its payments
--
-- SECURITY DEFINER so the roll-up isn't blocked by the driver's narrow column
-- permissions on purchase_orders (they may run a stop, but this writes status +
-- cod_amount + cod_method + cod_photo_url in one shot, as owner).
--
-- UNLIKE 070, this denormalizes ONLY the COD half of the latest payment
-- (cod_method + cod_photo_url + cod_amount). The handover fields — driver_id,
-- truck_plate, proof_url, receiver, time_in/out, gps_lat/lng — are the one
-- delivery's, written by the deliver action, and are left untouched: a top-up
-- payment must not re-stamp them (see the header note).
--
-- Status is gated on the row being handed over (driver_id + time_out present),
-- because purchase_orders_closed_complete forbids a non-pending row without
-- them. On a handed-over COD row: delivered at sum >= cod_due (>= not > — the
-- overpayment ruling), partial while 0 < sum < cod_due. If the row is somehow
-- not handed over yet, status is left as-is and only the money is recorded (the
-- ordering guard from the header).
--
-- Fires on DELETE/UPDATE too, so correcting or removing a payment re-derives the
-- PO. Removing every payment clears the denormalized COD money; a handed-over
-- row falls back to `delivered` (the goods were still handed over — it just has
-- no COD recorded now, the pre-partial interim state), never back to `pending`,
-- which the handover would contradict.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rollup_cod_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_id    UUID := COALESCE(NEW.po_id, OLD.po_id);
  v_sum      NUMERIC;
  v_latest   cod_payments%ROWTYPE;
  v_po       purchase_orders%ROWTYPE;
  v_handed   BOOLEAN;
BEGIN
  SELECT * INTO v_po FROM purchase_orders WHERE id = v_po_id;
  -- The PO was deleted (ON DELETE CASCADE fired first): nothing to roll up.
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_handed := v_po.driver_id IS NOT NULL AND v_po.time_out IS NOT NULL;

  SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM cod_payments WHERE po_id = v_po_id;

  SELECT * INTO v_latest
    FROM cod_payments
   WHERE po_id = v_po_id
   ORDER BY paid_at DESC, created_at DESC
   LIMIT 1;

  IF v_sum <= 0 THEN
    -- Every payment removed: clear the denormalized COD money. Keep the handover
    -- (this is the delivery, not the money) and fall a handed-over row back to
    -- delivered so it isn't stranded as `partial` with nothing on it.
    UPDATE purchase_orders SET
      cod_amount = NULL,
      cod_method = NULL,
      cod_photo_url = NULL,
      status = CASE WHEN v_handed AND status = 'partial' THEN 'delivered' ELSE status END
    WHERE id = v_po_id;
  ELSE
    UPDATE purchase_orders SET
      cod_amount = v_sum,
      cod_method = v_latest.payment_method,
      cod_photo_url = v_latest.payment_photo_url,
      -- Only a handed-over row may carry a partial/delivered status. Until then,
      -- record the money but leave status alone (the ordering guard).
      status = CASE
        WHEN v_handed
          THEN CASE WHEN v_sum >= v_po.cod_due THEN 'delivered' ELSE 'partial' END
        ELSE status
      END
    WHERE id = v_po_id;
  END IF;

  RETURN NULL; -- AFTER trigger: return value is ignored.
END;
$$;

DROP TRIGGER IF EXISTS cod_payments_rollup ON cod_payments;
CREATE TRIGGER cod_payments_rollup
  AFTER INSERT OR UPDATE OR DELETE ON cod_payments
  FOR EACH ROW EXECUTE FUNCTION public.rollup_cod_payment();


-- ----------------------------------------------------------------------------
-- 4. RLS
--
-- Mirrors the purchase_orders split (044) and collection_payments (070): admins
-- who run Delivery get everything; a driver may add a payment to a PO that is
-- still open on the list (pending or partial) and read back their own. The
-- driver never UPDATEs cod_due — the trigger owns cod_amount/status as owner,
-- which is why cod_due stays the admin's fixed figure.
--
-- Note this stays consistent with 044's asymmetry: cod_due IS visible to the
-- driver (a COD figure is the fixed price of the goods, not a hidden balance), so
-- unlike collection there is no anchoring-bias reason to withhold it.
-- ----------------------------------------------------------------------------
ALTER TABLE cod_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Delivery admins manage COD payments" ON cod_payments;
CREATE POLICY "Delivery admins manage COD payments" ON cod_payments
  FOR ALL TO authenticated
  USING (public.admin_manages_module('delivery'))
  WITH CHECK (public.admin_manages_module('delivery'));

-- A driver records a COD handover against a PO still open on the list (pending
-- or partial), stamping themselves as the payer. They cannot backdate one onto a
-- delivered/failed row, and cannot attribute it to someone else.
DROP POLICY IF EXISTS "Drivers add COD payments" ON cod_payments;
CREATE POLICY "Drivers add COD payments" ON cod_payments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() = 'delivery'
    AND driver_id = public.current_profile_id()
    AND EXISTS (
      SELECT 1 FROM purchase_orders p
      WHERE p.id = po_id AND p.status IN ('pending', 'partial')
    )
  );

DROP POLICY IF EXISTS "Drivers read own COD payments" ON cod_payments;
CREATE POLICY "Drivers read own COD payments" ON cod_payments
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'delivery'
    AND driver_id = public.current_profile_id()
  );

-- Drivers get no UPDATE or DELETE: a handover, once recorded with its proof, is a
-- fact. Corrections are an admin action through the FOR ALL policy above.

COMMENT ON TABLE cod_payments IS
  'One row per COD handover toward a purchase_order. The PO''s cod_amount is the SUM of these (rollup_cod_payment trigger); status flips to partial while 0 < sum < cod_due and delivered at sum >= cod_due, only once the PO is handed over. cod_due is never mutated, and the handover fields belong to the one delivery, not the installment. See migration 073 + the mobile PARTIAL_COD_CONTRACT.md.';
