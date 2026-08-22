-- ============================================================================
-- 126 — Store locations: pin-derived municipality marker + non-field read path
--
-- Cross-repo feature, web half of STORE_LOCATIONS_CONTRACT.md
-- §visibility+autoderive (owner decision 2026-08-22 — Option 2 + Option 3 as
-- ONE workstream). Read that contract section first. Twin of 113/114/123/124.
--
-- Owner picked the "web-only resolver" the contract recommends: the field
-- municipality is DERIVED FROM THE PIN, not the officer's typed pick. But this
-- project has no PostGIS and no PSGC boundary-polygon dataset, so the literal
-- resolve_locality(lat,lng) point-in-polygon inside set_client_location() is NOT
-- what ships. Instead the derivation runs in the WEB APP LAYER (reuse the
-- existing Nominatim reverse-geocode route + the bundled canonical PSGC dataset),
-- back-filling area/province a few seconds after a pin syncs — exactly the
-- "area confirmed after sync" behaviour the contract's §area-autoderive says to
-- accept. See app/api/geocode/derive-area/route.ts.
--
-- Because the derivation is async and app-layer, this migration deliberately
-- does NOT touch set_client_location() (123) or delete_client_location() (124):
--   * set_client_location() keeps persisting the officer's typed p_area/p_province
--     as an INTERIM/FALLBACK value (shown until the derive pass overwrites it with
--     the canonical PSGC name, and kept as-is if the pin can't be named).
--   * a promoted pin (delete_client_location's fallback) already carries its own
--     derived area from when it was first inserted — nothing to re-derive.
--
-- This migration adds exactly two things, both additive:
--   1. client_locations.area_resolved_at — the marker the derive pass stamps so a
--      pin is attempted once (even existing 123 rows re-derive to canonical once),
--      and an un-nameable pin isn't re-hammered against Nominatim's 1 req/s limit.
--   2. get_client_locations(p_client_id) — a SECURITY DEFINER read path so
--      NON-FIELD roles (sales/RSR/admin) can see a client's field pins. 113's RLS
--      keeps the base table field-role-only; without this, Option 2's admin/sales
--      UI would render nothing (contract §area+branch item 4's read-RLS caveat).
--
-- ⚠️ Merging this to main runs deploy-migrations.yml against the shared project
-- the mobile app also uses. Tell the mobile team before merging (same as 113–124).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Derivation marker. Nullable + additive: every existing 123 row is NULL, so
--    the derive pass picks them up once and canonicalises whatever area the
--    officer typed. Stamped on every attempt (match or not) so a pin Nominatim
--    can't name is tried once, not forever.
-- ----------------------------------------------------------------------------
ALTER TABLE public.client_locations
  ADD COLUMN IF NOT EXISTS area_resolved_at timestamptz;

COMMENT ON COLUMN public.client_locations.area_resolved_at IS
  'When the web derive-area pass last attempted to resolve area/province from this pin (Store Locations, 126). NULL = not yet attempted (the derive route selects these). Stamped even when the pin cannot be named, so it is not retried against Nominatim''s rate limit. See STORE_LOCATIONS_CONTRACT.md §visibility+autoderive.';


-- ----------------------------------------------------------------------------
-- 2. Read path for non-field roles. SECURITY DEFINER so it can read the
--    field-role-only base table (113 RLS) on behalf of sales/RSR/admin, with its
--    own role gate. Signature is fixed by the contract's shared interface so the
--    mobile sales client-detail card calls exactly this. Rows ordered seq ASC.
--
--    Authorization: any authenticated STAFF role. Field pins are low-sensitivity
--    operational data and the whole point of Option 2 is org-wide visibility;
--    gating to the known staff roles (rather than a per-client ownership check)
--    keeps this simple and avoids reimplementing the clients RLS inside a DEFINER
--    function. The registered clients.city stays authoritative for
--    territory/assignment regardless (contract §area+branch item 4).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_client_locations(p_client_id uuid)
RETURNS TABLE (
  id          uuid,
  seq         integer,
  label       text,
  lat         numeric,
  lng         numeric,
  is_current  boolean,
  kind        text,
  area        text,
  province    text,
  set_by_name text,
  captured_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cl.id, cl.seq, cl.label, cl.lat, cl.lng, cl.is_current, cl.kind,
         cl.area, cl.province, cl.set_by_name, cl.captured_at
    FROM public.client_locations cl
   WHERE cl.client_id = p_client_id
     AND public.current_user_role() IN (
       'superadmin', 'admin', 'executive',
       'sales_manager', 'sales_specialist', 'rsr_manager', 'rsr',
       'collector', 'delivery'
     )
   ORDER BY cl.seq ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_client_locations(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_client_locations(uuid) IS
  'Store Locations (126): read a client''s numbered field pins (area/province/kind/who/when) for NON-field roles. 113 RLS keeps the base table field-only; this SECURITY DEFINER fn is the sales/RSR/admin read path for Option 2''s visibility UI. Ordered seq ASC. See STORE_LOCATIONS_CONTRACT.md §visibility+autoderive.';


-- ============================================================================
-- Rollback (if ever needed):
--   drop function if exists public.get_client_locations(uuid);
--   alter table public.client_locations drop column if exists area_resolved_at;
--
-- Verification (staging first, TEST clients):
--   1. As an admin, select * from get_client_locations('<client with pins>')
--      -> returns the numbered pins seq ASC, area/province possibly NULL until
--         the derive pass runs.
--   2. After a pin is inserted (mobile push / set_client_location), the derive
--      route stamps area_resolved_at and sets area/province to a canonical PSGC
--      name; re-selecting shows the derived area.
--   3. A pin at a coordinate Nominatim can't name gets area_resolved_at stamped
--      but area left as the officer's typed value (or NULL) — not re-attempted.
-- ============================================================================
