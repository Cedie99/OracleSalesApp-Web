-- ============================================================================
-- 124 — Store locations: server-side delete of a pin
--
-- Cross-repo feature, web half of STORE_LOCATIONS_CONTRACT.md §delete (owner
-- decision 2026-08-22). Read that contract first.
--
-- THE PROBLEM. Mobile can already delete a wrong/stale pin, but for an
-- ALREADY-PUSHED pin the delete is only a LOCAL soft-tombstone
-- (client_locations.local_deleted = 1): the server row is untouched, so
-- teammates still see the pin and it returns on a fresh reinstall. The contract
-- asks web for a REAL delete so a tombstone can push as a true server delete and
-- the down-sync stops returning the row.
--
-- THE FIX. A single SECURITY DEFINER RPC, same authorization discipline as the
-- other Store Locations writes (113/114/123): a C&D admin, or a field role with
-- the client on their day list, may delete a pin for that client — via
-- can_set_client_location(). A HARD delete is correct here: removing the row
-- means the down-sync's plain SELECT naturally stops returning it (no soft-delete
-- column needed web-side; mobile's local tombstone is a device concern).
--
-- CURRENT-PIN REPLACEMENT. Deleting a store's CURRENT pin must not leave the
-- store with no location. Per the contract: promote the newest remaining
-- RELOCATION as current (a branch is never current), or fall back to the office
-- pin if none remains. Either way the denormalized default coordinate (114) on
-- the client's still-open (pending/partial) visits/POs is re-stamped to match —
-- new current pin if one exists, else clients.office_lat/office_lng — so the map
-- stays correct the same way keep-fresh does. Deleting a NON-current pin (a
-- history entry or a branch) touches nothing else.
--
-- Purely additive: one new function. Depends on 113 (client_locations,
-- can_set_client_location), 114 (client_lat/client_lng keep-fresh), 123 (kind).
--
-- ⚠️ Merging this to main runs deploy-migrations.yml against the shared project.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_client_location(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client      uuid;
  v_was_current boolean;
  v_new_lat     numeric;
  v_new_lng     numeric;
  v_coord_lat   numeric;
  v_coord_lng   numeric;
BEGIN
  SELECT client_id, is_current INTO v_client, v_was_current
    FROM public.client_locations WHERE id = p_location_id;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'location % not found', p_location_id;
  END IF;
  IF NOT public.can_set_client_location(v_client) THEN
    RAISE EXCEPTION 'not authorized to delete a location for this client';
  END IF;

  DELETE FROM public.client_locations WHERE id = p_location_id;

  -- Nothing else to do unless we removed the store's current pin.
  IF NOT v_was_current THEN
    RETURN;
  END IF;

  -- Promote the newest remaining RELOCATION (branches are never current). NULL
  -- if none remains — the store then has no field pin and falls back to office.
  SELECT lat, lng INTO v_new_lat, v_new_lng
    FROM public.client_locations
   WHERE client_id = v_client AND kind = 'relocation'
   ORDER BY seq DESC
   LIMIT 1;

  IF v_new_lat IS NOT NULL THEN
    UPDATE public.client_locations
       SET is_current = true, updated_at = now()
     WHERE id = (
       SELECT id FROM public.client_locations
        WHERE client_id = v_client AND kind = 'relocation'
        ORDER BY seq DESC
        LIMIT 1
     );
  END IF;

  -- Re-stamp the denormalized default coordinate on still-open stops: the new
  -- current pin if one was promoted, else the office pin (114 semantics).
  SELECT COALESCE(v_new_lat, c.office_lat), COALESCE(v_new_lng, c.office_lng)
    INTO v_coord_lat, v_coord_lng
    FROM public.clients c WHERE c.id = v_client;

  UPDATE public.collection_visits
     SET client_lat = v_coord_lat, client_lng = v_coord_lng
   WHERE client_id = v_client AND status IN ('pending', 'partial');

  UPDATE public.purchase_orders
     SET client_lat = v_coord_lat, client_lng = v_coord_lng
   WHERE client_id = v_client AND status IN ('pending', 'partial');
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_client_location(uuid) TO authenticated;

COMMENT ON FUNCTION public.delete_client_location(uuid) IS
  'Store Locations (124): hard-delete a client_locations pin (a wrong/stale one). Authorized for a C&D admin or a field role with the client on their day list. Deleting the current pin promotes the newest remaining relocation (else office-pin fallback) and re-stamps the denormalized default coordinate on still-open visits/POs. See STORE_LOCATIONS_CONTRACT.md §delete.';


-- ============================================================================
-- Rollback (if ever needed):
--   drop function if exists public.delete_client_location(uuid);
--
-- Verification (staging first, TEST clients):
--   1. Delete a NON-current history pin -> row gone; is_current pin unchanged;
--      visits/POs coordinate unchanged.
--   2. Delete the CURRENT pin while a seq-1 relocation still exists -> seq-1
--      becomes current; pending visits/POs client_lat/lng = seq-1 pin.
--   3. Delete the ONLY (current) pin -> no current pin remains; pending
--      visits/POs client_lat/lng fall back to clients.office_lat/office_lng.
--   4. Delete an additional_branch pin -> row gone; current pin + coordinates
--      untouched.
--   5. As a field role whose day list excludes client Y, call
--      delete_client_location(<Y's pin>) -> raises 'not authorized'.
-- ============================================================================
