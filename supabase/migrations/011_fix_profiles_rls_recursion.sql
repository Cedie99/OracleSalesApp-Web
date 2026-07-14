-- Fix: "infinite recursion detected in policy for relation profiles" (42P17).
--
-- The "Admin full access on profiles" policy lives ON profiles but its USING
-- clause SELECTs FROM profiles, so evaluating it re-triggers RLS on profiles
-- and Postgres aborts the whole query — even for users whose own-row policy
-- (003) would match. This broke the proxy's role lookup via the anon key and
-- sent every web login (superadmin included) to /unauthorized.
--
-- Standard fix: resolve the caller's role through a SECURITY DEFINER helper,
-- which reads profiles with RLS bypassed, and reference that in the policy.
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE user_id = auth.uid()
$$;

DROP POLICY IF EXISTS "Admin full access on profiles" ON profiles;
CREATE POLICY "Admin full access on profiles" ON profiles FOR ALL
  USING (public.current_user_role() IN ('admin', 'superadmin'));
