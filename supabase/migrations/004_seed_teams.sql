-- Seed two real teams with fixed IDs so sales_manager accounts can be
-- assigned a real team_id that matches the demo mock data (see lib/teams.ts).
INSERT INTO teams (id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Team 1'),
  ('00000000-0000-0000-0000-000000000002', 'Team 2')
ON CONFLICT (id) DO NOTHING;
