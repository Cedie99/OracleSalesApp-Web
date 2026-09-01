-- ============================================================================
-- 129 - auto-resolve the client-edit requests that a promotion to 'new' makes
-- permanently un-approvable, and backfill the ones already stranded.
--
-- Follows 128. That migration made the decision correct (an existing-override
-- still applies over prospect/in_progress, and is refused over 'new') and made
-- Reject reachable, but it left the admin holding a card they can only ever
-- reject by hand. On a queue that was sitting at 207 pending, "you may now
-- manually clear each one" is not a fix.
--
-- WHAT THIS SUPERSEDES, precisely:
--   pending client_edit_requests whose `changes` asks for customer_type ->
--   'existing', on a client that has just reached 'new'.
--
-- Nothing else. In particular a `-> existing` request over a client sitting at
-- prospect or in_progress is still perfectly approvable per 128's decision
-- (Adrian, 2026-09-01) and must NOT be touched here — that is the whole point
-- of that rule, and a trigger that swept those up would quietly undo it.
--
-- WHY A TRIGGER ON clients RATHER THAN INSIDE THE PROMOTION FUNCTIONS:
-- 'new' is reachable by four paths -- advance_prospect_to_new() and
-- advance_in_progress_to_new() (110/040/063), the tag-along resolution edge
-- (040), and a direct admin write. Hooking the column itself covers all of
-- them and cannot drift when a fifth is added.
--
-- SAFETY NOTES (see the bulk-DML gotchas that bit us on earlier cleanups):
--   - trg_notify_edit_request (083) is AFTER INSERT only, so rejecting by
--     UPDATE re-emits no notifications.
--   - client_edit_requests_updated_at (101) stamps updated_at on this UPDATE,
--     which is exactly the column use-auto-refresh watches -- so the web queue
--     drops the card on its next poll without any extra plumbing.
--   - reviewed_by is deliberately left NULL. Attributing the decision to
--     whoever approved the PO would put a name against a request that person
--     never actually reviewed; the note carries the explanation instead.
-- ============================================================================

create or replace function public.supersede_existing_override_on_new()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
begin
  -- Named only when a profile is in scope; a promotion can also arrive from a
  -- backfill or a service-role write, where there is no acting person and the
  -- note must still read correctly.
  select full_name into v_actor
    from public.profiles where id = public.current_profile_id();

  update public.client_edit_requests r
     set status = 'rejected',
         reviewed_at = now(),
         review_note = left(
           'Automatically superseded: this client was promoted to New'
           || coalesce(' when ' || v_actor || ' approved their close-deal PO', '')
           || ', so the request to mark them Existing can no longer be applied. '
           || 'The agent can raise a new request if they still believe this '
           || 'client belongs outside the prospect funnel.',
           1000
         )
   where r.client_id = new.id
     and r.status = 'pending'
     and r.changes ? 'customer_type'
     and r.changes -> 'customer_type' ->> 'new' = 'existing';

  return new;
end;
$$;

drop trigger if exists clients_supersede_existing_override on public.clients;
create trigger clients_supersede_existing_override
  after update of customer_type on public.clients
  for each row
  when (new.customer_type = 'new' and old.customer_type is distinct from 'new')
  execute function public.supersede_existing_override_on_new();

-- ----------------------------------------------------------------------------
-- Backfill: the requests already stranded before this trigger existed.
--
-- Same predicate as the trigger, evaluated against the CURRENT client stage.
-- At least one client is known to have been stranded this way (promoted
-- 2026-09-01); there may be more inside the pending queue, which is why this
-- is a set-based statement rather than a targeted one.
--
-- The wording differs from the trigger's on purpose: for these, the promotion
-- happened at some unknown earlier point and naming an actor would be a guess.
-- ----------------------------------------------------------------------------
update public.client_edit_requests r
   set status = 'rejected',
       reviewed_at = now(),
       review_note =
         'Automatically superseded: this client had already been promoted to '
         || 'New before this request could be reviewed, so the request to mark '
         || 'them Existing can no longer be applied. The agent can raise a new '
         || 'request if they still believe this client belongs outside the '
         || 'prospect funnel.'
  from public.clients c
 where c.id = r.client_id
   and r.status = 'pending'
   and c.customer_type = 'new'
   and r.changes ? 'customer_type'
   and r.changes -> 'customer_type' ->> 'new' = 'existing';

comment on function public.supersede_existing_override_on_new() is
  'Rejects pending customer_type -> existing edit requests when their client '
  'reaches new. Deliberately does NOT touch requests on prospect/in_progress '
  'clients, which migration 128 keeps approvable.';
