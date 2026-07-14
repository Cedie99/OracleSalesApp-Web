-- Profile avatars: mobile users upload their own photo from the app's
-- profile screen; the web shows it in User Management and as the agent's
-- face on map pins.
--
-- 1) profiles.avatar_url — public URL of the uploaded image
-- 2) 'avatars' storage bucket (public read) with per-user write access,
--    path convention: {auth.uid()}/avatar.jpg
-- 3) profiles has never had an update-own-row policy (003 is read-only,
--    011 is admin-only), so a mobile write to avatar_url would silently
--    update 0 rows. Add one — column-restricted so field agents can't
--    change their own role/team_id/is_active.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Own-row update policy (RLS decides WHICH ROWS you may update).
DROP POLICY IF EXISTS "Users update own profile" ON profiles;
CREATE POLICY "Users update own profile" ON profiles
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Column-level grants (grants decide WHICH COLUMNS you may update).
-- Supabase grants authenticated UPDATE on every column by default; narrow
-- it to the self-service ones. Admin/superadmin edits from the web go
-- through the service-role key (app/(admin)/users/actions.ts), which
-- bypasses both RLS and these grants, so they are unaffected.
REVOKE UPDATE ON profiles FROM authenticated;
GRANT UPDATE (avatar_url, full_name) ON profiles TO authenticated;

-- Public avatars bucket. Public read is intentional: map markers and the
-- users table render plain <img> URLs; a profile photo is not sensitive
-- data and signed-URL churn on a map full of markers isn't worth it.
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: anyone can view; users can only write inside their own
-- {user_id}/ folder.
DROP POLICY IF EXISTS "Avatar images are publicly readable" ON storage.objects;
CREATE POLICY "Avatar images are publicly readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Users upload own avatar" ON storage.objects;
CREATE POLICY "Users upload own avatar" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users update own avatar" ON storage.objects;
CREATE POLICY "Users update own avatar" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Users delete own avatar" ON storage.objects;
CREATE POLICY "Users delete own avatar" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
