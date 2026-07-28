-- ============================================================================
-- 044 — Delivery module (F-007): purchase_orders + cod_remittances
--
-- ⚠️ NUMBERING: 044, not 026 — see the note at the top of 043. Migration 026 is
-- taken by the mobile side (tag-along promotion gate, applied live 2026-07-23)
-- and is one of the three files web still owes as a backfill.
--
-- The Collection twin (025), in delivery nouns. Same model: the admin publishes
-- ONE TRIP LIST PER DAY — every customer and the area they're in, plus a COD
-- amount where there is one — and drivers on mobile work it down. No PO is
-- assigned to a driver up front; whoever reaches the stop delivers it, and
-- their name, their truck's plate, and the stop's position in their run all land
-- on the row at that moment.
--
-- Shapes match web types/index.ts `PurchaseOrder` / `CodRemittance`. The
-- cross-repo contract, and the list of things mobile's F-007 draft has to
-- change, are in COLLECTION_DELIVERY_FOR_MOBILE.md.
--
-- Three rules this schema encodes that the wireframes and mobile's draft get
-- wrong — all confirmed 2026-07-27:
--   1. ONE DAY, ONE OUTCOME. A PO belongs to its delivery day: delivered, or
--      failed with the goods riding back. There is no 3-day follow-up window
--      (that was the client-lifecycle rule, superseded on July 3, which leaked
--      into the delivery screens) and nothing re-lists itself.
--   2. A FAILED DELIVERY *IS* A BACKLOAD. Not two statuses. Nothing was
--      accepted, so the goods ride back and the backload photo is the proof —
--      hence a capture on a failed row, not a status of its own.
--   3. DELIVERY HAS GPS. This reverses the wireframe's "Walang GPS sa delivery
--      module (per confirmed scope)". The fix rides along with the photo the
--      driver already takes, so it costs them no extra step. No photo therefore
--      means no location, and web renders such a stop as "No pin" rather than
--      guessing a coordinate.
--
-- ⚠️ Merging this to main triggers .github/workflows/deploy-migrations.yml,
-- which runs `supabase db push` against the shared project the mobile app also
-- uses. Purely additive — two new tables and one new bucket, nothing existing
-- is altered — but tell the mobile team before merging.
--
-- Depends on 043 for public.admin_manages_module() and current_profile_id().
-- ============================================================================


-- ----------------------------------------------------------------------------
-- purchase_orders — one stop on one delivery day's trip list
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- ⚠️ EXTERNAL identifier, and deliberately NOT UNIQUE. It is printed on the
  -- paper PO the driver carries, so we never mint one. And a PO that failed on
  -- Monday and was re-listed for Wednesday appears TWICE with the same number —
  -- two attempts on two trip tickets, which is the whole point of the one-day
  -- rule. A unique constraint here would make the second attempt unsavable.
  po_number TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- Coarser than an address: with the customer name this is the whole of what
  -- the admin lists. There is deliberately no line-items column — the paper
  -- Trip Report has none either.
  area TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),

  -- --- Put on a delivery day's list by the Delivery Admin (web) -------------
  scheduled_for TIMESTAMPTZ NOT NULL,
  listed_by UUID REFERENCES profiles(id),
  listed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Per-PO toggle, not a mode the module runs in.
  cod BOOLEAN NOT NULL DEFAULT FALSE,
  cod_due NUMERIC(12, 2) CHECK (cod_due >= 0),

  -- --- Captured by the driver on the phone ----------------------------------
  -- Null until someone actually runs the stop. NOT an assignment.
  driver_id UUID REFERENCES profiles(id),
  truck_plate TEXT,
  -- Position in the driver's OWN run, assigned at the moment of delivery from
  -- the order they actually visit stops. Two drivers on one day's list each
  -- have a #1, so this is not unique per day.
  sequence_no INTEGER CHECK (sequence_no > 0),
  -- Optional: customers frequently refuse to give a name, which is exactly why
  -- the signature below carries the proof instead.
  receiver_name TEXT,
  receiver_signature_url TEXT,
  -- Straight off the paper Trip Report's TIME-IN / TIME-OUT columns. Both are
  -- set on a FAILED stop too — the truck still arrived, waited, and left — and
  -- the gap between them is the only measure of how long a stop really took.
  time_in TIMESTAMPTZ,
  time_out TIMESTAMPTZ,
  proof_url TEXT,
  backload_photo_url TEXT,
  -- Rule 3 above. Captured with the proof (or backload) photo.
  gps_lat DOUBLE PRECISION,
  gps_lng DOUBLE PRECISION,
  remarks TEXT,

  -- --- COD payment, captured at the stop when `cod` is set ------------------
  cod_amount NUMERIC(12, 2) CHECK (cod_amount >= 0),
  -- 'counter' is deliberately absent: that method means a store paying at its
  -- own counter, which has no meaning on a delivery.
  cod_method TEXT CHECK (cod_method IN ('cash', 'check', 'gcash')),
  cod_photo_url TEXT,
  cod_remitted BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A closed-out stop must say who ran it and when it ended, or it is invisible
  -- to both the trip board and the map.
  CONSTRAINT purchase_orders_closed_complete CHECK (
    status = 'pending' OR (driver_id IS NOT NULL AND time_out IS NOT NULL)
  ),
  CONSTRAINT purchase_orders_times_ordered CHECK (
    time_in IS NULL OR time_out IS NULL OR time_out >= time_in
  ),
  -- Nobody has reached a waiting stop, so no driver-side value belongs on it.
  CONSTRAINT purchase_orders_pending_is_unrun CHECK (
    status <> 'pending'
    OR (driver_id IS NULL AND sequence_no IS NULL AND time_out IS NULL)
  ),
  -- Money can't appear on a PO that isn't COD.
  CONSTRAINT purchase_orders_non_cod_has_no_money CHECK (
    cod OR (cod_due IS NULL AND cod_amount IS NULL AND cod_method IS NULL)
  ),
  CONSTRAINT purchase_orders_non_cod_not_remitted CHECK (cod OR NOT cod_remitted)
);

-- ⚠️ DELIBERATELY NOT CONSTRAINED, for the same two reasons as 025's photos:
-- proof_url, backload_photo_url, cod_photo_url and receiver_signature_url stay
-- nullable even on a closed-out stop. Mobile pushes the row through its
-- `outbox` and the images through a separate deferred upload lane, so an
-- offline delivery legitimately has NULL URLs for a while; and "closed out
-- without a capture the app should have blocked on" is a real hole the admin
-- needs to SEE, which a constraint would turn into an unsavable row.

CREATE INDEX IF NOT EXISTS idx_purchase_orders_scheduled_for
  ON purchase_orders (scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_client_id
  ON purchase_orders (client_id);
-- Covers the trip-map query: one driver's stops on one day, in run order.
CREATE INDEX IF NOT EXISTS idx_purchase_orders_driver_day
  ON purchase_orders (driver_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status
  ON purchase_orders (status);
-- The re-list lookup: "has this PO number been attempted before?"
CREATE INDEX IF NOT EXISTS idx_purchase_orders_po_number
  ON purchase_orders (po_number);
-- Partial index for the "COD still riding in a driver's truck" figure, which
-- both the dashboard and the remittance screen ask for on every load.
CREATE INDEX IF NOT EXISTS idx_purchase_orders_held_cod
  ON purchase_orders (driver_id) WHERE cod AND NOT cod_remitted;

-- Guarded so a re-applied file can't error on "already exists" (see 025).
DROP TRIGGER IF EXISTS purchase_orders_updated_at ON purchase_orders;
CREATE TRIGGER purchase_orders_updated_at
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ----------------------------------------------------------------------------
-- cod_remittances — a driver handing over the COD money they are holding
--
-- Reuses Collection's remittance pattern but is OFFICE-ONLY (2026-07-25,
-- Addendum 4): the 7-11 and bank-deposit destinations were removed from the
-- driver's Remit screen, so unlike `remittances` there is no destination column
-- at all and the receiving officer is always named.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cod_remittances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id UUID NOT NULL REFERENCES profiles(id),
  amount_remitted NUMERIC(12, 2) NOT NULL CHECK (amount_remitted >= 0),
  amount_collected NUMERIC(12, 2) NOT NULL CHECK (amount_collected >= 0),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'reconciled', 'variance')),
  -- Office is the only destination, so this is never optional.
  receiver_name TEXT NOT NULL,
  -- Always required by the driver's app — but not NOT NULL here, because it
  -- uploads through the deferred photo lane like every other capture.
  receiver_signature_url TEXT,
  po_ids UUID[] NOT NULL DEFAULT '{}',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cod_remittances_driver
  ON cod_remittances (driver_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_cod_remittances_status
  ON cod_remittances (status);


-- ----------------------------------------------------------------------------
-- RLS — mirrors 025 exactly, with 'delivery' in place of 'collector'
-- ----------------------------------------------------------------------------
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE cod_remittances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Delivery admins manage POs" ON purchase_orders;
CREATE POLICY "Delivery admins manage POs" ON purchase_orders
  FOR ALL TO authenticated
  USING (public.admin_manages_module('delivery'))
  WITH CHECK (public.admin_manages_module('delivery'));

-- Drivers read the whole day's trip list, not just their own stops — same
-- shared-pool reasoning as Collection. Scoping to `driver_id = me` would show a
-- driver an empty list every morning, before they had run anything.
DROP POLICY IF EXISTS "Drivers read the trip list" ON purchase_orders;
CREATE POLICY "Drivers read the trip list" ON purchase_orders
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'delivery');

-- A driver may take any UNRUN stop, or update one already theirs. The WITH
-- CHECK half stops them handing a stop to another driver.
DROP POLICY IF EXISTS "Drivers run the trip list" ON purchase_orders;
CREATE POLICY "Drivers run the trip list" ON purchase_orders
  FOR UPDATE TO authenticated
  USING (
    public.current_user_role() = 'delivery'
    AND (driver_id IS NULL OR driver_id = public.current_profile_id())
  )
  WITH CHECK (
    public.current_user_role() = 'delivery'
    AND driver_id = public.current_profile_id()
  );

-- No INSERT or DELETE for drivers: the admin publishes the trip list.

DROP POLICY IF EXISTS "Delivery admins manage COD remittances" ON cod_remittances;
CREATE POLICY "Delivery admins manage COD remittances" ON cod_remittances
  FOR ALL TO authenticated
  USING (public.admin_manages_module('delivery'))
  WITH CHECK (public.admin_manages_module('delivery'));

DROP POLICY IF EXISTS "Drivers submit own COD remittances" ON cod_remittances;
CREATE POLICY "Drivers submit own COD remittances" ON cod_remittances
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() = 'delivery'
    AND driver_id = public.current_profile_id()
  );

DROP POLICY IF EXISTS "Drivers read own COD remittances" ON cod_remittances;
CREATE POLICY "Drivers read own COD remittances" ON cod_remittances
  FOR SELECT TO authenticated
  USING (
    public.current_user_role() = 'delivery'
    AND driver_id = public.current_profile_id()
  );

-- Note the asymmetry with Collection, and that it is intentional: `cod_due` IS
-- meant to be visible to the driver. A COD figure is the fixed price of goods
-- being handed over, not a negotiable balance, so the anchoring-bias rule that
-- hides `amount_due` from collectors does not apply here.


-- ----------------------------------------------------------------------------
-- Storage: delivery-proofs
--
-- Proof photos, backload photos, COD payment photos, receiver signatures. Same
-- shape as collection-proofs (025) and meeting-photos (022) — public read does
-- NOT grant upload, hence the explicit INSERT policy.
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('delivery-proofs', 'delivery-proofs', true)
ON CONFLICT (id) DO NOTHING;

-- Suggested path convention, so a retried upload's 409 can be read as success:
--   delivery-proofs/{po_id}/{proof|backload|cod|signature}.jpg
DROP POLICY IF EXISTS "Drivers upload delivery proofs" ON storage.objects;
CREATE POLICY "Drivers upload delivery proofs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'delivery-proofs');
