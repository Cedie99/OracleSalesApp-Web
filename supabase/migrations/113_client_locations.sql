-- ============================================================================
-- 113 — Store locations on the C&D map: client_locations
--
-- Cross-repo feature. The mobile repo (OracleSalesApp-Mobile) owns the contract
-- in STORE_LOCATIONS_CONTRACT.md (2026-08-17); this migration is web's half.
-- Read that file first — the notes below only cover what the SQL does and why.
--
-- THE MODEL. Collection & Delivery officers need a MAP of the day's stores and
-- the ability to set a store's REAL location on the ground, because some stores
-- relocate and their registered office pin (clients.office_lat/office_lng, 052)
-- is stale or missing. A store therefore keeps a NUMBERED list of candidate pins
-- ("Location 1, 2, 3…"), exactly one flagged is_current. The field officer sets
-- it DIRECTLY — no admin approval (owner decision, 2026-08-17). History is kept:
-- a store that moves back can re-select an older pin.
--
-- WHY THIS IS WEB-OWNED. The numbered list must be a real table so a pin set by
-- one officer reaches the admin board and every other field device. types/
-- database.ts is generated from Supabase and has no client_locations, so
-- mobile's generic sync lanes can't be wired until this table + regenerated
-- types ship. Until then a set location lives only on the device that set it.
--
-- Purely additive: one new table, two SECURITY DEFINER RPCs, RLS on the new
-- table only. Nothing existing is altered. The default-pin denormalization onto
-- collection_visits / purchase_orders (contract §4) is the twin migration 114,
-- which also teaches set_client_location() to keep those copies fresh.
--
-- ⚠️ Merging this to main triggers .github/workflows/deploy-migrations.yml,
-- which runs `supabase db push` against the shared project the mobile app also
-- uses. Tell the mobile team before merging (same as 043/044/070).
--
-- Depends on: 043 (public.current_profile_id(), public.current_user_role(),
-- public.admin_manages_module()), 044 (purchase_orders), clients (office pin).
-- All statements are idempotent so a CI re-run after a partial failure cannot
-- error on "already exists".
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The table — one candidate location for a store, numbered per client
--
-- The mobile local mirror (SQLite client_locations) already matches this shape
-- column-for-column apart from Postgres types.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_locations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- "Location N", assigned per client. SERVER-assigned by the RPC below so two
  -- offline devices can't both mint "Location 3" (numbering only orders the
  -- list; it is not a uniqueness key — see the open question in the contract).
  seq         INTEGER NOT NULL,
  label       TEXT,                                     -- optional ("Warehouse", "New site")
  lat         NUMERIC NOT NULL,
  lng         NUMERIC NOT NULL,
  -- Exactly one true per client, enforced by the partial unique index below.
  is_current  BOOLEAN NOT NULL DEFAULT false,
  source      TEXT NOT NULL DEFAULT 'field_set'
    CHECK (source IN ('field_set', 'office_pin', 'admin', 'migrated')),
  set_by      UUID REFERENCES profiles(id),            -- the field officer who set it
  set_by_name TEXT,                                     -- denormalized for display, like claimed_by_name
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_locations_client_id
  ON client_locations (client_id);

-- The invariant: at most one current pin per client. A partial unique index is
-- the standard way to say "unique among the rows where is_current" without
-- constraining the history rows (all is_current = false) against each other.
CREATE UNIQUE INDEX IF NOT EXISTS client_locations_one_current
  ON client_locations (client_id) WHERE is_current;

DROP TRIGGER IF EXISTS client_locations_updated_at ON client_locations;
CREATE TRIGGER client_locations_updated_at
  BEFORE UPDATE ON client_locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE client_locations IS
  'Numbered candidate locations for a store (Store Locations feature, migration 113). One row per client is is_current. Set directly by a Collection/Delivery field officer via set_client_location() — no admin approval. See STORE_LOCATIONS_CONTRACT.md.';


-- ----------------------------------------------------------------------------
-- 2. RLS
--
-- Admin: full read/write if they administer either C&D module (a store's
-- location is not module-specific). Field roles: read + append a pin ONLY for a
-- client on their own day list, never flip is_current directly (that races two
-- currents) — the flip goes through the SECURITY DEFINER RPCs in §3, which
-- bypass RLS and demote-then-promote in the correct order.
--
-- "On their day list" = the client already has a row on the caller's module
-- board: a collection_visit for a collector, a purchase_order for a delivery
-- driver. This mirrors the shared-pool read the C&D boards already use (043/044:
-- a field role reads the WHOLE list) but bounds location writes to real stores.
-- ----------------------------------------------------------------------------
ALTER TABLE client_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "C&D admins manage store locations" ON client_locations;
CREATE POLICY "C&D admins manage store locations" ON client_locations
  FOR ALL TO authenticated
  USING (public.admin_manages_module('collection') OR public.admin_manages_module('delivery'))
  WITH CHECK (public.admin_manages_module('collection') OR public.admin_manages_module('delivery'));

DROP POLICY IF EXISTS "Field roles read store locations in scope" ON client_locations;
CREATE POLICY "Field roles read store locations in scope" ON client_locations
  FOR SELECT TO authenticated
  USING (
    (public.current_user_role() = 'collector'
       AND EXISTS (SELECT 1 FROM collection_visits v WHERE v.client_id = client_locations.client_id))
    OR (public.current_user_role() = 'delivery'
       AND EXISTS (SELECT 1 FROM purchase_orders p WHERE p.client_id = client_locations.client_id))
  );

-- Direct INSERT for the mobile generic sync-lane (Phase 4) as a fallback to the
-- RPC. The row must be for a client on the caller's day list and stamped with
-- the caller's own profile id — they cannot attribute a pin to someone else.
DROP POLICY IF EXISTS "Field roles add store locations in scope" ON client_locations;
CREATE POLICY "Field roles add store locations in scope" ON client_locations
  FOR INSERT TO authenticated
  WITH CHECK (
    set_by = public.current_profile_id()
    AND (
      (public.current_user_role() = 'collector'
         AND EXISTS (SELECT 1 FROM collection_visits v WHERE v.client_id = client_locations.client_id))
      OR (public.current_user_role() = 'delivery'
         AND EXISTS (SELECT 1 FROM purchase_orders p WHERE p.client_id = client_locations.client_id))
    )
  );


-- ----------------------------------------------------------------------------
-- 3. Write RPCs (SECURITY DEFINER)
--
-- SECURITY DEFINER for two reasons: (a) the "set current" flip touches SIBLING
-- rows, which a narrow field-role UPDATE policy would otherwise have to allow
-- broadly; (b) seq must be assigned server-side. Because DEFINER bypasses RLS,
-- each function re-checks authorization against the CALLER (auth.uid() is
-- preserved through the call, so current_user_role()/current_profile_id() still
-- resolve to the caller).
-- ----------------------------------------------------------------------------

-- Shared authorization predicate: may the caller set a location for this client?
-- A C&D admin always; a field role only for a client on their own day list.
CREATE OR REPLACE FUNCTION public.can_set_client_location(p_client_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT public.admin_manages_module('collection')
      OR public.admin_manages_module('delivery')
      OR (public.current_user_role() = 'collector'
          AND EXISTS (SELECT 1 FROM collection_visits v WHERE v.client_id = p_client_id))
      OR (public.current_user_role() = 'delivery'
          AND EXISTS (SELECT 1 FROM purchase_orders p WHERE p.client_id = p_client_id));
$$;

-- Append a NEW/relocated pin and make it current, atomically for this client:
-- demote the old current, then insert the next "Location N" as current. Returns
-- the new row's id. The two steps are separate statements (not one flip UPDATE)
-- so the partial unique index never sees two currents mid-statement.
CREATE OR REPLACE FUNCTION public.set_client_location(
  p_client_id uuid,
  p_lat       numeric,
  p_lng       numeric,
  p_label     text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_name    text;
  v_id      uuid;
BEGIN
  IF NOT public.can_set_client_location(p_client_id) THEN
    RAISE EXCEPTION 'not authorized to set a location for this client';
  END IF;

  -- Basic sanity guard. Philippines-specific bounds are a mobile concern (the
  -- office-pin service already guards there); here we only reject nonsense that
  -- would poison the map, matching how office pins are stored without a strict
  -- SQL range check.
  IF p_lat IS NULL OR p_lng IS NULL
     OR p_lat < -90 OR p_lat > 90 OR p_lng < -180 OR p_lng > 180 THEN
    RAISE EXCEPTION 'invalid coordinate (lat %, lng %)', p_lat, p_lng;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_profile;

  UPDATE public.client_locations
     SET is_current = false, updated_at = now()
   WHERE client_id = p_client_id AND is_current;

  INSERT INTO public.client_locations
    (client_id, seq, label, lat, lng, is_current, source, set_by, set_by_name)
  VALUES
    (p_client_id,
     (SELECT COALESCE(MAX(seq), 0) + 1 FROM public.client_locations WHERE client_id = p_client_id),
     p_label, p_lat, p_lng, true, 'field_set', v_profile, v_name)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Re-select an EXISTING saved pin as current (the store moved back). Demote all
-- of that client's pins, then promote the chosen one — two statements, same
-- no-transient-dup reasoning as above.
CREATE OR REPLACE FUNCTION public.set_current_client_location(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client uuid;
BEGIN
  SELECT client_id INTO v_client FROM public.client_locations WHERE id = p_location_id;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'location % not found', p_location_id;
  END IF;
  IF NOT public.can_set_client_location(v_client) THEN
    RAISE EXCEPTION 'not authorized to set a location for this client';
  END IF;

  UPDATE public.client_locations
     SET is_current = false, updated_at = now()
   WHERE client_id = v_client AND is_current;

  UPDATE public.client_locations
     SET is_current = true, updated_at = now()
   WHERE id = p_location_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_client_location(uuid, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_current_client_location(uuid) TO authenticated;

COMMENT ON FUNCTION public.set_client_location(uuid, numeric, numeric, text) IS
  'Store Locations (113): append the next numbered pin for a client and make it current, atomically. Server-assigns seq and demotes the old current. Authorized for a C&D admin, or a field role with the client on their day list. See STORE_LOCATIONS_CONTRACT.md §2.';
COMMENT ON FUNCTION public.set_current_client_location(uuid) IS
  'Store Locations (113): re-select an existing saved pin as the client''s current location (a store that moved back). Demote-then-promote so the one-current invariant never transiently breaks.';


-- ============================================================================
-- Rollback (if ever needed):
--   drop function if exists public.set_current_client_location(uuid);
--   drop function if exists public.set_client_location(uuid, numeric, numeric, text);
--   drop function if exists public.can_set_client_location(uuid);
--   drop table if exists public.client_locations;   -- ON DELETE CASCADE from clients only
--
-- Verification (staging first, TEST clients):
--   1. As a collector whose day list includes client X, call
--      select set_client_location('X-uuid', 14.5995, 120.9842, 'New site');
--      Confirm: a client_locations row exists, is_current = true, seq = 1,
--      set_by_name is your name.
--   2. Call it again for X with different coords. Confirm: two rows, seq 1 and 2,
--      only seq 2 is_current, seq 1 demoted. (one-current index held.)
--   3. select set_current_client_location('<seq-1 id>'). Confirm: seq 1 current
--      again, seq 2 demoted.
--   4. As a collector whose day list does NOT include client Y, call
--      set_client_location('Y-uuid', ...). Confirm: raises 'not authorized'.
--   5. As a delivery driver with a purchase_order for client Z, repeat step 1
--      for Z. Confirm: succeeds (delivery scope).
-- ============================================================================
