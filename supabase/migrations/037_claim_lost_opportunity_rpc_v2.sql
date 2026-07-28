-- ============================================================================
-- 037 - claim_lost_opportunity() v2 (atomic claim)
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-27, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version is created with `supabase migration repair --status applied`,
-- so `supabase db push` skips it. If a push ever tries to EXECUTE this file,
-- stop and fix the repair rather than letting it run.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-037-Report.md
--
-- CREATE OR REPLACE over the 033 stub - same signature, so mobile call sites
-- are unaffected. Must run after 035 and 036.
-- ============================================================================

-- Migration 037: atomic claim. Replaces the Migration 033 stub via CREATE OR REPLACE.
create or replace function public.claim_lost_opportunity(p_client_id uuid)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public
as $$
declare
  caller_id   uuid := public.current_profile_id();
  caller_role text;
  claimed_row public.clients%rowtype;
  diag        record;
begin
  if caller_id is null then
    return jsonb_build_object('ok', false, 'code', 'role_not_eligible');
  end if;

  select role into caller_role
    from public.profiles where id = caller_id and is_active;
  if caller_role is null or caller_role not in ('sales_specialist','rsr') then
    return jsonb_build_object('ok', false, 'code', 'role_not_eligible');
  end if;

  -- ============ THE COMPARE-AND-SWAP ============
  -- Every claimability predicate lives in the WHERE clause of ONE UPDATE.
  update public.client_cycles cc
     set claimed_by = caller_id, claimed_at = now()
   where cc.client_id = p_client_id
     and cc.end_reason = 'lost'
     and cc.claimed_by is null
     and cc.reassignable_at is not null
     and cc.reassignable_at <= now()
     -- PERMANENT exclusion: caller must never have owned ANY cycle of this client.
     and not exists (
           select 1 from public.client_cycles pc
            where pc.client_id = p_client_id
              and pc.owner_id = caller_id);

  if found then
    -- Open the new cycle, reset the client, in the same transaction.
    insert into public.client_cycles (client_id, owner_id, started_at, agenda_policy_version)
      values (p_client_id, caller_id, now(),
              (select policy_version from public.agenda_policy_versions where is_current));

    update public.clients c
       set assigned_agent_id = caller_id,
           status            = 'active',
           customer_type     = 'prospect',
           lost_at           = null,
           reassignable_at   = null,
           inactive_reason   = null,
           in_progress_at    = null,
           current_cycle_id  = (select id from public.client_cycles
                                  where client_id = p_client_id and ended_at is null),
           cycle_started_at  = now()
     where c.id = p_client_id
    returning c.* into claimed_row;

    insert into public.client_reassignment_events
      (client_id, cycle_id, previous_owner_id, new_owner_id, actor_id, kind)
      select p_client_id, current_cycle_id, cc.owner_id, caller_id, caller_id, 'lost_claim'
        from public.client_cycles cc
       where cc.client_id = p_client_id and cc.claimed_by = caller_id and cc.claimed_at = now()
       limit 1;

    return jsonb_build_object('ok', true, 'code', 'claimed', 'client', to_jsonb(claimed_row));
  end if;

  -- ============ DIAGNOSIS (read-only, never grants anything) ============
  select c.status, c.reassignable_at,
         exists (select 1 from public.client_cycles pc
                  where pc.client_id = c.id and pc.owner_id = caller_id) as is_former_owner,
         exists (select 1 from public.client_cycles lc
                  where lc.client_id = c.id and lc.claimed_by is not null
                    and lc.claimed_at >= now() - interval '1 day') as recently_claimed
    into diag
    from public.clients c where c.id = p_client_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found_or_not_lost');
  end if;
  if diag.status <> 'lost' then
    if diag.recently_claimed then
      return jsonb_build_object('ok', false, 'code', 'already_claimed');
    end if;
    return jsonb_build_object('ok', false, 'code', 'not_found_or_not_lost');
  end if;
  if diag.is_former_owner then
    return jsonb_build_object('ok', false, 'code', 'former_owner_excluded');
  end if;
  if diag.reassignable_at is null or diag.reassignable_at > now() then
    return jsonb_build_object('ok', false, 'code', 'cooling_down');
  end if;
  return jsonb_build_object('ok', false, 'code', 'already_claimed');
end;
$$;

revoke execute on function public.claim_lost_opportunity(uuid) from public, anon;
grant execute on function public.claim_lost_opportunity(uuid) to authenticated;
