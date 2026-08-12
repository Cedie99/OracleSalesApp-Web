-- Joint Manager record holders and approval requests (ADR-060).
-- One canonical client remains; holder rows are relationships, not copies.

create table if not exists public.client_record_holders (
  client_id uuid not null references public.clients(id) on delete cascade,
  manager_id uuid not null references public.profiles(id),
  manager_name text,
  origin_team_id uuid references public.teams(id),
  active boolean not null default true,
  assigned_at timestamptz not null default now(),
  primary key (client_id, manager_id)
);
create index if not exists idx_client_record_holders_manager_active
  on public.client_record_holders (manager_id, active, client_id);
alter table public.client_record_holders enable row level security;

create table if not exists public.joint_manager_requests (
  id uuid primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  requester_id uuid not null references public.profiles(id),
  origin_team_id uuid references public.teams(id),
  manager_ids uuid[] not null,
  action_kind text not null default 'holder_assignment',
  action_payload jsonb not null default '{}'::jsonb,
  base_updated_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  required_count smallint not null check (required_count in (1,2)),
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_joint_manager_requests_client_status
  on public.joint_manager_requests (client_id, status);
create index if not exists idx_joint_manager_requests_requester
  on public.joint_manager_requests (requester_id, created_at desc);
alter table public.joint_manager_requests enable row level security;

create table if not exists public.joint_manager_request_decisions (
  request_id uuid not null references public.joint_manager_requests(id) on delete cascade,
  manager_id uuid not null references public.profiles(id),
  decision text not null default 'pending' check (decision in ('pending','approved','declined')),
  decided_at timestamptz,
  primary key (request_id, manager_id)
);
create index if not exists idx_joint_manager_decisions_manager
  on public.joint_manager_request_decisions (manager_id, decision);
alter table public.joint_manager_request_decisions enable row level security;
alter table public.client_record_holders add column if not exists manager_name text;

create schema if not exists app_private;
create or replace function app_private.can_read_client_record(p_client_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select auth.uid() is not null and (exists (
    select 1 from public.clients c where c.id = p_client_id and c.assigned_agent_id = public.current_profile_id()
  ) or exists (
    select 1 from public.client_record_holders h where h.client_id = p_client_id and h.manager_id = public.current_profile_id() and h.active
  ));
$$;
revoke all on function app_private.can_read_client_record(uuid) from public, anon;
grant execute on function app_private.can_read_client_record(uuid) to authenticated;

drop policy if exists "Active record holders read canonical clients" on public.clients;
create policy "Active record holders read canonical clients" on public.clients
  for select to authenticated using (
    app_private.can_read_client_record(id)
  );

alter table public.joint_manager_requests add column if not exists manager_ids uuid[];
alter table public.joint_manager_requests add column if not exists action_kind text not null default 'holder_assignment';
alter table public.joint_manager_requests add column if not exists action_payload jsonb not null default '{}'::jsonb;
alter table public.joint_manager_requests add column if not exists base_updated_at timestamptz;

drop policy if exists "joint holders participants read" on public.client_record_holders;
create policy "joint holders participants read" on public.client_record_holders
  for select to authenticated using (
    app_private.can_read_client_record(client_id)
  );
drop policy if exists "joint requests participants read" on public.joint_manager_requests;
create policy "joint requests participants read" on public.joint_manager_requests
  for select to authenticated using (
    requester_id = public.current_profile_id()
    or exists (select 1 from public.joint_manager_request_decisions d where d.request_id = id and d.manager_id = public.current_profile_id())
  );
drop policy if exists "joint decisions participants read" on public.joint_manager_request_decisions;
create policy "joint decisions participants read" on public.joint_manager_request_decisions
  for select to authenticated using (
    manager_id = public.current_profile_id()
    or exists (select 1 from public.joint_manager_requests r where r.id = request_id and r.requester_id = public.current_profile_id())
  );
drop policy if exists "agents create joint requests" on public.joint_manager_requests;
create policy "agents create joint requests" on public.joint_manager_requests
  for insert to authenticated with check (
    requester_id = public.current_profile_id()
    and exists (select 1 from public.clients c where c.id = client_id and c.assigned_agent_id = public.current_profile_id())
  );

create or replace function public.seed_joint_manager_decisions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if cardinality(new.manager_ids) not between 1 and 2 or exists (
    select 1 from profiles p where p.id = any(new.manager_ids) and (p.role <> 'sales_manager' or not p.is_active)
  ) or (select count(*) from profiles p where p.id = any(new.manager_ids)) <> cardinality(new.manager_ids) then
    raise exception 'invalid manager holder selection';
  end if;
  insert into joint_manager_request_decisions(request_id, manager_id)
    select new.id, unnest(new.manager_ids) on conflict do nothing;
  return new;
end; $$;
drop trigger if exists seed_joint_manager_decisions on public.joint_manager_requests;
create trigger seed_joint_manager_decisions after insert on public.joint_manager_requests
  for each row execute function public.seed_joint_manager_decisions();
drop policy if exists "agents create joint decisions" on public.joint_manager_request_decisions;
create policy "agents create joint decisions" on public.joint_manager_request_decisions
  for insert to authenticated with check (false);
drop policy if exists "agents create joint holders" on public.client_record_holders;
create policy "agents create joint holders" on public.client_record_holders
  for insert to authenticated with check (false);

create or replace function public.create_joint_manager_request(
  p_request_id uuid, p_client_id uuid, p_manager_ids uuid[],
  p_action_kind text default 'holder_assignment', p_action_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker volatile set search_path = public as $$
declare manager_count integer; base_version timestamptz;
begin
  manager_count := coalesce(array_length(p_manager_ids, 1), 0);
  if manager_count not between 1 and 2 or p_manager_ids[1] is null or (manager_count = 2 and p_manager_ids[1] = p_manager_ids[2]) then
    return jsonb_build_object('ok', false, 'code', 'invalid_managers');
  end if;
  if not exists (select 1 from clients where id = p_client_id and assigned_agent_id = current_profile_id()) then
    return jsonb_build_object('ok', false, 'code', 'not_owner');
  end if;
  if p_action_kind <> 'holder_assignment' then return jsonb_build_object('ok', false, 'code', 'unsupported_action'); end if;
  select updated_at into base_version from clients where id = p_client_id;
  insert into joint_manager_requests(id, client_id, requester_id, origin_team_id, manager_ids, required_count, base_updated_at)
    select p_request_id, p_client_id, current_profile_id(), c.team_id, p_manager_ids, manager_count, c.updated_at from clients c where c.id = p_client_id
    on conflict (id) do nothing;
  if not found then return jsonb_build_object('ok', true, 'code', 'already_created'); end if;
  update joint_manager_requests set action_kind = p_action_kind, action_payload = coalesce(p_action_payload, '{}'::jsonb), base_updated_at = base_version where id = p_request_id;
  insert into joint_manager_request_decisions(request_id, manager_id)
    select p_request_id, unnest(p_manager_ids);
  return jsonb_build_object('ok', true, 'code', 'created');
end; $$;

create or replace function public.decide_joint_manager_request(
  p_request_id uuid, p_decision text
) returns jsonb language plpgsql security definer volatile set search_path = public as $$
declare req joint_manager_requests%rowtype; approved_count integer; declined_count integer;
begin
  if p_decision not in ('approved','declined') then return jsonb_build_object('ok', false, 'code', 'invalid_decision'); end if;
  select * into req from joint_manager_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if not exists (select 1 from profiles where id = current_profile_id() and role = 'sales_manager' and is_active) then return jsonb_build_object('ok', false, 'code', 'role_not_eligible'); end if;
  if not exists (select 1 from joint_manager_request_decisions where request_id = p_request_id and manager_id = current_profile_id()) then
    return jsonb_build_object('ok', false, 'code', 'not_eligible');
  end if;
  update joint_manager_request_decisions set decision = p_decision, decided_at = now()
    where request_id = p_request_id and manager_id = current_profile_id() and decision = 'pending';
  if not found then return jsonb_build_object('ok', false, 'code', 'already_decided'); end if;
  select count(*) filter (where decision = 'approved'), count(*) filter (where decision = 'declined') into approved_count, declined_count
    from joint_manager_request_decisions where request_id = p_request_id;
  if declined_count > 0 then update joint_manager_requests set status = 'declined', updated_at = now() where id = p_request_id; return jsonb_build_object('ok', true, 'code', 'declined'); end if;
  if approved_count = req.required_count then
    if exists (select 1 from clients where id = req.client_id and updated_at <> req.base_updated_at) then
      update joint_manager_requests set status = 'declined', updated_at = now() where id = p_request_id;
      return jsonb_build_object('ok', false, 'code', 'base_conflict');
    end if;
    update client_record_holders set active = false where client_id = req.client_id and active;
    insert into client_record_holders(client_id, manager_id, manager_name, origin_team_id)
      select req.client_id, d.manager_id, p.full_name, req.origin_team_id from joint_manager_request_decisions d join profiles p on p.id = d.manager_id where d.request_id = p_request_id
      on conflict (client_id, manager_id) do update set active = true;
    update joint_manager_requests set status = 'approved', applied_at = coalesce(applied_at, now()), updated_at = now() where id = p_request_id;
    return jsonb_build_object('ok', true, 'code', 'approved');
  end if;
  return jsonb_build_object('ok', true, 'code', 'pending');
end; $$;
revoke all on function public.decide_joint_manager_request(uuid, text) from public, anon;
grant execute on function public.decide_joint_manager_request(uuid, text) to authenticated;
revoke all on function public.create_joint_manager_request(uuid, uuid, uuid[], text, jsonb) from public, anon;
grant execute on function public.create_joint_manager_request(uuid, uuid, uuid[], text, jsonb) to authenticated;

create or replace function public.get_manager_joint_requests() returns table (
  id uuid, client_id uuid, requester_id uuid, origin_team_id uuid, manager_ids uuid[], status text,
  required_count smallint, approved_count bigint, declined_count bigint, created_at timestamptz, updated_at timestamptz, applied_at timestamptz
) language sql security definer stable set search_path = public as $$
  select r.id, r.client_id, r.requester_id, r.origin_team_id, r.manager_ids, r.status, r.required_count,
    count(d.*) filter (where d.decision = 'approved'), count(d.*) filter (where d.decision = 'declined'), r.created_at, r.updated_at, r.applied_at
  from joint_manager_requests r join joint_manager_request_decisions d on d.request_id = r.id
  where exists (select 1 from joint_manager_request_decisions mine where mine.request_id = r.id and mine.manager_id = current_profile_id())
  group by r.id;
$$;
revoke all on function public.get_manager_joint_requests() from public, anon;
grant execute on function public.get_manager_joint_requests() to authenticated;

create or replace function public.get_manager_directory() returns table (id uuid, full_name text, team_id uuid)
language sql security definer stable set search_path = public as $$
  select p.id, p.full_name, p.team_id from profiles p
  where p.role = 'sales_manager' and p.is_active
    and exists (select 1 from profiles me where me.id = current_profile_id() and me.role in ('sales_specialist','rsr') and me.is_active);
$$;
revoke all on function public.get_manager_directory() from public, anon;
grant execute on function public.get_manager_directory() to authenticated;

create or replace function public.get_my_holder_clients() returns setof public.clients
language sql security invoker stable set search_path = public as $$
  select c from public.clients c where c.assigned_agent_id = public.current_profile_id() or exists (
    select 1 from public.client_record_holders h where h.client_id = c.id and h.manager_id = public.current_profile_id() and h.active
  );
$$;
grant execute on function public.get_my_holder_clients() to authenticated;
