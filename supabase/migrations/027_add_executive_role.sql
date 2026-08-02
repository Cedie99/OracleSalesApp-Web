-- ============================================================================
-- 027 - Add executive to the profiles.role CHECK constraint
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-23, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version is created with `supabase migration repair --status applied`,
-- so `supabase db push` skips it. If a push ever tries to EXECUTE this file,
-- stop and fix the repair rather than letting it run.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-027-Report.md
--
-- Renumbered from 024 by the vault on 2026-07-25; web had claimed 024 for
-- add_admin_scope. THIS FILE IS THE FIX FOR A REAL INCIDENT: web
-- 023_add_delivery_role.sql rewrote profiles_role_check without knowing
-- executive was a valid value, silently dropped it, and broke the live
-- executive@gmail.com account. Committing it is what stops that recurring.
-- ============================================================================

-- Migration 027 (formerly numbered 024): allow 'executive' as a valid
-- profiles.role value. This is the fix for the incident described above —
-- committing this file is what prevents it from happening again.
alter table public.profiles drop constraint profiles_role_check;

alter table public.profiles add constraint profiles_role_check
  check (role = any (array[
    'superadmin'::text,
    'admin'::text,
    'sales_manager'::text,
    'sales_specialist'::text,
    'rsr'::text,
    'collector'::text,
    'delivery'::text,
    'executive'::text
  ]));
