-- ============================================================================
-- 132 — Close anon EXECUTE on SECURITY DEFINER functions in public
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
-- THERE ARE TWO GRANT PATHS, AND BOTH HAVE TO GO. This is what the first
-- attempt at this migration got wrong, and the assertion at the bottom is what
-- caught it:
--
--   1. A DIRECT grant to `anon`. Supabase ships a project-level
--        alter default privileges in schema public
--          grant all on functions to anon, authenticated, service_role;
--      so every function created in `public` is born with one.
--
--   2. The PUBLIC pseudo-role grant. PostgreSQL itself grants EXECUTE to PUBLIC
--      on every new function, and `anon` inherits through it.
--
-- The old pattern (`revoke all ... from public` + `grant ... to authenticated`)
-- removes only #2, leaving #1. Revoking only from `anon` removes only #1,
-- leaving #2 — which is why the first run of this file reported "revoked from
-- 96 routines" and then found 65 still open. `has_function_privilege()` resolves
-- BOTH paths, which is precisely why the check is written against it.
--
-- WHY authenticated/service_role ARE RE-GRANTED FIRST: many of the functions in
-- scope are RLS helpers — `current_profile_id()`, `is_admin()`,
-- `is_manager_of_profile()` — called from inside policy expressions. Several of
-- them hold no direct grant at all and reach `authenticated` only through
-- PUBLIC. Revoking PUBLIC without re-granting first would strip EXECUTE from
-- every policy that calls them and take the entire application down. So each
-- routine's CURRENT effective privilege is read first and re-issued as an
-- explicit grant, then both anon paths are closed. Net effect for a signed-in
-- user: exactly nothing changes.
--
-- WHY TRIGGER FUNCTIONS ARE OUT OF SCOPE: `update_updated_at()`, the `notify_*`
-- and `trg_*` and `rollup_*` families return type `trigger`. PostgREST cannot
-- invoke them as RPCs, so they are not reachable by anon in the first place,
-- and PostgreSQL does not check EXECUTE on a trigger function when the trigger
-- fires. Sweeping them would be churn with a non-zero chance of breaking
-- writes, for no security gain.
--
-- WHY SECURITY INVOKER FUNCTIONS ARE OUT OF SCOPE: they run with the CALLER's
-- privileges, so RLS still applies and anon gets nothing. That is already
-- observable — `get_manager_approval_feed()` and `get_manager_directory()`
-- answer 401 to the anon key today, without any grant change. Only `definer`
-- bypasses RLS, so only `definer` is the vulnerability.
--
-- BLAST RADIUS — please read, mobile:
--
--   * `authenticated` and `service_role` keep every privilege they have today;
--     the sweep re-grants before it revokes. A logged-in mobile or web client
--     sends its user JWT and is `authenticated`, never `anon`.
--   * The only thing that can break is an RPC called with the anon key BEFORE
--     login. Both apps are login-gated end to end and no such call is known. If
--     mobile has one it will start returning 42501 — tell us and we re-grant
--     that single function rather than reverting this.
--   * An anon query against an RLS-protected table may now report 42501
--     ("permission denied for function current_profile_id") instead of an empty
--     result. Both are refusals; only the wording changes. This is already the
--     behaviour for `shares_tag_along_with_current` today.
--   * Sign-in is unaffected; GoTrue does not go through these.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The sweep — SECURITY DEFINER, non-trigger routines in `public`
--
-- `oid::regprocedure` renders a correctly quoted, fully qualified signature, so
-- overloads are handled individually and nothing needs escaping by hand.
--
-- Extension-owned routines are skipped: anything from `create extension`
-- (uuid-ossp, pgcrypto, pg_trgm) belongs to the extension, the migration role
-- may not own it — in which case REVOKE degrades to a WARNING and achieves
-- nothing — and column defaults like uuid_generate_v4() have no business being
-- re-permissioned by an application migration.
--
-- Idempotent: re-granting a held privilege and revoking an absent one are both
-- no-ops, so a re-run changes nothing.
-- ----------------------------------------------------------------------------
do $$
declare
  r record;
  n_total int := 0;
  n_closed int := 0;
begin
  for r in
    select
      p.oid::regprocedure::text as signature,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_had,
      has_function_privilege('service_role',  p.oid, 'EXECUTE') as service_role_had,
      has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_had
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prokind in ('f', 'p')
      -- SECURITY DEFINER only: invoker functions cannot bypass RLS.
      and p.prosecdef
      -- Not a trigger or event-trigger function.
      and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid
          and d.classid = 'pg_proc'::regclass
          and d.deptype = 'e'
      )
  loop
    n_total := n_total + 1;

    -- Preserve current effective access as an EXPLICIT grant, BEFORE the
    -- PUBLIC grant it may depend on is taken away.
    if r.authenticated_had then
      execute format('grant execute on routine %s to authenticated', r.signature);
    end if;
    if r.service_role_had then
      execute format('grant execute on routine %s to service_role', r.signature);
    end if;

    -- Both paths, in one statement: the direct anon grant and the PUBLIC one.
    execute format('revoke all on routine %s from public, anon', r.signature);

    if r.anon_had then
      n_closed := n_closed + 1;
    end if;
  end loop;

  raise notice
    'SECURITY DEFINER routines in public: % examined, % were anon-executable and are now closed',
    n_total, n_closed;
end $$;


-- ----------------------------------------------------------------------------
-- 2. Close the defaults, so the next migration cannot reopen this
--
-- Without this the sweep above is a one-off cleanup that silently rots: the
-- very next `create function` in `public` is born anon-executable again, by
-- both routes.
--
-- BOTH lines are required, for the same reason the sweep needs both. Revoking
-- only the direct anon default would leave the PUBLIC default, and anon would
-- keep inheriting through it — the exact hole this migration exists to close.
--
-- Consequence for future migrations: a new function gets no PUBLIC grant, so it
-- must name its callers explicitly. Supabase's own default still issues direct
-- grants to `authenticated` and `service_role`, so in practice a new function
-- keeps working for signed-in users — but new migrations should keep writing
-- `grant execute ... to authenticated` rather than relying on that.
--
-- NOTE: default privileges attach to the role that CREATES the object. This
-- covers objects created by the role running this migration, which is the role
-- CI uses for `supabase db push`. A function created by some other role would
-- not inherit it, which is the remaining reason to keep naming `anon` and
-- `public` in new migrations' revoke lines rather than relying on this alone.
-- ----------------------------------------------------------------------------
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from public;


-- ----------------------------------------------------------------------------
-- 3. Confirm the fix in the same transaction that made it
--
-- A privilege change that looks correct and does nothing is the exact failure
-- mode that produced this bug — twice. So the migration proves its own result
-- and fails the deploy otherwise.
--
-- `has_function_privilege()` is what makes this check meaningful: it resolves
-- direct grants AND PUBLIC inheritance, so it cannot be satisfied by closing
-- only one of the two paths.
--
-- Scoped to exactly what section 1 swept. Trigger functions and invoker
-- functions are deliberately excluded here too — asserting over them would fail
-- the deploy on routines that were never reachable by anon to begin with.
-- ----------------------------------------------------------------------------
do $$
declare
  still_open text[];
  broke_auth text[];
begin
  select array_agg(p.oid::regprocedure::text)
  into still_open
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.prokind in ('f', 'p')
    and p.prosecdef
    and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
    and not exists (
      select 1 from pg_depend d
      where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
    )
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if still_open is not null then
    raise exception 'anon still holds EXECUTE on % definer routine(s) in public: %',
      array_length(still_open, 1), still_open;
  end if;

  -- The other half of the contract, and the one that would hurt more if it were
  -- wrong: the RLS helpers must still be callable by signed-in users. If the
  -- re-grant above missed anything, fail here rather than discover it as a
  -- site-wide outage.
  select array_agg(fn)
  into broke_auth
  from unnest(array[
    'public.current_profile_id()',
    'public.current_user_role()',
    'public.current_team_id()',
    'public.is_admin()',
    'public.is_manager_of_profile(uuid)'
  ]) as fn
  where to_regprocedure(fn) is not null
    and not has_function_privilege('authenticated', to_regprocedure(fn), 'EXECUTE');

  if broke_auth is not null then
    raise exception 'authenticated LOST EXECUTE on RLS helper(s): % — aborting', broke_auth;
  end if;

  raise notice 'Verified: no definer routine in public is anon-executable; RLS helpers intact.';
end $$;
