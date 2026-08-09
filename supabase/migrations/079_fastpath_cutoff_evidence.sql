-- 079 — Recognize New/Existing fast-path completion evidence in cutoff attribution.
--
-- THE BUG (mobile Bugs.md B-107, confirmed 2026-08-10). ADR-015 gave New and
-- Existing meetings a photo-only start/end flow (record-visit.tsx) that never
-- collects the full-form selfie: mobile syncs those rows with `photo_url =
-- NULL` by design and relies on `start_captured_at` + `end_photo_url` as
-- completion evidence instead. 071's evidence gate only ever recognized
-- `photo_url`, so every synced, valid fast-path New/Existing meeting has been
-- landing on `excluded_invalid` since the gate was written — and 071's own
-- delayed-evidence trigger listens for a `photo_url` update, which a
-- fast-path row never receives, so nothing self-heals. Device evidence:
-- three completed Existing and four completed New meetings for the active
-- Aug 9–23 cutoff, each `sync_status = 'synced'` with a frozen
-- `client_status_at_meeting` and an uploaded `end_photo_url`, still counted
-- nowhere.
--
-- THE FIX. Recognize a second, narrower evidence shape alongside the
-- existing one:
--
--   full-form   outcome in (successful, follow_up) AND photo_url is not null
--   fast-path   outcome in (successful, follow_up)
--               AND client_status_at_meeting IN ('new', 'existing')  -- frozen, no fallback
--               AND start_captured_at is not null
--               AND end_photo_url is not null
--
-- The fast-path arm deliberately reads `m.client_status_at_meeting` directly,
-- never `coalesce(m.client_status_at_meeting, c.customer_type)` (the `stage`
-- variable used everywhere else in this function). `customer_type` is live
-- and mutable; a meeting recorded before 067 ever froze a stage has no
-- record of what the client was AT THE MEETING, so it must keep failing
-- closed into the full-form/photo_url rule rather than being pulled into the
-- fast-path exemption by whatever the client's status happens to be today.
--
-- EVERYTHING ELSE IS UNCHANGED: Manila-local date resolution (072), the
-- pending/declined tag-along gates (059/077), frozen client stage (067) for
-- the capped/uncapped/pool decision, per-role and per-team-kind pools and
-- caps (074/076), the one-row-per-participant ledger and manager tag-along
-- credit (076), and every RPC signature mobile reads
-- (get_client_cutoff_allowance / get_my_cutoff_usage_summary). This migration
-- touches only the evidence test inside the existing gate.

create or replace function public.attribute_meeting_cutoff(p_meeting_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.meetings%rowtype;
  c public.clients%rowtype;
  p public.cutoff_periods%rowtype;
  pending boolean;
  declined boolean;
  stage text;
  agent_role text;
  agent_kind text;
  role_cap integer;
  used_count integer;
  meeting_local_date date;
  has_valid_evidence boolean;
  part record;
begin
  if exists (select 1 from public.meeting_cutoff_attributions
             where meeting_id = p_meeting_id and attribution <> 'pending_validity') then return; end if;
  select * into m from public.meetings where id = p_meeting_id;
  if not found then return; end if;
  select * into c from public.clients where id = m.client_id;
  stage := coalesce(m.client_status_at_meeting, c.customer_type);
  meeting_local_date := (coalesce(m.start_captured_at, m.meeting_date) at time zone 'Asia/Manila')::date;

  -- The only change in this migration. Full-form's photo_url proof is
  -- unchanged; the fast-path arm is additive and requires the FROZEN stage
  -- (never the live customer_type fallback used by `stage` above) plus both
  -- halves of its own completion evidence.
  has_valid_evidence :=
    m.photo_url is not null
    or (
      m.client_status_at_meeting in ('new', 'existing')
      and m.start_captured_at is not null
      and m.end_photo_url is not null
    );

  select pr.role, t.kind into agent_role, agent_kind
    from public.profiles pr
    left join public.teams t on t.id = pr.team_id
   where pr.id = m.agent_id;

  select exists (select 1 from public.tag_along_requests
    where related_meeting_id = p_meeting_id and context = 'meeting'
      and invitee_kind = 'manager' and status = 'pending') into pending;
  select exists (select 1 from public.tag_along_requests
    where related_meeting_id = p_meeting_id and context = 'meeting'
      and invitee_kind = 'manager' and status = 'declined') into declined;

  if pending then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage,
       captured_agent_role, captured_team_kind, participation, attribution)
    values (m.id, null, m.client_id, m.agent_id, stage, agent_role, agent_kind, 'agent', 'pending_validity')
    on conflict (meeting_id, agent_id) do update set period_id = excluded.period_id,
      captured_client_stage = excluded.captured_client_stage,
      captured_agent_role = excluded.captured_agent_role,
      captured_team_kind = excluded.captured_team_kind,
      attribution = excluded.attribution,
      slot_index = null, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  if declined or m.outcome not in ('successful', 'follow_up') or not has_valid_evidence then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage,
       captured_agent_role, captured_team_kind, participation, attribution)
    values (m.id, null, m.client_id, m.agent_id, stage, agent_role, agent_kind, 'agent', 'excluded_invalid')
    on conflict (meeting_id, agent_id) do update set captured_client_stage = excluded.captured_client_stage,
      captured_agent_role = excluded.captured_agent_role,
      captured_team_kind = excluded.captured_team_kind,
      attribution = excluded.attribution, period_id = null, slot_index = null, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  select * into p from public.cutoff_periods
   where status = 'active' and meeting_local_date between starts_on and ends_on
   order by starts_on desc limit 1;

  for part in
    select m.agent_id as agent_id, agent_role as role, agent_kind as team_kind,
           'agent'::text as participation
    union all
    select tar.invitee_id, pr.role, t.kind, 'tag_along'::text
      from public.tag_along_requests tar
      join public.profiles pr on pr.id = tar.invitee_id
      left join public.teams t on t.id = pr.team_id
     where tar.related_meeting_id = m.id
       and tar.context = 'meeting'
       and tar.invitee_kind = 'manager'
       and tar.status = 'accepted'
       and tar.invitee_id <> m.agent_id
    order by 2 nulls last, 1
  loop

    if p.id is null then
      insert into public.meeting_cutoff_attributions
        (meeting_id, period_id, client_id, agent_id, captured_client_stage,
         captured_agent_role, captured_team_kind, participation, attribution)
      values (m.id, null, m.client_id, part.agent_id, stage, part.role, part.team_kind,
              part.participation, 'unattributed')
      on conflict (meeting_id, agent_id) do update set attribution = excluded.attribution,
        captured_client_stage = excluded.captured_client_stage,
        captured_agent_role = excluded.captured_agent_role,
        captured_team_kind = excluded.captured_team_kind,
        participation = excluded.participation,
        period_id = null, slot_index = null, attributed_at = now()
        where public.meeting_cutoff_attributions.attribution = 'pending_validity';
      continue;
    end if;

    if stage not in ('new', 'existing') then
      insert into public.meeting_cutoff_attributions
        (meeting_id, period_id, client_id, agent_id, captured_client_stage,
         captured_agent_role, captured_team_kind, participation, attribution)
      values (m.id, p.id, m.client_id, part.agent_id, stage, part.role, part.team_kind,
              part.participation, 'excluded_uncapped')
      on conflict (meeting_id, agent_id) do update set attribution = excluded.attribution,
        captured_client_stage = excluded.captured_client_stage,
        captured_agent_role = excluded.captured_agent_role,
        captured_team_kind = excluded.captured_team_kind,
        participation = excluded.participation,
        period_id = excluded.period_id, slot_index = null, attributed_at = now()
        where public.meeting_cutoff_attributions.attribution = 'pending_validity';
      continue;
    end if;

    role_cap := public.cutoff_cap_for_agent(
      part.role, part.team_kind,
      p.sales_client_meeting_cap, p.rsr_client_meeting_cap, p.client_meeting_cap);

    perform pg_advisory_xact_lock(
      hashtext(c.id::text || p.id::text || public.cutoff_pool_key(part.role, part.team_kind)));

    select count(*) into used_count from public.meeting_cutoff_attributions
     where client_id = c.id and period_id = p.id and attribution = 'counted'
       and captured_agent_role is not distinct from part.role
       and (part.role is distinct from 'sales_manager'
            or captured_team_kind is not distinct from part.team_kind);

    if used_count < role_cap then
      insert into public.meeting_cutoff_attributions
        (meeting_id, period_id, client_id, agent_id, captured_client_stage,
         captured_agent_role, captured_team_kind, participation, attribution, slot_index)
      values (m.id, p.id, m.client_id, part.agent_id, stage, part.role, part.team_kind,
              part.participation, 'counted', used_count + 1)
      on conflict (meeting_id, agent_id) do update set attribution = excluded.attribution,
        captured_client_stage = excluded.captured_client_stage,
        captured_agent_role = excluded.captured_agent_role,
        captured_team_kind = excluded.captured_team_kind,
        participation = excluded.participation,
        period_id = excluded.period_id, slot_index = excluded.slot_index, attributed_at = now()
        where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    else
      insert into public.meeting_cutoff_attributions
        (meeting_id, period_id, client_id, agent_id, captured_client_stage,
         captured_agent_role, captured_team_kind, participation, attribution)
      values (m.id, p.id, m.client_id, part.agent_id, stage, part.role, part.team_kind,
              part.participation, 'over_cap')
      on conflict (meeting_id, agent_id) do update set attribution = excluded.attribution,
        captured_client_stage = excluded.captured_client_stage,
        captured_agent_role = excluded.captured_agent_role,
        captured_team_kind = excluded.captured_team_kind,
        participation = excluded.participation,
        period_id = excluded.period_id, slot_index = null, attributed_at = now()
        where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    end if;
  end loop;
end;
$$;

revoke all on function public.attribute_meeting_cutoff(uuid) from public, authenticated, anon;

-- --- Delayed-evidence reattribution: now listens to BOTH evidence columns ---
--
-- 071 wired this trigger to `photo_url` alone, which is exactly the column a
-- fast-path row never populates. Widened to fire on either `photo_url` or
-- `end_photo_url`, with the same has_valid_evidence test the main function
-- uses, so a late-uploading fast-path end photo self-heals the same way a
-- late-uploading full-form selfie always has.

create or replace function public.reattribute_meeting_cutoff_after_photo()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  has_valid_evidence boolean;
begin
  -- `after update of photo_url, end_photo_url` fires whenever either column
  -- appears in the UPDATE's SET list, not only when its value actually moved
  -- — guard against a no-op write to either one.
  if new.photo_url is not distinct from old.photo_url
     and new.end_photo_url is not distinct from old.end_photo_url then
    return new;
  end if;

  if new.outcome not in ('successful', 'follow_up') then return new; end if;

  has_valid_evidence :=
    new.photo_url is not null
    or (
      new.client_status_at_meeting in ('new', 'existing')
      and new.start_captured_at is not null
      and new.end_photo_url is not null
    );
  if not has_valid_evidence then return new; end if;

  if exists (select 1 from public.tag_along_requests where related_meeting_id = new.id
    and context = 'meeting' and invitee_kind = 'manager' and status = 'declined') then return new; end if;

  -- Only an excluded_invalid row whose delayed evidence now makes it qualify,
  -- in the period that is CURRENTLY active for the meeting's Manila-local
  -- date. Every other decision (counted, over_cap, pending_validity,
  -- excluded_uncapped, unattributed) is left exactly as it stands.
  if exists (select 1 from public.meeting_cutoff_attributions a join public.cutoff_periods p
    on p.status = 'active' and (coalesce(new.start_captured_at, new.meeting_date) at time zone 'Asia/Manila')::date between p.starts_on and p.ends_on
    where a.meeting_id = new.id and a.attribution = 'excluded_invalid') then
    delete from public.meeting_cutoff_attributions where meeting_id = new.id and attribution = 'excluded_invalid';
    perform public.attribute_meeting_cutoff(new.id);
  end if;
  return new;
end;
$$;

revoke all on function public.reattribute_meeting_cutoff_after_photo() from public, authenticated, anon;
drop trigger if exists trg_reattribute_meeting_cutoff_after_photo on public.meetings;
create trigger trg_reattribute_meeting_cutoff_after_photo
  after update of photo_url, end_photo_url on public.meetings
  for each row execute function public.reattribute_meeting_cutoff_after_photo();

-- --- Bounded, idempotent repair for rows the old gate already decided ------
--
-- Scope, precisely:
--   - only rows currently sitting on 'excluded_invalid'
--   - only New/Existing fast-path meetings (frozen client_status_at_meeting,
--     never the live customer_type) with both start_captured_at and
--     end_photo_url present, and a qualifying outcome
--   - only meetings whose Manila-local date falls inside a period that is
--     CURRENTLY 'active' — a closed or superseded period is never touched,
--     matching 071/072/077's own repair scope exactly
--   - never a declined manager tag-along
--
-- What it does NOT do: it never deletes, re-slots, or otherwise touches a
-- 'counted', 'over_cap', 'pending_validity', or 'excluded_uncapped' row —
-- the WHERE clause below only ever matches 'excluded_invalid'. Re-attribution
-- goes through the same attribute_meeting_cutoff() the trigger uses, which
-- applies the CURRENT per-role/per-team-kind cap and pool (074/076): a
-- qualifying meeting becomes 'counted' only while its own pool still has
-- room, and any extra becomes 'over_cap' exactly as a fresh insert would.
-- Sales and RSR remain separate pools; a manager's tag-along is re-credited
-- through the same participant loop, keyed to their team kind.
--
-- Deterministic order — by the row's existing attribution time, then meeting
-- id — so a repair run always revisits candidates in the same sequence and
-- therefore always allocates the same slots, whether run once or (safely)
-- re-run after this migration is re-applied.
do $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select m.id
    from public.meetings m
    join public.meeting_cutoff_attributions a
      on a.meeting_id = m.id and a.attribution = 'excluded_invalid'
    where m.outcome in ('successful', 'follow_up')
      and m.client_status_at_meeting in ('new', 'existing')
      and m.start_captured_at is not null
      and m.end_photo_url is not null
      and exists (
        select 1 from public.cutoff_periods p
         where p.status = 'active'
           and (coalesce(m.start_captured_at, m.meeting_date) at time zone 'Asia/Manila')::date
               between p.starts_on and p.ends_on
      )
      and not exists (
        select 1 from public.tag_along_requests t
         where t.related_meeting_id = m.id and t.context = 'meeting'
           and t.invitee_kind = 'manager' and t.status = 'declined'
      )
    order by a.attributed_at, m.id
  loop
    delete from public.meeting_cutoff_attributions
     where meeting_id = r.id and attribution = 'excluded_invalid';
    perform public.attribute_meeting_cutoff(r.id);
    v_count := v_count + 1;
  end loop;

  raise notice
    '079: reattributed % previously excluded_invalid New/Existing fast-path meeting(s) with valid start+end-photo evidence, in currently active periods only.',
    v_count;
end $$;

-- ============================================================================
-- LIMITS (read before assuming this closes B-107 completely)
--
--   - A fast-path meeting recorded in a period that has since gone 'closed'
--     or 'superseded' is NOT repaired here and stays excluded_invalid. That
--     cutoff has already been reported/paid against; restating it silently
--     would be worse than the undercount. If B-107 evidence includes a
--     closed-period case, it needs a separate, explicitly-approved
--     restatement — not a rerun of this migration.
--   - A meeting missing EITHER start_captured_at or end_photo_url (e.g. an
--     interrupted fast-path save) is correctly left excluded_invalid — that
--     is incomplete evidence, not a mismatch this migration exists to fix.
--   - No-restatement rule: nothing here ever moves a row OFF 'counted',
--     'over_cap', 'pending_validity', or 'excluded_uncapped'. This migration
--     only ever promotes a subset of 'excluded_invalid' rows forward.
--
-- ROLLBACK
--   The function bodies (attribute_meeting_cutoff,
--   reattribute_meeting_cutoff_after_photo) can be restored to their pre-079
--   state by re-running migration 076 followed by 077's trigger definition
--   (077 does not redefine attribute_meeting_cutoff itself). The trigger
--   column list can be narrowed back with:
--     drop trigger if exists trg_reattribute_meeting_cutoff_after_photo on public.meetings;
--     create trigger trg_reattribute_meeting_cutoff_after_photo
--       after update of photo_url on public.meetings
--       for each row execute function public.reattribute_meeting_cutoff_after_photo();
--   The repair block is DATA, not schema, and is not reversible by re-running
--   076/077 — a meeting this migration promoted out of 'excluded_invalid'
--   stays wherever attribute_meeting_cutoff() next decided it belongs. If a
--   specific reattributed meeting must be reverted, it has to be identified
--   and reset by hand; this migration does not track which ids it touched.
-- ============================================================================
