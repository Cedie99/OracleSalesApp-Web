-- ============================================================================
-- Applied directly by Vince Carter (mobile lead, has Supabase dashboard
-- access) on 2026-07-14, ahead of T-001 (offline SQLite schema) — same
-- pattern as the B-002 is_admin() hotfix: applied first, web team notified
-- after via a summary report, since mobile's business rules (two-phase
-- Create Client, prospect lifecycle, ADR-015 fast path, structured office
-- address) have no home in the current schema and were blocking T-001.
-- Numbered 013 to follow the web repo's own migrations/ sequence (currently
-- up to 012_add_profile_avatars.sql) — renumber if the web team has since
-- added migrations past that.
--
-- Deliberately NOT touched here — separate open questions for the web team:
--   Q1. Is `unique_company_per_agent UNIQUE (company_name, assigned_agent_id)`
--       intentional, or should duplicate company names be blocked GLOBALLY
--       (area-suffix branches like "Oracle Petroleum (Bataan)" excepted)?
--   Q2. Confirm current `clock_records` shape post the
--       guanez-feature-clock-records rework — not touched in this file.
--   Q3. Confirm the `rsr_manager` role removal (migration 010) is final —
--       no role/RLS changes are made here until that's answered, see
--       Database.md's Role enum conflict note.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Two-phase Create Client — make Phase B fields nullable
--    (Phase A only requires company_name; today these are all NOT NULL,
--    so a name-only insert is impossible)
-- ----------------------------------------------------------------------------
ALTER TABLE clients ALTER COLUMN contact_person DROP NOT NULL;
ALTER TABLE clients ALTER COLUMN contact_number DROP NOT NULL;
ALTER TABLE clients ALTER COLUMN customer_type DROP NOT NULL;
ALTER TABLE clients ALTER COLUMN sales_channel DROP NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. Structured office address (confirmed 2026-07-14 — replaces the single
--    free-text office_address column). City is a plain dropdown filtered by
--    the selected province client-side — no province/city columns are
--    derived from address text, so no server-side parsing needed.
-- ----------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_line1 TEXT;   -- street / building
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_line2 TEXT;   -- barangay / subdivision
ALTER TABLE clients ADD COLUMN IF NOT EXISTS landmark TEXT;        -- optional, replaces the originally-proposed "address line 3"
ALTER TABLE clients ADD COLUMN IF NOT EXISTS province TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS city TEXT;

-- Best-effort backfill: put the existing single-line address into address_line1
-- so no data is silently dropped. Province/city/landmark are left NULL —
-- there's no reliable way to split free text into those fields automatically.
-- Guarded with `address_line1 IS NULL` (added 2026-07-21 when this file was
-- committed retroactively): the original ran once against an empty table, but
-- this file is now re-runnable via CI, and without the guard a re-run would
-- clobber structured addresses with the deprecated single-line value.
UPDATE clients SET address_line1 = office_address
  WHERE office_address IS NOT NULL AND address_line1 IS NULL;

-- office_address is intentionally NOT dropped in this migration — keeping it
-- avoids breaking any web-side code that still reads it. Propose dropping it
-- in a follow-up migration once web confirms nothing references it anymore.
ALTER TABLE clients ALTER COLUMN office_address DROP NOT NULL;
COMMENT ON COLUMN clients.office_address IS 'DEPRECATED 2026-07-14 — superseded by address_line1/address_line2/landmark/province/city. Drop once web confirms no remaining references.';


-- ----------------------------------------------------------------------------
-- 3. Prospect lifecycle columns (ADR-006, July 3 business rules)
-- ----------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS details_deadline_at TIMESTAMPTZ;   -- created_at + 1 month; auto-delete trigger if never completed
ALTER TABLE clients ADD COLUMN IF NOT EXISTS details_completed_at TIMESTAMPTZ;  -- anchors the 2-month meeting window + 6-month lost-opp lifespan
ALTER TABLE clients ADD COLUMN IF NOT EXISTS inactive_reason TEXT;              -- required when status is manually set to 'inactive'

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_status_check;
ALTER TABLE clients ADD CONSTRAINT clients_status_check
  CHECK (status IN ('active', 'inactive', 'lost', 'deleted'));


-- ----------------------------------------------------------------------------
-- 4. Meetings — existing-client photo-only fast path (ADR-015, 2026-07-10)
--    Duration calc (end - start) stays a web-side Excel-export concern;
--    mobile only captures + syncs these two timestamps + photos.
-- ----------------------------------------------------------------------------
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS start_photo_url TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS start_captured_at TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS end_photo_url TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS end_captured_at TIMESTAMPTZ;


-- ============================================================================
-- NOT included in this proposal (deliberately):
--   - Any change to the `unique_company_per_agent` constraint (Q1 above)
--   - Any change to clock_records (Q2 above)
--   - Any change to the role enum / rsr_manager (Q3 above)
--   - Dropping office_address (follow-up migration once confirmed unused)
-- ============================================================================
