-- ============================================================================
-- 143 — Collection: the admin-designated payment method ("this store pays at
--       the Counter")
--
-- Until now the payment method on a collection visit was entirely the
-- collector's call, made on the phone at the moment of collection. The office
-- sometimes knows in advance that a store settles over the counter, and wants
-- to say so when it lists the store — so the collector does not arrive
-- expecting cash, and cannot record the store any other way.
--
-- Scope is PER LISTING (per collection_visits row), not per client: the admin
-- sets it in the Add Store dialog, or on a still-unworked store from its detail
-- dialog, and it applies to that day's listing only. A store that pays at the
-- counter every week is ticked every week; that was the owner's call
-- (2026-10-27) over a standing client-level default.
--
-- Only 'counter' is accepted for now. The column is named for the general idea
-- so that widening the CHECK later is a one-line change rather than a rename.
--
-- ── ⚠️ MOBILE CONTRACT ──────────────────────────────────────────────────────
-- When `designated_payment_method` is set, mobile must PRE-SELECT that method
-- and LOCK the picker to it — the collector cannot choose another. The
-- database enforces the same rule (section 2 below): a visit or installment
-- recorded with any other method is rejected with SQLSTATE 23514
-- (check_violation), the same code mobile already handles for a bad method.
-- Mobile reads the column verbatim (a nullable text, NULL = collector's choice).
--
-- ⚠️ Rollout order: an older phone build that does not know this column will
-- let the collector pick Cash on a Counter store, and the sync will be
-- rejected. Ship the mobile half before admins start designating stores in
-- production.
--
-- Purely additive: one nullable column (NULL on every existing row = no
-- designation, behaviour unchanged) and two guard triggers. Admin writes go
-- through 043's existing "Collection admins manage visits" FOR ALL policy; no
-- RLS change.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The column
-- ----------------------------------------------------------------------------
ALTER TABLE collection_visits
  ADD COLUMN IF NOT EXISTS designated_payment_method TEXT;

ALTER TABLE collection_visits
  DROP CONSTRAINT IF EXISTS collection_visits_designated_payment_method_check;
ALTER TABLE collection_visits
  ADD CONSTRAINT collection_visits_designated_payment_method_check CHECK (
    designated_payment_method IS NULL OR designated_payment_method IN ('counter')
  );

COMMENT ON COLUMN collection_visits.designated_payment_method IS
  'Admin-set before collection: the only payment method this listing may be recorded with. NULL = collector chooses as usual. Currently only ''counter''. Mobile pre-selects and locks to it; the guard triggers reject any other method (23514). See migration 143.';


-- ----------------------------------------------------------------------------
-- 2. Guards — the lock holds whichever path the method arrives by
--
-- A visit's method reaches the row two ways: written directly on a one-shot
-- collection, or rolled up from the latest `collection_payments` row by 070's
-- trigger. Both are guarded, so a partial paid in installments cannot slip a
-- Cash installment past a Counter designation.
--
-- The visit guard also stops an admin designating a store that was ALREADY
-- recorded with a different method — the designation is an instruction for a
-- visit that has not happened yet, not a relabel of one that has.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_visit_designated_method()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.designated_payment_method IS NOT NULL
     AND NEW.payment_method IS NOT NULL
     AND NEW.payment_method <> NEW.designated_payment_method THEN
    RAISE EXCEPTION 'This store was set by the office to pay by %; it cannot be recorded as %.',
      NEW.designated_payment_method, NEW.payment_method
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collection_visits_designated_method ON collection_visits;
CREATE TRIGGER collection_visits_designated_method
  BEFORE INSERT OR UPDATE OF payment_method, designated_payment_method ON collection_visits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_visit_designated_method();

-- SECURITY DEFINER because the collector inserting the installment may not be
-- able to read the parent visit's row under 043's policies (it is unclaimed by
-- them until the roll-up writes collector_id). It only reads one column.
CREATE OR REPLACE FUNCTION public.enforce_payment_designated_method()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_designated TEXT;
BEGIN
  SELECT designated_payment_method INTO v_designated
    FROM collection_visits WHERE id = NEW.visit_id;

  IF v_designated IS NOT NULL AND NEW.payment_method <> v_designated THEN
    RAISE EXCEPTION 'This store was set by the office to pay by %; it cannot be recorded as %.',
      v_designated, NEW.payment_method
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collection_payments_designated_method ON collection_payments;
CREATE TRIGGER collection_payments_designated_method
  BEFORE INSERT OR UPDATE OF payment_method, visit_id ON collection_payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_designated_method();

-- No grant changes: both return `trigger`, so PostgREST cannot call them as
-- RPCs and PostgreSQL does not check EXECUTE when a trigger fires (see 132).
