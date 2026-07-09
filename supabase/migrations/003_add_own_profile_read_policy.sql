-- Every authenticated user must be able to read their own profile row
-- (role + team_id) so the web app can gate routes/nav by role.
-- Without this, only 'admin' can read profiles at all (see 001_initial.sql),
-- so a sales_manager logging in can't even resolve their own role.
CREATE POLICY "Users can read own profile" ON profiles FOR SELECT
  USING (auth.uid() = user_id);
