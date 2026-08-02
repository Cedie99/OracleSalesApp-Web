-- ============================================================================
-- 045 — Denormalize the customer name onto the published day lists
--
-- NUMBERING: 045 follows web's own 043/044. Mobile proposed this number in
-- their WEB_FIXES_NEEDED_FOR_SYNC.md, so it is not one of the 025-042 range
-- claimed by the mobile side. See the header of 043 before renumbering.
--
-- WHY THIS EXISTS: `collection_visits` and `purchase_orders` reference the
-- customer only by `client_id`. Migration 031 dropped the broad
-- "Authenticated read clients" policy, and the four scoped SELECT policies that
-- replaced it (030) cover agents, managers, executives and tag-along
-- participants — NOT the `collector` or `delivery` roles. So a phone logged in
-- as a collector or driver can read the list row but cannot resolve its
-- client_id to a name: every row renders a blank customer. This blocks mobile
-- from reading the live lists at all.
--
-- The fix is denormalization rather than a new RLS policy on `clients`, and
-- that is deliberate. Field roles have no business reading the customer
-- master — contacts, assigned agent, lifecycle status, the lot — just to put a
-- name on a stop. The admin already knows the name at the moment they publish
-- the row, so the name travels ON the row. 030's scoping stays intact.
--
-- CONSEQUENCE: these columns are a point-in-time copy, not a live mirror. A
-- customer later renamed in `clients` keeps the old name on rows already
-- published. That is the correct behaviour here — the trip ticket should say
-- what it said on the day it was worked — but it does mean web must keep
-- reading the joined `clients` row for anything current-state.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Columns
-- ----------------------------------------------------------------------------

-- Nullable, and staying that way: mobile pushes rows through its offline
-- outbox, and a NOT NULL here would turn a missing denormalized field into a
-- failed insert instead of a visibly incomplete row.
ALTER TABLE collection_visits ADD COLUMN IF NOT EXISTS client_name TEXT;
-- Collection has no area column of its own (unlike delivery, where the admin
-- types one). Sourced from `clients.city` — the coarse locality the collector
-- needs to group their trip.
ALTER TABLE collection_visits ADD COLUMN IF NOT EXISTS area TEXT;

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS client_name TEXT;
-- NOTE: purchase_orders.area already exists (044) and is admin-entered on the
-- form, so it is deliberately NOT touched here.

COMMENT ON COLUMN collection_visits.client_name IS
  'Customer name copied from clients.company_name when the admin published this store. Denormalized because collector/delivery roles have no RLS read on clients (030/031). Point-in-time, not a live mirror.';
COMMENT ON COLUMN collection_visits.area IS
  'Locality copied from clients.city at publish time. Collection has no admin-entered area field; this is the collector-facing grouping.';
COMMENT ON COLUMN purchase_orders.client_name IS
  'Customer name copied from clients.company_name when the admin published this PO. Same reasoning as collection_visits.client_name.';

-- ----------------------------------------------------------------------------
-- 2. Backfill rows already published
--
-- Migrations run with full access, so this join reaches `clients` even though
-- the field roles cannot. COALESCE on area preserves anything already set
-- rather than overwriting it.
-- ----------------------------------------------------------------------------

UPDATE collection_visits v
SET client_name = c.company_name,
    area        = COALESCE(v.area, c.city)
FROM clients c
WHERE c.id = v.client_id;

UPDATE purchase_orders p
SET client_name = c.company_name
FROM clients c
WHERE c.id = p.client_id;
