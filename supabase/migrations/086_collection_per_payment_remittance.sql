-- ============================================================================
-- 086 — Collection: per-PAYMENT remittance coverage
--
-- Cross-repo feature. The mobile repo (OracleSalesApp-Mobile) owns the contract
-- in REMITTANCE_CONTRACT.md (2026-08-10); this migration is web's half. Read
-- that file first — the notes below only cover what the SQL does and why.
--
-- THE BUG (found 2026-08-10). Remittance coverage is tracked PER VISIT today:
-- `remittances.visit_ids UUID[]` (043) lists the visits a hand-over covered.
-- That is all-or-nothing on a visit id, which breaks the moment a visit accrues
-- cash in MORE THAN ONE installment (partial collection, 070):
--
--   * A `partial` visit gets remitted → its id is now inside a past remittance's
--     visit_ids. The customer later pays the REMAINING installment (visit flips
--     partial → collected). That top-up cash can never be remitted: the visit id
--     is already "spent" on the earlier remittance, so on-hand math that keys off
--     the visit excludes it forever. The cash is stranded.
--   * "Remitted vs still-on-hand" is only answerable at the PAYMENT level, because
--     a single visit can be half-remitted.
--
-- THE FIX (owner-approved model in the contract): the unit of remittance is a
-- PAYMENT, not a visit. Each `collection_payments` row (070) is remitted exactly
-- once. A payment is ON HAND ⇔ its remittance link is NULL; a remittance covers
-- exactly the payments that point at it, and its amount is their SUM.
--
-- Purely additive: one nullable FK column, one partial index, one narrow
-- collector UPDATE policy. Nothing existing is dropped or narrowed —
-- `remittances.visit_ids` stays for display/back-compat but no longer DEFINES
-- coverage. No new column on collection_visits: the visit keeps rolling up
-- amount_collected from ALL its payments (070) exactly as before.
--
-- The delivery-COD twin of this bug is fixed in 087.
--
-- ⚠️ Merging this to main triggers .github/workflows/deploy-migrations.yml,
-- which runs `supabase db push` against the shared project the mobile app also
-- uses. Tell the mobile team before merging (same as 043/070).
--
-- Depends on 070 (collection_payments), 043 (remittances,
-- public.current_user_role(), public.current_profile_id()).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The link column — which remittance covered this payment
--
-- NULL = still on hand (not yet remitted). Set once, at remittance-submit time,
-- to a remittance the same collector owns. NULLable and no default: a payment is
-- born on-hand and the field only ever fills in later. ON DELETE is left as the
-- default (RESTRICT): a remittance that covers real cash must not be deletable
-- out from under its payments; admin corrections re-point or clear the link
-- first. (A submitted remittance is a signed hand-over, not a scratch row.)
-- ----------------------------------------------------------------------------
ALTER TABLE collection_payments
  ADD COLUMN IF NOT EXISTS remittance_id UUID NULL REFERENCES remittances(id);

-- The on-hand query the phone and the dashboard both run every load:
-- "my payments not yet remitted." Partial index — the remitted rows are dead
-- weight for this question and the table only grows.
CREATE INDEX IF NOT EXISTS idx_collection_payments_unremitted
  ON collection_payments (collector_id)
  WHERE remittance_id IS NULL;
-- Coverage lookup from the remittance side ("what did this hand-over cover", and
-- the SUM that is amount_remitted).
CREATE INDEX IF NOT EXISTS idx_collection_payments_remittance
  ON collection_payments (remittance_id)
  WHERE remittance_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. RLS — a collector links their OWN, UNREMITTED payments, once
--
-- 070 gave collectors no UPDATE on collection_payments at all (a recorded
-- hand-over is a fact). This adds ONE narrow UPDATE lane, purely to stamp the
-- remittance link at submit time:
--
--   USING      — the collector can only reach their OWN rows that are STILL on
--                hand (remittance_id IS NULL). An already-linked row fails USING,
--                so it is invisible to this policy → the link is IMMUTABLE once
--                set (no re-pointing to a different remittance, no un-remit).
--   WITH CHECK — the row must come out linked (remittance_id IS NOT NULL) to a
--                remittance THIS collector owns. So they cannot null it back out,
--                and cannot dump their cash onto someone else's remittance.
--
-- The remittance-ownership EXISTS runs as the collector under RLS, so it only
-- sees their own remittances (043's "Collectors read own remittances") — a
-- second guarantee on top of the explicit collector_id check.
--
-- WHY NOT REVOKE UPDATE + a column grant to lock every OTHER column: admins
-- correct payments through the "Collection admins manage payments" FOR ALL policy
-- (070) using the same `authenticated` role via the browser client, so a
-- table-wide REVOKE would break that documented admin path. The residual — a
-- collector could edit amount on their own not-yet-remitted payment in the same
-- statement — is not a new trust boundary: the collector already self-reports
-- each amount at INSERT time. The invariants that matter (can't touch another
-- collector's cash, can't double-remit, can't un-remit) are all enforced above.
--
-- The delivery side mirrors this exactly in 087.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Collectors link own payments to remittance" ON collection_payments;
CREATE POLICY "Collectors link own payments to remittance" ON collection_payments
  FOR UPDATE TO authenticated
  USING (
    public.current_user_role() = 'collector'
    AND collector_id = public.current_profile_id()
    AND remittance_id IS NULL
  )
  WITH CHECK (
    public.current_user_role() = 'collector'
    AND collector_id = public.current_profile_id()
    AND remittance_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM remittances r
      WHERE r.id = remittance_id
        AND r.collector_id = public.current_profile_id()
    )
  );

-- Sync-down needs no new policy: 070's "Collectors read own payments" SELECT
-- already exposes the whole payment ledger (id, visit_id, amount, method, and now
-- remittance_id) to its owner, which is what mobile pulls to compute on-hand.

COMMENT ON COLUMN collection_payments.remittance_id IS
  'The remittance (043) that covered this cash hand-over, or NULL while it is still on hand. Per-payment remittance coverage (086): a payment is remitted exactly once; a remittance''s amount_remitted = SUM(amount) of the payments linking to it. Supersedes remittances.visit_ids as the source of truth for coverage. Collector-immutable once set. See REMITTANCE_CONTRACT.md.';
