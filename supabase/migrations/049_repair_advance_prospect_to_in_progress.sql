-- ============================================================================
-- 049 - Repair advance_prospect_to_in_progress() type-invalid join (P0 hotfix)
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
-- NUMBERING: originally documented mobile-side as "Migration 043" before this
-- backfill. Renumbered to 049 on 2026-07-29 after discovering web's own
-- 043-047 (Collection/Delivery/notifications) already claimed those numbers
-- independently. No SQL/schema conflict existed (disjoint tables) - this was
-- a documentation/label collision only. See the vault's
-- projects/OracleSalesApp-Mobile/Migration-049-Report.md for full detail,
-- including the renumbering note and why the collision was safe.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-049-Report.md
--
-- Fixes Migration 040's advance_prospect_to_in_progress(), which shipped with
-- `ac.policy_version = c.cycle_started_at is not null` - Postgres parses this
-- as `(integer = timestamptz) IS NOT NULL`, a type-invalid comparison. Because
-- promote_on_successful_meeting is an AFTER INSERT trigger on meetings, every
-- successful-meeting insert aborted and rolled back while this was live.
-- ============================================================================

create or replace function public.advance_prospect_to_in_progress(p_client_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.clients c
  set customer_type = 'in_progress', in_progress_at = now()
  where c.id = p_client_id
    and (c.customer_type is null or c.customer_type = 'prospect')
    and c.status not in ('lost','deleted')
    and exists (
      select 1 from public.meetings m
      join lateral unnest(m.agenda_ids) as aid on true
      join public.agenda_catalog ac
        on ac.agenda_id = aid
       and ac.policy_version = (select cc.agenda_policy_version
                                  from public.client_cycles cc
                                 where cc.id = c.current_cycle_id)
      join public.agenda_stage_rules asr
        on asr.agenda_id = ac.agenda_id
       and asr.policy_version = ac.policy_version
       and asr.stage = 'prospect'
      where m.client_id = c.id
        and m.cycle_id = c.current_cycle_id
        and m.outcome = 'successful'
        and asr.is_visible
    )
    and not exists (  -- Migration 026 tag-along gate, preserved on this edge
      select 1 from public.tag_along_requests t
      where t.related_client_id = c.id
        and t.invitee_kind = 'manager' and t.context = 'meeting' and t.status = 'pending'
    );
end; $$;
