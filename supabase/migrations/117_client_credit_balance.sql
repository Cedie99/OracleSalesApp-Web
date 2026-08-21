-- ============================================================================
-- 117 — Collection: store-level running credit balance
--
-- THE MODEL (owner decision, 2026-08-21). A store now carries a PERSISTENT credit
-- balance that lives on the store, not on any one day's visit. The Collection
-- admin sets a store's opening credit (e.g. PHP 30,000); collectors draw it down
-- as they collect (collect 1,000 -> balance 29,000 the next day); and the admin
-- can raise it again when the store buys more goods. It is a running ledger the
-- admin maintains, decremented automatically by every collection.
--
-- This is the cross-day source of truth that Collection never had. Until now the
-- only figure a store owed was collection_visits.amount_due — an admin-typed,
-- per-day, per-visit number (043) that carried nothing forward. That number
-- stays exactly as it is: it is still the per-day snapshot the collected amount
-- is reconciled against, and from now on the Add-store dialog defaults it to the
-- store's current balance instead of making the admin re-type it. The balance is
-- the thing that persists; amount_due is a photograph of it on a given day.
--
-- WHY THE BALANCE CAN DECREMENT WITH NO MOBILE CHANGE. Since migration 086 every
-- collection — whether paid in one go or in installments — is a row in
-- collection_payments (070); the visit's amount_collected is always their SUM.
-- So collection_payments is the single "money came in" source of truth, and a
-- trigger on it is all that is needed to draw the balance down. The phone keeps
-- writing collection_payments exactly as before and never has to know the
-- balance exists — which is also correct for the anchoring-bias rule (2026-07-25):
-- the amount a store owes is kept OFF the collector's screen, and this feature
-- does not leak it there.
--
-- SHAPE (mirrors 070's derive-from-children design so the balance is self-healing
-- and auditable, never a counter that can drift):
--   * clients.credit_balance — denormalized running balance.
--   * client_credit_entries — one signed delta per event: an admin 'adjustment'
--     (set/correct, +/-), an admin 'charge' (new goods, +), or an automatic
--     'collection' (-, one per collection_payments row). The balance is the SUM
--     of these, kept by a rollup trigger. Reversing a payment reverses its debit.
--
-- Purely additive: one new column, one new table, two triggers + functions, RLS
-- on the new table only. Nothing existing is dropped or narrowed. Delivery COD is
-- deliberately untouched — a COD figure is the fixed price of goods handed over
-- that day, not a persistent store balance (owner decision: Collection only).
--
-- Merging this to main triggers .github/workflows/deploy-migrations.yml, which
-- runs `supabase db push` against the shared project the mobile app also uses.
-- Tell the mobile team before merging (same as 043/070/086) — though mobile needs
-- no code change for it.
--
-- Depends on: 070 (collection_payments), 043 (public.admin_manages_module()),
-- clients. All statements are idempotent so a CI re-run after a partial failure
-- cannot error on "already exists".
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The denormalized balance on the store
--
-- NOT NULL DEFAULT 0: every existing client starts with no credit on file, and
-- the admin sets each store's opening balance through the Collection tool (which
-- writes an 'adjustment' entry below). No bulk backfill — an opening balance is a
-- real business figure, not something to invent per row.
-- ----------------------------------------------------------------------------
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS credit_balance NUMERIC(12, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN clients.credit_balance IS
  'Store''s running credit balance (migration 117). Denormalized SUM of client_credit_entries, kept by rollup_client_credit(). Set/raised by a Collection admin; drawn down automatically by every collection_payments row. The cross-day figure a store owes; collection_visits.amount_due is the per-day snapshot of it. Collection only — delivery COD is unrelated.';


-- ----------------------------------------------------------------------------
-- 2. client_credit_entries — one signed delta per event
--
-- amount is a SIGNED delta so the balance is a plain SUM: a charge/positive
-- adjustment is > 0, a collection/negative adjustment is < 0. entry_type records
-- WHY, so the admin's ledger reads as a history ("opening 30,000, collected
-- -1,000, new order +5,000") rather than a bare number.
--
-- payment_id links a 'collection' entry to the collection_payments row that
-- caused it (NULL on admin entries). ON DELETE CASCADE: removing a payment
-- removes its debit, and the rollup trigger below then restores the balance — the
-- reversal is automatic. The partial unique index makes that link one-to-one, so
-- the sync trigger in §4 can upsert safely.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_credit_entries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  entry_type  TEXT NOT NULL CHECK (entry_type IN ('adjustment', 'charge', 'collection')),
  -- Signed delta. A 'charge' is > 0; a 'collection' is < 0; an 'adjustment' may
  -- be either. Never 0 — a no-op movement is not an event worth recording.
  amount      NUMERIC(12, 2) NOT NULL CHECK (amount <> 0),
  note        TEXT,
  -- The admin who made a manual entry. NULL on a 'collection' entry, which the
  -- trigger writes with no acting profile — the payment's own collector_id is the
  -- author of the money, and it is one join away via payment_id.
  created_by  UUID REFERENCES profiles(id),
  -- The collection_payments row a 'collection' entry mirrors; NULL on admin
  -- entries. CASCADE so a reversed/removed payment reverses this debit.
  payment_id  UUID REFERENCES collection_payments(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_credit_entries_client
  ON client_credit_entries (client_id, created_at DESC);

-- One credit entry per payment, so §4's sync can INSERT-or-UPDATE by payment_id
-- and a payment can never be double-counted against the balance.
CREATE UNIQUE INDEX IF NOT EXISTS client_credit_entries_one_per_payment
  ON client_credit_entries (payment_id) WHERE payment_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 3. Roll-up trigger — the balance is always the SUM of a client's entries
--
-- SECURITY DEFINER so a collector's collection_payments INSERT can cascade into
-- this write on clients (which the collector has no UPDATE on) as owner — the
-- same reason 070's rollup runs as definer. Fires on INSERT/UPDATE/DELETE so a
-- corrected or removed entry re-derives the balance rather than leaving it stale.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rollup_client_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_id UUID := COALESCE(NEW.client_id, OLD.client_id);
BEGIN
  UPDATE clients
     SET credit_balance = COALESCE(
       (SELECT SUM(amount) FROM client_credit_entries WHERE client_id = v_client_id),
       0)
   WHERE id = v_client_id;

  RETURN NULL; -- AFTER trigger: return value is ignored.
END;
$$;

DROP TRIGGER IF EXISTS client_credit_entries_rollup ON client_credit_entries;
CREATE TRIGGER client_credit_entries_rollup
  AFTER INSERT OR UPDATE OR DELETE ON client_credit_entries
  FOR EACH ROW EXECUTE FUNCTION public.rollup_client_credit();


-- ----------------------------------------------------------------------------
-- 4. Sync trigger — every collection draws the balance down
--
-- Keeps a 'collection' entry in step with each collection_payments row. On INSERT
-- it writes the debit (amount = -payment.amount) against the payment's client; on
-- UPDATE it re-derives that debit in case a correction changed the amount or moved
-- the payment to another visit (hence another client). DELETE needs no branch:
-- the payment_id FK is ON DELETE CASCADE, which removes the entry and lets §3's
-- rollup restore the balance.
--
-- SECURITY DEFINER: the acting collector has no write on client_credit_entries
-- (they get no RLS policy there at all — see §5), so the debit must be written as
-- owner. The client is resolved from the payment's visit, never trusted from the
-- caller.
-- ----------------------------------------------------------------------------
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

  -- A visit always has a client_id (043), but guard rather than write a NULL
  -- entry if a payment ever arrives ahead of its visit.
  IF v_client_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO client_credit_entries (client_id, entry_type, amount, payment_id)
  VALUES (v_client_id, 'collection', -NEW.amount, NEW.id)
  ON CONFLICT (payment_id) WHERE payment_id IS NOT NULL
  DO UPDATE SET client_id = EXCLUDED.client_id,
               amount     = EXCLUDED.amount;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS collection_payments_credit_sync ON collection_payments;
CREATE TRIGGER collection_payments_credit_sync
  AFTER INSERT OR UPDATE ON collection_payments
  FOR EACH ROW EXECUTE FUNCTION public.sync_collection_payment_credit();


-- ----------------------------------------------------------------------------
-- 5. RLS
--
-- Collection admins manage the ledger — set an opening balance, add a charge,
-- correct an entry — through the same FOR ALL gate the rest of the module uses
-- (admin_manages_module('collection'), 043). Collectors get NO policy here: the
-- 'collection' entries that reflect their work are written by the SECURITY
-- DEFINER trigger in §4, not by the field, so the balance can never be moved from
-- a phone. This is what keeps the owed figure office-side.
-- ----------------------------------------------------------------------------
ALTER TABLE client_credit_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Collection admins manage credit entries" ON client_credit_entries;
CREATE POLICY "Collection admins manage credit entries" ON client_credit_entries
  FOR ALL TO authenticated
  USING (public.admin_manages_module('collection'))
  WITH CHECK (public.admin_manages_module('collection'));

COMMENT ON TABLE client_credit_entries IS
  'Signed-delta ledger behind clients.credit_balance (migration 117). entry_type: admin ''adjustment'' (set/correct), admin ''charge'' (new goods), or automatic ''collection'' (one per collection_payments row, written by sync_collection_payment_credit). The balance is SUM(amount), kept by rollup_client_credit. Collection admins write manual entries; collection debits are trigger-only.';


-- ============================================================================
-- Rollback (if ever needed):
--   drop trigger if exists collection_payments_credit_sync on collection_payments;
--   drop function if exists public.sync_collection_payment_credit();
--   drop trigger if exists client_credit_entries_rollup on client_credit_entries;
--   drop function if exists public.rollup_client_credit();
--   drop table if exists public.client_credit_entries;
--   alter table clients drop column if exists credit_balance;
--
-- Verification (staging first, TEST clients):
--   1. insert into client_credit_entries (client_id, entry_type, amount, note)
--        values ('X-uuid', 'adjustment', 30000, 'opening');
--      Confirm clients.credit_balance for X is 30000.
--   2. Insert a collection_payments row of 1000 against a visit whose client is X
--      (via SQL or the mobile collect flow). Confirm: a 'collection' entry of
--      -1000 with payment_id set, and clients.credit_balance = 29000.
--   3. delete that collection_payments row. Confirm the entry is gone (cascade)
--      and credit_balance is back to 30000.
--   4. insert ... ('X-uuid', 'charge', 5000, 'new order'). Confirm balance 34000.
-- ============================================================================
