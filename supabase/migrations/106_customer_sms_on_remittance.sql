-- ============================================================================
-- 106 — Customer acknowledgement SMS on remittance
--
-- WHY: when a collector/driver REMITS the cash they took from a store, the
-- company wants to text that store an acknowledgement — "we received your
-- payment of PHP X; remaining balance PHP Y" — so the customer has proof the
-- money reached us, not just the field agent. The trigger is REMITTANCE, not the
-- field handover: a payment becomes eligible the moment it is linked to a
-- remittance (086 `collection_payments.remittance_id`, 087
-- `cod_payments.cod_remittance_id`).
--
-- HOW: a web-side Vercel Cron (app/api/cron/remittance-sms) polls for payments
-- that are remitted (link IS NOT NULL) but not yet acknowledged, sends one SMS
-- per store through BusyBee (the keys are server-only, in the web app), and
-- stamps the rows so they are never texted twice. This migration is only the
-- stamp + the index the poll reads; the send logic lives in the route. BusyBee
-- cannot be called from the DB, which is why this is a poll and not a trigger.
--
-- WHY A PER-PAYMENT STAMP (not per-visit/PO): coverage is per-payment (086/087)
-- — a store can pay in installments remitted across different hand-overs. Each
-- payment is acknowledged exactly once, keyed off the same row that carries the
-- remittance link, so a later top-up gets its own ack when ITS remittance lands.
-- The route groups a batch's payments by store so a store with two payments in
-- one remittance still gets a single text.
--
-- Purely additive: one nullable timestamp column + one partial index per table.
-- Nothing existing is dropped or narrowed.
--
-- Depends on 086 (collection_payments.remittance_id), 087
-- (cod_payments.cod_remittance_id).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Collection — the stamp + the poll index
--
-- NULL = remitted payment still awaiting its customer ack (or not yet remitted).
-- Set to NOW() by the route once the store has been texted. Never cleared: a
-- sent SMS is a fact, and re-sending would double-text the customer.
-- ----------------------------------------------------------------------------
ALTER TABLE collection_payments
  ADD COLUMN IF NOT EXISTS customer_sms_sent_at TIMESTAMPTZ NULL;

-- The exact question the cron runs every pass: "remitted payments not yet
-- acknowledged." Partial index — sent rows are dead weight for this query and
-- the table only grows. Keyed on remittance_id so the route can also group the
-- batch by its covering hand-over if needed.
CREATE INDEX IF NOT EXISTS idx_collection_payments_pending_customer_sms
  ON collection_payments (remittance_id)
  WHERE remittance_id IS NOT NULL AND customer_sms_sent_at IS NULL;

COMMENT ON COLUMN collection_payments.customer_sms_sent_at IS
  'When the customer acknowledgement SMS for this remitted payment was sent (106). NULL while a remitted payment still awaits its ack, or while the payment is still on hand (remittance_id NULL). Set once by app/api/cron/remittance-sms; never cleared.';


-- ----------------------------------------------------------------------------
-- 2. Delivery (COD) — the twin
--
-- Same column, keyed off the COD remittance link (087) instead.
-- ----------------------------------------------------------------------------
ALTER TABLE cod_payments
  ADD COLUMN IF NOT EXISTS customer_sms_sent_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_cod_payments_pending_customer_sms
  ON cod_payments (cod_remittance_id)
  WHERE cod_remittance_id IS NOT NULL AND customer_sms_sent_at IS NULL;

COMMENT ON COLUMN cod_payments.customer_sms_sent_at IS
  'When the customer acknowledgement SMS for this remitted COD payment was sent (106). NULL while a remitted COD payment still awaits its ack, or while it is still on hand (cod_remittance_id NULL). Set once by app/api/cron/remittance-sms; never cleared.';


-- ============================================================================
-- ROLLBACK
--   DROP INDEX IF EXISTS idx_collection_payments_pending_customer_sms;
--   DROP INDEX IF EXISTS idx_cod_payments_pending_customer_sms;
--   ALTER TABLE collection_payments DROP COLUMN IF EXISTS customer_sms_sent_at;
--   ALTER TABLE cod_payments DROP COLUMN IF EXISTS customer_sms_sent_at;
-- ============================================================================
