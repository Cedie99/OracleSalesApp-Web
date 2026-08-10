-- ============================================================================
-- 083 — Notification feed: real events, module segregation, per-admin read
--
-- WHY: 047 built the notifications table + bell for ONE cron event (prospect
-- auto-delete). This turns the bell into a live feed for events that actually
-- happen in the field — a collector remitting, an agent requesting an edit, a
-- store paying down a partial balance, a collector acknowledging an urgent
-- "additional" store.
--
-- KEY FACT that shapes the whole design: those events are born in the MOBILE
-- app, which writes straight to these tables. The web server runs no code when
-- they happen, so there is no server-action seam to hook. The only place both
-- repos meet is the database, so the notification rows are created by AFTER
-- INSERT/UPDATE triggers here — SECURITY DEFINER so they can write to
-- notifications, which (by 047's design) has no INSERT policy for anyone.
--
-- SEGREGATION: every notification carries a `module` (sales | collection |
-- delivery | system). A scoped admin (migration 024's admin_scope) sees only
-- their module plus system-wide alerts; an unrestricted admin / superadmin sees
-- everything. Enforced in the SELECT policy so it holds for realtime too.
--
-- READ STATE: moved off the global notifications.read_at (047's "any admin
-- opening it clears it for everyone") onto a per-admin notification_reads row —
-- a single seen_at watermark per admin. Chosen over a column on profiles
-- because 012 locked profiles to column-level GRANT UPDATE (avatar_url,
-- full_name) and this keeps that surface untouched.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. notifications: module segregation + a generic link to the source row
-- ----------------------------------------------------------------------------
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS module TEXT NOT NULL DEFAULT 'system'
    CHECK (module IN ('sales', 'collection', 'delivery', 'system'));

-- Points at whatever row spawned the notification (a remittance, an edit
-- request, a payment, a visit). Deliberately no FK: it references different
-- tables per `type`, and the notification must outlive the source row anyway.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS entity_id UUID;

CREATE INDEX IF NOT EXISTS idx_notifications_module_created_at
  ON notifications (module, created_at DESC);

-- ----------------------------------------------------------------------------
-- 2. Scope-aware read policy (replaces 047's flat admin-only SELECT)
--
-- superadmin / unrestricted admin: everything.
-- scoped admin: their own module + 'system' (system alerts are everyone's).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS notifications_select_admin ON notifications;
CREATE POLICY notifications_select_admin ON notifications
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND (
          p.role = 'superadmin'
          OR (
            p.role = 'admin'
            AND (
              p.admin_scope = 'all'
              OR notifications.module = 'system'
              OR notifications.module = p.admin_scope
            )
          )
        )
    )
  );

-- ----------------------------------------------------------------------------
-- 3. Per-admin read watermark
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_reads (
  -- profiles.id IS the auth user id (see 047's policy), so this is auth.uid().
  profile_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  -- Everything created at or before this instant is "seen" by this admin.
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_reads_own ON notification_reads;
CREATE POLICY notification_reads_own ON notification_reads
  FOR ALL
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- Unlike notifications (write-only via triggers), admins own their watermark.
GRANT SELECT, INSERT, UPDATE ON notification_reads TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Event triggers — all SECURITY DEFINER so they may INSERT into
--    notifications despite the table having no INSERT policy.
-- ----------------------------------------------------------------------------

-- Peso amount, e.g. 1234.5 -> '₱1,234.50'.
CREATE OR REPLACE FUNCTION notif_peso(amount NUMERIC)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT '₱' || to_char(COALESCE(amount, 0), 'FM999,999,999,990.00');
$$;

-- 4a. Collector remits ------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_remittance_submitted()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_collector TEXT;
BEGIN
  SELECT full_name INTO v_collector FROM profiles WHERE id = NEW.collector_id;
  INSERT INTO notifications (type, title, message, module, entity_id)
  VALUES (
    'remittance_submitted',
    'Remittance submitted',
    COALESCE(v_collector, 'A collector') || ' remitted ' || notif_peso(NEW.amount_remitted)
      || ' to ' || replace(NEW.destination, '_', ' ') || '.',
    'collection',
    NEW.id
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_remittance ON remittances;
CREATE TRIGGER trg_notify_remittance
  AFTER INSERT ON remittances
  FOR EACH ROW EXECUTE FUNCTION notify_remittance_submitted();

-- 4b. Agent requests an edit approval --------------------------------------
CREATE OR REPLACE FUNCTION notify_edit_request()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_requester TEXT; v_company TEXT;
BEGIN
  -- Only a genuinely pending request is an admin's to-do. Rows that arrive
  -- already resolved (or later flip status) shouldn't ring the bell.
  IF NEW.status <> 'pending' THEN RETURN NEW; END IF;

  SELECT full_name INTO v_requester FROM profiles WHERE id = NEW.requested_by;
  SELECT company_name INTO v_company FROM clients WHERE id = NEW.client_id;
  INSERT INTO notifications (type, title, message, module, entity_id, client_id)
  VALUES (
    'edit_request_submitted',
    'Edit request awaiting approval',
    COALESCE(v_requester, 'An agent') || ' requested changes to '
      || COALESCE(v_company, 'a client') || '.',
    'sales',
    NEW.id,
    NEW.client_id
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_edit_request ON client_edit_requests;
CREATE TRIGGER trg_notify_edit_request
  AFTER INSERT ON client_edit_requests
  FOR EACH ROW EXECUTE FUNCTION notify_edit_request();

-- 4c. Store pays down a partial balance ------------------------------------
-- Fires per installment. Only rings when a balance REMAINS (still partial) —
-- a payment that closes the visit in full is a normal collection, not an
-- exception worth a notification. Balance is recomputed from the payments so
-- it never depends on 070's recalc trigger having run first.
CREATE OR REPLACE FUNCTION notify_partial_payment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company TEXT; v_due NUMERIC; v_paid NUMERIC; v_balance NUMERIC;
BEGIN
  SELECT c.company_name, v.amount_due
    INTO v_company, v_due
    FROM collection_visits v
    JOIN clients c ON c.id = v.client_id
   WHERE v.id = NEW.visit_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
    FROM collection_payments WHERE visit_id = NEW.visit_id;

  v_balance := v_due - v_paid;
  IF v_balance <= 0 THEN RETURN NEW; END IF;  -- paid in full: not a partial

  INSERT INTO notifications (type, title, message, module, entity_id)
  VALUES (
    'partial_payment',
    'Partial payment',
    COALESCE(v_company, 'A store') || ' paid ' || notif_peso(NEW.amount)
      || ' — ' || notif_peso(v_balance) || ' still owed.',
    'collection',
    NEW.id
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_partial_payment ON collection_payments;
CREATE TRIGGER trg_notify_partial_payment
  AFTER INSERT ON collection_payments
  FOR EACH ROW EXECUTE FUNCTION notify_partial_payment();

-- 4d. Collector acknowledges an "additional" (urgent) store ----------------
-- The additional flow (068/069): admin adds an urgent store after the list is
-- out; the collector's phone stamps additional_seen_at when they open it. That
-- null->set transition is the "they know about it" signal the admin is waiting
-- on. WHEN keeps the trigger off every unrelated visit update.
CREATE OR REPLACE FUNCTION notify_additional_seen()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company TEXT; v_collector TEXT;
BEGIN
  SELECT company_name INTO v_company FROM clients WHERE id = NEW.client_id;
  SELECT full_name INTO v_collector FROM profiles WHERE id = NEW.collector_id;
  INSERT INTO notifications (type, title, message, module, entity_id, client_id)
  VALUES (
    'additional_seen',
    'Additional store acknowledged',
    COALESCE(v_collector, 'The collector') || ' opened the additional store '
      || COALESCE(v_company, '') || '.',
    'collection',
    NEW.id,
    NEW.client_id
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_additional_seen ON collection_visits;
CREATE TRIGGER trg_notify_additional_seen
  AFTER UPDATE ON collection_visits
  FOR EACH ROW
  WHEN (OLD.additional_seen_at IS NULL AND NEW.additional_seen_at IS NOT NULL)
  EXECUTE FUNCTION notify_additional_seen();

-- ----------------------------------------------------------------------------
-- 5. Realtime — let the bell update live instead of only on page load.
--    Tolerant of a local DB where the publication doesn't exist, and of the
--    table already being a member on re-run.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
EXCEPTION
  WHEN duplicate_object THEN NULL;   -- already a member
  WHEN undefined_object THEN NULL;   -- no supabase_realtime publication here
END $$;

-- ============================================================================
-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_notify_remittance ON remittances;
--   DROP TRIGGER IF EXISTS trg_notify_edit_request ON client_edit_requests;
--   DROP TRIGGER IF EXISTS trg_notify_partial_payment ON collection_payments;
--   DROP TRIGGER IF EXISTS trg_notify_additional_seen ON collection_visits;
--   DROP FUNCTION IF EXISTS notify_remittance_submitted();
--   DROP FUNCTION IF EXISTS notify_edit_request();
--   DROP FUNCTION IF EXISTS notify_partial_payment();
--   DROP FUNCTION IF EXISTS notify_additional_seen();
--   DROP FUNCTION IF EXISTS notif_peso(NUMERIC);
--   DROP TABLE IF EXISTS notification_reads;
--   ALTER TABLE notifications DROP COLUMN IF EXISTS module;
--   ALTER TABLE notifications DROP COLUMN IF EXISTS entity_id;
--   -- (restore 047's flat notifications_select_admin if you need the old policy)
--
-- Additive. Rolling back stops new event notifications and reverts read state
-- to global; the prospect-cleanup cron and all mobile writes keep working.
-- ============================================================================
