-- ============================================================================
-- 058 - Meeting cutoff attribution ledger (Batch 7A/7B)
--
-- One row per meeting, keyed on the client-generated meeting UUID mobile
-- already produces (its existing outbox idempotency key - no new identifier
-- is introduced). Written EXCLUSIVELY by the SECURITY DEFINER function in
-- 059; no INSERT/UPDATE policy is granted to any client role, so this table
-- is authoritative and cannot be forged or edited from the API.
--
-- Values (Decisions.md ADR-053):
--   counted           - consumed a per-client slot, contributes to the role's
--                        period target.
--   over_cap          - valid, truthful, preserved meeting; pool was full.
--                        Excluded from both the per-client allowance and the
--                        period quota (contract O-3), but never deleted.
--   excluded_uncapped - client stage at start was prospect/in_progress; no
--                        slot consumed, still contributes to the period target.
--   excluded_invalid  - outcome/evidence did not qualify (contract: only
--                        Successful/Follow-up Required with valid evidence
--                        count; No Show/Abandoned/Incomplete/duplicate never
--                        count - Rescheduled/No Show are not implemented
--                        outcomes on this schema, confirmed 2026-08-02, do
--                        not add them).
--   pending_validity  - a manager tag-along confirmation is still pending on
--                        this meeting (tag_along_requests.status='pending').
--                        Reserves NO slot (contract O-4). Re-decided to a
--                        terminal value once the request resolves - see 059's
--                        second trigger.
--   unattributed      - no active cutoff_periods row covered the meeting's
--                        start time (contract O-10). Counts toward nothing.
--                        Never automatically reassigned to a later period.
--
-- Declined tag-along requests settle their meeting to excluded_invalid, not
-- pending_validity and not counted (contract: "Declined requests remain
-- uncounted").
-- ============================================================================

create table if not exists public.meeting_cutoff_attributions (
  meeting_id            uuid primary key references public.meetings(id) on delete cascade,
  period_id             uuid references public.cutoff_periods(id),
  client_id             uuid not null references public.clients(id),
  agent_id              uuid not null references public.profiles(id),
  captured_client_stage text,
  attribution           text not null
                          check (attribution in (
                            'counted','over_cap','excluded_uncapped',
                            'excluded_invalid','pending_validity','unattributed'
                          )),
  slot_index            integer,
  attributed_at         timestamptz not null default now(),
  decided_by_version     integer not null default 1,
  constraint mca_slot_only_when_counted
    check ((attribution = 'counted') = (slot_index is not null))
);

comment on table public.meeting_cutoff_attributions is
  'Server-authoritative cutoff/quota attribution ledger, one row per meeting. Written only by public.attribute_meeting_cutoff() (059) - no client role has INSERT/UPDATE here, enforced by the absence of any such RLS policy.';

create index if not exists idx_mca_client_period_counted
  on public.meeting_cutoff_attributions (client_id, period_id)
  where attribution = 'counted';
create index if not exists idx_mca_agent_period
  on public.meeting_cutoff_attributions (agent_id, period_id);
create index if not exists idx_mca_pending
  on public.meeting_cutoff_attributions (meeting_id)
  where attribution = 'pending_validity';

alter table public.meeting_cutoff_attributions enable row level security;

-- Read scope mirrors the existing migration 029 helpers, matching the
-- profiles.id-ownership + team-scope + org-wide-executive pattern already
-- used everywhere else (no new authorization vocabulary invented, per the
-- reuse-first rule).
drop policy if exists "Own cutoff attributions" on public.meeting_cutoff_attributions;
create policy "Own cutoff attributions" on public.meeting_cutoff_attributions
  for select using (agent_id = public.current_profile_id());

drop policy if exists "Manager team cutoff attributions" on public.meeting_cutoff_attributions;
create policy "Manager team cutoff attributions" on public.meeting_cutoff_attributions
  for select using (public.is_manager_of_profile(agent_id));

drop policy if exists "Executive read all cutoff attributions" on public.meeting_cutoff_attributions;
create policy "Executive read all cutoff attributions" on public.meeting_cutoff_attributions
  for select using (public.is_executive());

drop policy if exists "Admin read all cutoff attributions" on public.meeting_cutoff_attributions;
create policy "Admin read all cutoff attributions" on public.meeting_cutoff_attributions
  for select using (public.is_admin());

-- Deliberately no INSERT/UPDATE/DELETE policy for any role. Writes happen
-- exclusively inside the SECURITY DEFINER function (059), which executes as
-- the function owner and bypasses RLS by design - that is the entire
-- integrity guarantee of this table.
