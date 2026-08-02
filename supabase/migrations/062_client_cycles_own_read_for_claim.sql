-- ============================================================================
-- 062 - PROPOSED, NOT APPLIED. Own-cycle read for former-owner claim hiding.
--
-- Status: drafted for Vince's review only. Do not push/apply until approved.
--
-- Business rule (locked 2026-08-02, mobile vault
-- Meeting-Controller-LostOpps-Spec-DRAFT.md decision #3): a former owner must
-- never see their own previously-lost client as claimable in the Sales/RSR
-- Lost Opportunities list, even if they lost it in an earlier client_cycles
-- row than the current one. The mobile app already excludes the CURRENT
-- cycle's owner for free (clients.assigned_agent_id != caller). Excluding
-- HISTORICAL former owners requires reading client_cycles, whose only
-- existing SELECT policy (migration 035) is admin-only - a sales_specialist/
-- rsr device cannot see this table at all today.
--
-- Scope: additive, minimum-privilege. This policy lets a caller read ONLY
-- client_cycles rows where THEY were the owner - never another agent's
-- cycle history, never claimed_by/claimed_at for a cycle they didn't own.
-- It is deliberately NOT the broader "Managers read team cycles" or
-- "Executive read all cycles" shape - those are separate, undecided
-- questions (see Open Question 4 in the same spec doc re: Executive
-- claimed/claimedBy display, explicitly deferred, NOT covered by this file).
--
-- No new write path, no new table, no column changes. Reuses
-- current_profile_id() (migration 029, already live).
-- ============================================================================

-- Idempotent per the 2026-07-29 standing convention (Migration-052-Report):
-- CI must be able to re-run this file safely. drop-then-create is the only
-- idempotent shape for a policy, since Postgres has no CREATE OR REPLACE
-- POLICY.
drop policy if exists "Agents read own client cycles" on public.client_cycles;
create policy "Agents read own client cycles" on public.client_cycles
  for select using (owner_id = public.current_profile_id());

comment on policy "Agents read own client cycles" on public.client_cycles is
  'Additive, 2026-08-02. Lets an agent see their own past cycles (incl. ended/lost ones) so mobile can exclude a client they themselves formerly lost from their own claimable Lost Opportunities list. Does not expose any other agent''s cycle history. See vault Meeting-Controller-LostOpps-Spec-DRAFT.md decision #3.';

-- ============================================================================
-- Rollback (if ever needed): additive and read-only, safe to drop with no
-- data impact.
--   drop policy "Agents read own client cycles" on public.client_cycles;
--
-- Verification queries to run post-apply, before Vince approves the
-- Sales/RSR Lost Opportunities feature to ship against this:
--   1. As a sales_specialist/rsr session: select from client_cycles where
--      owner_id <> current_profile_id() -> must return 0 rows (no leak of
--      other agents' history).
--   2. As the same session: select from client_cycles where owner_id =
--      current_profile_id() -> must return exactly that agent's own cycles,
--      including any ended_at/end_reason='lost' rows.
--   3. Confirm admin/superadmin access is unchanged (migration 035's
--      "Admin read client cycles" policy is untouched, this is additive).
--   4. Confirm no INSERT/UPDATE/DELETE policy was added - client_cycles
--      remains write-only via SECURITY DEFINER server code.
-- ============================================================================
