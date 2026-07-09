-- Add 'rsr_manager' as a distinct role: parallel to sales_manager, but
-- oversees a team of RSRs instead of sales specialists.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'sales_manager', 'sales_specialist', 'rsr_manager', 'rsr', 'collector'));
