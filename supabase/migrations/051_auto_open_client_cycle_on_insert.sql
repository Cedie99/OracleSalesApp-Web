-- ============================================================================
-- 051 - Auto-open a client_cycles row for every newly created client
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-29, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version must be created with `supabase migration repair --status applied`
-- before this file is merged, so `supabase db push` skips it. If a push ever
-- tries to EXECUTE this file, stop and fix the repair rather than letting it run.
--
-- NUMBERING: originally documented mobile-side as "Migration 045" within
-- hours of being written. Renumbered to 051 on 2026-07-29 after discovering
-- web's own 045 (Collection/Delivery client_name/area denormalization)
-- already claimed that number independently - see the vault's
-- projects/OracleSalesApp-Mobile/Migration-051-Report.md for full detail.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-051-Report.md
--
-- Closes the gap where only Migration 035's one-time backfill (2026-07-27)
-- ever populated clients.current_cycle_id. Any client created after that
-- backfill had current_cycle_id = NULL permanently, which silently blocked
-- meetings.cycle_id stamping (trg_stamp_meeting_cycle, Migration 038) and
-- therefore blocked advance_prospect_to_in_progress() (Migration 049) from
-- ever matching, regardless of agenda_ids being correctly populated.
-- ============================================================================

create or replace function public.trg_open_cycle_on_client_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cycle_id uuid;
  v_policy_version int;
begin
  -- Matches Migration 035's own backfill condition: only owned clients get a cycle.
  if new.assigned_agent_id is null then
    return new;
  end if;

  -- Defensive: never double-open a cycle for the same insert.
  if new.current_cycle_id is not null then
    return new;
  end if;

  select policy_version into v_policy_version
    from public.agenda_policy_versions where is_current limit 1;

  insert into public.client_cycles (client_id, owner_id, started_at, agenda_policy_version)
    values (new.id, new.assigned_agent_id, new.created_at, v_policy_version)
    returning id into v_cycle_id;

  update public.clients
    set current_cycle_id = v_cycle_id, cycle_started_at = new.created_at
    where id = new.id;

  return new;
end;
$$;

-- AFTER INSERT (not BEFORE): client_cycles.client_id has a FK to clients.id,
-- so the clients row must already exist before we can insert the child row.
--
-- DROP IF EXISTS first: this trigger is already live on production (applied
-- by hand 2026-07-29, see header note above), so a straight CREATE TRIGGER
-- fails with "already exists" (SQLSTATE 42710) the moment CI tries to
-- back-fill this file via `supabase db push` against a database that
-- already has it. Dropping and recreating the identical trigger definition
-- is a no-op in effect (same function, same timing, same table) and makes
-- this migration safely re-runnable without a manual `migration repair`
-- step, unlike the CREATE OR REPLACE FUNCTION statement above which was
-- already idempotent on its own.
drop trigger if exists open_cycle_on_client_insert on public.clients;
create trigger open_cycle_on_client_insert
  after insert on public.clients
  for each row execute function public.trg_open_cycle_on_client_insert();
