create table if not exists public.philippines_geocode_cache (
  cache_key text primary key,
  response jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.philippines_geocode_cache enable row level security;
revoke all on public.philippines_geocode_cache from anon, authenticated;

create table if not exists public.philippines_geocode_rate_limit (
  id boolean primary key default true check (id),
  last_request_at timestamptz
);
insert into public.philippines_geocode_rate_limit (id) values (true) on conflict (id) do nothing;

create or replace function public.consume_philippines_geocode_slot()
returns boolean language plpgsql security definer set search_path = public
as $$
declare affected integer;
begin
  update public.philippines_geocode_rate_limit
    set last_request_at = now()
    where id = true and (last_request_at is null or now() - last_request_at >= interval '1 second');
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;
revoke all on function public.consume_philippines_geocode_slot() from public, anon, authenticated;
grant execute on function public.consume_philippines_geocode_slot() to service_role;
