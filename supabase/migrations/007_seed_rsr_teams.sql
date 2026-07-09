-- Seed two dedicated RSR teams (kept separate from the sales teams in
-- 004_seed_teams.sql) so rsr_manager accounts get a clean, non-mixed team.
INSERT INTO teams (id, name) VALUES
  ('00000000-0000-0000-0000-000000000003', 'RSR Team 1'),
  ('00000000-0000-0000-0000-000000000004', 'RSR Team 2')
ON CONFLICT (id) DO NOTHING;
