-- ============================================================================
-- 017 — Automatic prospect -> new promotion (ADR-027)
--
-- PROVENANCE: authored by Vince Carter (mobile lead) 2026-07-19 and applied
-- directly to the shared Supabase project via the SQL Editor. Verified live
-- 2026-07-21 (function promote_client_to_new present). Committed here
-- retroactively. SQL matches the vault's Migration-017-Report.md.
--
-- ⚠ NOTE: that report is still headed "DRAFT — REVIEW BEFORE SENDING" and
-- carries a note-to-self saying it had not yet been reviewed or pasted in.
-- The function is nonetheless live, so the draft status appears stale rather
-- than accurate. Worth confirming with Vince that what ran matches this file.
--
-- THE RULE: clients.customer_type (mobile's prospect/new/existing lifecycle
-- value — NOT the coarser clients.status active/inactive/lost/deleted flag)
-- flips from 'prospect' (or null) to 'new' the moment BOTH are true, in either
-- order:
--   1. clients.details_completed_at is non-null (two-phase Complete Info)
--   2. at least one meeting for that client has outcome = 'successful'
-- One-way and one-time: never touches a client already at new/existing.
--
-- WHY SERVER-SIDE: this was first built on-device, which broke the standing
-- ADR-006 rule that lifecycle automations run server-side. A device is offline
-- most of the time, and the two conditions can be satisfied by writes from two
-- different devices/agents (reassignment, or a manager's device recording the
-- meeting) — so a per-device check can miss the transition entirely.
-- ============================================================================


-- Shared check-and-promote function — both triggers below call it.
CREATE OR REPLACE FUNCTION public.promote_client_to_new(p_client_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
begin
  update public.clients
  set customer_type = 'new'
  where id = p_client_id
    and (customer_type is null or customer_type = 'prospect')
    and details_completed_at is not null
    and exists (
      select 1 from public.meetings
      where client_id = p_client_id
        and outcome = 'successful'
    );
end;
$$;


-- Trigger 1: Complete Info sets details_completed_at for the first time —
-- promote if a Successful meeting already exists.
CREATE OR REPLACE FUNCTION public.trg_promote_on_details_completed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if (new.details_completed_at is not null and old.details_completed_at is null) then
    perform public.promote_client_to_new(new.id);
  end if;
  return new;
end;
$$;

DROP TRIGGER IF EXISTS promote_on_details_completed ON public.clients;
CREATE TRIGGER promote_on_details_completed
  AFTER UPDATE OF details_completed_at ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_promote_on_details_completed();


-- Trigger 2: a meeting's outcome becomes 'successful' (on insert, or a later
-- update) — promote the related client if their info is already completed.
CREATE OR REPLACE FUNCTION public.trg_promote_on_successful_meeting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if (new.outcome = 'successful' and new.client_id is not null) then
    perform public.promote_client_to_new(new.client_id);
  end if;
  return new;
end;
$$;

DROP TRIGGER IF EXISTS promote_on_successful_meeting ON public.meetings;
CREATE TRIGGER promote_on_successful_meeting
  AFTER INSERT OR UPDATE OF outcome ON public.meetings
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_promote_on_successful_meeting();


-- ============================================================================
-- ROLLBACK
--   DROP TRIGGER IF EXISTS promote_on_details_completed ON public.clients;
--   DROP TRIGGER IF EXISTS promote_on_successful_meeting ON public.meetings;
--   DROP FUNCTION IF EXISTS public.trg_promote_on_details_completed();
--   DROP FUNCTION IF EXISTS public.trg_promote_on_successful_meeting();
--   DROP FUNCTION IF EXISTS public.promote_client_to_new(uuid);
--
-- Clients already promoted stay promoted; that is expected, same as the rest
-- of this series.
-- ============================================================================
