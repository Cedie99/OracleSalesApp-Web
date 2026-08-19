-- 108 - Re-decide the visits 098 left behind.
--
-- Migration 098 widened the eligibility gate to admit `no_decision`:
--
--   if declined
--      or m.outcome not in ('successful', 'follow_up', 'no_decision')
--      or not has_valid_evidence
--
-- but its own backfill re-evaluated only `pending_validity` rows:
--
--   ... where a.attribution = 'pending_validity' loop
--
-- Every meeting already sitting on `excluded_invalid` kept the verdict it was
-- given under the OLD rule, where No Decision was refused. And because
-- `attribute_meeting_cutoff` returns early on any terminal attribution, and
-- every on-conflict arm is guarded to `pending_validity`, nothing could ever
-- revise them. The rule moved; the decisions did not.
--
-- On production 2026-08-19 that is 88 rows in the Aug 9-23 cutoff alone —
-- visits whose agents did the work and are being denied credit against a rule
-- that has not existed since 098 shipped.
--
-- THIS IS 098's MISSING BACKFILL, not a new policy. It grants credit only where
-- today's gate already says credit is due; a visit that still fails is left
-- exactly as it stands.
--
-- Shaped after 079, which does the same job for evidence that arrives late:
-- delete the `excluded_invalid` rows, then re-run. Deleting first is what lets
-- the guard fall through, and an `excluded_invalid` meeting holds exactly one
-- row (098 returns before its participant loop), so nothing else is disturbed.
-- The re-run writes the full participant set, so a manager who tagged along on
-- one of these visits is credited in the same pass.

do $$
declare
  v_meeting_id uuid;
  v_fixed integer := 0;
begin
  for v_meeting_id in
    select m.id
      from public.meetings m
      join public.meeting_cutoff_attributions a
        on a.meeting_id = m.id
       and a.attribution = 'excluded_invalid'
      -- ACTIVE periods only, matching 079. A closed or superseded cutoff has
      -- been reported on, and moving credit inside one would contradict every
      -- number already published from it.
      join public.cutoff_periods p
        on p.status = 'active'
       and (coalesce(m.start_captured_at, m.meeting_date) at time zone 'Asia/Manila')::date
           between p.starts_on and p.ends_on
     where
       -- 098's gate, negated: select only what it would now ADMIT. A meeting it
       -- still refuses is not touched, so this cannot take credit away.
       not exists (
         select 1 from public.tag_along_requests tar
          where tar.related_meeting_id = m.id
            and tar.context = 'meeting'
            and tar.invitee_kind = 'manager'
            and tar.status = 'declined'
       )
       and m.outcome in ('successful', 'follow_up', 'no_decision')
       -- Deliberately stricter than 098 in one corner. With no photo AND a null
       -- client_status_at_meeting this expression is NULL, so the row is not
       -- selected; inside 098 the same NULL makes its `if` fall through and the
       -- visit counts. Erring toward leaving a verdict alone: this migration
       -- can then only ever grant credit the gate plainly agrees with, never
       -- credit that rests on three-valued logic.
       and (
         m.photo_url is not null
         or (m.client_status_at_meeting in ('new', 'existing')
             and m.start_captured_at is not null
             and m.end_photo_url is not null)
       )
     group by m.id, m.meeting_date
     -- Chronological, so the client's slots are re-taken in the order the
     -- visits happened rather than in whatever order the planner returns.
     order by m.meeting_date
  loop
    -- Only the excluded_invalid rows, exactly as 079 does. A meeting in this
    -- set has no other rows, but scoping the delete keeps that an assertion
    -- rather than an assumption.
    delete from public.meeting_cutoff_attributions
     where meeting_id = v_meeting_id and attribution = 'excluded_invalid';

    perform public.attribute_meeting_cutoff(v_meeting_id);
    v_fixed := v_fixed + 1;
  end loop;

  raise notice '108: re-decided % visits that today''s gate admits', v_fixed;
end;
$$;

-- Idempotent by construction: a second run finds nothing, because everything it
-- admitted is no longer `excluded_invalid`. Anything still sitting there failed
-- the gate on its own merits and is meant to stay.
