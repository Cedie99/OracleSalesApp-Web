-- ============================================================================
-- 087 — Delivery: per-PAYMENT COD remittance coverage
--
-- Cross-repo feature. The delivery-COD twin of 086 — same bug, same fix, same
-- shape — so read 086 and the mobile REMITTANCE_CONTRACT.md first; the notes
-- below only cover where DELIVERY genuinely differs.
--
-- THE BUG. COD remittance coverage is tracked PER PO today:
-- `cod_remittances.po_ids UUID[]` (044) plus the `purchase_orders.cod_remitted`
-- boolean. Both are all-or-nothing on a PO, which breaks partial COD (073): a
-- `partial` PO that is remitted, then receives a LATER COD installment, strands
-- that increment — the PO is already "remitted" so on-hand math keyed off the PO
-- drops the top-up. "Remitted vs on-hand" is only answerable per PAYMENT.
--
-- THE FIX. The unit of remittance is a `cod_payments` row (073), remitted exactly
-- once. A COD payment is ON HAND ⇔ its remittance link is NULL; a cod_remittance
-- covers exactly the payments pointing at it, its amount being their SUM.
--
-- NOTE ON THE EXISTING `purchase_orders.cod_remitted` BOOLEAN (044): it is left
-- in place (the dashboard's "COD still in the truck" partial index reads it) but,
-- exactly like po_ids, it is NO LONGER the source of truth for coverage — a
-- per-PO flag cannot describe a half-remitted PO. Coverage is the payment link.
-- Retiring cod_remitted / its index is a later cleanup, not this migration's job;
-- keeping it avoids touching 044's index and constraints here.
--
-- Purely additive: one nullable FK column, two partial indexes, one narrow
-- driver UPDATE policy. Nothing existing is dropped or narrowed.
--
-- ⚠️ Merging this to main triggers .github/workflows/deploy-migrations.yml
-- against the shared project. Tell the mobile team before merging (same as
-- 044/073).
--
-- Depends on 073 (cod_payments), 044 (cod_remittances, purchase_orders),
-- 043 (public.current_user_role(), public.current_profile_id()).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The link column — which COD remittance covered this payment
--
-- Named `cod_remittance_id` (not `remittance_id`) to match the delivery table it
-- points at and the mobile field name in the contract. NULL = still on hand.
-- Set once, at remittance-submit time, to a cod_remittance the same driver owns.
-- ON DELETE default (RESTRICT): a submitted hand-over must not be deletable out
-- from under the payments it covers.
-- ----------------------------------------------------------------------------
ALTER TABLE cod_payments
  ADD COLUMN IF NOT EXISTS cod_remittance_id UUID NULL REFERENCES cod_remittances(id);

-- "My COD payments not yet remitted" — the driver's on-hand figure.
CREATE INDEX IF NOT EXISTS idx_cod_payments_unremitted
  ON cod_payments (driver_id)
  WHERE cod_remittance_id IS NULL;
-- Coverage lookup from the remittance side (and the SUM that is amount_remitted).
CREATE INDEX IF NOT EXISTS idx_cod_payments_remittance
  ON cod_payments (cod_remittance_id)
  WHERE cod_remittance_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. RLS — a driver links their OWN, UNREMITTED COD payments, once
--
-- Exact mirror of 086, with driver/'delivery'/cod_remittances in place of
-- collector/'collector'/remittances. USING gates to the driver's still-on-hand
-- rows (link IS NULL → immutable once set); WITH CHECK forces the row out linked
-- to a cod_remittance the driver owns (no un-remit, no dumping onto another
-- driver's hand-over). The ownership EXISTS runs under 044's "Drivers read own
-- COD remittances". See 086 for why this is a narrow UPDATE policy rather than a
-- REVOKE + column grant.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Drivers link own COD payments to remittance" ON cod_payments;
CREATE POLICY "Drivers link own COD payments to remittance" ON cod_payments
  FOR UPDATE TO authenticated
  USING (
    public.current_user_role() = 'delivery'
    AND driver_id = public.current_profile_id()
    AND cod_remittance_id IS NULL
  )
  WITH CHECK (
    public.current_user_role() = 'delivery'
    AND driver_id = public.current_profile_id()
    AND cod_remittance_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM cod_remittances r
      WHERE r.id = cod_remittance_id
        AND r.driver_id = public.current_profile_id()
    )
  );

-- Sync-down needs no new policy: 073's "Drivers read own COD payments" SELECT
-- already exposes the COD payment ledger (id, po_id, amount, method, and now
-- cod_remittance_id) to its owner.

COMMENT ON COLUMN cod_payments.cod_remittance_id IS
  'The cod_remittance (044) that covered this COD hand-over, or NULL while it is still on hand. Per-payment coverage (087): a COD payment is remitted exactly once; a cod_remittance''s amount_remitted = SUM(amount) of the payments linking to it. Supersedes cod_remittances.po_ids and purchase_orders.cod_remitted as the source of truth for coverage. Driver-immutable once set. See REMITTANCE_CONTRACT.md.';
