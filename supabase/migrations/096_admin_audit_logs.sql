-- ============================================================================
-- 096 — Admin activity log (web)
--
-- WHY: nothing on the web side records who did what. An admin can edit a
-- client, approve an edit request, publish a collection or delivery list,
-- release someone's claim, reconcile a remittance, or create/deactivate a user,
-- and the only trace left is the mutated row itself — which carries no actor on
-- most tables, and on the ones that do (`listed_by`, `reviewed_by`) is
-- overwritten by the next edit. There is no way to answer "who moved this
-- client to lost, and when, and what was it before".
--
-- NOT the same thing as `sync_audit_log` (015). That table is the MOBILE sync
-- engine's delivery record — did agent X's offline write reach the server. This
-- one is the web admin's action history. Different actors, different questions,
-- deliberately separate tables.
--
-- WRITE PATH: rows are written by the `recordAuditLog` server action
-- (lib/audit/actions.ts) on the service-role key, never from the browser. The
-- actor is resolved server-side from the session cookie, so a client cannot
-- forge who an entry belongs to — that is the whole point of the table, and the
-- reason there is no INSERT policy below for any role.
--
-- WHY APPLICATION-LEVEL AND NOT TRIGGERS: a trigger sees `UPDATE clients SET
-- status='lost'`. It cannot distinguish an admin declaring a lost opportunity
-- from the nightly sweep (api/cron/lost-opportunity-sweep) doing it, and it has
-- no idea that an `client_edit_requests` UPDATE means "approved". The log is
-- read by humans looking for intent, so intent is what gets recorded. The cost
-- is that a new web write path has to remember to log; the read hook and the
-- action catalog in lib/audit/entries.ts are where you notice one is missing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHO. The FK is safe: profiles are never hard-deleted (see 095 — archiving
  -- is a listing concept, the row stays), so this never dangles.
  actor_profile_id UUID NOT NULL REFERENCES profiles(id),

  -- ...and a snapshot of how they looked at the time. Denormalized on purpose:
  -- a rename, a role change, or a scope change must not silently rewrite last
  -- quarter's history. The join to `profiles` is for the avatar and the current
  -- name; these three columns are what the entry actually *meant*.
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  actor_scope TEXT,

  -- WHAT. `<entity>.<verb>` — 'client.updated', 'remittance.status_changed'.
  -- Free text rather than a CHECK constraint: the catalog lives in
  -- lib/audit/entries.ts, and adding a web action should not need a migration
  -- coordinated with the mobile repo. Unknown values render as a humanised
  -- fallback, the same way roleLabel() handles an unknown role.
  action TEXT NOT NULL,

  -- Which business function the entry belongs to. Same four values as
  -- notifications.module (083) so the two feeds can be filtered alike;
  -- 'system' covers user administration and quota/cutoff settings, which are
  -- not any one module's.
  module TEXT NOT NULL DEFAULT 'system'
    CHECK (module IN ('sales', 'collection', 'delivery', 'system')),

  -- WHAT IT WAS DONE TO. `entity_id` deliberately has NO foreign key: it points
  -- at a different table per action, and — the load-bearing half — the log must
  -- outlive the row. Deleting a collection visit is itself a logged action, and
  -- a FK would either cascade that entry away or block the delete outright.
  entity_table TEXT,
  entity_id UUID,

  -- How the target should read in the log: a company name, a PO number, a
  -- user's name. Snapshotted for the same reason as actor_name, and it is the
  -- only thing left to show once the target row is gone.
  entity_label TEXT,

  -- One human-readable sentence, composed at write time. The log is a reading
  -- surface first; `changes` is the detail underneath it.
  summary TEXT NOT NULL,

  -- Field-level before/after, as
  --   [{ "field": "status", "label": "Status", "from": "active", "to": "lost" }]
  -- `label` is stored rather than looked up at render time so an entry keeps
  -- reading correctly after the UI renames a field. Empty array for actions
  -- with nothing to diff (a delete, a claim release).
  changes JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Anything action-specific that is not a field diff — the SMS fan-out result
  -- on an additional store, the reason a sweep skipped a row.
  metadata JSONB,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The page's default view is "everything, newest first", then narrowed by
-- actor / action / module. This index serves the default and the module filter;
-- the actor and action filters are selective enough on their own.
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_occurred_at
  ON admin_audit_logs (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_module_occurred_at
  ON admin_audit_logs (module, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor
  ON admin_audit_logs (actor_profile_id, occurred_at DESC);
-- "show me everything that ever happened to THIS client" — the entity timeline.
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_entity
  ON admin_audit_logs (entity_table, entity_id);

ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;

-- READ: superadmin and the unrestricted admin only.
--
-- Deliberately NOT admin_manages_module() — that would let a Collection Admin
-- read collection entries, which sounds reasonable until you notice it also
-- lets them watch every other Collection Admin. Account administration is
-- already gated this way ('/users' and '/settings' are absent from every
-- narrowed SCOPE_ROUTES entry in lib/permissions.ts); the activity log is the
-- same kind of surface and gets the same gate.
DROP POLICY IF EXISTS admin_audit_logs_select_admin ON admin_audit_logs;
CREATE POLICY admin_audit_logs_select_admin ON admin_audit_logs
  FOR SELECT
  USING (
    public.current_user_role() = 'superadmin'
    OR (
      public.current_user_role() = 'admin'
      AND public.current_admin_scope() = 'all'
    )
  );

-- No INSERT / UPDATE / DELETE policy for ANY role, including the superadmin who
-- can read it. Writes arrive on the service-role key, which bypasses RLS;
-- everything else — the browser, the mobile app, a leaked anon key — can only
-- read. A log an admin can edit is not a log, and the people most motivated to
-- rewrite an entry are exactly the ones with an account here.
--
-- Same reasoning as 015's sync_audit_log, and the same consequence: rows are
-- never pruned from the app. If retention ever becomes a real problem, it gets
-- a deliberate migration, not a delete button.

GRANT SELECT ON admin_audit_logs TO authenticated;

COMMENT ON TABLE admin_audit_logs IS
  'Who did what on the web admin. Written service-role only by lib/audit/actions.ts; read by superadmin and unrestricted admins. Immutable — no write policies by design.';


-- ============================================================================
-- ROLLBACK
--   DROP TABLE IF EXISTS admin_audit_logs;
--
-- Purely additive. Nothing reads this table to make a decision — it is a record
-- alongside the writes, never a dependency of them, and every logging call site
-- swallows its own failure. Dropping it loses history; it breaks no flow.
-- ============================================================================
