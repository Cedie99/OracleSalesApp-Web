-- ============================================================================
-- 059 - Attribution function and triggers (Batch 7A/7B)
--
-- Server-owned, idempotent, atomic attribution. Mobile's SQLite -> outbox ->
-- Supabase write path for meetings is completely unchanged - this function
-- runs INSIDE the same insert transaction via an AFTER INSERT trigger, so a
-- meeting insert either fully succeeds (row inserted, attribution decided)
-- or fully rolls back together. Over-cap is a normal, successful outcome -
-- this function NEVER raises for an over-cap decision (contract O-5: do not
-- block Start Meeting; preserve the record; classify, don't fail).
--
-- Concurrency (two offline devices racing for one client's last slot):
-- serialised per (client_id, period_id) with a transaction-scoped advisory
-- lock, so only writers competing for the SAME client+period ever block each
-- other. First to commit gets the slot; the second is over_cap. Re-submission
-- of an already-decided meeting_id is idempotent (primary key on the ledger).
-- ============================================================================

create or replace function public.attribute_meeting_cutoff(p_meeting_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meeting  public.meetings%rowtype;
  v_client   public.clients%rowtype;
  v_period   public.cutoff_periods%rowtype;
  v_pending  boolean;
  v_declined boolean;
  v_count    integer;
  v_slot     integer;
  v_stage    text;
begin
  -- Idempotent: a terminal decision already exists, nothing to do. A
  -- pending_validity row is not terminal and falls through to be re-decided.
  if exists (
    select 1 from public.meeting_cutoff_attributions
     where meeting_id = p_meeting_id and attribution <> 'pending_validity'
  ) then
    return;
  end if;

  select * into v_meeting from public.meetings where id = p_meeting_id;
  if not found then
    return;
  end if;

  select * into v_client from public.clients where id = v_meeting.client_id;
  v_stage := v_client.customer_type;

  -- Manager tag-along gate (contract O-4). A pending request reserves no
  -- slot. A declined request is excluded_invalid, never counted. An
  -- accepted/absent request proceeds to normal classification.
  select exists (
    select 1 from public.tag_along_requests
     where related_meeting_id = p_meeting_id
       and context = 'meeting'
       and invitee_kind = 'manager'
       and status = 'pending'
  ) into v_pending;

  select exists (
    select 1 from public.tag_along_requests
     where related_meeting_id = p_meeting_id
       and context = 'meeting'
       and invitee_kind = 'manager'
       and status = 'declined'
  ) into v_declined;

  if v_pending then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution, slot_index)
    values
      (p_meeting_id, null, v_meeting.client_id, v_meeting.agent_id, v_stage, 'pending_validity', null)
    on conflict (meeting_id) do update
      set period_id = excluded.period_id,
          attribution = excluded.attribution,
          slot_index = excluded.slot_index,
          attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  -- Outcome/evidence gate: only Successful or Follow-up Required, with a
  -- photo (required evidence) present, ever count. No Show/Abandoned/
  -- Incomplete are not modeled as outcomes on this schema (confirmed
  -- 2026-08-02 - do not add them). A declined tag-along also lands here.
  if v_declined
     or v_meeting.outcome not in ('successful', 'follow_up')
     or v_meeting.photo_url is null
  then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution, slot_index)
    values
      (p_meeting_id, null, v_meeting.client_id, v_meeting.agent_id, v_stage, 'excluded_invalid', null)
    on conflict (meeting_id) do update
      set attribution = excluded.attribution,
          period_id = excluded.period_id,
          slot_index = excluded.slot_index,
          attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  -- Period resolution: meeting START time attributes the period (contract
  -- O-1/O-6). start_captured_at is only reliably populated going forward
  -- (Batch 7C fix to record.tsx); fall back to meeting_date for older rows.
  select * into v_period from public.cutoff_periods
   where status = 'active'
     and coalesce(v_meeting.start_captured_at, v_meeting.meeting_date)::date
         between starts_on and ends_on
   order by starts_on desc
   limit 1;

  if not found then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution, slot_index)
    values
      (p_meeting_id, null, v_meeting.client_id, v_meeting.agent_id, v_stage, 'unattributed', null)
    on conflict (meeting_id) do update
      set attribution = excluded.attribution,
          period_id = excluded.period_id,
          slot_index = excluded.slot_index,
          attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  -- Prospect/In Progress clients are never capped (contract #3), but do
  -- contribute to the role's period target (contract O-3: only over_cap is
  -- excluded from the target, excluded_uncapped is not).
  if v_stage not in ('new', 'existing') then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution, slot_index)
    values
      (p_meeting_id, v_period.id, v_meeting.client_id, v_meeting.agent_id, v_stage, 'excluded_uncapped', null)
    on conflict (meeting_id) do update
      set attribution = excluded.attribution,
          period_id = excluded.period_id,
          slot_index = excluded.slot_index,
          attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  -- Shared New/Existing pool, serialised per (client, period) so two
  -- concurrent writers for the same client's last slot cannot both win.
  perform pg_advisory_xact_lock(hashtext(v_client.id::text || v_period.id::text));

  select count(*) into v_count
    from public.meeting_cutoff_attributions
   where client_id = v_client.id
     and period_id = v_period.id
     and attribution = 'counted';

  if v_count < v_period.client_meeting_cap then
    v_slot := v_count + 1;
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution, slot_index)
    values
      (p_meeting_id, v_period.id, v_meeting.client_id, v_meeting.agent_id, v_stage, 'counted', v_slot)
    on conflict (meeting_id) do update
      set attribution = excluded.attribution,
          period_id = excluded.period_id,
          slot_index = excluded.slot_index,
          attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
  else
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, attribution, slot_index)
    values
      (p_meeting_id, v_period.id, v_meeting.client_id, v_meeting.agent_id, v_stage, 'over_cap', null)
    on conflict (meeting_id) do update
      set attribution = excluded.attribution,
          period_id = excluded.period_id,
          slot_index = excluded.slot_index,
          attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
  end if;
end;
$$;

-- Never grant broad EXECUTE - only the trigger context (which runs under the
-- function's own SECURITY DEFINER rights, independent of the invoking role's
-- grants) and the function owner need to call this.
revoke all on function public.attribute_meeting_cutoff(uuid) from public, authenticated, anon;

create or replace function public.trg_attribute_meeting_cutoff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.attribute_meeting_cutoff(new.id);
  return new;
end;
$$;

drop trigger if exists trg_meetings_cutoff_attribution on public.meetings;
create trigger trg_meetings_cutoff_attribution
  after insert on public.meetings
  for each row
  execute function public.trg_attribute_meeting_cutoff();

-- Re-decide when a manager's tag-along confirmation resolves (accept or
-- decline) - a pending_validity row is the only non-terminal state and is
-- the only one this can ever change (contract O-4).
create or replace function public.trg_attribute_meeting_cutoff_on_tagalong_resolved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.context = 'meeting'
     and new.invitee_kind = 'manager'
     and new.status in ('accepted', 'declined')
     and old.status = 'pending'
     and new.related_meeting_id is not null
  then
    perform public.attribute_meeting_cutoff(new.related_meeting_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_tagalong_resolved_cutoff on public.tag_along_requests;
create trigger trg_tagalong_resolved_cutoff
  after update of status on public.tag_along_requests
  for each row
  execute function public.trg_attribute_meeting_cutoff_on_tagalong_resolved();
