-- Fix the mutually recursive participant policies introduced by 091.
-- A request policy queried decisions while the decision policy queried
-- requests, causing Postgres to recurse through RLS on every SELECT.

-- This narrowly scoped helper is SECURITY DEFINER only so it can inspect both
-- RLS-protected tables without re-entering either policy. The auth guard,
-- empty search_path, qualified relations, and restricted EXECUTE grant keep
-- it from becoming a general data-access endpoint.
create or replace function app_private.can_read_joint_manager_request(
  p_request_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.joint_manager_requests r
      where r.id = p_request_id
        and (
          r.requester_id = public.current_profile_id()
          or exists (
            select 1
            from public.joint_manager_request_decisions d
            where d.request_id = r.id
              and d.manager_id = public.current_profile_id()
          )
        )
    );
$$;

grant usage on schema app_private to authenticated;
revoke all on function app_private.can_read_joint_manager_request(uuid)
  from public, anon;
grant execute on function app_private.can_read_joint_manager_request(uuid)
  to authenticated;

drop policy if exists "joint requests participants read"
  on public.joint_manager_requests;
create policy "joint requests participants read"
  on public.joint_manager_requests
  for select to authenticated
  using (app_private.can_read_joint_manager_request(id));

drop policy if exists "joint decisions participants read"
  on public.joint_manager_request_decisions;
create policy "joint decisions participants read"
  on public.joint_manager_request_decisions
  for select to authenticated
  using (app_private.can_read_joint_manager_request(request_id));
