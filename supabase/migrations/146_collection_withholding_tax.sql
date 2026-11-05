-- ============================================================================
-- 146 — Collection: stores that withhold 1% expanded withholding tax (EWT)
--
-- THE PROBLEM. Some customers are withholding agents: on a ₱112,000 invoice they
-- hand the collector ₱111,000 and remit ₱1,000 to the BIR themselves (Form 2307).
-- The collector records the ₱111,000 they actually received — correctly — but
-- 070's roll-up compares that cash to amount_due, so the visit sits at `partial`
-- forever, and 117's ledger leaves ₱1,000 on the store's credit balance that the
-- store does not owe.
--
-- THE MODEL (owner decision, 2026-11-05):
--   * PER STORE, set once — clients.withholds_tax. A withholding agent stays one,
--     so it is not re-ticked per listing (unlike 143's Counter / 145's down payment).
--   * RATE: 1% of the VAT-EXCLUSIVE amount, the BIR basis for goods from a
--     VAT-registered seller. Gross G, withheld W = G / 1.12 × 1% = G / 112, cash
--     received N = G − W = G × 111/112. So from the cash the collector records,
--     W = N / 111 (₱111,000 received → ₱1,000 withheld, ₱112,000 settled).
--   * THE COLLECTOR KEEPS TYPING THE CASH. No mobile change: each payment's
--     withheld tax is derived server-side, so the field can't inflate it and the
--     remittance reconciliation (086, cash vs cash) is untouched.
--
-- WHAT CHANGES:
--   1. clients.withholds_tax — the per-store flag, set via a definer RPC.
--   2. collection_payments.withheld_tax — snapshot per payment, filled by a
--      BEFORE trigger from the store's flag AT THE TIME OF PAYMENT, so turning
--      the flag off later never rewrites past payments.
--   3. collection_visits.withholding_tax — the visit's SUM of (2). amount_collected
--      stays CASH (what the collector remits); the roll-up now settles the visit
--      on cash + withheld >= amount_due.
--   4. client_credit_entries gets a 'withholding' entry per such payment, so the
--      balance drops by the full gross and the ledger shows cash and tax apart.
--
-- Purely additive for every existing row: both flags/amounts default to false/0,
-- so a store that isn't ticked behaves exactly as before. No RLS change on the
-- tables: admins already manage visits/payments/ledger (043/070/117); collectors
-- read the visit's new column like any other.
--
-- Depends on: 043, 070 (collection_payments + rollup), 117 (ledger + sync).
-- Idempotent, so a CI re-run after a partial failure cannot error.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The per-store flag
-- ----------------------------------------------------------------------------
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS withholds_tax BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN clients.withholds_tax IS
  'Collection (migration 146): the store withholds 1% EWT on the VAT-exclusive amount, so the cash a collector receives is 111/112 of what it settles. Set by a Collection admin via set_client_withholds_tax(). Drives collection_payments.withheld_tax.';

-- Collection admins have no UPDATE on clients (that is the sales side's), so the
-- tick goes through a narrow definer function gated the same way as the rest of
-- the module, rather than a new broad policy on clients.
CREATE OR REPLACE FUNCTION public.set_client_withholds_tax(p_client_id UUID, p_enabled BOOLEAN)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.admin_manages_module('collection') THEN
    RAISE EXCEPTION 'Only a Collection admin can change a store''s withholding tax.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE clients SET withholds_tax = COALESCE(p_enabled, false) WHERE id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Store not found.' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_client_withholds_tax(UUID, BOOLEAN) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_client_withholds_tax(UUID, BOOLEAN) TO authenticated;


-- ----------------------------------------------------------------------------
-- 2. The withheld tax on each payment — derived, never trusted from the caller
-- ----------------------------------------------------------------------------
ALTER TABLE collection_payments
  ADD COLUMN IF NOT EXISTS withheld_tax NUMERIC(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE collection_payments DROP CONSTRAINT IF EXISTS collection_payments_withheld_tax_nonneg;
ALTER TABLE collection_payments
  ADD CONSTRAINT collection_payments_withheld_tax_nonneg CHECK (withheld_tax >= 0);

COMMENT ON COLUMN collection_payments.withheld_tax IS
  'EWT the customer withheld on this payment (migration 146): round(amount / 111, 2) when the store withholds_tax at the time of payment, else 0. amount stays the cash received. Set by a BEFORE trigger; a caller-supplied value is ignored.';

-- On INSERT: snapshot from the store's flag right now. On UPDATE: an amount
-- correction re-derives the tax at the SAME treatment the payment was taken
-- under (OLD.withheld_tax > 0), so toggling the store flag later never touches
-- history. A visit moved to another store keeps the treatment it was paid with.
CREATE OR REPLACE FUNCTION public.derive_collection_payment_withholding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_withholds BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT c.withholds_tax INTO v_withholds
      FROM collection_visits v JOIN clients c ON c.id = v.client_id
     WHERE v.id = NEW.visit_id;
  ELSE
    v_withholds := OLD.withheld_tax > 0;
  END IF;

  NEW.withheld_tax := CASE WHEN COALESCE(v_withholds, false)
                           THEN round(NEW.amount / 111.0, 2)
                           ELSE 0 END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collection_payments_withholding ON collection_payments;
CREATE TRIGGER collection_payments_withholding
  BEFORE INSERT OR UPDATE OF amount, withheld_tax ON collection_payments
  FOR EACH ROW EXECUTE FUNCTION public.derive_collection_payment_withholding();


-- ----------------------------------------------------------------------------
-- 3. The visit's total withheld, and a roll-up that counts it
-- ----------------------------------------------------------------------------
ALTER TABLE collection_visits
  ADD COLUMN IF NOT EXISTS withholding_tax NUMERIC(12, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN collection_visits.withholding_tax IS
  'SUM of collection_payments.withheld_tax for this visit (migration 146), kept by rollup_collection_payment(). amount_collected stays cash; the visit is collected when amount_collected + withholding_tax >= amount_due.';

-- Same as 070's version except: it sums withheld_tax alongside amount, writes it
-- to the visit, and settles on cash + withheld. The ₱0.01 allowance applies to
-- withholding visits only: the customer rounds W on the gross while we derive it
-- from the cash, and the two can land a centavo apart — that centavo must not
-- leave a fully paid store stuck at `partial`.
CREATE OR REPLACE FUNCTION public.rollup_collection_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_visit_id UUID := COALESCE(NEW.visit_id, OLD.visit_id);
  v_sum      NUMERIC;
  v_wht      NUMERIC;
  v_latest   collection_payments%ROWTYPE;
BEGIN
  SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(withheld_tax), 0)
    INTO v_sum, v_wht
    FROM collection_payments WHERE visit_id = v_visit_id;

  SELECT * INTO v_latest
    FROM collection_payments
   WHERE visit_id = v_visit_id
   ORDER BY paid_at DESC, created_at DESC
   LIMIT 1;

  IF v_sum <= 0 THEN
    UPDATE collection_visits SET
      status = 'pending',
      amount_collected = NULL,
      withholding_tax = 0,
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
      withholding_tax = v_wht,
      -- >= not > : overpayment still counts as fully paid (070 owner ruling).
      status = CASE
        WHEN v_sum + v_wht >= amount_due - CASE WHEN v_wht > 0 THEN 0.01 ELSE 0 END
          THEN 'collected'
        ELSE 'partial'
      END,
      collector_id = v_latest.collector_id,
      payment_method = v_latest.payment_method,
      payment_photo_url = v_latest.payment_photo_url,
      delivery_receipt_photo_url = v_latest.delivery_receipt_photo_url,
      gps_lat = v_latest.gps_lat,
      gps_lng = v_latest.gps_lng,
      visited_at = v_latest.paid_at
    WHERE id = v_visit_id;
  END IF;

  RETURN NULL;
END;
$$;


-- ----------------------------------------------------------------------------
-- 4. The ledger: a 'withholding' entry beside each payment's 'collection' entry
--
-- 117 allowed one entry per payment; a withholding payment now carries two (cash
-- and tax), so the one-per-payment index becomes one-per-(payment, type). The
-- inline CHECK from 117 is auto-named client_credit_entries_entry_type_check.
-- ----------------------------------------------------------------------------
ALTER TABLE client_credit_entries DROP CONSTRAINT IF EXISTS client_credit_entries_entry_type_check;
ALTER TABLE client_credit_entries
  ADD CONSTRAINT client_credit_entries_entry_type_check
  CHECK (entry_type IN ('adjustment', 'charge', 'collection', 'withholding'));

DROP INDEX IF EXISTS client_credit_entries_one_per_payment;
CREATE UNIQUE INDEX IF NOT EXISTS client_credit_entries_one_per_payment_type
  ON client_credit_entries (payment_id, entry_type) WHERE payment_id IS NOT NULL;

-- Same as 117's version plus the withholding entry: written when the payment
-- carries tax, removed if a correction brings it to 0. DELETE of the payment
-- still needs no branch — both entries cascade off payment_id.
CREATE OR REPLACE FUNCTION public.sync_collection_payment_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_id UUID;
BEGIN
  SELECT client_id INTO v_client_id
    FROM collection_visits WHERE id = NEW.visit_id;

  IF v_client_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO client_credit_entries (client_id, entry_type, amount, payment_id)
  VALUES (v_client_id, 'collection', -NEW.amount, NEW.id)
  ON CONFLICT (payment_id, entry_type) WHERE payment_id IS NOT NULL
  DO UPDATE SET client_id = EXCLUDED.client_id,
               amount     = EXCLUDED.amount;

  IF NEW.withheld_tax > 0 THEN
    INSERT INTO client_credit_entries (client_id, entry_type, amount, payment_id, note)
    VALUES (v_client_id, 'withholding', -NEW.withheld_tax, NEW.id, '1% EWT withheld by customer')
    ON CONFLICT (payment_id, entry_type) WHERE payment_id IS NOT NULL
    DO UPDATE SET client_id = EXCLUDED.client_id,
                 amount     = EXCLUDED.amount;
  ELSE
    DELETE FROM client_credit_entries
     WHERE payment_id = NEW.id AND entry_type = 'withholding';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON TABLE client_credit_entries IS
  'Signed-delta ledger behind clients.credit_balance (migrations 117, 146). entry_type: admin ''adjustment'' (set/correct), admin ''charge'' (new goods), automatic ''collection'' (cash, one per collection_payments row) and automatic ''withholding'' (EWT the customer withheld on that payment, 146). The balance is SUM(amount), kept by rollup_client_credit. Collection admins write manual entries; collection/withholding entries are trigger-only.';


-- ============================================================================
-- Rollback (if ever needed — run 070's rollup and 117's sync definitions again
-- after these):
--   drop trigger if exists collection_payments_withholding on collection_payments;
--   drop function if exists public.derive_collection_payment_withholding();
--   delete from client_credit_entries where entry_type = 'withholding';
--   drop index if exists client_credit_entries_one_per_payment_type;
--   create unique index client_credit_entries_one_per_payment
--     on client_credit_entries (payment_id) where payment_id is not null;
--   (restore the 3-value entry_type check)
--   alter table collection_visits drop column if exists withholding_tax;
--   alter table collection_payments drop column if exists withheld_tax;
--   drop function if exists public.set_client_withholds_tax(uuid, boolean);
--   alter table clients drop column if exists withholds_tax;
--
-- Verification (staging, TEST store X):
--   1. select set_client_withholds_tax('X', true);  -- as a Collection admin
--   2. Set X's balance to 112000; list it (amount_due 112000).
--   3. Collect 111000 on the phone. Expect: payment.withheld_tax = 1000,
--      visit.status = 'collected', visit.amount_collected = 111000,
--      visit.withholding_tax = 1000, ledger has -111000 'collection' and
--      -1000 'withholding', clients.credit_balance = 0.
--   4. Partial: list for 112000, collect 55500 → withheld 500, status partial;
--      collect 55500 more → collected, balance 0.
--   5. Untick X, collect again → withheld_tax 0, behaves as before.
-- ============================================================================
