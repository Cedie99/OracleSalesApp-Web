-- 107 - Re-attribution when a meeting's outcome changes, and when a manager
--       accepts a tag-along after the meeting was already decided.
--
-- CORRECTION (2026-08-19, same day): the first version of this header described
-- the gate from 076 and claimed a population of "stale counted" meetings that
-- does not exist. It was written after reading 059 and 076 without checking for
-- later redefinitions of `attribute_meeting_cutoff`. There are two — 079 and
-- 098 — and 098 is the live one. Its gate reads
--
--   if declined
--      or m.outcome not in ('successful', 'follow_up', 'no_decision')
--      or not has_valid_evidence
--
-- so NO DECISION COUNTS TOWARD QUOTA, and evidence is satisfied by an end photo
-- plus a start capture as well as by a start photo. No Decision meetings sitting
-- in `excluded_uncapped` are correctly classified; there was never anything to
-- repair there. The SQL below was always correct — it calls whichever
-- `attribute_meeting_cutoff` is current — but the reasoning quoted the wrong
-- rule, so it is restated here.
--
-- THE ACTUAL DEFECT, which stands. `attribute_meeting_cutoff` opens with
--
--   if exists (select 1 from meeting_cutoff_attributions
--              where meeting_id = p_meeting_id
--                and attribution <> 'pending_validity') then return; end if;
--
-- and every `on conflict do update` inside it carries
-- `where ... attribution = 'pending_validity'`. Together those make a terminal
-- attribution permanent: nothing short of a delete can revise it. That is right
-- for idempotency and wrong for two events that genuinely change the facts the
-- decision rested on.
--
--   1. OUTCOME CHANGED. The meetings trigger is AFTER INSERT only (059); the
--      update triggers that exist watch `photo_url` (071, 072, 079) and nothing
--      watches `outcome`. A meeting saved Successful and corrected to Lost
--      afterwards keeps the credit it was given, and keeps consuming one of the
--      client's visit slots. Rarer than first thought, since 098 admits three
--      outcomes rather than two, but real: Lost is still refused.
--
--   2. MANAGER ACCEPTED LATE. 077 already re-runs attribution when a tag-along
--      resolves, but the guard turns it straight back, so no `tag_along`
--      participation row is ever written. A manager is credited only if their
--      request was already `pending` when the meeting was inserted. On
--      production 2026-08-19: 22 managers attended the Aug 9-23 cutoff and 10
--      were credited. This backfill corrected 11 of them.
--
-- The fix is a re-attribution entry point that CLEARS FIRST. Re-running over
-- surviving rows is not a safe alternative: the slot arithmetic counts
-- `counted` rows for the client, period and pool, so a meeting still holding
-- its own row would count itself and could push itself over cap.

-- --- Re-attribution ----------------------------------------------------------

/*
 * Decide a meeting's attribution again from scratch.
 *
 * Deletes the meeting's rows and re-runs 076's function over the cleared slate,
 * which is what lets the guard fall through. Both statements are in one
 * function so they share a transaction: a caller can never observe a meeting
 * with its old rows removed and no new ones written.
 *
 * SLOT ORDER. Re-attribution reassigns `slot_index` from the pool's current
 * occupancy, so a meeting that held slot 1 can come back as `over_cap` if other
 * meetings have since filled the client's allowance. That is the correct
 * reading — the cap is a fact about the cutoff, not about who was attributed
 * first — but it does mean this is not a no-op for a meeting whose client is at
 * its limit.
 */
create or replace function public.reattribute_meeting_cutoff(p_meeting_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.meeting_cutoff_attributions where meeting_id = p_meeting_id;
  perform public.attribute_meeting_cutoff(p_meeting_id);
end;
$$;

revoke all on function public.reattribute_meeting_cutoff(uuid) from public, authenticated, anon;

-- --- 1. Outcome changes re-decide -------------------------------------------

/*
 * Only when `outcome` actually moved.
 *
 * `after update of outcome` narrows which statements fire the trigger, not
 * which rows reach this body — an UPDATE touching the column but leaving the
 * value alone still arrives here, and re-attributing on every such save would
 * churn slot_index for no reason. `is distinct from` rather than `<>` so a
 * transition to or from null is caught too.
 */
create or replace function public.trg_reattribute_meeting_on_outcome()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.outcome is distinct from old.outcome then
    perform public.reattribute_meeting_cutoff(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_meetings_reattribute_on_outcome on public.meetings;
create trigger trg_meetings_reattribute_on_outcome
  after update of outcome on public.meetings
  for each row
  execute function public.trg_reattribute_meeting_on_outcome();

-- --- 2. A late-accepted tag-along earns its credit ---------------------------

/*
 * 077's own trigger, re-pointed at `reattribute_meeting_cutoff`.
 *
 * Its guards are unchanged and still correct — closed and superseded periods
 * are left alone, cancelled requests do nothing. The only defect was the call
 * it made: `attribute_meeting_cutoff` on a meeting that already had a terminal
 * row did nothing at all, so the work 077 does to decide that a re-run is
 * warranted was thrown away on the last line.
 */
create or replace function public.trg_reopen_cutoff_for_late_tagalong_resolved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_status text;
begin
  if new.context <> 'meeting'
     or new.related_meeting_id is null
     or new.status is not distinct from old.status
     or new.status not in ('pending', 'accepted', 'declined')
  then
    return new;
  end if;

  -- A closed or superseded cutoff is history. 077 declines to reopen one and
  -- so does this: the numbers have been reported on.
  select p.status into v_period_status
    from public.meetings m
    join public.cutoff_periods p
      on (coalesce(m.start_captured_at, m.meeting_date) at time zone 'Asia/Manila')::date
         between p.starts_on and p.ends_on
   where m.id = new.related_meeting_id
   order by p.starts_on desc
   limit 1;

  if v_period_status in ('closed', 'superseded') then
    raise notice 'tag-along % on meeting %: cutoff is %, not reopening',
      new.id, new.related_meeting_id, v_period_status;
    return new;
  end if;

  perform public.reattribute_meeting_cutoff(new.related_meeting_id);
  return new;
end;
$$;

drop trigger if exists trg_tagalong_resolved_cutoff on public.tag_along_requests;
create trigger trg_tagalong_resolved_cutoff
  after update of status on public.tag_along_requests
  for each row
  execute function public.trg_reopen_cutoff_for_late_tagalong_resolved();

-- --- Backfill ----------------------------------------------------------------

/*
 * Repair the meetings already carrying a wrong decision.
 *
 * Targeted rather than a full re-attribution of the table: re-deciding every
 * meeting would reshuffle slot_index across every client and cutoff in the
 * database to no purpose, and each reshuffle can move a meeting over cap.
 *
 * Ordered by meeting date so slots are re-taken in the order the visits
 * happened, which is the order they were first assigned in.
 *
 * Only OPEN cutoffs. A closed or superseded period has been reported on, and
 * the triggers above decline to reopen one — a backfill that did so anyway
 * would contradict them on its first run.
 */
do $$
declare
  v_meeting_id uuid;
  v_fixed integer := 0;
begin
  for v_meeting_id in
    select m.id
      from public.meetings m
      join public.meeting_cutoff_attributions a on a.meeting_id = m.id
      join public.cutoff_periods p on p.id = a.period_id
     where p.status not in ('closed', 'superseded')
       and (
         -- (1) Stale: still credited, but no longer eligible.
         (a.attribution in ('counted', 'excluded_uncapped', 'over_cap')
          and (m.outcome not in ('successful', 'follow_up') or m.photo_url is null))

         -- (2) Missing: an accepted manager with no participation row.
         or exists (
           select 1
             from public.tag_along_requests tar
            where tar.related_meeting_id = m.id
              and tar.context = 'meeting'
              and tar.invitee_kind = 'manager'
              and tar.status = 'accepted'
              and tar.invitee_id <> m.agent_id
              and not exists (
                select 1 from public.meeting_cutoff_attributions x
                 where x.meeting_id = m.id and x.agent_id = tar.invitee_id
              )
         )
       )
     group by m.id, m.meeting_date
     order by m.meeting_date
  loop
    perform public.reattribute_meeting_cutoff(v_meeting_id);
    v_fixed := v_fixed + 1;
  end loop;

  raise notice '107 backfill: re-attributed % meetings', v_fixed;
end;
$$;
