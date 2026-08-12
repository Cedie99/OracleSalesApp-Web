-- Sales/RSR requesters need the same offline holder read model as the active
-- Manager(s). The table policy is intentionally participant-scoped, but the
-- generic sync registry can only filter direct columns; this RPC keeps that
-- policy decision server-authoritative without a broad client-side join.
alter table public.client_record_holders
  add column if not exists updated_at timestamptz not null default now();

create or replace function app_private.stamp_client_record_holder_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists stamp_client_record_holder_updated_at on public.client_record_holders;
create trigger stamp_client_record_holder_updated_at
before update on public.client_record_holders
for each row execute function app_private.stamp_client_record_holder_updated_at();

create or replace function public.get_my_client_record_holders()
returns table (
  client_id uuid,
  manager_id uuid,
  manager_name text,
  active boolean,
  origin_team_id uuid,
  updated_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select h.client_id, h.manager_id, h.manager_name, h.active, h.origin_team_id, h.updated_at
  from public.client_record_holders h
  where (select auth.uid()) is not null
    and (
      exists (
        select 1
        from public.clients c
        where c.id = h.client_id
          and c.assigned_agent_id = public.current_profile_id()
      )
      or exists (
        select 1
        from public.client_record_holders mine
        where mine.client_id = h.client_id
          and mine.manager_id = public.current_profile_id()
          and mine.active
      )
    );
$$;

revoke all on function public.get_my_client_record_holders() from public, anon;
grant execute on function public.get_my_client_record_holders() to authenticated;
