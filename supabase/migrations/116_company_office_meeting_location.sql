-- ============================================================================
-- 116 - Company Office meeting location, no geofence (ADR-063)
--
-- Vince, 2026-08-19/20: meeting location only ever offered Client Office /
-- Online / Others. A meeting held at our own company office had nowhere to
-- go. A 50 m geofence was proposed and explicitly CANCELLED (Vince) — it
-- would need a `company_offices` table synced offline, a haversine helper,
-- and a GPS-accuracy tolerance design for indoor accuracy, for a check
-- decided not worth the cost. What ships instead: ONE new location tag,
-- `'company_office'`, no radius validation, no distance shown, no branch
-- list/picker. If it is marked a company-office meeting and the admin can
-- see it on the map, that is sufficient (Vince's own words).
--
-- `meetings_location_type_check` (confirmed live via `pg_constraint`, see
-- Bugs.md B-012) is `('client_office', 'other')` — this widens it to add the
-- third value. Column itself, `location_name`, and every other meetings
-- column are untouched.
--
-- Guard (Office-Location-Spec-2026-07-29, unaffected by this migration):
-- ONLY a `'client_office'` meeting may ever set `clients.office_lat/lng` via
-- the existing Client Office auto-capture path — that logic keys off an
-- exact string match, so a `'company_office'` meeting structurally cannot
-- trip it. Nothing here needs to enforce that separately.
--
-- RENUMBERED 112 -> 116 (2026-08-20): Adrian Guañez took 111-114
-- (guanez-feature-collection / feature/mobile-store-locations, merged to
-- staging while this file sat unpushed) before this was pushed. No content
-- change, number only.
-- ============================================================================

alter table public.meetings
  drop constraint if exists meetings_location_type_check;

alter table public.meetings
  add constraint meetings_location_type_check
  check (location_type in ('client_office', 'company_office', 'other'));

-- ============================================================================
-- ROLLBACK
--   alter table public.meetings drop constraint if exists meetings_location_type_check;
--   alter table public.meetings add constraint meetings_location_type_check
--     check (location_type in ('client_office', 'other'));
--   -- Only safe if no live row has been written with location_type = 'company_office' yet.
--
-- Verification (staging):
--   1. Insert/update a TEST meeting with location_type = 'company_office' —
--      confirm it succeeds (previously: 23514 check violation).
--   2. Confirm location_type = 'client_office' and 'other' are unaffected.
-- ============================================================================
