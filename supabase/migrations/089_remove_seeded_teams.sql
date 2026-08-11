-- 089 — Remove the four seeded teams, so every environment starts with none.
--
-- THE DECISION. A team is no longer a thing the schema hands you; it is created
-- when you create the manager who runs it, inline from the Users page
-- ("+ New team…" → createTeam(), app/(admin)/users/actions.ts). Migration 075
-- built that: `kind` became a column, the SALES_TEAM_IDS/RSR_TEAM_IDS arrays
-- went away, and a hand-created team finally showed up in the picker. What 075
-- did not do is remove the four rows that started it all —
--
--   004_seed_teams.sql      1, 2  → 'Team 1'/'Team 2', renamed by 008
--   007_seed_rsr_teams.sql  3, 4  → 'RSR Team 1'/'RSR Team 2'
--
-- — so a fresh database still boots with four teams nobody asked for, and the
-- real org has to work around them. This deletes all four, sales and RSR alike.
--
-- WHY NOT JUST EDIT 004 AND 007. Because editing an applied migration changes
-- nothing where it matters. Production and staging ran those files long ago;
-- the rows are already there and deleting the INSERTs would not remove them. A
-- forward migration is the only thing that reaches every environment, and it
-- also survives replay: on a fresh database 004 and 007 create the four rows
-- and this file removes them again a few steps later. Slightly wasteful, and
-- correct, which is the trade every migration chain makes.
--
-- SCOPE. Only the four seeded UUIDs. A team an admin created through the UI has
-- a random id and is left alone — this file must not become "delete all teams",
-- because it would then do exactly that to whatever exists when it first runs.

-- --- Detach members first ---------------------------------------------------
--
-- profiles.team_id is `REFERENCES teams(id)` with no on-delete clause
-- (001_initial.sql), i.e. RESTRICT — the DELETE below fails outright while any
-- profile still points at one of these rows. Nulling is the intended outcome
-- rather than a workaround: with the seeds gone there is no team for these
-- people to belong to until an admin makes one, and a manager's team is
-- re-assigned through the same Users form that now creates it.
--
-- Scoped to the four seed ids on purpose. `update profiles set team_id = null`
-- unqualified would unassign members of hand-created teams too, silently.

update public.profiles
   set team_id = null
 where team_id in (
   '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000003',
   '00000000-0000-0000-0000-000000000004'
 );

-- --- Then the rows ----------------------------------------------------------
--
-- teams.manager_id → profiles.id (fk_teams_manager, 001_initial) points the
-- other way and needs no clearing; no migration has ever written that column,
-- and lib/teams.ts resolves a team's manager from profiles.team_id instead.

delete from public.teams
 where id in (
   '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000003',
   '00000000-0000-0000-0000-000000000004'
 );

-- --- Say what happened ------------------------------------------------------
--
-- A notice rather than a constraint: how many rows this touched depends on
-- whether the environment had already been cleaned by hand, and neither answer
-- is an error worth aborting a deploy over.

do $$
declare
  v_left integer;
begin
  select count(*) into v_left from public.teams;

  if v_left = 0 then
    raise notice '089: all seeded teams removed; teams is now empty, as intended.';
  else
    raise notice
      '089: seeded teams removed. % hand-created team(s) remain and were deliberately left alone.',
      v_left;
  end if;
end $$;

-- ============================================================================
-- ROLLBACK
--   insert into public.teams (id, name, kind) values
--     ('00000000-0000-0000-0000-000000000001', 'Sales Team 1', 'sales'),
--     ('00000000-0000-0000-0000-000000000002', 'Sales Team 2', 'sales'),
--     ('00000000-0000-0000-0000-000000000003', 'Team 3',       'rsr'),
--     ('00000000-0000-0000-0000-000000000004', 'Team 4',       'rsr')
--   on conflict (id) do nothing;
--
--   Names are the live ones as of 2026-08-11, not the seed files' — 008 renamed
--   1 and 2, and 3 and 4 were renamed by hand to 'Team 3'/'Team 4' at some
--   point. Membership is NOT restored: profiles.team_id was nulled above and
--   which person belonged to which team is not recoverable from this file.
-- ============================================================================
