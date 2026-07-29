-- ============================================================================
-- 050 - Authorize reassign_team_client() (P0 security hotfix)
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-28, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version must be created with `supabase migration repair --status applied`
-- before this file is merged, so `supabase db push` skips it. If a push ever
-- tries to EXECUTE this file, stop and fix the repair rather than letting it run.
--
-- NUMBERING: originally documented mobile-side as "Migration 044" before this
-- backfill. Renumbered to 050 on 2026-07-29 - same reconciliation as 049, see
-- that file's header and the vault's
-- projects/OracleSalesApp-Mobile/Migration-050-Report.md for full detail.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-050-Report.md
--
-- Fixes Migration 038 Part C's reassign_team_client(), which shipped as
-- SECURITY DEFINER granted to all authenticated users with NO caller-role or
-- team check. Any authenticated user of any role who knew a client's id and
-- current assigned_agent_id could reassign it to anyone. This adds: mandatory
-- non-empty reason, same-owner rejection, caller-is-manager-of-outgoing-owner
-- check, caller-is-manager-of-incoming-owner check, incoming-owner
-- active/role-eligible check. Vince's locked decision 2026-07-28:
-- admin/superadmin may NOT reassign; managers may reassign only within their
-- own team, enforced via is_manager_of_profile() on both the outgoing and
-- incoming owner.
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

  -- Caller must be a sales_manager AND the outgoing owner must be on their
  -- team. Admin/superadmin fail this by construction (helper requires
  -- role = 'sales_manager'), per Vince's decision 2026-07-28.
  if not public.is_manager_of_profile(p_expected_current_agent_id) then
    return jsonb_build_object('ok', false, 'code', 'role_not_eligible');
  end if;

  -- Incoming owner must be on that same team (same helper, same caller).
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
