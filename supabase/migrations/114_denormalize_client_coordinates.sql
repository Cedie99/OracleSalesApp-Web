-- ============================================================================
-- 114 — Store locations: default coordinate on every visit / PO
--
-- Cross-repo feature, web half of STORE_LOCATIONS_CONTRACT.md §4/§4a. Twin of
-- 113 (client_locations). Read that contract first.
--
-- THE PROBLEM this fixes (owner requirement, 2026-08-18). A collection/delivery
-- officer must see each store's DEFAULT location on the map BEFORE they set out —
-- that is how they know where to go; the set-location feature (113) is only for
-- when they arrive and find the store relocated. That default does NOT reach the
-- field device today, confirmed in mobile code:
--
--   * The clients sync-down is scoped assigned_agent_id = <me>. A collector/
--     driver is not the SALES agent who owns those clients, so their clients
--     pull returns ZERO rows — clients.office_lat/office_lng never lands on the
--     phone.
--   * collection_visits / purchase_orders carry only visit-time GPS
--     (gps_lat/gps_lng), present only AFTER a stop is worked. A pending,
--     unvisited store has NO coordinate anywhere on the device.
--
-- THE FIX (contract's recommended option — cheapest, matches existing
-- denormalization). Copy the store's default coordinate onto the visit/PO row,
-- exactly the way client_name / area / claimed_by_name already are (045). The
-- coordinate is COALESCE(current client_locations pin, office pin). Mobile then
-- reads client_lat/client_lng straight off the synced visit/PO row — no clients
-- RLS/sync widening. Rides the existing collection_visits / purchase_orders
-- pull; no new sync-down policy.
--
-- Three pieces here (all web-side, all in this migration):
--   Step 1 — the columns (additive, nullable).
--   Step 2 — one-time backfill of existing rows.
--   Step 3 — a BEFORE INSERT trigger that fills the coordinate on every new row,
--            from any insert path (web board, web server action, mobile). This
--            is the robust form of the contract's "populate-on-write"; because
--            it lives in the row's own lifecycle it needs no change at each
--            publish/create call site, and an explicit caller value still wins.
--   Step 3b — keep-fresh: teach set_client_location() (113) to re-copy a new pin
--            onto the client's still-open (pending/partial) visits & POs, so a
--            same-day relocation reaches other officers' maps (owner's
--            recommended option, contract §4a Step 3b).
--
-- Purely additive. Depends on 113 (client_locations, set_client_location),
-- 070/073 (the 'partial' status), 052 (clients office pin).
--
-- ⚠️ Merging this to main runs deploy-migrations.yml against the shared project.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Step 1 — columns. Nullable: a row with no resolvable coordinate (store with
-- neither a client_locations pin nor an office pin) simply stays null, and mobile
-- falls through to its next precedence tier (visit GPS → "location not set").
-- ----------------------------------------------------------------------------
ALTER TABLE collection_visits ADD COLUMN IF NOT EXISTS client_lat numeric;
ALTER TABLE collection_visits ADD COLUMN IF NOT EXISTS client_lng numeric;
ALTER TABLE purchase_orders   ADD COLUMN IF NOT EXISTS client_lat numeric;
ALTER TABLE purchase_orders   ADD COLUMN IF NOT EXISTS client_lng numeric;

COMMENT ON COLUMN collection_visits.client_lat IS
  'Store DEFAULT map coordinate, denormalized at insert (Store Locations, 114): COALESCE(current client_locations pin, clients.office_lat). Distinct from gps_lat (visit-time GPS). See STORE_LOCATIONS_CONTRACT.md §4.';
COMMENT ON COLUMN purchase_orders.client_lat IS
  'Store DEFAULT map coordinate, denormalized at insert (Store Locations, 114): COALESCE(current client_locations pin, clients.office_lat). Distinct from gps_lat (visit-time GPS). See STORE_LOCATIONS_CONTRACT.md §4.';


-- ----------------------------------------------------------------------------
-- Step 2 — one-time backfill. Precedence = current relocation pin, else office
-- pin. The LEFT JOIN degrades to office-pin-only for clients with no
-- client_locations row yet. Idempotent: re-running just recomputes the same
-- COALESCE, and a manual override (should one ever exist) is preserved because
-- we only touch rows still matching their client — safe to re-run under CI.
-- ----------------------------------------------------------------------------
UPDATE collection_visits v SET
  client_lat = COALESCE(cl.lat, c.office_lat),
  client_lng = COALESCE(cl.lng, c.office_lng)
FROM clients c
LEFT JOIN client_locations cl
  ON cl.client_id = c.id AND cl.is_current
WHERE v.client_id = c.id
  AND v.client_lat IS NULL AND v.client_lng IS NULL;

UPDATE purchase_orders p SET
  client_lat = COALESCE(cl.lat, c.office_lat),
  client_lng = COALESCE(cl.lng, c.office_lng)
FROM clients c
LEFT JOIN client_locations cl
  ON cl.client_id = c.id AND cl.is_current
WHERE p.client_id = c.id
  AND p.client_lat IS NULL AND p.client_lng IS NULL;


-- ----------------------------------------------------------------------------
-- Step 3 — populate-on-insert trigger. Fills client_lat/client_lng from the same
-- COALESCE(current pin, office pin) whenever a new visit/PO is inserted without
-- them. Only fills when BOTH are null, so an explicit caller-supplied coordinate
-- always wins and a genuine "no coordinate known" (both null after resolution)
-- is left null for mobile's fallback tiers.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fill_client_coordinate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.client_lat IS NULL AND NEW.client_lng IS NULL THEN
    SELECT COALESCE(cl.lat, c.office_lat), COALESCE(cl.lng, c.office_lng)
      INTO NEW.client_lat, NEW.client_lng
      FROM public.clients c
      LEFT JOIN public.client_locations cl
        ON cl.client_id = c.id AND cl.is_current
     WHERE c.id = NEW.client_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collection_visits_fill_coordinate ON collection_visits;
CREATE TRIGGER collection_visits_fill_coordinate
  BEFORE INSERT ON collection_visits
  FOR EACH ROW EXECUTE FUNCTION public.fill_client_coordinate();

DROP TRIGGER IF EXISTS purchase_orders_fill_coordinate ON purchase_orders;
CREATE TRIGGER purchase_orders_fill_coordinate
  BEFORE INSERT ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.fill_client_coordinate();


-- ----------------------------------------------------------------------------
-- Step 3b — keep-fresh. Re-declare set_client_location() (113) so that after it
-- makes a new pin current, it re-copies that pin onto the client's still-OPEN
-- (pending/partial) visits & POs. A store that relocates mid-day then updates
-- every officer's map for stops not yet worked; worked rows (collected/delivered/
-- rescheduled/failed) are historical and left untouched. Identical to 113's body
-- plus the two trailing UPDATEs.
-- ----------------------------------------------------------------------------
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

  -- keep-fresh: push the new default onto stops not yet worked.
  UPDATE public.collection_visits
     SET client_lat = p_lat, client_lng = p_lng
   WHERE client_id = p_client_id AND status IN ('pending', 'partial');

  UPDATE public.purchase_orders
     SET client_lat = p_lat, client_lng = p_lng
   WHERE client_id = p_client_id AND status IN ('pending', 'partial');

  RETURN v_id;
END;
$$;


-- ============================================================================
-- Rollback (if ever needed):
--   drop trigger if exists collection_visits_fill_coordinate on collection_visits;
--   drop trigger if exists purchase_orders_fill_coordinate on purchase_orders;
--   drop function if exists public.fill_client_coordinate();
--   alter table collection_visits drop column if exists client_lat, drop column if exists client_lng;
--   alter table purchase_orders   drop column if exists client_lat, drop column if exists client_lng;
--   -- and restore set_client_location() to the 113 body (without the two keep-fresh UPDATEs).
--
-- Verification (staging first, TEST rows):
--   1. Publish a new collection visit for a client that has an office pin but no
--      client_locations row. Confirm: client_lat/client_lng = the office pin
--      (trigger filled it), no app change needed.
--   2. set_client_location() a NEW pin for that client while the visit is still
--      pending. Confirm: the visit's client_lat/client_lng now equal the new pin
--      (keep-fresh), and a collected visit for the same client is unchanged.
--   3. Publish a PO for a client with neither pin. Confirm: client_lat/client_lng
--      are null (mobile falls back to visit GPS / "not set").
-- ============================================================================
