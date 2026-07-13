-- Add 'superadmin' role: the only role (besides 'admin') allowed to use the
-- web dashboard. Superadmin is the sole role that can create/edit admin and
-- superadmin accounts; admin manages every other (mobile-only) role.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('superadmin', 'admin', 'sales_manager', 'sales_specialist', 'rsr_manager', 'rsr', 'collector'));

DROP POLICY IF EXISTS "Admin full access on profiles" ON profiles;
CREATE POLICY "Admin full access on profiles" ON profiles FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.role IN ('admin', 'superadmin')));

DROP POLICY IF EXISTS "Admin full access on clients" ON clients;
CREATE POLICY "Admin full access on clients" ON clients FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.role IN ('admin', 'superadmin')));

DROP POLICY IF EXISTS "Admin full access on meetings" ON meetings;
CREATE POLICY "Admin full access on meetings" ON meetings FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.role IN ('admin', 'superadmin')));

DROP POLICY IF EXISTS "Admin full access on edit requests" ON client_edit_requests;
CREATE POLICY "Admin full access on edit requests" ON client_edit_requests FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.role IN ('admin', 'superadmin')));

DROP POLICY IF EXISTS "Admin full access on clock records" ON clock_records;
CREATE POLICY "Admin full access on clock records" ON clock_records FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.role IN ('admin', 'superadmin')));
