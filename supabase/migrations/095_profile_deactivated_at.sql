-- `is_active` (002) is a bare boolean: it records THAT an account is off, never
-- since when. The Users page wants to retire accounts that have been inactive
-- for a year, and there was no way to ask that question. This adds the missing
-- timestamp.
--
-- Deliberately NOT a hard delete, now or later. `profiles.id` is the target of
-- ~20 foreign keys (clients.assigned_agent_id, meetings, collection, delivery,
-- quota_policy, cutoff_periods, the activity log). A DELETE either cascades a
-- year of history away or fails on the constraint, and an archived agent's name
-- must still render on last year's reports. Archiving is a *listing* concept:
-- the row stays, the Users page hides it.
--
-- Also NOT a stored `archived` flag or a nightly cron. Archived is a pure
-- function of this timestamp — (not is_active) and deactivated_at < now() - 1yr
-- — so anything that persists it is a second copy that can drift, and a cron is
-- a job that can silently stop. Callers derive it; see ARCHIVE_AFTER_DAYS in
-- lib/users.ts, which must stay in step with the interval documented here.
alter table public.profiles
  add column if not exists deactivated_at timestamptz;

comment on column public.profiles.deactivated_at is
  'When is_active last went false; null while active. Maintained by trigger, not by callers. Drives the Users page archive rule (inactive > 1 year).';

-- Stamped by trigger rather than by the app: mobile's login/suspension check and
-- the web action both read is_active, but either repo — or a hand-edit in the
-- SQL editor — can flip the flag directly. A trigger is the only place that
-- catches every writer.
create or replace function app_private.stamp_profile_deactivated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- An account created already-deactivated starts its clock now.
    if not new.is_active then
      new.deactivated_at := coalesce(new.deactivated_at, now());
    end if;
    return new;
  end if;

  -- Only a transition moves the clock. An unrelated UPDATE (rename, role
  -- change, avatar) on an already-inactive row must not restart the year.
  if old.is_active and not new.is_active then
    new.deactivated_at := now();
  elsif not old.is_active and new.is_active then
    new.deactivated_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists stamp_profile_deactivated_at on public.profiles;
create trigger stamp_profile_deactivated_at
before insert or update on public.profiles
for each row execute function app_private.stamp_profile_deactivated_at();

-- Backfill: rows deactivated before this migration have no timestamp, and
-- leaving them null would read as "active" to every caller. Stamping now()
-- starts their year at deploy rather than archiving the whole backlog on day
-- one — a silent mass-disappearance from the Users page is the worse failure.
update public.profiles
set deactivated_at = now()
where not is_active and deactivated_at is null;
