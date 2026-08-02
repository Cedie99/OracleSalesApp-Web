-- ============================================================================
-- 061 — Collection: the 'delivery_receipt' payment method + customer signature
--
-- Both changes answer mobile commit 3180b7b (2026-08-01, PR #27). Mobile shipped
-- the UI first and flagged the two database dependencies in its own source:
--
--   * types/database.ts:75 — "'delivery_receipt' requires the web DB
--     `payment_method` CHECK constraint to be widened to accept it — otherwise
--     the outbox push is rejected."
--   * lib/collection-delivery-write.ts:78 — the customer signature is captured
--     to JPEG on every payment method but deliberately NOT persisted, because
--     `collection_visits` has no column to put it in.
--
-- Web owns migrations (COLLECTION_DELIVERY_FOR_MOBILE.md §8), so both land here.
-- Purely additive: one widened CHECK, one new nullable column. Nothing existing
-- is dropped or narrowed, and no deployed row can violate either.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 'delivery_receipt' joins the payment methods
--
-- The store's balance is settled by the delivery receipt itself — no cash
-- changes hands at the visit, so the collector enters no amount and takes no
-- separate receipt photo. The one payment photo IS the delivery receipt.
--
-- This is the same shape of change as the 2026-07-26 one that turned Counter
-- from a third proof capture into a payment method: a new way of settling, not
-- a new column. Note that 044's `cod_method` is deliberately NOT widened —
-- a COD hand-over on a delivery is always cash/check/gcash, and settling by
-- delivery receipt has no meaning on the truck.
-- ----------------------------------------------------------------------------

-- Named explicitly on the way back in. 043 declared this inline, so it carries
-- Postgres' generated name; re-adding it named makes the next widening a
-- one-liner instead of a guess.
ALTER TABLE collection_visits DROP CONSTRAINT IF EXISTS collection_visits_payment_method_check;
ALTER TABLE collection_visits DROP CONSTRAINT IF EXISTS collection_visits_payment_method_valid;
ALTER TABLE collection_visits ADD CONSTRAINT collection_visits_payment_method_valid CHECK (
  payment_method IS NULL
  OR payment_method IN ('cash', 'check', 'gcash', 'counter', 'delivery_receipt')
);

COMMENT ON COLUMN collection_visits.payment_method IS
  'How the store settled. cash/check/gcash take an amount and two photos; counter and delivery_receipt take the payment photo only. delivery_receipt means the delivery receipt itself settles the balance — no cash at the visit (2026-08-01).';

-- ⚠️ `collection_visits_collected_complete` (043) is deliberately NOT relaxed,
-- even though counter and delivery_receipt collect no cash. It requires
-- amount_collected IS NOT NULL, and mobile sends 0 for those methods
-- (app/(collection)/visit.tsx: `amount: showAmount ? amountValue : 0`), which
-- satisfies both that check and `amount_collected >= 0`. Zero is the honest
-- value here — the store was worked and nothing was handed over — whereas NULL
-- would be indistinguishable from a row that never recorded one. Web sums it
-- harmlessly. Do not "fix" this into a nullable case.

-- ----------------------------------------------------------------------------
-- 2. The customer's acknowledgment signature
--
-- Mobile now requires a signature on EVERY payment method before it will accept
-- "✓ Collected" — including counter and delivery_receipt, where it is the only
-- thing tying the settlement to the customer rather than to the collector's word.
--
-- Named customer_signature_url, not the bare `signature_url` mobile's comment
-- guesses at, to match 044's `receiver_signature_url` on purchase_orders and to
-- say WHOSE signature it is. Mobile's call site is still unwritten (the comment
-- calls it "a one-line queuePhoto once ready"), so the rename costs one string.
--
-- NULLABLE, like the two photo columns above it, and for the same two reasons
-- 043 spelled out: the business row rides the outbox while images ride a
-- separate upload lane, so a collected visit legitimately exists with a NULL
-- URL for a while; and a row that closed out without a required capture is a
-- hole web must SHOW the admin, not reject at the door.
-- ----------------------------------------------------------------------------

ALTER TABLE collection_visits ADD COLUMN IF NOT EXISTS customer_signature_url TEXT;

COMMENT ON COLUMN collection_visits.customer_signature_url IS
  'Customer''s acknowledgment signature, drawn on the collector''s phone and uploaded as JPEG. Required by mobile on every payment method (2026-08-01). Nullable because it arrives on the deferred upload lane after the row, and because a missing capture is a hole to show rather than reject.';

-- No storage work needed: the `collection-proofs` bucket (043) already exists,
-- and its INSERT policy checks only `bucket_id`, with no path prefix — so
-- collection-proofs/{visit_id}/signature.jpg is already writable by collectors.
-- Every row published before this migration keeps a NULL signature, which is
-- correct: those visits were closed out before the rule existed.
