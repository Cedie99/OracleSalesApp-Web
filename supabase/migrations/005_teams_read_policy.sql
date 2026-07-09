-- If RLS got enabled on 'teams' (e.g. via the Supabase Table Editor) with no
-- policies, any non-superuser role silently gets 0 rows back (no error),
-- which is why the web app's Team dropdown showed nothing despite the table
-- having data. Team names aren't sensitive, so any logged-in user can read them.
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read teams" ON teams
  FOR SELECT TO authenticated USING (true);
