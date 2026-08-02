-- ============================================================================
-- 023 — Add the 'delivery' role
--
-- Delivery is its own mobile-app role, parallel to 'collector': the Collection
-- and Delivery modules (F-007) are worked by different people on the phone, and
-- until now delivery personnel had no role to be assigned. Web previously had to
-- infer who was doing deliveries from the purchase-order data itself.
--
-- Roles on this table are a CHECK constraint, not a Postgres enum (see 001, and
-- 006/009/010 for the add/remove precedent), so the constraint is dropped and
-- re-added with the full list. Keep the list below in sync with:
--   - web:    types/index.ts UserRole, lib/permissions.ts ROLE_LABEL
--   - mobile: types/index.ts UserRole union + role-based routing
--
-- 'delivery' is NOT added to WEB_ROLES — like every non-admin role it signs in
-- through the mobile app only. No RLS change is needed yet because the delivery
-- tables (purchase_orders et al) do not exist; when they land, they need their
-- own policies granting delivery personnel access to their assigned POs.
--
-- ⚠️ Merging this to main triggers .github/workflows/deploy-migrations.yml,
-- which runs `supabase db push` against the shared project that the mobile app
-- also uses. Coordinate with the mobile team before merging: adding a value to
-- the constraint is backwards-compatible on its own, but mobile's UserRole union
-- and route guards must handle 'delivery' before such accounts are created.
-- ============================================================================

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('superadmin', 'admin', 'sales_manager', 'sales_specialist', 'rsr', 'collector', 'delivery'));
