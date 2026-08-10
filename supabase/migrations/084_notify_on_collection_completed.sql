-- ============================================================================
-- 084 — Notify when a collector completes a collection
--
-- WHY: 083 wired notifications for remittances, PARTIAL payments, and the
-- "additional store opened" ack — but missed the most common event of all: a
-- collector actually collecting from a store. That is not an INSERT anywhere;
-- per 043's RLS a collector works the list by UPDATing collection_visits
-- (claims the row, then sets status='collected' + amount_collected). 083 had no
-- trigger on that transition, so an ordinary collection rang no bell.
--
-- This fires when a visit's status BECOMES 'collected', which covers both
-- paths that reach it:
--   * mobile's direct UPDATE for a normal one-shot collection (pending->collected)
--   * 070's payment rollup closing a balance (pending/partial -> collected)
--
-- No double-notify: the first partial installment moves the visit to 'partial'
-- (not 'collected'), so it stays with 083's notify_partial_payment; the final
-- installment moves it to 'collected' and rings here exactly once. `IS DISTINCT
-- FROM` guards against an idempotent re-write of an already-collected row.
-- ============================================================================

CREATE OR REPLACE FUNCTION notify_collection_completed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company TEXT; v_collector TEXT;
BEGIN
  SELECT company_name INTO v_company FROM clients WHERE id = NEW.client_id;
  SELECT full_name INTO v_collector FROM profiles WHERE id = NEW.collector_id;
  INSERT INTO notifications (type, title, message, module, entity_id, client_id)
  VALUES (
    'collection_completed',
    'Collection submitted',
    COALESCE(v_collector, 'A collector') || ' collected '
      || notif_peso(COALESCE(NEW.amount_collected, 0))
      || ' from ' || COALESCE(v_company, 'a store') || '.',
    'collection',
    NEW.id,
    NEW.client_id
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_collection_completed ON collection_visits;
CREATE TRIGGER trg_notify_collection_completed
  AFTER UPDATE ON collection_visits
  FOR EACH ROW
  WHEN (NEW.status = 'collected' AND OLD.status IS DISTINCT FROM 'collected')
  EXECUTE FUNCTION notify_collection_completed();

-- ============================================================================
-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_notify_collection_completed ON collection_visits;
--   DROP FUNCTION IF EXISTS notify_collection_completed();
--
-- Additive; reuses notif_peso() and the notifications table from 083.
-- ============================================================================
