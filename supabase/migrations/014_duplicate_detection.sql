-- ============================================================================
-- 014 — Global company-name uniqueness + duplicate detection (ADR-018)
--
-- PROVENANCE: authored by Vince Carter (mobile lead) and applied directly to
-- the shared Supabase project via the SQL Editor on 2026-07-16. Verified live
-- on 2026-07-21 and committed here retroactively so the repo can reproduce the
-- database. SQL matches the vault's Migration-014-Report.md.
--
-- Behaviour verified against live data 2026-07-21:
--   exact existing name + city            -> is_company_name_available = false
--   "  MKUBUVUV.  " (case/punct variant)  -> false  (normalization works)
--   same name, different city             -> true   (city branching works)
--
-- Replaces the old per-agent constraint: two different agents could previously
-- each create the same company as separate rows.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Normalization — conservative v1: lowercase, trim, collapse every run of
--    punctuation/whitespace to a single space. Deliberately does NOT strip
--    legal suffixes (Inc, Corp) or fuzzy-match, so it can never block two
--    genuinely different companies.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION normalize_company_name(raw text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT trim(regexp_replace(lower(raw), '[^a-z0-9]+', ' ', 'g'));
$$;


-- ----------------------------------------------------------------------------
-- 2. Generated column
--
-- NOTE: the report pairs this with a manual dedupe audit that must be run
-- BEFORE the unique index below, since the index fails to create if duplicates
-- already exist. That audit is an operator step, not a migration step, so it is
-- recorded here as a comment rather than executed:
--
--   SELECT normalized_company_name, city, count(*), array_agg(id)
--   FROM clients WHERE status <> 'deleted'
--   GROUP BY normalized_company_name, city HAVING count(*) > 1;
--
-- Verified clean against live data on 2026-07-21 (zero duplicate groups).
-- ----------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS normalized_company_name text
  GENERATED ALWAYS AS (normalize_company_name(company_name)) STORED;


-- ----------------------------------------------------------------------------
-- 3. Uniqueness on (normalized name, city)
--
--    "Oracle Petroleum" in Bataan and in Pampanga are distinct, valid clients;
--    two identical name+city combinations are blocked.
--
--    Partial (WHERE status <> 'deleted') so a lifecycle-deleted prospect frees
--    its name for reuse, while 'lost' still blocks — that keeps the 14-day
--    reassignment cooldown meaningful.
--
--    NULL city never collides (a UNIQUE index treats NULLs as distinct). Mobile
--    always sends a city, so that is a safety net for legacy/web-created rows,
--    not the primary mechanism.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS unique_company_name_city
  ON clients (normalized_company_name, city)
  WHERE status <> 'deleted';

ALTER TABLE clients DROP CONSTRAINT IF EXISTS unique_company_per_agent;


-- ----------------------------------------------------------------------------
-- 4. Helper RPC so the app makes one clean call instead of re-deriving the
--    normalization client-side for the live availability check.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_company_name_available(p_name text, p_city text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM clients
    WHERE normalized_company_name = normalize_company_name(p_name)
      AND (city IS NOT DISTINCT FROM p_city)
      AND status <> 'deleted'
  );
$$;


-- ============================================================================
-- ROLLBACK
--   DROP INDEX IF EXISTS unique_company_name_city;
--   ALTER TABLE clients DROP COLUMN IF EXISTS normalized_company_name;
--   DROP FUNCTION IF EXISTS normalize_company_name(text);
--   DROP FUNCTION IF EXISTS is_company_name_available(text, text);
--   ALTER TABLE clients ADD CONSTRAINT unique_company_per_agent
--     UNIQUE (company_name, assigned_agent_id);
-- ============================================================================
