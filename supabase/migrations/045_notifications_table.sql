-- ============================================================================
-- 045 — Admin notifications (prospect auto-delete alert)
--
-- WHY: app/api/cron/prospect-cleanup soft-deletes (status='deleted') a
-- prospect once its 1-month details deadline passes with nothing filled in.
-- That happens with nobody watching, so admins need a way to find out which
-- companies disappeared and why — this table backs the bell-icon dropdown in
-- the header (see lib/hooks/use-notifications.ts).
--
-- Written exclusively by the service-role client from server-side cron
-- routes, which bypasses RLS — there is deliberately no INSERT policy for any
-- authenticated role. Read/mark-as-read is admin-only, mirroring
-- sync_audit_log's admin-only SELECT (015).
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- e.g. 'prospect_auto_deleted' — free-form on purpose so future cron/system
  -- events (the other two rows on the sheet: lost-opportunity sweep, new→
  -- existing promotion) can reuse this table instead of growing a new one each.
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,

  -- Nullable + ON DELETE SET NULL: the notification is a historical record and
  -- must survive even if the referenced client row is ever hard-deleted later.
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,

  -- Global read state, not per-admin — "an admin has seen this" is enough;
  -- there's no requirement here for each admin to track their own read state.
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_select_admin ON notifications;
CREATE POLICY notifications_select_admin ON notifications
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'superadmin')
    )
  );

-- Lets an admin mark rows read from the client (only read_at should ever
-- change; there is no column-level enforcement of that here, matching how
-- other admin-writable tables in this app are policed at the app layer).
DROP POLICY IF EXISTS notifications_update_admin ON notifications;
CREATE POLICY notifications_update_admin ON notifications
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'superadmin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'superadmin')
    )
  );

-- No INSERT policy for any authenticated role — only the service-role cron
-- routes write here. No DELETE policy — notifications are a permanent history,
-- same stance as sync_audit_log (015).


-- ============================================================================
-- ROLLBACK
--   DROP TABLE IF EXISTS notifications;
--
-- Purely additive. Rolling back only removes the admin alert feed; the
-- prospect-cleanup cron's soft-delete keeps working (the notification insert
-- in app/api/cron/prospect-cleanup/route.ts is best-effort and already
-- tolerates failure without blocking the delete).
-- ============================================================================
