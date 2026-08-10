-- ============================================================================
-- 085 — Notifications: fix the auth bug + wire every module's events
--
-- TWO problems this fixes:
--
-- 1. THE BELL NEVER SHOWED ANYTHING. 083 (and 047 before it) gated the SELECT
--    policy on `profiles.id = auth.uid()`. But in this schema auth.uid() is
--    `profiles.user_id`, not `profiles.id` (id is a random PK; see 001 and the
--    canonical helpers current_user_role()/current_profile_id(), which all
--    filter on user_id = auth.uid()). So the policy matched ZERO rows for every
--    admin and the feed was always empty, no matter what the triggers inserted.
--    notification_reads was mis-keyed the same way (FK to profiles.id, but the
--    client writes auth.uid()), so read-tracking silently failed too.
--
-- 2. COVERAGE. 083/084 only wired collection (remit, full/partial collect,
--    additional-ack). This adds the rest of what the admin side receives across
--    ALL modules: delivery (COD remit, delivered, failed, partial COD), sales
--    (meeting logged, tag-along request, close-deal PO approval), and a
--    collection "rescheduled" event.
--
-- Every new trigger function swallows its own errors (EXCEPTION WHEN OTHERS):
-- a notification is best-effort and must NEVER roll back the collector's /
-- driver's / agent's actual submission.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. FIX: scope-aware SELECT policy using the real helpers
--    admin_manages_module() already encodes "superadmin, or admin whose scope
--    is 'all' or this module". 'system' rows are visible to every admin.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS notifications_select_admin ON notifications;
CREATE POLICY notifications_select_admin ON notifications
  FOR SELECT
  USING (
    (public.current_user_role() IN ('admin', 'superadmin') AND notifications.module = 'system')
    OR public.admin_manages_module(notifications.module)
  );

-- ----------------------------------------------------------------------------
-- 2. FIX: re-key the per-admin read watermark on auth.uid() directly.
--    The old table (083) keyed on profiles.id and was never writable, so it is
--    empty — safe to drop and recreate.
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS notification_reads;
CREATE TABLE notification_reads (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_reads_own ON notification_reads;
CREATE POLICY notification_reads_own ON notification_reads
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE ON notification_reads TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. DELIVERY events (→ delivery admins). Mirrors collection.
-- ----------------------------------------------------------------------------

-- 3a. Driver remits COD to the office
CREATE OR REPLACE FUNCTION notify_cod_remittance()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_driver TEXT;
BEGIN
  SELECT full_name INTO v_driver FROM profiles WHERE id = NEW.driver_id;
  INSERT INTO notifications (type, title, message, module, entity_id)
  VALUES (
    'cod_remittance_submitted',
    'COD remittance submitted',
    COALESCE(v_driver, 'A driver') || ' remitted ' || notif_peso(NEW.amount_remitted)
      || ' in COD to the office.',
    'delivery',
    NEW.id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_cod_remittance ON cod_remittances;
CREATE TRIGGER trg_notify_cod_remittance
  AFTER INSERT ON cod_remittances
  FOR EACH ROW EXECUTE FUNCTION notify_cod_remittance();

-- 3b. Driver completes a delivery (pending -> delivered; also the final COD
--     top-up that closes a partial, via 073's rollup).
CREATE OR REPLACE FUNCTION notify_delivery_completed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company TEXT; v_driver TEXT;
BEGIN
  SELECT company_name INTO v_company FROM clients WHERE id = NEW.client_id;
  SELECT full_name INTO v_driver FROM profiles WHERE id = NEW.driver_id;
  INSERT INTO notifications (type, title, message, module, entity_id, client_id)
  VALUES (
    'delivery_completed',
    'Delivery completed',
    COALESCE(v_driver, 'A driver') || ' delivered PO ' || NEW.po_number
      || ' to ' || COALESCE(v_company, 'a customer') || '.',
    'delivery',
    NEW.id,
    NEW.client_id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_delivery_completed ON purchase_orders;
CREATE TRIGGER trg_notify_delivery_completed
  AFTER UPDATE ON purchase_orders
  FOR EACH ROW
  WHEN (NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered')
  EXECUTE FUNCTION notify_delivery_completed();

-- 3c. Delivery failed (the store didn't receive it)
CREATE OR REPLACE FUNCTION notify_delivery_failed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company TEXT; v_driver TEXT;
BEGIN
  SELECT company_name INTO v_company FROM clients WHERE id = NEW.client_id;
  SELECT full_name INTO v_driver FROM profiles WHERE id = NEW.driver_id;
  INSERT INTO notifications (type, title, message, module, entity_id, client_id)
  VALUES (
    'delivery_failed',
    'Delivery failed',
    'PO ' || NEW.po_number || ' to ' || COALESCE(v_company, 'a customer')
      || ' failed' || COALESCE(' (' || v_driver || ')', '') || '.',
    'delivery',
    NEW.id,
    NEW.client_id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_delivery_failed ON purchase_orders;
CREATE TRIGGER trg_notify_delivery_failed
  AFTER UPDATE ON purchase_orders
  FOR EACH ROW
  WHEN (NEW.status = 'failed' AND OLD.status IS DISTINCT FROM 'failed')
  EXECUTE FUNCTION notify_delivery_failed();

-- 3d. Partial COD payment (twin of 083's partial collection; only rings while a
--     balance REMAINS — a payment that closes the PO is the delivery_completed
--     event above).
CREATE OR REPLACE FUNCTION notify_partial_cod()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company TEXT; v_due NUMERIC; v_paid NUMERIC; v_balance NUMERIC;
BEGIN
  SELECT c.company_name, p.cod_due
    INTO v_company, v_due
    FROM purchase_orders p
    JOIN clients c ON c.id = p.client_id
   WHERE p.id = NEW.po_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
    FROM cod_payments WHERE po_id = NEW.po_id;

  v_balance := COALESCE(v_due, 0) - v_paid;
  IF v_balance <= 0 THEN RETURN NEW; END IF;

  INSERT INTO notifications (type, title, message, module, entity_id)
  VALUES (
    'partial_cod',
    'Partial COD payment',
    COALESCE(v_company, 'A customer') || ' paid ' || notif_peso(NEW.amount)
      || ' COD — ' || notif_peso(v_balance) || ' still owed.',
    'delivery',
    NEW.id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_partial_cod ON cod_payments;
CREATE TRIGGER trg_notify_partial_cod
  AFTER INSERT ON cod_payments
  FOR EACH ROW EXECUTE FUNCTION notify_partial_cod();

-- ----------------------------------------------------------------------------
-- 4. SALES events (→ sales admins).
-- ----------------------------------------------------------------------------

-- 4a. Agent logs a meeting
CREATE OR REPLACE FUNCTION notify_meeting_logged()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_agent TEXT; v_company TEXT;
BEGIN
  SELECT full_name INTO v_agent FROM profiles WHERE id = NEW.agent_id;
  SELECT company_name INTO v_company FROM clients WHERE id = NEW.client_id;
  INSERT INTO notifications (type, title, message, module, entity_id, client_id)
  VALUES (
    'meeting_logged',
    'Meeting logged',
    COALESCE(v_agent, 'An agent') || ' logged a ' || replace(NEW.outcome, '_', ' ')
      || ' meeting with ' || COALESCE(v_company, 'a client') || '.',
    'sales',
    NEW.id,
    NEW.client_id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_meeting_logged ON meetings;
CREATE TRIGGER trg_notify_meeting_logged
  AFTER INSERT ON meetings
  FOR EACH ROW EXECUTE FUNCTION notify_meeting_logged();

-- 4b. Tag-along request
CREATE OR REPLACE FUNCTION notify_tag_along()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_requester TEXT;
BEGIN
  IF NEW.status <> 'pending' THEN RETURN NEW; END IF;
  SELECT full_name INTO v_requester FROM profiles WHERE id = NEW.requester_id;
  INSERT INTO notifications (type, title, message, module, entity_id, client_id)
  VALUES (
    'tag_along_request',
    'Tag-along request',
    COALESCE(v_requester, 'An agent') || ' sent a tag-along request ('
      || replace(NEW.context, '_', ' ') || ').',
    'sales',
    NEW.id,
    NEW.related_client_id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_tag_along ON tag_along_requests;
CREATE TRIGGER trg_notify_tag_along
  AFTER INSERT ON tag_along_requests
  FOR EACH ROW EXECUTE FUNCTION notify_tag_along();

-- 4c. Close-deal PO confirmation awaiting approval
CREATE OR REPLACE FUNCTION notify_po_confirmation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_requester TEXT; v_company TEXT;
BEGIN
  IF NEW.status <> 'pending' THEN RETURN NEW; END IF;
  SELECT full_name INTO v_requester FROM profiles WHERE id = NEW.requester_id;
  SELECT company_name INTO v_company FROM clients WHERE id = NEW.client_id;
  INSERT INTO notifications (type, title, message, module, entity_id, client_id)
  VALUES (
    'po_confirmation_request',
    'PO confirmation awaiting approval',
    COALESCE(v_requester, 'An agent') || ' submitted a close-deal PO for '
      || COALESCE(v_company, 'a client') || ' awaiting approval.',
    'sales',
    NEW.id,
    NEW.client_id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_po_confirmation ON po_confirmation_requests;
CREATE TRIGGER trg_notify_po_confirmation
  AFTER INSERT ON po_confirmation_requests
  FOR EACH ROW EXECUTE FUNCTION notify_po_confirmation();

-- ----------------------------------------------------------------------------
-- 5. COLLECTION: rescheduled (the store wasn't collected today) — mirrors
--    delivery_failed. The other collection events shipped in 083/084.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_collection_rescheduled()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company TEXT; v_collector TEXT;
BEGIN
  SELECT company_name INTO v_company FROM clients WHERE id = NEW.client_id;
  SELECT full_name INTO v_collector FROM profiles WHERE id = NEW.collector_id;
  INSERT INTO notifications (type, title, message, module, entity_id, client_id)
  VALUES (
    'collection_rescheduled',
    'Collection rescheduled',
    COALESCE(v_collector, 'A collector') || ' rescheduled the collection for '
      || COALESCE(v_company, 'a store') || '.',
    'collection',
    NEW.id,
    NEW.client_id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_collection_rescheduled ON collection_visits;
CREATE TRIGGER trg_notify_collection_rescheduled
  AFTER UPDATE ON collection_visits
  FOR EACH ROW
  WHEN (NEW.status = 'rescheduled' AND OLD.status IS DISTINCT FROM 'rescheduled')
  EXECUTE FUNCTION notify_collection_rescheduled();

-- ----------------------------------------------------------------------------
-- 6. Make sure the read table is carried by realtime is NOT needed — only
--    notifications drives the live feed (083 added it to supabase_realtime).
-- ============================================================================
-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_notify_cod_remittance ON cod_remittances;
--   DROP TRIGGER IF EXISTS trg_notify_delivery_completed ON purchase_orders;
--   DROP TRIGGER IF EXISTS trg_notify_delivery_failed ON purchase_orders;
--   DROP TRIGGER IF EXISTS trg_notify_partial_cod ON cod_payments;
--   DROP TRIGGER IF EXISTS trg_notify_meeting_logged ON meetings;
--   DROP TRIGGER IF EXISTS trg_notify_tag_along ON tag_along_requests;
--   DROP TRIGGER IF EXISTS trg_notify_po_confirmation ON po_confirmation_requests;
--   DROP TRIGGER IF EXISTS trg_notify_collection_rescheduled ON collection_visits;
--   DROP FUNCTION IF EXISTS notify_cod_remittance, notify_delivery_completed,
--     notify_delivery_failed, notify_partial_cod, notify_meeting_logged,
--     notify_tag_along, notify_po_confirmation, notify_collection_rescheduled;
--   -- (SELECT policy + notification_reads keying stay fixed; do not revert.)
-- ============================================================================
