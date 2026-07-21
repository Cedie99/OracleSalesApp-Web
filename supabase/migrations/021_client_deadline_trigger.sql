-- ============================================================================
-- 021 — Client info-completion deadline: backfill + trigger
--
-- PROVENANCE: authored by Vince Carter (mobile lead) 2026-07-21. Unlike
-- 013-020, this one is **genuinely not yet applied** — web verified against
-- live data on 2026-07-21 and found details_deadline_at NULL on all 26 client
-- rows. This is therefore the first migration in the series to reach the
-- database through this repo's CI pipeline rather than the SQL Editor.
-- SQL matches the vault's Migration-021-Report.md.
--
-- THE GAP: the "1-month rule" deadline (surfaced on My Clients as
-- "Deadline N days left") was never actually written by anything. The column
-- has existed since 013 but no code path, local or remote, ever set a value —
-- so the deadline UI correctly rendered nothing. Not a UI bug; missing data.
--
-- Mobile shipped its own fix the same day: lib/client-service.ts::createClient()
-- now computes details_deadline_at = created_at + 30 days at creation time.
-- That is a static value assigned once, not a reactive lifecycle automation
-- (contrast ADR-027's prospect->new promotion, which genuinely had to be
-- server-side because it reacts to async, possibly cross-device conditions),
-- so computing it on the same device that creates the row is safe.
--
-- This migration is still needed because that fix only runs at creation time
-- on mobile: it cannot retroactively fix rows that already exist, and it does
-- not cover rows created from the web dashboard or any future non-mobile insert
-- path. The deadline should never be solely a mobile-client responsibility.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Backfill rows that never got a deadline. Naturally idempotent — the WHERE
--    clause excludes anything already carrying a value.
-- ----------------------------------------------------------------------------
UPDATE public.clients
SET details_deadline_at = created_at + interval '30 days'
WHERE details_deadline_at IS NULL;


-- ----------------------------------------------------------------------------
-- 2. Trigger: set the deadline on every new row, mirroring
--    lib/client-service.ts::createClient()'s exact formula so mobile-created
--    and web-created rows never disagree.
--
--    The `IS NULL` guard means mobile's own already-computed value (sent up via
--    the outbox insert) is respected as-is; the trigger only fills the gap for
--    inserts that do not provide one.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_client_deadline()
RETURNS trigger AS $$
begin
  if new.details_deadline_at is null then
    -- coalesce added by web 2026-07-21 (deviation from the report's SQL):
    -- clients.created_at is nullable with a DEFAULT, so an explicit
    -- `created_at = NULL` insert would otherwise yield a NULL deadline — the
    -- exact gap this migration exists to close. Flagged to Vince for review.
    new.details_deadline_at := coalesce(new.created_at, now()) + interval '30 days';
  end if;
  return new;
end;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_client_deadline ON public.clients;
CREATE TRIGGER trg_set_client_deadline
  BEFORE INSERT ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.set_client_deadline();


-- ============================================================================
-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_set_client_deadline ON public.clients;
--   DROP FUNCTION IF EXISTS public.set_client_deadline();
--   -- backfilled values are left in place; clearing them would re-break the
--   -- deadline UI for every existing row.
-- ============================================================================
