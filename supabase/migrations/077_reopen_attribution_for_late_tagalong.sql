-- 077 — Attribution waits for a companion that has not arrived yet.
--
-- THE BUG. Migration 059 gates a meeting on its manager tag-along: a pending
-- companion parks the meeting on `pending_validity`, a decline settles it to
-- `excluded_invalid`, and only an accept lets it count. That gate has never
-- fired from the app, and could not have.
--
-- The mobile client is offline-first and pushes its outbox by priority
-- (lib/sync/entity-registry.ts):
--
--     meetings            priority 20
--     tag_along_requests  priority 30, dependencies: [ meetings ]
--
-- The ordering is not incidental and cannot simply be swapped: tag_along_requests
-- .related_meeting_id is a foreign key to meetings(id), so the meeting MUST land
-- first. Which means that when trg_meetings_cutoff_attribution fires on insert,
-- there is never a companion row for that meeting yet. The two existence checks
-- inside attribute_meeting_cutoff() —
--
--     ... where related_meeting_id = p_meeting_id and status = 'pending'
--     ... where related_meeting_id = p_meeting_id and status = 'declined'
--
-- both return false every time, and the meeting is decided immediately on
-- information that is incomplete by construction.
--
-- Three consequences, in order of severity:
--
--   1. A DECLINED tag-along leaves the meeting `counted`. The contract says such
--      a meeting must not count. This is live now and has been since 059.
--   2. `pending_validity` is unreachable through the app, so nothing ever waits
--      for a manager's confirmation (contract O-4).
--   3. A manager who accepts earns no credit: by the time
--      trg_tagalong_resolved_cutoff re-runs attribution, the idempotency guard
--      sees a terminal row and returns immediately. (Only visible once 076 gives
--      managers credit at all, but the same root cause.)
--
-- Nothing on the meetings row carries the missing signal — mobile computes a
-- `validity_status` at save time but writes it only to its local SQLite mirror,
-- never to the remote payload (lib/remote-meeting-payload.ts), so the server
-- cannot know a companion is coming.
--
-- THE FIX. Treat a companion request arriving for an already-decided meeting as
-- what it is: new information about that meeting. Re-open it and decide again.
--
-- This does not weaken the rule that decided meetings are never re-slotted. That
-- rule exists so an ADMIN editing a cap cannot retroactively reclassify finished
-- work — a change to the policy a meeting was measured by. This is the opposite
-- case: the same meeting, the same policy, a fact about it that arrived a few
-- hundred milliseconds late through a queue. The guards below keep it to exactly
-- that.

-- --- Re-open on arrival -----------------------------------------------------

/*
 * Fires on INSERT, where 059's trigger fires only on a status UPDATE.
 *
 * Every status except 'cancelled' is acted on, because each one changes the
 * verdict and each one can arrive as the request's FIRST state:
 *
 *   pending   the normal path — park the meeting until the manager answers
 *   accepted  mobile's `companionsPreAccepted` flow syncs up already accepted
 *   declined  settles the meeting to excluded_invalid, which is bug 1 above
 *
 * 'cancelled' is skipped: a request withdrawn before it was ever answered leaves
 * the meeting exactly as it stands.
 */
create or replace function public.trg_reopen_cutoff_for_late_tagalong()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_status text;
begin
  if new.context <> 'meeting'
     or new.invitee_kind <> 'manager'
     or new.related_meeting_id is null
     or new.status not in ('pending', 'accepted', 'declined')
  then
    return new;
  end if;

  -- Already open: attribute_meeting_cutoff() will read this row when it next
  -- runs, so there is nothing to re-open and no decision to disturb.
  if not exists (
    select 1 from public.meeting_cutoff_attributions
     where meeting_id = new.related_meeting_id
       and attribution <> 'pending_validity'
  ) then
    perform public.attribute_meeting_cutoff(new.related_meeting_id);
    return new;
  end if;

  /*
   * Never reopen against a finished period.
   *
   * In practice the request follows its meeting within one sync run, so the
   * period is invariably still active and this never triggers. It is here
   * because the alternative — a companion row arriving weeks late, after payroll
   * has been run against a closed cutoff — would silently restate a period
   * someone has already been paid on. A late arrival is worth correcting; a
   * settled one is not.
   */
  select p.status into v_period_status
    from public.meeting_cutoff_attributions mca
    join public.cutoff_periods p on p.id = mca.period_id
   where mca.meeting_id = new.related_meeting_id
   limit 1;

  if v_period_status in ('closed', 'superseded') then
    raise notice
      '077: tag-along % arrived for meeting % after its period was %; attribution left as decided.',
      new.id, new.related_meeting_id, v_period_status;
    return new;
  end if;

  /*
   * Hand every row for this meeting back to pending_validity, which is the one
   * state attribute_meeting_cutoff() is willing to overwrite — its on-conflict
   * clauses all carry `where ... attribution = 'pending_validity'`. Clearing
   * period_id and slot_index keeps mca_slot_only_when_counted satisfied and
   * releases the slot, so the re-run allocates from the pool's true state.
   *
   * A released slot can be taken by a meeting inserted in between, which would
   * push this one to over_cap. That is not a regression: arrival order is what
   * has always decided slots, and this meeting's claim was provisional.
   */
  update public.meeting_cutoff_attributions
     set attribution   = 'pending_validity',
         period_id     = null,
         slot_index    = null,
         attributed_at = now()
   where meeting_id = new.related_meeting_id;

  perform public.attribute_meeting_cutoff(new.related_meeting_id);
  return new;
end;
$$;

comment on function public.trg_reopen_cutoff_for_late_tagalong() is
  'Re-decides a meeting when its manager tag-along request arrives after the meeting itself. Mobile''s outbox always pushes meetings (priority 20) before tag_along_requests (priority 30, FK-dependent on meetings), so attribution first runs with no companion visible and the pending/declined gates in 059 can never see one.';

drop trigger if exists trg_tagalong_created_cutoff on public.tag_along_requests;
create trigger trg_tagalong_created_cutoff
  after insert on public.tag_along_requests
  for each row
  execute function public.trg_reopen_cutoff_for_late_tagalong();

-- --- Repair what the bug already decided ------------------------------------

/*
 * Meetings sitting on a verdict reached without their companion.
 *
 * Scoped to periods that are still open, for the same reason the trigger is: a
 * closed cutoff has been reported on, and rewriting it now would move numbers
 * somebody has already acted on. Those are left alone deliberately — the notice
 * below reports how many, so the discrepancy is known rather than discovered.
 *
 * The declined case is the one that matters: those meetings are counting toward
 * quota right now and should not be.
 */
do $$
declare
  v_repair uuid[];
  v_frozen integer;
  v_mid    uuid;
begin
  select coalesce(array_agg(distinct mca.meeting_id), '{}')
    into v_repair
    from public.meeting_cutoff_attributions mca
    join public.cutoff_periods p on p.id = mca.period_id
    join public.tag_along_requests tar
      on tar.related_meeting_id = mca.meeting_id
     and tar.context = 'meeting'
     and tar.invitee_kind = 'manager'
     and tar.status in ('pending', 'accepted', 'declined')
   where mca.attribution <> 'pending_validity'
     and p.status not in ('closed', 'superseded')
     -- Decided before its companion existed. A meeting attributed after the
     -- request was already there saw it, and needs nothing.
     and mca.attributed_at < tar.created_at;

  select count(distinct mca.meeting_id)
    into v_frozen
    from public.meeting_cutoff_attributions mca
    join public.cutoff_periods p on p.id = mca.period_id
    join public.tag_along_requests tar
      on tar.related_meeting_id = mca.meeting_id
     and tar.context = 'meeting'
     and tar.invitee_kind = 'manager'
     and tar.status = 'declined'
   where mca.attribution = 'counted'
     and p.status in ('closed', 'superseded')
     and mca.attributed_at < tar.created_at;

  if array_length(v_repair, 1) > 0 then
    update public.meeting_cutoff_attributions
       set attribution   = 'pending_validity',
           period_id     = null,
           slot_index    = null,
           attributed_at = now()
     where meeting_id = any(v_repair);

    -- Re-decided one at a time, in a stable order, so slot_index lands the same
    -- way a fresh run would rather than in whatever order the array happened to
    -- come back in.
    for v_mid in select m from unnest(v_repair) as m order by m loop
      perform public.attribute_meeting_cutoff(v_mid);
    end loop;

    raise notice '077: re-decided % meeting(s) that were attributed before their tag-along arrived.',
      array_length(v_repair, 1);
  end if;

  if v_frozen > 0 then
    raise notice
      '077: % meeting(s) in CLOSED periods are counted despite a declined tag-along. Left as-is on purpose — those cutoffs have already been reported on.',
      v_frozen;
  end if;
end $$;

-- ============================================================================
-- ROLLBACK
--   drop trigger if exists trg_tagalong_created_cutoff on public.tag_along_requests;
--   drop function if exists public.trg_reopen_cutoff_for_late_tagalong();
--   (the repair block is data, not schema — re-running 077 is idempotent, since
--    a repaired meeting's attributed_at then postdates its tag-along row)
-- ============================================================================
