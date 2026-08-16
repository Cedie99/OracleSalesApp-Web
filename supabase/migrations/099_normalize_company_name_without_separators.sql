-- Make company identity resistant to separator-only variants:
-- "Test 1", "test1", and "TEST-1" resolve to one canonical key.
-- This migration deliberately stops when legacy data would collide; no client
-- row is deleted or silently merged. Resolve each reported pair first, then
-- rerun the migration.

CREATE OR REPLACE FUNCTION normalize_company_name(raw text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT regexp_replace(lower(raw), '[^a-z0-9]+', '', 'g');
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM clients
    WHERE status <> 'deleted'
    GROUP BY normalize_company_name(company_name), city
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot strengthen company-name normalization: resolve existing separator-only duplicate client names in the same city first.';
  END IF;
END;
$$;

-- Stored generated values are recomputed only when a base column changes.
-- This no-op update refreshes the generated key and its existing unique index
-- after the normalization function changes.
UPDATE clients
SET company_name = company_name
WHERE status <> 'deleted'
  AND normalized_company_name IS DISTINCT FROM normalize_company_name(company_name);
