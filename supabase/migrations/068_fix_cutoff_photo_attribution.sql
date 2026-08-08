-- ============================================================================
-- 068 - Reconcile cutoff attribution after delayed meeting-photo uploads.
--
-- Mobile writes the meeting first and uploads photo evidence asynchronously.
-- Migration 059 therefore classified a qualifying meeting with a temporarily
-- null photo as excluded_invalid and never revisited it.  This migration keeps
-- all terminal decisions immutable except that narrow, evidence-only case.
-- It also uses the frozen meeting stage (067) whenever present, so a later
-- client promotion cannot change the cutoff classification of an old meeting.
-- ============================================================================

-- Preserve 059's function, changing only the stage source.  Legacy meetings
-- (before 067) retain the historical client-status fallback.
create or replace function public.attribute_meeting_cutoff(p_meeting_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.meetings%rowtype;
  c public.clients%rowtype;
  p public.cutoff_periods%rowtype;
  pending boolean;
  declined boolean;
  stage text;
  used_count integer;
begin
  if exists (select 1 from public.meeting_cutoff_attributions
             where meeting_id = p_meeting_id and attribution <> 'pending_validity') then
    return;
  end if;
  select * into m from public.meetings where id = p_meeting_id;
  if not found then return; end if;
  select * into c from public.clients where id = m.client_id;
  stage := coalesce(m.client_status_at_meeting, c.customer_type);

  select exists (select 1 from public.tag_along_requests
    where related_meeting_id = p_meeting_id and context = 'meeting'
      and invitee_kind = 'manager' and status = 'pending') into pending;
  select exists (select 1 from public.tag_along_requests
    where related_meeting_id = p_meeting_id and context = 'meeting'
      and invitee_kind = 'manager' and status = 'declined') into declined;

  if pending then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution)
    values (m.id, null, m.client_id, m.agent_id, stage, 'pending_validity')
    on conflict (meeting_id) do update set period_id = excluded.period_id,
      captured_client_stage = excluded.captured_client_stage,
      attribution = excluded.attribution, slot_index = null, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  if declined or m.outcome not in ('successful', 'follow_up') or m.photo_url is null then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution)
    values (m.id, null, m.client_id, m.agent_id, stage, 'excluded_invalid')
    on conflict (meeting_id) do update set captured_client_stage = excluded.captured_client_stage,
      attribution = excluded.attribution, period_id = null, slot_index = null,
      attributed_at = now() where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  select * into p from public.cutoff_periods
   where status = 'active'
     and coalesce(m.start_captured_at, m.meeting_date)::date between starts_on and ends_on
   order by starts_on desc limit 1;
  if not found then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution)
    values (m.id, null, m.client_id, m.agent_id, stage, 'unattributed')
    on conflict (meeting_id) do update set attribution = excluded.attribution,
      captured_client_stage = excluded.captured_client_stage, period_id = null,
      slot_index = null, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  if stage not in ('new', 'existing') then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution)
    values (m.id, p.id, m.client_id, m.agent_id, stage, 'excluded_uncapped')
    on conflict (meeting_id) do update set attribution = excluded.attribution,
      captured_client_stage = excluded.captured_client_stage, period_id = excluded.period_id,
      slot_index = null, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext(c.id::text || p.id::text));
  select count(*) into used_count from public.meeting_cutoff_attributions
   where client_id = c.id and period_id = p.id and attribution = 'counted';
  if used_count < p.client_meeting_cap then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution, slot_index)
    values (m.id, p.id, m.client_id, m.agent_id, stage, 'counted', used_count + 1)
    on conflict (meeting_id) do update set attribution = excluded.attribution,
      captured_client_stage = excluded.captured_client_stage, period_id = excluded.period_id,
      slot_index = excluded.slot_index, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
  else
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution)
    values (m.id, p.id, m.client_id, m.agent_id, stage, 'over_cap')
    on conflict (meeting_id) do update set attribution = excluded.attribution,
      captured_client_stage = excluded.captured_client_stage, period_id = excluded.period_id,
      slot_index = null, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
  end if;
end;
$$;

revoke all on function public.attribute_meeting_cutoff(uuid) from public, authenticated, anon;

-- Only an excluded_invalid row whose delayed evidence now makes it qualify is
-- eligible.  Existing valid, no-decision, over-cap, pending, and declined
-- decisions are never touched.
create or replace function public.reattribute_meeting_cutoff_after_photo()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.photo_url is null or new.photo_url is not distinct from old.photo_url
     or new.outcome not in ('successful', 'follow_up') then return new; end if;
  if exists (select 1 from public.tag_along_requests
    where related_meeting_id = new.id and context = 'meeting'
      and invitee_kind = 'manager' and status = 'declined') then return new; end if;
  if exists (select 1 from public.meeting_cutoff_attributions a
    join public.cutoff_periods p on p.status = 'active'
      and coalesce(new.start_captured_at, new.meeting_date)::date between p.starts_on and p.ends_on
    where a.meeting_id = new.id and a.attribution = 'excluded_invalid') then
    delete from public.meeting_cutoff_attributions
     where meeting_id = new.id and attribution = 'excluded_invalid';
    perform public.attribute_meeting_cutoff(new.id);
  end if;
  return new;
end;
$$;

revoke all on function public.reattribute_meeting_cutoff_after_photo() from public, authenticated, anon;
drop trigger if exists trg_reattribute_meeting_cutoff_after_photo on public.meetings;
create trigger trg_reattribute_meeting_cutoff_after_photo
  after update of photo_url on public.meetings
  for each row execute function public.reattribute_meeting_cutoff_after_photo();

-- One-time, bounded repair for rows already in the ledger.  It intentionally
-- requires a qualifying outcome, photo, active period, and no declined invite.
do $$
declare r record;
begin
  for r in
    select m.id
    from public.meetings m
    join public.meeting_cutoff_attributions a on a.meeting_id = m.id
    where a.attribution = 'excluded_invalid'
      and m.photo_url is not null
      and m.outcome in ('successful', 'follow_up')
      and exists (select 1 from public.cutoff_periods p
        where p.status = 'active'
          and coalesce(m.start_captured_at, m.meeting_date)::date between p.starts_on and p.ends_on)
      and not exists (select 1 from public.tag_along_requests t
        where t.related_meeting_id = m.id and t.context = 'meeting'
          and t.invitee_kind = 'manager' and t.status = 'declined')
  loop
    delete from public.meeting_cutoff_attributions
     where meeting_id = r.id and attribution = 'excluded_invalid';
    perform public.attribute_meeting_cutoff(r.id);
  end loop;
end $$;
