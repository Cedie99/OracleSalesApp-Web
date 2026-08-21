-- ============================================================================
-- 119 — ADR-067 correction: holder status derives from Tag-Along accept only
--
-- Migration 118 shipped an extra, unwanted decision: a `holder_decision`
-- column + `decide_client_record_holder_status()` RPC requiring the invited
-- manager to make a SECOND, separate approval before becoming a client
-- record holder. Vince corrected this 2026-08-22 (after 118 was already
-- merged to staging): there is no second decision. Accepting the existing
-- meeting-context Tag-Along invite IS the holder decision — nothing else.
--
-- 118 is intentionally left as-is (already applied on staging; per this
-- repo's standing rule, an applied migration is never hand-edited — see
-- [[Migration-052-Report]]). This migration corrects it forward instead:
--
--   1. Drop `decide_client_record_holder_status()` — dead code, no caller
--      will exist on either mobile or web after this ships.
--   2. Drop `tag_along_requests.holder_decision` — the extra decision this
--      migration removes. Nothing currently deployed depends on reading it
--      (mobile app has not shipped a build calling the 118 RPC).
--   3. Add a trigger that grants holder status automatically the instant a
--      manager's meeting-context Tag-Along invite transitions to
--      `status = 'accepted'` — reusing 118's existing "Invitee responds to
--      pending" RLS policy (migration 019) as the only path to that
--      transition, so this trigger fires regardless of how/when it's set.
--
-- `client_meeting_holders` itself, its RLS, and 118's widened
-- `decide_client_edit_request()` eligibility are UNCHANGED and correct as
-- shipped — only the holder-*grant* mechanism was wrong.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Drop the now-dead RPC from 118.
-- ----------------------------------------------------------------------------

drop function if exists public.decide_client_record_holder_status(uuid, text);

-- ----------------------------------------------------------------------------
-- 2. Drop the now-dead column from 118.
-- ----------------------------------------------------------------------------

alter table public.tag_along_requests
  drop column if exists holder_decision;

-- ----------------------------------------------------------------------------
-- 3. Trigger: accepting a meeting-context manager invite grants holder
--    status directly. No separate button, RPC, or column.
-- ----------------------------------------------------------------------------

create or replace function public.grant_client_holder_on_tagalong_accept()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'accepted'
     and old.status is distinct from 'accepted'
     and new.context = 'meeting'
     and new.invitee_kind = 'manager'
     and new.related_client_id is not null then
    insert into public.client_meeting_holders (client_id, manager_id, granted_via_request_id)
    values (new.related_client_id, new.invitee_id, new.id)
    on conflict (client_id, manager_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_grant_client_holder_on_tagalong_accept on public.tag_along_requests;
create trigger trg_grant_client_holder_on_tagalong_accept
  after update of status on public.tag_along_requests
  for each row
  execute function public.grant_client_holder_on_tagalong_accept();

-- ----------------------------------------------------------------------------
-- Backfill: any meeting-context manager invite that was ALREADY accepted
-- before this migration ran (between 118's deploy and this one) would not
-- have a holder row yet, since 118 never auto-granted one on accept. Grant
-- it now so no in-flight acceptance is silently missed.
-- ----------------------------------------------------------------------------

insert into public.client_meeting_holders (client_id, manager_id, granted_via_request_id)
select related_client_id, invitee_id, id
from public.tag_along_requests
where status = 'accepted'
  and context = 'meeting'
  and invitee_kind = 'manager'
  and related_client_id is not null
on conflict (client_id, manager_id) do nothing;

-- ============================================================================
-- ROLLBACK
--   drop trigger if exists trg_grant_client_holder_on_tagalong_accept on public.tag_along_requests;
--   drop function if exists public.grant_client_holder_on_tagalong_accept();
--   -- Note: the backfilled client_meeting_holders rows above are NOT undone
--   -- by this rollback (ADR-067 decision 3: holder grants are never revoked).
--   alter table public.tag_along_requests
--     add column if not exists holder_decision text
--       check (holder_decision in ('approved', 'rejected'));
--   -- decide_client_record_holder_status() is not recreated by this rollback;
--   -- restore it from migration 118's body if ever truly needed again.
-- ============================================================================
