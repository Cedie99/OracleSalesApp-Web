-- ============================================================================
-- 132 — Revoke EXECUTE from `anon` on every function in public
--
-- SECURITY FIX. Read this before writing another SECURITY DEFINER function.
--
-- WHAT WAS WRONG: `get_clients_overview()` and `get_clients_page()` (131) and
-- `get_company_directory()` (030) were callable with the ANON key — no login,
-- no session — and being SECURITY DEFINER they ran as the owner and returned
-- real data straight past RLS. The anon key ships in the browser bundle by
-- design (NEXT_PUBLIC_SUPABASE_ANON_KEY), so this needed no credential at all.
-- Confirmed against a live database: the `clients` table correctly refused the
-- same key with 42501, while the RPC answered 200 with the full company
-- hierarchy. `get_clients_page()` is the worst of them — every parameter has a
-- default, so a bare call works, and its rows carry email, full_name, role,
-- credit_balance, office_lat/office_lng, city, province and landmark.
--
-- WHY THE EXISTING PATTERN DID NOT PREVENT IT:
--
--     revoke all on function ... from public;
--     grant execute on function ... to authenticated;
--
-- That looks airtight and is not. Supabase ships a project-level
--
--     alter default privileges in schema public
--       grant all on functions to anon, authenticated, service_role;
--
-- so every function created in `public` is born with a DIRECT grant to `anon`.
-- `revoke ... from public` drops only the PUBLIC pseudo-role's grant; it does
-- not touch a direct grant to a named role. The `grant ... to authenticated`
-- line then reads like the whole access policy while `anon` quietly keeps its
-- own. Migration 090 is the only file in this repo that ever got this right,
-- and it did so by naming anon explicitly:
--
--     revoke all on function ... from public, anon, authenticated;
--
-- 131 inherited the broken shape from 030 by copying it. Both are fixed here.
--
-- WHY A SWEEP RATHER THAN THREE NAMED REVOKES: the defect is not in those three
-- functions, it is in the default. An audit found four data-returning functions
-- already exposed (the three above plus `get_my_cutoff_usage_summary`) and four
-- more definer helpers (`current_admin_scope`, `current_profile_id`,
-- `current_user_role`, `current_team_id`). Fixing only what we happened to
-- notice leaves the rest, so this revokes across the schema and then closes the
-- default so the NEXT function cannot reopen it.
--
-- BLAST RADIUS — please read, mobile:
--
--   * Only `anon` is touched. `authenticated` and `service_role` keep every
--     grant they had, so nothing a signed-in user does changes. A logged-in
--     mobile or web client sends its user JWT and is `authenticated`, not
--     `anon`.
--   * The only thing that breaks is an RPC called with the anon key BEFORE
--     login. Both apps are login-gated end to end and no such call is known.
--     If mobile has one, it will start returning 42501 — tell us and we will
--     re-grant that single function rather than reverting this.
--   * Sign-in itself is unaffected: GoTrue does not go through these.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The three named in the report, revoked explicitly
--
-- Redundant with the sweep below, and kept anyway: an explicit line naming the
-- function that leaked is what a reader looks for when they come back to this
-- file, and it documents the fix independently of the loop working.
-- ----------------------------------------------------------------------------
revoke all on function public.get_clients_overview(text, text, text, text, text)
  from public, anon;

revoke all on function public.get_clients_page(text, text, text, text, text, text, text, text[], int, int)
  from public, anon;

revoke all on function public.get_company_directory()
  from public, anon;


-- ----------------------------------------------------------------------------
-- 2. The sweep — every routine in `public`
--
-- `oid::regprocedure` renders a correctly quoted, fully qualified signature, so
-- overloads are handled individually and no name needs escaping by hand.
-- ON ROUTINE rather than ON FUNCTION so procedures (prokind 'p') are covered
-- too.
--
-- Extension-owned routines are skipped. Anything installed by `create
-- extension` (uuid-ossp, pgcrypto, pg_trgm) belongs to the extension, not to
-- us: the migration role may not own it, in which case REVOKE degrades to a
-- WARNING and achieves nothing, and column defaults like uuid_generate_v4()
-- have no business being re-permissioned by an application migration anyway.
--
-- Idempotent: revoking a privilege that is not held is a no-op, so a re-run is
-- harmless.
-- ----------------------------------------------------------------------------
do $$
declare
  r record;
  revoked int := 0;
begin
  for r in
    select p.oid::regprocedure::text as signature
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prokind in ('f', 'p')
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid
          and d.classid = 'pg_proc'::regclass
          and d.deptype = 'e'
      )
  loop
    execute format('revoke all on routine %s from anon', r.signature);
    revoked := revoked + 1;
  end loop;

  raise notice 'Revoked EXECUTE from anon on % routine(s) in schema public', revoked;
end $$;


-- ----------------------------------------------------------------------------
-- 3. Close the default, so the next migration cannot reopen this
--
-- Without this, the very next `create function` in `public` is born
-- anon-executable again and the sweep above becomes a one-off cleanup that
-- silently rots. This counters Supabase's project default for functions created
-- by the role running migrations.
--
-- Scoped deliberately narrowly: FUNCTIONS only, schema `public` only, role
-- `anon` only. Tables, views and sequences are untouched — those are governed
-- by RLS, which is working correctly (it is what refused the `clients` read
-- while the RPC answered).
--
-- NOTE: default privileges attach to the role that CREATES the object. This
-- covers objects created by the role running this migration, which is the same
-- role CI uses for `supabase db push`. A function created by a different role
-- would not inherit it — which is the remaining reason to keep naming `anon` in
-- new migrations' revoke lines rather than relying on this alone.
-- ----------------------------------------------------------------------------
alter default privileges in schema public revoke execute on functions from anon;


-- ----------------------------------------------------------------------------
-- 4. Confirm the fix in the same transaction that made it
--
-- A migration that silently did nothing is the failure mode worth guarding
-- against here, given the first attempt at this also looked correct. If any
-- application routine is still anon-executable, fail the deploy rather than
-- report success. Extension routines are excluded for the reason above.
-- ----------------------------------------------------------------------------
do $$
declare
  still_open text[];
begin
  select array_agg(p.oid::regprocedure::text)
  into still_open
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.prokind in ('f', 'p')
    and not exists (
      select 1 from pg_depend d
      where d.objid = p.oid
        and d.classid = 'pg_proc'::regclass
        and d.deptype = 'e'
    )
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if still_open is not null then
    raise exception
      'anon still holds EXECUTE on % routine(s) in public: %',
      array_length(still_open, 1), still_open;
  end if;

  raise notice 'Verified: anon holds EXECUTE on no routine in schema public.';
end $$;
