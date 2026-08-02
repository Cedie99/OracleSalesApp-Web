-- ============================================================================
-- 043 — Collection module (F-007): collection_visits + remittances
--
-- ⚠️ NUMBERING: this is 043, not 025, and the gap is not a mistake.
-- Migration numbers 025-042 are ALREADY CLAIMED by the mobile side and tracked
-- in the vault (projects/OracleSalesApp-Mobile/Migration-0NN-Report.md), even
-- though web's supabase/migrations/ folder jumps straight from 024 to here.
-- 025/026/027 and 033/034 are applied LIVE; 035-040 and 042 are spec'd and
-- pending; 041 is reserved. Web still owes three backfill files for 025-027 —
-- see the vault's Web-Migration-Backfill-Action-2026-07-26.md.
--
-- This exact gap has already caused one production incident: web's
-- 023_add_delivery_role.sql rewrote profiles_role_check without knowing the
-- mobile side had added a value, silently dropping it and breaking a live
-- account. Do not renumber this file down into the gap to "tidy up".
--
-- First real tables for Collection. Until now both repos ran on mock data
-- (web lib/mock/data.ts, mobile lib/collection-delivery-data.ts), which meant
-- nobody could insert a test record and mobile had nothing to develop against.
-- Shapes match web types/index.ts `CollectionVisit` / `Remittance` exactly; the
-- cross-repo contract and mobile's required changes are in
-- COLLECTION_DELIVERY_FOR_MOBILE.md.
--
-- THE MODEL, because the column names alone don't convey it: the admin
-- publishes ONE LIST PER DAY — every store and what it owes — and collectors on
-- mobile work that shared list down. No store is assigned to a collector up
-- front. Whoever gets there collects it, and their name lands on the row at
-- that moment. That is why `collector_id` is nullable and why the collector
-- RLS policy below lets any collector claim any unclaimed store.
--
-- ⚠️ Merging this to main triggers .github/workflows/deploy-migrations.yml,
-- which runs `supabase db push` against the shared project the mobile app also
-- uses. This is purely additive — two new tables, one new bucket, two new
-- SECURITY DEFINER helpers, and nothing existing altered (see the guard on
-- current_profile_id below, which is the one place that could have) — but tell
-- the mobile team before merging so the tables aren't a surprise.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Identity helpers
--
-- These resolve the caller through SECURITY DEFINER for the reason 011 documents
-- at length: a policy ON a table whose USING clause SELECTs FROM profiles is
-- fine, but anything that re-enters the SAME table recurses (42P17). More
-- practically, they keep every policy below a single function call instead of a
-- repeated subquery, so the identity rule lives in one place.
--
-- One of the three already exists live and two are new, which is why they are
-- created differently — read the note on each rather than assuming symmetry.
-- ----------------------------------------------------------------------------
-- ⚠️ CREATED ONLY IF ABSENT, never CREATE OR REPLACE.
--
-- `current_profile_id()` ALREADY EXISTS on the shared Supabase project — it was
-- added by the mobile side outside web's migration history (it appears in
-- Migration-034-Report as the identity helper that migration got wrong), and
-- live RLS policies we do not own already call it. A CREATE OR REPLACE here
-- would silently redefine a function other people's policies depend on, and the
-- damage would show up as mysterious permission behaviour elsewhere in the app
-- rather than as an error in this migration.
--
-- The body below is the canonical definition and exists so a rebuild from this
-- repo alone still works. Where the function is already present, whatever is
-- live wins.
--
-- Note `profiles.user_id = auth.uid()`, NOT `profiles.id = auth.uid()` — that
-- confusion is bug B-015 and migration 016 exists to fix instances of it.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'current_profile_id'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION public.current_profile_id()
      RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = public
      AS 'SELECT id FROM profiles WHERE user_id = auth.uid()'
    $fn$;
  END IF;
END
$do$;

-- Migration 024 added profiles.admin_scope and deliberately enforced it in
-- navigation only, noting: "Real enforcement belongs with the backend wiring
-- for Collection and Delivery, whose tables do not exist yet." They exist now,
-- so the policies below are that enforcement — a Delivery Admin cannot read
-- collection rows through the API, not merely be steered away from the page.
CREATE OR REPLACE FUNCTION public.current_admin_scope()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(admin_scope, 'all') FROM profiles WHERE user_id = auth.uid()
$$;

-- True when the caller administers `p_module` ('collection' | 'delivery' |
-- 'sales'). superadmin is unrestricted by definition; a plain admin is narrowed
-- by admin_scope, where 'all' means every module.
CREATE OR REPLACE FUNCTION public.admin_manages_module(p_module text)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT public.current_user_role() = 'superadmin'
      OR (public.current_user_role() = 'admin'
          AND public.current_admin_scope() IN ('all', p_module))
$$;


-- ----------------------------------------------------------------------------
-- collection_visits — one store on one day's published list
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_visits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('collected', 'rescheduled', 'pending')),

  -- --- Put on the day's list by the Collection Admin (web) ------------------
  scheduled_for TIMESTAMPTZ NOT NULL,
  listed_by UUID REFERENCES profiles(id),
  listed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- What the office says the store owes. Admin-entered and deliberately NOT
  -- shown on the collector's Collect Payment screen (anchoring bias). That is a
  -- UI rule, not a database one — see the note under the RLS policies.
  amount_due NUMERIC(12, 2) NOT NULL CHECK (amount_due >= 0),

  -- --- Captured by the collector on the phone -------------------------------
  -- Null until someone actually works the store. NOT an assignment.
  collector_id UUID REFERENCES profiles(id),
  amount_collected NUMERIC(12, 2) CHECK (amount_collected >= 0),
  payment_method TEXT CHECK (payment_method IN ('cash', 'check', 'gcash', 'counter')),
  -- One photo slot whose meaning follows payment_method, which is why 'counter'
  -- needs no capture of its own (2026-07-26 change).
  payment_photo_url TEXT,
  delivery_receipt_photo_url TEXT,
  -- Captured at the moment the payment photo is taken, so it survives offline
  -- and reflects where the collector actually stood.
  gps_lat DOUBLE PRECISION,
  gps_lng DOUBLE PRECISION,
  remarks TEXT,
  rescheduled_to TIMESTAMPTZ,
  -- The ONLY ordering signal for a collector's trip on the map: collection has
  -- no sequence number, so web derives route order entirely from this.
  visited_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A worked store must say who worked it and when. Enforced because a
  -- collected row without these is invisible to both the day board and the trip
  -- map — it would silently vanish rather than show up wrong.
  CONSTRAINT collection_visits_collected_complete CHECK (
    status <> 'collected'
    OR (collector_id IS NOT NULL AND amount_collected IS NOT NULL
        AND payment_method IS NOT NULL AND visited_at IS NOT NULL)
  ),
  CONSTRAINT collection_visits_rescheduled_has_date CHECK (
    status <> 'rescheduled' OR rescheduled_to IS NOT NULL
  ),
  -- Nobody has reached a pending store, so no collector-side value belongs on it.
  CONSTRAINT collection_visits_pending_is_unworked CHECK (
    status <> 'pending'
    OR (collector_id IS NULL AND amount_collected IS NULL AND visited_at IS NULL)
  )
);

-- ⚠️ DELIBERATELY NOT CONSTRAINED: the two proof photos are nullable even on a
-- collected row, for two independent reasons.
--   1. Offline. Mobile pushes the business row through its `outbox` and the
--      photos through a separate upload lane, so a collected visit legitimately
--      exists with NULL photo URLs until the images land — sometimes hours
--      later, from a different place. A NOT NULL here would make every
--      offline collection fail at insert.
--   2. Web needs to SEE the hole. "Collected but missing a required capture" is
--      a real state the admin has to chase, and both the Collection page and
--      the trip map surface it. A constraint would make those rows unwritable
--      rather than visible, which hides the problem instead of fixing it.

CREATE INDEX IF NOT EXISTS idx_collection_visits_scheduled_for
  ON collection_visits (scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_collection_visits_client_id
  ON collection_visits (client_id);
-- Covers the trip-map query: one collector's stops on one day, in worked order.
CREATE INDEX IF NOT EXISTS idx_collection_visits_collector_day
  ON collection_visits (collector_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_collection_visits_status
  ON collection_visits (status);

-- Guarded like every CREATE below: `supabase db push` re-applying a file after a
-- partial failure must not error on "already exists", which is how a half-applied
-- migration turns into a stuck deploy.
DROP TRIGGER IF EXISTS collection_visits_updated_at ON collection_visits;
CREATE TRIGGER collection_visits_updated_at
  BEFORE UPDATE ON collection_visits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ----------------------------------------------------------------------------
-- remittances — a collector handing over the money they are holding
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS remittances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  collector_id UUID NOT NULL REFERENCES profiles(id),
  destination TEXT NOT NULL
    CHECK (destination IN ('office', 'bayad_center', 'bank_deposit')),
  amount_remitted NUMERIC(12, 2) NOT NULL CHECK (amount_remitted >= 0),
  -- Sum of the visits this covers. Variance = remitted - collected, computed by
  -- the app rather than stored, so it can never disagree with its own inputs.
  amount_collected NUMERIC(12, 2) NOT NULL CHECK (amount_collected >= 0),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'reconciled', 'variance')),
  receiver_name TEXT,
  signed_proof_url TEXT,
  receiver_signature_url TEXT,
  -- Array rather than a junction table, matching how both repos already model
  -- it (`visit_ids: string[]`). The cost is no referential integrity on the
  -- members; revisit if remittances ever need to be queried FROM the visit side.
  visit_ids UUID[] NOT NULL DEFAULT '{}',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Office hand-overs need a named receiver. The in-app SIGNATURE is also
  -- required for office (2026-07-16) but is NOT enforced here — it uploads
  -- through the same deferred photo lane as the proofs above, so requiring it
  -- at insert would break offline remittance. Mobile blocks submit on it.
  CONSTRAINT remittances_office_has_receiver CHECK (
    destination <> 'office' OR receiver_name IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_remittances_collector
  ON remittances (collector_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_remittances_status ON remittances (status);


-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
ALTER TABLE collection_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE remittances ENABLE ROW LEVEL SECURITY;

-- Admins who run Collection get everything. This is where migration 024's
-- admin_scope finally bites at the data layer.
DROP POLICY IF EXISTS "Collection admins manage visits" ON collection_visits;
CREATE POLICY "Collection admins manage visits" ON collection_visits
  FOR ALL TO authenticated
  USING (public.admin_manages_module('collection'))
  WITH CHECK (public.admin_manages_module('collection'));

-- Collectors read the WHOLE day's list, not just their own rows — the list is a
-- shared pool and a collector must see the stores nobody has taken yet. Scoping
-- this to `collector_id = me` would show them an empty app every morning.
DROP POLICY IF EXISTS "Collectors read the list" ON collection_visits;
CREATE POLICY "Collectors read the list" ON collection_visits
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'collector');

-- A collector may claim any UNCLAIMED store, or update one already theirs.
-- USING gates which rows are visible to the update; WITH CHECK gates the result,
-- so the second half stops a collector reassigning a store to someone else.
DROP POLICY IF EXISTS "Collectors work the list" ON collection_visits;
CREATE POLICY "Collectors work the list" ON collection_visits
  FOR UPDATE TO authenticated
  USING (
    public.current_user_role() = 'collector'
    AND (collector_id IS NULL OR collector_id = public.current_profile_id())
  )
  WITH CHECK (
    public.current_user_role() = 'collector'
    AND collector_id = public.current_profile_id()
  );

-- Collectors do NOT get INSERT or DELETE: the admin publishes the list, the
-- collector works it. A collector inventing a store would be inventing a debt.

DROP POLICY IF EXISTS "Collection admins manage remittances" ON remittances;
CREATE POLICY "Collection admins manage remittances" ON remittances
  FOR ALL TO authenticated
  USING (public.admin_manages_module('collection'))
  WITH CHECK (public.admin_manages_module('collection'));

DROP POLICY IF EXISTS "Collectors submit own remittances" ON remittances;
CREATE POLICY "Collectors submit own remittances" ON remittances
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() = 'collector'
    AND collector_id = public.current_profile_id()
  );

DROP POLICY IF EXISTS "Collectors read own remittances" ON remittances;
CREATE POLICY "Collectors read own remittances" ON remittances
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'collector'
    AND collector_id = public.current_profile_id()
  );

-- ⚠️ `amount_due` is readable by collectors, because RLS filters ROWS, not
-- COLUMNS. Hiding it from the Collect Payment screen is a mobile UI rule and
-- stays one. If it ever has to be enforced server-side, the shape is a
-- collector-facing VIEW that omits the column, plus a REVOKE on the base table
-- — not something that can be bolted onto these policies.


-- ----------------------------------------------------------------------------
-- Storage: collection-proofs
--
-- Payment photos and delivery receipts. Mirrors the meeting-photos bucket (022)
-- including its gotcha: marking a bucket public grants READ only — uploads
-- still fail with "new row violates row-level security policy" until an INSERT
-- policy exists, which is why the second statement is not optional.
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('collection-proofs', 'collection-proofs', true)
ON CONFLICT (id) DO NOTHING;

-- Not scoped to a per-user folder, matching meeting-photos. Suggested path
-- convention so retries are idempotent (a 409 then means "already uploaded",
-- which is the trick mobile's pending_uploads lane already relies on):
--   collection-proofs/{visit_id}/{payment|receipt}.jpg
DROP POLICY IF EXISTS "Collectors upload collection proofs" ON storage.objects;
CREATE POLICY "Collectors upload collection proofs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'collection-proofs');
