-- ============================================================================
-- 015 — Permanent sync audit log (T-014 Phase A, ADR-022 #11)
--
-- PROVENANCE: authored by Vince Carter (mobile lead) and applied directly to
-- the shared Supabase project via the SQL Editor on/around 2026-07-16 — note
-- that mobile's own Database.md still lists this one as "pending", but the
-- table was verified live on 2026-07-21 carrying 90 rows. Committed here
-- retroactively. SQL matches the vault's Migration-015-Report.md.
--
-- IDEMPOTENCY: `IF NOT EXISTS` guards and drop-before-create on policies were
-- added when committing (the original was a bare CREATE TABLE, which would
-- fail with 42P07 on the CI re-run).
--
-- WHY: the on-device Sync Center prunes synced outbox rows after 7 days. That
-- is fine for a device's working queue, but it would leave no record of
-- "did agent X's meeting from three weeks ago actually reach the server, and
-- if not, why". Admin (web) needs a complete, permanent, never-deleted history
-- across every user and device — a compliance/support record, not a queue.
--
-- Mobile enqueues one row per TERMINAL transition (synced/failed/conflict, plus
-- the conflict resolutions and the LWW-overwrite notice) through the same
-- offline-safe outbox as business writes, at a very low push priority (900) so
-- audit rows never compete with real business data. Individual retry attempts
-- and non-terminal states are deliberately NOT logged.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- the originating outbox row's own client-generated id. Paired with `outcome`
  -- in the unique constraint so one outbox row logs at most once per outcome
  -- (it may appear once as 'conflict' and later once as
  -- 'conflict_resolved_rename', but never twice for the same outcome). This is
  -- also what makes mobile's upsert (onConflict: 'device_op_id,outcome')
  -- idempotent.
  device_op_id uuid NOT NULL,

  -- the agent whose DEVICE performed the operation — not necessarily the
  -- record's owner, once Phase D's manager offline queue ships.
  user_id uuid NOT NULL REFERENCES profiles(id),

  -- stable per-install UUID from SecureStore, not a hardware identifier.
  device_id text NOT NULL,

  entity_table text NOT NULL,
  entity_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('insert', 'update', 'delete', 'upload')),
  outcome text NOT NULL CHECK (outcome IN (
    'synced',
    'failed',
    'conflict',
    'conflict_resolved_rename',
    'conflict_resolved_adopt_server',
    'lww_overwrite_applied'
  )),
  attempt_count int NOT NULL DEFAULT 1,

  -- populated for failed/conflict outcomes only. error_detail carries the sync
  -- engine's ClassifiedError shape { message, kind }, where kind is 'transient'
  -- or 'permanent'. A 'transient' error that reached `failed` exhausted
  -- MAX_OUTBOX_ATTEMPTS; 'permanent' means an immediate, non-retried failure.
  error_code text,
  error_detail jsonb,

  -- the device's own clock at the transition. May lag recorded_at by however
  -- long the row sat in the outbox before it could push.
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (device_op_id, outcome)
);

CREATE INDEX IF NOT EXISTS idx_sync_audit_log_user_id ON sync_audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_sync_audit_log_entity ON sync_audit_log (entity_table, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_audit_log_occurred_at ON sync_audit_log (occurred_at);

ALTER TABLE sync_audit_log ENABLE ROW LEVEL SECURITY;

-- Any authenticated user may insert their OWN audit rows, mirroring how
-- clients/meetings outbox rows are written by their own agent.
-- NOTE: this policy is REPLACED by migration 016 — as originally written it
-- compared `user_id` (a profiles.id-typed column) against auth.uid() directly,
-- which is the B-015 identity bug. Kept here as-authored so the history is
-- faithful; 016 immediately corrects it.
DROP POLICY IF EXISTS sync_audit_log_insert_own ON sync_audit_log;
CREATE POLICY sync_audit_log_insert_own ON sync_audit_log
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Only admin/superadmin may read — this is a permanent compliance/support
-- record, not a per-agent self-service view.
DROP POLICY IF EXISTS sync_audit_log_select_admin ON sync_audit_log;
CREATE POLICY sync_audit_log_select_admin ON sync_audit_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'superadmin')
    )
  );

-- No UPDATE/DELETE policy for ANY role — immutable by design. Deliberate
-- (Vince, 2026-07-16): the point of this table is a permanent history that
-- nothing (future migrations, admin UI bugs, a well-meaning cleanup job) can
-- silently rewrite or prune.


-- ============================================================================
-- ROLLBACK
--   DROP TABLE IF EXISTS sync_audit_log;
--
-- Purely additive — an audit trail alongside the sync mechanism, never a
-- dependency of it. Rolling back never breaks clients/meetings sync; it only
-- means queued audit rows fail permanently until re-applied, which is a
-- cosmetic loss of history rather than a functional break.
-- ============================================================================
