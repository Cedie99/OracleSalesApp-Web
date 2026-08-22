-- ============================================================================
-- 125 — a client record holder can reassign a held client onto their own
-- team (ADR-067 follow-up, Vince 2026-08-22)
--
-- Guest Records originally excluded reassignment entirely (a holder could
-- see a held client's full history and approve edit requests on it, but
-- never move it). Vince corrected this after device testing: a holder
-- should get the SAME functionality a team manager already has for their
-- own team's clients, including reassignment — the one exception is WHERE
-- the client can go: a holder reassigns a held client onto their OWN team
-- (pulling it in), never to an arbitrary agent anywhere in the system.
--
-- migration 050's reassign_team_client() currently authorizes only via
-- is_manager_of_profile(p_expected_current_agent_id) — "caller manages the
-- OUTGOING owner's team". A holder (e.g. manager2, holding a client whose
-- assigned_agent_id belongs to sales1 on a different team) fails that check
-- even after 118/120's RLS already lets them READ the client. This widens
-- the OUTGOING-owner check with an OR arm for holder status, mirroring
-- 118's widening of decide_client_edit_request() -- same shape, same
-- reasoning: an existing authorization check gets ONE more valid path, the
-- original path is untouched.
--
-- The INCOMING-owner check (is_manager_of_profile(p_new_agent_id)) is
-- DELIBERATELY UNCHANGED -- this is what pins "onto the holder's own team"
-- as the only valid destination, since is_manager_of_profile() always
-- checks against the CALLER's own team regardless of which OUTGOING-owner
-- arm passed.
--
-- Reassigning a held client does not touch client_meeting_holders (ADR-067
-- decision 3: holder rows are never removed) -- the (now former) holder
-- keeps holder status even after true ownership moves to their own team,
-- which is harmless (redundant, not incorrect) since they're the new real
-- owner anyway.
-- ============================================================================

create or replace function public.reassign_team_client(
  p_client_id uuid, p_new_agent_id uuid, p_expected_current_agent_id uuid, p_reason text
) returns jsonb
language plpgsql security definer volatile set search_path = public as $$
declare
  updated_row public.clients%rowtype;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'reason_required');
  end if;

  if p_new_agent_id = p_expected_current_agent_id then
    return jsonb_build_object('ok', false, 'code', 'same_owner');
  end if;

  -- Caller must EITHER manage the outgoing owner's team (unchanged, 050),
  -- OR currently hold this client via an accepted meeting-context Tag-Along
  -- invite (ADR-067, new arm). Admin/superadmin still fail both by
  -- construction (is_manager_of_profile requires role='sales_manager';
  -- holder rows are only ever granted to a manager invitee).
  if not (
    public.is_manager_of_profile(p_expected_current_agent_id)
    or exists (
      select 1 from public.client_meeting_holders h
      where h.client_id = p_client_id
        and h.manager_id = public.current_profile_id()
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'role_not_eligible');
  end if;

  -- Incoming owner must be on the CALLER's own team (unchanged, 050) -- this
  -- is what keeps a holder's reassignment scoped to pulling the client onto
  -- their own team, never to an arbitrary agent elsewhere.
  if not public.is_manager_of_profile(p_new_agent_id) then
    return jsonb_build_object('ok', false, 'code', 'new_owner_not_in_team');
  end if;

  -- Incoming owner must be active and hold a client-owning role.
  if not exists (
    select 1 from public.profiles p
     where p.id = p_new_agent_id
       and p.is_active
       and p.role in ('sales_manager','sales_specialist','rsr')
  ) then
    return jsonb_build_object('ok', false, 'code', 'new_owner_not_eligible');
  end if;

  update public.clients
     set assigned_agent_id = p_new_agent_id
   where id = p_client_id
     and assigned_agent_id = p_expected_current_agent_id
     and status <> 'lost'  -- Migration 032 guard, preserved
  returning * into updated_row;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'stale_or_not_permitted');
  end if;

  insert into public.client_reassignment_events
    (client_id, cycle_id, previous_owner_id, new_owner_id, actor_id, kind, reason)
    values (p_client_id, updated_row.current_cycle_id, p_expected_current_agent_id,
            p_new_agent_id, public.current_profile_id(), 'manager_reassignment', p_reason);

  return jsonb_build_object('ok', true, 'code', 'reassigned', 'client', to_jsonb(updated_row));
end; $$;

-- ============================================================================
-- ROLLBACK
--   -- restore migration 050's body verbatim (drop the holder OR-arm) via
--   -- CREATE OR REPLACE; OUT-parameter row type (jsonb) is unchanged, no
--   -- DROP FUNCTION needed either direction.
--
-- Verification (staging):
--   1. As a holder-manager (client_meeting_holders row exists, but caller is
--      NOT is_manager_of_profile(current owner)): call reassign_team_client
--      targeting one of the caller's own team agents -- expect 'reassigned',
--      assigned_agent_id updated, a client_reassignment_events row inserted.
--   2. Same caller, targeting an agent NOT on their own team -- expect
--      'new_owner_not_in_team' (holder status alone must not bypass this).
--   3. An unrelated caller (no holder row, not the outgoing owner's manager)
--      -- expect 'role_not_eligible', unchanged from 050.
--   4. An ordinary same-team manager reassignment (no holder involved) --
--      still succeeds exactly as before, confirming 050's original path is
--      untouched.
-- ============================================================================
