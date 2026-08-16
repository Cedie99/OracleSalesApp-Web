-- ============================================================================
-- 099 - Org-wide prospect map markers
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
-- Security note (read before merging): `public.clients`/`public.meetings`
-- SELECT RLS is already the broad "Authenticated read" policy from the
-- never-numbered 2026-07-16 changes (captured in
-- 022_capture_adhoc_rls_and_storage.sql) — USING (auth.role() = 'authenticated'),
-- with NO team or role scoping at the table level. That policy already lets
-- any authenticated user read every clients/meetings row directly; the
-- team-boundary this feature "bypasses" is enforced only in the mobile app's
-- own queries (e.g. lib/manager-team-map-service.ts scoping by
-- assigned_agent_id), not by RLS. SECURITY DEFINER is used here anyway,
-- deliberately, to add the one restriction the table-level RLS does NOT
-- provide: a role check limited to the roles that actually have a Maps
-- screen. It also narrows the returned columns to pin-rendering fields only
-- (id/lat/lng/label), a stricter surface than "select * from clients" even
-- though RLS alone wouldn't stop that today. Vince: please review whether the
-- broad clients/meetings SELECT policy itself should also be tightened in a
-- follow-up — out of scope for this migration.
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
