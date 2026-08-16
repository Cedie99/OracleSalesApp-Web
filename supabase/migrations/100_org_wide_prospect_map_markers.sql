-- ============================================================================
-- 100 (originally numbered 099, renumbered — 099 was already occupied/out
-- of order on remote by the time this deployed) - Org-wide prospect map markers
--
-- Vince direction (2026-08-16): every role with a Maps screen (Sales/RSR,
-- Manager, Executive) should be able to see a NEW, opt-in layer of
-- prospect-status pins across ALL teams, not just their own team/combined
-- scope. Confirmed narrow scope:
--   - all three roles get it, explicitly NOT limited to one
--   - org-wide, NOT team-scoped (the whole point)
--   - visually distinct marker color + a filter toggle, default OFF
--   - ONLY clients.customer_type = 'prospect' — never new/in_progress/
--     existing, never the full client record, just enough to render a pin
--
-- Schema note: this codebase's client "status" language is split across two
-- columns (Database.md / migrations 001, 013, 038, 040):
--   - clients.customer_type — the *lifecycle* status the product spec means
--     by "prospect" (prospect/in_progress/new/existing)
--   - clients.status — the *record* lifecycle (active/inactive/lost/deleted)
-- This RPC filters on customer_type = 'prospect' and excludes lost/deleted
-- records (mirrors the `status not in ('lost','deleted')` guard used
-- throughout the lifecycle RPCs, e.g. 040_four_stage_lifecycle_split_promotion.sql).
--
-- Security note (read before merging): the 2026-07-16 broad "Authenticated
-- read" policy on `clients`/`meetings` (auth.role() = 'authenticated', no
-- team/role scoping — captured as backfill in
-- 022_capture_adhoc_rls_and_storage.sql) is NOT the live state. Migration
-- 030 (030_rls_scoped_read_policies.sql, live 2026-07-26) added real scoped
-- SELECT policies, and Migration 031 (031_drop_broad_read_policies.sql, live
-- the same day, "THE FLIP") dropped the broad ones. The CURRENT live RLS on
-- `clients`/`meetings` SELECT is:
--   - sales_specialist/rsr: own rows only (assigned_agent_id / agent_id)
--   - sales_manager: own team's rows only (is_manager_of_profile())
--   - executive: ALL rows, org-wide, already unrestricted (is_executive())
-- So for sales_specialist/rsr/sales_manager this RPC is a genuine,
-- deliberate bypass of a real per-team RLS boundary — exactly the narrow
-- exception Vince asked for, and exactly why SECURITY DEFINER + an explicit
-- role check are used instead of SECURITY INVOKER. For executive, RLS
-- already permits full org-wide reads of clients directly (`Executives read
-- all clients` policy), so this RPC adds no NEW access for that role — its
-- only value there is the narrower column set (id/lat/lng/label only, vs.
-- the full client row `Executives read all clients` already permits).
-- Please review this characterization directly against the live
-- `pg_policies` dump before merging — it's transcribed from the migration
-- history, not re-verified against production from this sandbox.
--
-- Convention followed: matches 042_manager_approval_feed_rpcs.sql's shape
-- (create or replace function ... language sql ... set search_path = public,
-- revoke from public/anon, grant to authenticated) and reuses the
-- SECURITY DEFINER role-check style from 029_rls_helper_functions.sql's
-- `is_executive()`.
-- ============================================================================

create or replace function public.get_org_wide_prospect_map_markers()
returns table (
  id uuid,
  lat double precision,
  lng double precision,
  label text
)
language sql
security definer
stable
set search_path = public
as $$
  select c.id, c.office_lat, c.office_lng, c.company_name
  from public.clients c
  where c.customer_type = 'prospect'
    and c.status not in ('lost', 'deleted')
    and c.office_lat is not null
    and c.office_lng is not null
    and exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role in ('sales_specialist', 'rsr', 'sales_manager', 'executive')
    );
$$;

revoke execute on function public.get_org_wide_prospect_map_markers() from public, anon;
grant execute on function public.get_org_wide_prospect_map_markers() to authenticated;
