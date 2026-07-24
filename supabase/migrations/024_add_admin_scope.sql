-- ============================================================================
-- 024 — Categorise admins by business function
--
-- Client decision: 'admin' is too broad. An admin now belongs to one of four
-- categories — Sales Admin, Collection Admin, Delivery Admin, or a plain Admin
-- who oversees everything.
--
-- Deliberately a NEW COLUMN rather than new role values. The obvious modelling
-- (sales_admin / collection_admin / delivery_admin in profiles_role_check) would
-- put three unknown strings into a column the mobile app also reads, and mobile
-- has already hard-crashed the web Users page once by shipping a role web didn't
-- know about ('executive', 2026-07-24 — see roleLabel in lib/permissions.ts).
-- Keeping role = 'admin' means mobile's UserRole union and route guards need no
-- change at all: these accounts look exactly like the admins it already ignores.
--
-- 'all' is the default so every existing admin keeps today's full access, and so
-- a row written by anything that doesn't know about this column stays valid.
--
-- Scope is meaningful only for role = 'admin'. superadmin is always unrestricted
-- and mobile roles never sign in to the web, so both simply stay 'all'.
--
-- Web-side gating on this column is navigation + route guard only (the sidebar
-- and proxy.ts). There is intentionally NO RLS change here: a scoped admin is
-- steered away from pages outside their function, not yet blocked at the data
-- layer. Real enforcement belongs with the backend wiring for Collection and
-- Delivery, whose tables do not exist yet.
--
-- ⚠️ Merging this to main triggers .github/workflows/deploy-migrations.yml,
-- which runs `supabase db push` against the shared project. This one is additive
-- and mobile-neutral — no role values change — but mention it to the mobile team
-- so profiles.admin_scope isn't a surprise in their schema dumps.
-- ============================================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS admin_scope TEXT NOT NULL DEFAULT 'all';

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_admin_scope_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_admin_scope_check
  CHECK (admin_scope IN ('all', 'sales', 'collection', 'delivery'));

-- Anything that isn't a plain admin has no business carrying a narrower scope.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_admin_scope_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_admin_scope_role_check
  CHECK (role = 'admin' OR admin_scope = 'all');

-- Column-level grants: 012 narrowed authenticated UPDATE to the self-service
-- columns. admin_scope is emphatically not one of them — it is set from the web
-- through the service-role key, which bypasses grants and RLS. Restated here so
-- the intent survives the next person reading either migration alone.
REVOKE UPDATE ON profiles FROM authenticated;
GRANT UPDATE (avatar_url, full_name) ON profiles TO authenticated;
