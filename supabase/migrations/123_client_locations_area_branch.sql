-- ============================================================================
-- 123 — Store locations: field municipality + relocation-vs-branch intent
--
-- Cross-repo feature, web half of STORE_LOCATIONS_CONTRACT.md §area+branch
-- (owner decision 2026-08-22). Twin of 113/114 — read that contract first.
--
-- TWO additive things the mobile side already built its local half for and is
-- now blocked on:
--
--   1. FIELD-OBSERVED MUNICIPALITY. When a field officer relocates a store they
--      can record the area/province they are actually standing in. This is kept
--      ALONGSIDE the registered (sales/RSR-set) clients.city — never replaces it
--      (the registered value stays authoritative for territory/reporting/RSR
--      assignment). Web stores it here so the admin board + other devices see it;
--      today it lives only on the setting device. area/province are persisted on
--      the client_locations row (contract §area+branch item 1).
--
--      NOTE — a later contract section (§area-autoderive, 2026-08-22) supersedes
--      the TYPED area with a server-side reverse-geocode of the pin. That work
--      (PostGIS psgc_boundaries + resolve_locality) is deliberately NOT in this
--      migration. These columns are exactly where that derived value will land;
--      until then set_client_location() persists whatever the officer typed
--      (p_area/p_province), an interim/override per the contract.
--
--   2. RELOCATION vs. ADDITIONAL BRANCH. Setting a location now carries an
--      INTENT (client_locations.kind):
--        * 'relocation'        — the SAME store moved. Existing field-direct
--                                behaviour: becomes the client's is_current pin
--                                and keeps the denormalized default coordinate
--                                (114) fresh on still-open visits/POs.
--        * 'additional_branch' — a SEPARATE second store at the same client. A
--                                field tap must NOT silently fork a billable
--                                account, so this row is saved NON-current and
--                                flagged: it never becomes is_current and never
--                                re-stamps the visit/PO default coordinate. Admin/
--                                sales later decides if a branch is a real account.
--
-- WRITE-PATH CHANGE. set_client_location() (113, keep-fresh added in 114) gains
-- p_area / p_province / p_kind. The 4-arg form must be DROPPED first: adding
-- defaulted params creates a 7-arg overload, and a 4-positional-arg call (mobile's
-- store-location-push.ts) would then be ambiguous against both. Dropping the old
-- one leaves the new 7-arg function as the sole resolution for a 4-arg call
-- (kind defaults to 'relocation', area/province null) — backward compatible.
--
-- set_current_client_location() (113) also gains a guard: an additional_branch
-- row can never be promoted to current (server-side enforcement of the model,
-- mirroring mobile's "branches aren't re-selectable" rule).
--
-- Purely additive. Depends on 113 (client_locations, set_client_location,
-- can_set_client_location), 114 (client_lat/client_lng keep-fresh).
--
-- ⚠️ Merging this to main runs deploy-migrations.yml against the shared project
-- the mobile app also uses. Tell the mobile team before merging (same as 113/114).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Columns. All additive/nullable except kind, which defaults so existing
--    rows become 'relocation' (they predate branches — every pin set so far was
--    a relocation). CHECK matches mobile's two-value enum.
-- ----------------------------------------------------------------------------
ALTER TABLE client_locations ADD COLUMN IF NOT EXISTS area     text;
ALTER TABLE client_locations ADD COLUMN IF NOT EXISTS province text;
ALTER TABLE client_locations ADD COLUMN IF NOT EXISTS kind     text NOT NULL DEFAULT 'relocation';

-- Add the CHECK separately + idempotently (ADD COLUMN IF NOT EXISTS can't carry
-- one that survives a re-run cleanly, and the column may already exist).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_locations_kind_check'
  ) THEN
    ALTER TABLE client_locations
      ADD CONSTRAINT client_locations_kind_check
      CHECK (kind IN ('relocation', 'additional_branch'));
  END IF;
END $$;

COMMENT ON COLUMN client_locations.area IS
  'Field-observed municipality for this pin (Store Locations, 123). Kept ALONGSIDE the registered clients.city, never replaces it. See STORE_LOCATIONS_CONTRACT.md §area+branch.';
COMMENT ON COLUMN client_locations.province IS
  'Field-observed province for this pin (Store Locations, 123). Companion to area.';
COMMENT ON COLUMN client_locations.kind IS
  'relocation = the same store moved (becomes current); additional_branch = a separate second store at this client, saved non-current and flagged for admin/sales triage (Store Locations, 123).';


-- ----------------------------------------------------------------------------
-- 2. set_client_location() — add p_area / p_province / p_kind and the branch
--    rule. Reproduces 114's body (auth + coord guard + demote/insert +
--    keep-fresh) and branches on p_kind:
--      relocation        -> demote old current, insert is_current = true,
--                           keep-fresh re-stamp still-open visits/POs (as 114).
--      additional_branch -> insert is_current = false, DO NOT demote current,
--                           DO NOT keep-fresh (a branch is not the store's
--                           location). seq still advances so it lists as the
--                           next "Location N".
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_client_location(uuid, numeric, numeric, text);

CREATE OR REPLACE FUNCTION public.set_client_location(
  p_client_id uuid,
  p_lat       numeric,
  p_lng       numeric,
  p_label     text DEFAULT NULL,
  p_area      text DEFAULT NULL,
  p_province  text DEFAULT NULL,
  p_kind      text DEFAULT 'relocation'
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_name    text;
  v_id      uuid;
  v_current boolean := (p_kind = 'relocation');
BEGIN
  IF NOT public.can_set_client_location(p_client_id) THEN
    RAISE EXCEPTION 'not authorized to set a location for this client';
  END IF;

  IF p_kind NOT IN ('relocation', 'additional_branch') THEN
    RAISE EXCEPTION 'invalid kind % (expected relocation | additional_branch)', p_kind;
  END IF;

  IF p_lat IS NULL OR p_lng IS NULL
     OR p_lat < -90 OR p_lat > 90 OR p_lng < -180 OR p_lng > 180 THEN
    RAISE EXCEPTION 'invalid coordinate (lat %, lng %)', p_lat, p_lng;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_profile;

  -- Only a relocation touches the current pin. A branch is saved alongside.
  IF v_current THEN
    UPDATE public.client_locations
       SET is_current = false, updated_at = now()
     WHERE client_id = p_client_id AND is_current;
  END IF;

  INSERT INTO public.client_locations
    (client_id, seq, label, lat, lng, is_current, source, set_by, set_by_name,
     area, province, kind)
  VALUES
    (p_client_id,
     (SELECT COALESCE(MAX(seq), 0) + 1 FROM public.client_locations WHERE client_id = p_client_id),
     p_label, p_lat, p_lng, v_current, 'field_set', v_profile, v_name,
     p_area, p_province, p_kind)
  RETURNING id INTO v_id;

  -- keep-fresh (114) — relocation only. A branch must never re-stamp the store's
  -- default coordinate on its visits/POs.
  IF v_current THEN
    UPDATE public.collection_visits
       SET client_lat = p_lat, client_lng = p_lng
     WHERE client_id = p_client_id AND status IN ('pending', 'partial');

    UPDATE public.purchase_orders
       SET client_lat = p_lat, client_lng = p_lng
     WHERE client_id = p_client_id AND status IN ('pending', 'partial');
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_client_location(uuid, numeric, numeric, text, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.set_client_location(uuid, numeric, numeric, text, text, text, text) IS
  'Store Locations (113/114/123): append the next numbered pin for a client. p_kind=relocation makes it current + keep-fresh (default, backward compatible with the 4-arg call); p_kind=additional_branch saves it non-current and does not touch the default coordinate. p_area/p_province record the field-observed municipality alongside the registered one. See STORE_LOCATIONS_CONTRACT.md §area+branch.';


-- ----------------------------------------------------------------------------
-- 3. set_current_client_location() — guard against promoting a branch. A branch
--    is a separate store, never the client's current location; re-selecting one
--    as current would violate the model. Otherwise identical to 113.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_current_client_location(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client uuid;
  v_kind   text;
BEGIN
  SELECT client_id, kind INTO v_client, v_kind
    FROM public.client_locations WHERE id = p_location_id;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'location % not found', p_location_id;
  END IF;
  IF NOT public.can_set_client_location(v_client) THEN
    RAISE EXCEPTION 'not authorized to set a location for this client';
  END IF;
  IF v_kind = 'additional_branch' THEN
    RAISE EXCEPTION 'an additional_branch pin cannot be made current';
  END IF;

  UPDATE public.client_locations
     SET is_current = false, updated_at = now()
   WHERE client_id = v_client AND is_current;

  UPDATE public.client_locations
     SET is_current = true, updated_at = now()
   WHERE id = p_location_id;
END;
$$;


-- ============================================================================
-- Rollback (if ever needed):
--   -- restore 114's 4-arg set_client_location() and 113's set_current_client_location():
--   drop function if exists public.set_client_location(uuid, numeric, numeric, text, text, text, text);
--   -- (then re-create the 4-arg 114 body and the 113 set_current body)
--   alter table client_locations drop constraint if exists client_locations_kind_check;
--   alter table client_locations drop column if exists kind,
--                                drop column if exists province,
--                                drop column if exists area;
--
-- Verification (staging first, TEST clients):
--   1. set_client_location('X', 14.6, 121.0, 'moved', 'Malolos', 'Bulacan')
--      -> new row is_current, kind='relocation', area='Malolos'; old current demoted;
--         X's pending visits/POs client_lat/lng = new pin (keep-fresh).
--   2. set_client_location('X', 14.7, 121.1, 'branch', 'Guiguinto', 'Bulacan',
--         'additional_branch')
--      -> new row is_current = FALSE, kind='additional_branch'; the seq-1 relocation
--         stays current; X's visits/POs client_lat/lng UNCHANGED (no keep-fresh).
--   3. set_current_client_location('<the branch id>') -> raises
--      'an additional_branch pin cannot be made current'.
--   4. Legacy 4-arg call set_client_location('X', 14.8, 121.2, 'lbl') still works,
--      kind defaults to 'relocation'.
-- ============================================================================
