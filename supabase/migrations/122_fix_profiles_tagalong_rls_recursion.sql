-- ============================================================================
-- 122 — fix infinite recursion between profiles and tag_along_requests RLS (42P17)
--
-- REGRESSION introduced by migration 121 (B-131, "Tag-along participants read
-- each other's profile"). That migration added a SELECT policy ON profiles whose
-- USING clause sub-selects FROM tag_along_requests:
--
--     exists (select 1 from public.tag_along_requests t where ...)
--
-- but tag_along_requests already carries a SELECT policy that reads profiles
-- BACK — migration 019's "Participants read own requests":
--
--     requester_id = (select id from profiles where user_id = auth.uid())
--     or invitee_id = (select id from profiles where user_id = auth.uid())
--
-- so the two policies are mutually recursive:
--
--     read profiles → 121's policy scans tag_along_requests
--                   → 019's policy scans profiles
--                   → 121's policy scans tag_along_requests → …
--
-- Postgres aborts with 42P17 "infinite recursion detected in policy for relation
-- profiles". Because permissive SELECT policies are OR'd and the WHOLE statement
-- errors if ANY policy expression throws, EVERY authenticated read of profiles
-- now fails — even the plain "users read own profile" (003) that would otherwise
-- match. In proxy.ts the role lookup AND its same-table fallback both error, role
-- resolves to undefined, and hasWebAccess(undefined) sends every web user —
-- admin and SUPERADMIN included — to /unauthorized. The web app is fully locked.
--
-- THE FIX — identical shape to migration 120 (client_meeting_holders) and 011
-- (the original profiles recursion): route the tag-along check through a
-- SECURITY DEFINER helper, which reads tag_along_requests with RLS BYPASSED, so
-- the leg back into 019's profiles-reading policy is never taken and the cycle
-- cannot form. 121's intent is preserved exactly (either party of a
-- tag_along_requests row may read the other's profile, ungated by status); only
-- the recursion is removed. 019's policy is left untouched.
--
-- Data-safe: policies + one function only, no row is read or written by this
-- migration.
--
-- ⚠️ Merging this to main runs deploy-migrations.yml against the shared project.
-- Depends on: 029 (current_profile_id), 019 (tag_along_requests), 121 (the
-- policy being replaced).
-- ============================================================================

-- SECURITY DEFINER so the tag_along_requests read inside it does NOT re-enter
-- that table's RLS (019's policy), which is the leg that closed the loop.
-- current_profile_id() (029) is itself DEFINER, so it does not re-enter profiles
-- RLS either. STABLE: read-only.
create or replace function public.shares_tag_along_with_current(p_profile_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.tag_along_requests t
    where (t.requester_id = p_profile_id and t.invitee_id = public.current_profile_id())
       or (t.invitee_id = p_profile_id and t.requester_id = public.current_profile_id())
  );
$$;
revoke execute on function public.shares_tag_along_with_current(uuid) from public, anon;
grant execute on function public.shares_tag_along_with_current(uuid) to authenticated;

-- Same policy name and intent as 121, now recursion-free.
drop policy if exists "Tag-along participants read each other's profile" on public.profiles;
create policy "Tag-along participants read each other's profile" on public.profiles
  for select using (
    public.shares_tag_along_with_current(profiles.id)
  );

-- ============================================================================
-- ROLLBACK
--   drop policy if exists "Tag-along participants read each other's profile" on public.profiles;
--   drop function if exists public.shares_tag_along_with_current(uuid);
--   -- (to also restore 121's recursive form, re-create its policy body — but
--   --  that re-introduces the 42P17 lock; do not.)
--
-- Verification (staging):
--   1. As ANY authenticated web user (esp. superadmin), select role from profiles
--      where user_id = auth.uid() — returns the row (previously: 42P17 error).
--   2. As a tag-along invitee outside the meeting agent's team, select from
--      profiles where id = <that agent_id> — returns a row (121's intent holds).
--   3. As an unrelated third profile, the same select returns zero rows.
--   4. Load the web app as superadmin — dashboard loads, no /unauthorized bounce.
-- ============================================================================
