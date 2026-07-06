-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Teams
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  manager_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Profiles (extends auth.users)
CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'sales_manager', 'sales_specialist', 'rsr', 'collector')),
  team_id UUID REFERENCES teams(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add FK from teams to profiles (manager)
ALTER TABLE teams ADD CONSTRAINT fk_teams_manager
  FOREIGN KEY (manager_id) REFERENCES profiles(id);

-- Clients
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name TEXT NOT NULL,
  contact_person TEXT NOT NULL,
  contact_position TEXT,
  contact_number TEXT NOT NULL,
  office_address TEXT NOT NULL,
  customer_type TEXT NOT NULL CHECK (customer_type IN ('existing', 'new', 'prospect')),
  sales_channel TEXT NOT NULL CHECK (sales_channel IN ('distributor', 'dealer', 'end_user', 'private_label')),
  assigned_agent_id UUID REFERENCES profiles(id) NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lost', 'deleted')),
  lost_at TIMESTAMPTZ,
  reassignable_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_company_per_agent UNIQUE (company_name, assigned_agent_id)
);

-- Client Edit Requests (approval workflow)
CREATE TABLE client_edit_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  requested_by UUID REFERENCES profiles(id) NOT NULL,
  changes JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES profiles(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meetings
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  agent_id UUID REFERENCES profiles(id) NOT NULL,
  recorded_by UUID REFERENCES profiles(id),
  meeting_type TEXT NOT NULL CHECK (meeting_type IN ('f2f', 'online')),
  online_platform TEXT CHECK (online_platform IN ('zoom', 'googlemeet')),
  location_type TEXT NOT NULL CHECK (location_type IN ('client_office', 'other')),
  location_name TEXT,
  gps_lat DOUBLE PRECISION,
  gps_lng DOUBLE PRECISION,
  photo_url TEXT,
  agenda TEXT[] NOT NULL DEFAULT '{}',
  remarks TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('successful', 'follow_up', 'no_decision', 'lost_opportunity')),
  contact_person TEXT NOT NULL,
  contact_position TEXT,
  meeting_date TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Clock Records
CREATE TABLE clock_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID REFERENCES profiles(id) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('office', 'event')),
  action TEXT NOT NULL CHECK (action IN ('in', 'out')),
  gps_lat DOUBLE PRECISION,
  gps_lng DOUBLE PRECISION,
  photo_url TEXT,
  event_name TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at on clients
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-mark lost opportunity client as reassignable after 14 days
CREATE OR REPLACE FUNCTION handle_lost_opportunity()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'lost' AND OLD.status != 'lost' THEN
    NEW.lost_at = NOW();
    NEW.reassignable_at = NOW() + INTERVAL '14 days';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clients_lost_opportunity
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION handle_lost_opportunity();

-- Auto-delete prospects with no meeting after 3 days
CREATE OR REPLACE FUNCTION delete_stale_prospects()
RETURNS void AS $$
BEGIN
  DELETE FROM clients
  WHERE customer_type = 'prospect'
    AND status = 'active'
    AND created_at < NOW() - INTERVAL '3 days'
    AND id NOT IN (SELECT DISTINCT client_id FROM meetings);
END;
$$ LANGUAGE plpgsql;

-- Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_edit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clock_records ENABLE ROW LEVEL SECURITY;

-- Admin sees everything
CREATE POLICY "Admin full access on profiles" ON profiles FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.role = 'admin'));

CREATE POLICY "Admin full access on clients" ON clients FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.role = 'admin'));

CREATE POLICY "Admin full access on meetings" ON meetings FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.role = 'admin'));

CREATE POLICY "Admin full access on edit requests" ON client_edit_requests FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.role = 'admin'));

CREATE POLICY "Admin full access on clock records" ON clock_records FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.role = 'admin'));

-- Sample seed data (run separately if needed)
-- INSERT INTO profiles ...
