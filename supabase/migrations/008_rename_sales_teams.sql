-- Rename 'Team 1'/'Team 2' to 'Sales Team 1'/'Sales Team 2' for clarity,
-- now that RSR Team 1/2 exist alongside them (see 007_seed_rsr_teams.sql).
UPDATE teams SET name = 'Sales Team 1' WHERE id = '00000000-0000-0000-0000-000000000001';
UPDATE teams SET name = 'Sales Team 2' WHERE id = '00000000-0000-0000-0000-000000000002';
