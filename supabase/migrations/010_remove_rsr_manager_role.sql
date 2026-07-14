-- Client decision: drop the separate 'rsr_manager' role. A single
-- 'sales_manager' role now oversees both sales-specialist teams and RSR
-- teams — the team type is determined by team_id, not by a separate role.
--
-- (Re-saved to trigger the deploy-migrations.yml workflow, which didn't
-- exist yet when this file was first merged.)
UPDATE profiles SET role = 'sales_manager' WHERE role = 'rsr_manager';

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('superadmin', 'admin', 'sales_manager', 'sales_specialist', 'rsr', 'collector'));
