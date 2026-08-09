-- 075 — Teams get a `kind`, so a team is a row rather than a constant.
--
-- THE PROBLEM. The sales/RSR distinction has always existed, but it lived in
-- TypeScript, as four hardcoded UUIDs:
--
--   lib/teams.ts
--     export const SALES_TEAM_IDS = [TEAM_1_ID, TEAM_2_ID]
--     export const RSR_TEAM_IDS   = [TEAM_RSR_1_ID, TEAM_RSR_2_ID]
--
--   app/(admin)/users/page.tsx
--     const availableTeams = teams.filter(t => teamIdsForRole(form.role).includes(t.id))
--
-- Read those two together and the consequence is worse than "an admin has to
-- write SQL to add a team": an admin who DID write the SQL would get a team the
-- picker refuses to show, because its id is not in the array. Adding a team took
-- a migration, a code change, and a deploy. That is the bug this fixes.
--
-- It is also why migration 074 had nothing to say about a sales_manager's visit
-- limit. The rule the supervisor wants — a manager is capped like the team they
-- run, sales manager to sales, sales manager to RSR — is not expressible while
-- the only record of a team's kind is a constant the database cannot read. With
-- `kind` here, `cap = the cap of my team's kind` becomes a join. That change is
-- 076's, deliberately kept separate; this migration adds the fact, and nothing
-- reads it for attribution yet.
--
-- Not a data migration in any risky sense: one column, backfilled, then made
-- NOT NULL. Additive and idempotent, drops nothing.

-- --- The column -------------------------------------------------------------
--
-- Added nullable so the backfill below has somewhere to write. It becomes NOT
-- NULL at the end of this file, once every row has a value — a team whose kind
-- is unknown is not a state any caller should have to handle, since `kind` is
-- what decides both who may join the team and (from 076) which ceiling its
-- manager is measured against.

alter table public.teams
  add column if not exists kind text;

-- --- Backfill, in three passes, most trustworthy first ----------------------

-- Pass 1: the seeded teams. 004_seed_teams.sql created 1 and 2 for sales,
-- 007_seed_rsr_teams.sql created 3 and 4 for RSR, with fixed UUIDs precisely so
-- the app could recognise them. This is that recognition, moved into the row.
update public.teams
   set kind = 'sales'
 where kind is null
   and id in (
     '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000002'
   );

update public.teams
   set kind = 'rsr'
 where kind is null
   and id in (
     '00000000-0000-0000-0000-000000000003',
     '00000000-0000-0000-0000-000000000004'
   );

-- Pass 2: anything created by hand since. The web app could not have made these
-- (no create-team UI existed until now), so they came from the Supabase table
-- editor or a mobile-side script, and their ids are unknown here. Their members
-- give them away: rsr and sales_specialist can only belong to a team of their
-- own kind, so a single rsr member settles it.
--
-- `sales_manager` is deliberately NOT consulted. Since migration 010 folded
-- rsr_manager into sales_manager, a manager's role says nothing about which kind
-- of team they run — that is the whole reason this column has to exist.
update public.teams t
   set kind = case
     when exists (
       select 1 from public.profiles p
        where p.team_id = t.id and p.role = 'rsr'
     ) then 'rsr'
     else 'sales'
   end
 where t.kind is null
   and exists (
     select 1 from public.profiles p
      where p.team_id = t.id
        and p.role in ('rsr', 'sales_specialist')
   );

-- Pass 3: an empty team of unknowable kind. 'sales' is a guess, and it is
-- announced as one rather than made silently — an admin can change it in the UI,
-- and an empty team has no members to mis-scope in the meantime.
do $$
declare
  v_guessed integer;
begin
  update public.teams set kind = 'sales' where kind is null;
  get diagnostics v_guessed = row_count;

  if v_guessed > 0 then
    raise notice
      '075: % team(s) had no sales_specialist/rsr members and were defaulted to kind=sales. Check them in Users → Team.',
      v_guessed;
  end if;
end $$;

-- --- Lock it down -----------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.teams'::regclass
       and conname  = 'teams_kind_check'
  ) then
    alter table public.teams
      add constraint teams_kind_check check (kind in ('sales', 'rsr'));
  end if;
end $$;

alter table public.teams
  alter column kind set not null;

comment on column public.teams.kind is
  'Whether this is a sales team or an RSR team. Decides which roles may join it (sales_specialist vs rsr) and, from migration 076, which per-client visit ceiling its sales_manager is measured against. Replaces the hardcoded SALES_TEAM_IDS/RSR_TEAM_IDS arrays that used to live in lib/teams.ts.';

-- --- One team per name ------------------------------------------------------
--
-- Now that names are typed by an admin rather than seeded, two teams called
-- "Team 3" are a real possibility, and the picker shows nothing but the name —
-- so the duplicate would be indistinguishable on screen. Case-insensitive
-- because "RSR Team 1" and "rsr team 1" are the same team to everyone but
-- Postgres.
--
-- Guarded rather than created outright: this file cannot see the live table, and
-- a pre-existing duplicate would abort the whole migration over a naming nicety.
-- If one exists, the index is skipped with a notice and the rest still applies.
do $$
declare
  v_dupes integer;
begin
  select count(*) into v_dupes
    from (
      select lower(name) from public.teams group by lower(name) having count(*) > 1
    ) d;

  if v_dupes > 0 then
    raise notice
      '075: % duplicate team name(s) already exist, so teams_name_unique was NOT created. Rename them and re-run this file.',
      v_dupes;
  else
    create unique index if not exists teams_name_unique on public.teams (lower(name));
  end if;
end $$;

-- --- Writes stay off the client --------------------------------------------
--
-- No INSERT/UPDATE policy is added on purpose. 005_teams_read_policy.sql gave
-- this table a SELECT policy and nothing else, and team creation runs through
-- createTeam() in app/(admin)/users/actions.ts on the service-role key, behind
-- the same requireCallerIsSuperadmin() gate as createUser(). Adding a write
-- policy here would open a second path to the same table with weaker checks.
--
-- teams.manager_id is likewise left alone: no migration has ever written it, and
-- lib/teams.ts resolves a team's manager from profiles.team_id instead. Starting
-- to write it now would create a second source of truth that could disagree.

-- ============================================================================
-- ROLLBACK
--   drop index if exists public.teams_name_unique;
--   alter table public.teams drop constraint if exists teams_kind_check;
--   alter table public.teams drop column if exists kind;
-- ============================================================================
