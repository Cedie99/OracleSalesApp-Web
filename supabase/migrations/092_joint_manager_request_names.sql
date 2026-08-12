-- Manager inbox must not call the Sales/RSR-only directory RPC. Return the
-- authorized participant names alongside each inbox request instead.
create or replace function public.get_manager_joint_requests() returns table (
  id uuid, client_id uuid, requester_id uuid, origin_team_id uuid, manager_ids uuid[], manager_names text[], status text,
  required_count smallint, approved_count bigint, declined_count bigint, created_at timestamptz, updated_at timestamptz, applied_at timestamptz
) language sql security definer stable set search_path = public as $$
  select r.id, r.client_id, r.requester_id, r.origin_team_id, r.manager_ids,
    (select coalesce(array_agg(p.full_name order by array_position(r.manager_ids, p.id)), '{}')::text[]
       from profiles p where p.id = any(r.manager_ids)),
    r.status, r.required_count,
    count(d.*) filter (where d.decision = 'approved'), count(d.*) filter (where d.decision = 'declined'), r.created_at, r.updated_at, r.applied_at
  from joint_manager_requests r
  join joint_manager_request_decisions d on d.request_id = r.id
  where exists (select 1 from joint_manager_request_decisions mine where mine.request_id = r.id and mine.manager_id = current_profile_id())
  group by r.id;
$$;
revoke all on function public.get_manager_joint_requests() from public, anon;
grant execute on function public.get_manager_joint_requests() to authenticated;
