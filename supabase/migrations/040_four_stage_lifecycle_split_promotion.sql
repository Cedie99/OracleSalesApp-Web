-- ============================================================================
-- 040 - Four-stage transition functions (the flip)
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
-- projects/OracleSalesApp-Mobile/Migration-040-Report.md
--
-- Retires promote_client_to_new() from migrations 017 and 026, splitting it
-- into two stage-specific functions.
-- ============================================================================

-- Migration 040: THE FLIP. Retires promote_client_to_new(); splits it into
-- two stage-specific functions so "no direct Prospect→New" is structurally
-- true, not just a documented rule.

drop trigger if exists promote_on_details_completed on public.clients;
drop trigger if exists promote_on_successful_meeting on public.meetings;
drop trigger if exists promote_on_tagalong_resolved on public.tag_along_requests;
drop function if exists public.promote_client_to_new(uuid);
drop function if exists public.trg_promote_on_tagalong_resolved();

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
        on ac.agenda_id = aid and ac.policy_version = c.cycle_started_at is not null
           and ac.policy_version = (select cc.agenda_policy_version from public.client_cycles cc where cc.id = c.current_cycle_id)
      join public.agenda_stage_rules asr
        on asr.agenda_id = ac.agenda_id and asr.policy_version = ac.policy_version and asr.stage = 'prospect'
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

create or replace function public.advance_in_progress_to_new(p_client_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.clients c
  set customer_type = 'new'
  where c.id = p_client_id
    and c.customer_type = 'in_progress'   -- NEVER from 'prospect': no direct hop
    and c.status not in ('lost','deleted')
    and c.details_completed_at is not null
    and exists (   -- Close-deal evidence must postdate entry into in_progress
      select 1 from public.meetings m
      where m.client_id = c.id
        and m.cycle_id = c.current_cycle_id
        and m.outcome = 'successful'
        and m.agenda_ids @> array['close_deal']
        and m.created_at > c.in_progress_at
    )
    and exists (   -- Manager-approved PO evidence for THIS cycle
      select 1 from public.po_confirmation_requests p
      where p.client_id = c.id and p.cycle_id = c.current_cycle_id and p.status = 'approved'
    )
    and not exists (   -- Both-edge tag-along gate (Vince's explicit decision)
      select 1 from public.tag_along_requests t
      where t.related_client_id = c.id
        and t.invitee_kind = 'manager' and t.context = 'meeting' and t.status = 'pending'
    );
end; $$;

-- Trigger wiring
create or replace function public.trg_promote_on_successful_meeting()
returns trigger language plpgsql security definer as $$
begin
  if new.outcome = 'successful' and new.cycle_id is not null then
    perform public.advance_prospect_to_in_progress(new.client_id);
    perform public.advance_in_progress_to_new(new.client_id);
  end if;
  return new;
end; $$;
create trigger promote_on_successful_meeting
  after insert or update of outcome on public.meetings
  for each row execute function public.trg_promote_on_successful_meeting();

create or replace function public.trg_promote_on_details_completed()
returns trigger language plpgsql security definer as $$
begin
  perform public.advance_in_progress_to_new(new.id);  -- info-completion no longer drives the first edge
  return new;
end; $$;
create trigger promote_on_details_completed
  after update of details_completed_at on public.clients
  for each row execute function public.trg_promote_on_details_completed();

-- Stage-dispatching tag-along resolution re-check (replaces the 026 version,
-- which only knew about one edge):
create or replace function public.trg_promote_on_tagalong_resolved()
returns trigger language plpgsql security definer as $$
declare stage text;
begin
  if (new.status in ('accepted','declined') and old.status = 'pending'
      and new.invitee_kind = 'manager' and new.context = 'meeting'
      and new.related_client_id is not null) then
    select customer_type into stage from public.clients where id = new.related_client_id;
    if stage = 'prospect' then
      perform public.advance_prospect_to_in_progress(new.related_client_id);
    elsif stage = 'in_progress' then
      perform public.advance_in_progress_to_new(new.related_client_id);
    end if;
  end if;
  return new;
end; $$;
create trigger promote_on_tagalong_resolved
  after update of status on public.tag_along_requests
  for each row execute function public.trg_promote_on_tagalong_resolved();

-- PO-approval re-check trigger:
create or replace function public.trg_promote_on_po_confirmed()
returns trigger language plpgsql security definer as $$
begin
  if new.status = 'approved' and old.status = 'pending' then
    perform public.advance_in_progress_to_new(new.client_id);
  end if;
  return new;
end; $$;
create trigger promote_on_po_confirmed
  after update of status on public.po_confirmation_requests
  for each row execute function public.trg_promote_on_po_confirmed();
