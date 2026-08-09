-- 074 — The per-client visit limit, split per role.
--
-- Until now there was ONE ceiling, `client_meeting_cap`, applied to every
-- meeting regardless of who made it. The role TARGETS have been per-role since
-- 057 (sales_target per cutoff, rsr_daily_target per working day); the cap never
-- got the same treatment. 057's own table comment anticipated this exact change:
--   "client_meeting_cap is the shared New/Existing per-client cap for the period
--    unless a future revision splits it per role."
-- This is that revision, requested by the supervisor 2026-08-09.
--
-- THE MODEL: separate pools, not one pool with a role-dependent ceiling.
--
-- A single pool whose cap depends on who is asking is incoherent — a client
-- with a Sales limit of 2 and an RSR limit of 4 would be "full" or "not full"
-- depending on the role of whoever happened to visit last, and the same two
-- meetings would classify differently on re-run. So the pool itself is now keyed
-- per (client, period, ROLE): each role has its own allowance against a client,
-- counted independently. Sales filling its two slots does not consume any of
-- RSR's four.
--
-- In practice this changes almost nothing about how pools behave, because
-- clients.assigned_agent_id (001) means a client belongs to exactly one agent,
-- hence one role — so a client has one non-empty pool. The per-role key matters
-- for correctness at the edges (a reassignment across roles mid-cutoff, a
-- meeting recorded by someone of another role) rather than as a routine case.
--
-- WHY THE LEDGER NEEDS A NEW COLUMN: to count a role's pool the trigger has to
-- know which role each existing row belongs to, and the ledger stored only
-- agent_id. Reading profiles.role live would make an agent's role change
-- retroactively re-slot meetings decided months ago. So the role is FROZEN onto
-- the row at attribution time, exactly as captured_client_stage already freezes
-- the client's stage (058) for the same reason.
--
-- NOTHING RE-ATTRIBUTES. Both new caps are backfilled equal to the existing
-- `client_meeting_cap`, so every meeting already decided keeps the verdict it
-- has, and splitting a pool that both roles were never sharing changes no count.
-- The admin differentiates the two numbers afterwards, and — matching the rule
-- apply_standing_targets() has always applied to the cap — a change reaches only
-- periods that have not STARTED, because the cap drives slot allocation and no
-- amount of editing can retroactively re-slot what the trigger already decided.
--
-- Additive and idempotent throughout: safe to re-run, drops nothing.

-- --- The two caps, on both layers ------------------------------------------
--
-- Nullable, not NOT NULL, and every read coalesces to `client_meeting_cap`.
-- That is deliberate given this schema is shared with the mobile repo and rows
-- get inserted from both sides: an insert that predates this migration, or that
-- simply omits the new columns, keeps behaving exactly as it does today instead
-- of failing. Null here means "not split — use the legacy shared ceiling", which
-- is a real and correct state, not a missing value.

alter table public.cutoff_periods
  add column if not exists sales_client_meeting_cap integer,
  add column if not exists rsr_client_meeting_cap   integer;

alter table public.quota_settings
  add column if not exists sales_client_meeting_cap integer,
  add column if not exists rsr_client_meeting_cap   integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cutoff_periods'::regclass
       and conname  = 'cutoff_periods_sales_client_cap_positive'
  ) then
    alter table public.cutoff_periods
      add constraint cutoff_periods_sales_client_cap_positive
      check (sales_client_meeting_cap is null or sales_client_meeting_cap > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cutoff_periods'::regclass
       and conname  = 'cutoff_periods_rsr_client_cap_positive'
  ) then
    alter table public.cutoff_periods
      add constraint cutoff_periods_rsr_client_cap_positive
      check (rsr_client_meeting_cap is null or rsr_client_meeting_cap > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.quota_settings'::regclass
       and conname  = 'quota_settings_sales_client_cap_positive'
  ) then
    alter table public.quota_settings
      add constraint quota_settings_sales_client_cap_positive
      check (sales_client_meeting_cap is null or sales_client_meeting_cap > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.quota_settings'::regclass
       and conname  = 'quota_settings_rsr_client_cap_positive'
  ) then
    alter table public.quota_settings
      add constraint quota_settings_rsr_client_cap_positive
      check (rsr_client_meeting_cap is null or rsr_client_meeting_cap > 0);
  end if;
end $$;

-- Backfill: both roles start on the number they were already sharing, so the
-- split is a no-op until an admin makes the two differ.
update public.cutoff_periods
   set sales_client_meeting_cap = client_meeting_cap
 where sales_client_meeting_cap is null;

update public.cutoff_periods
   set rsr_client_meeting_cap = client_meeting_cap
 where rsr_client_meeting_cap is null;

update public.quota_settings
   set sales_client_meeting_cap = client_meeting_cap
 where sales_client_meeting_cap is null;

update public.quota_settings
   set rsr_client_meeting_cap = client_meeting_cap
 where rsr_client_meeting_cap is null;

comment on column public.cutoff_periods.sales_client_meeting_cap is
  'Per-client meeting ceiling for meetings recorded by a sales_specialist, for this period. One pool across new+existing, counted separately from the rsr pool. Null means fall back to client_meeting_cap.';
comment on column public.cutoff_periods.rsr_client_meeting_cap is
  'Per-client meeting ceiling for meetings recorded by an rsr, for this period. One pool across new+existing, counted separately from the sales pool. Null means fall back to client_meeting_cap.';

-- DEPRECATED, deliberately not dropped, for the same reason as rsr_target: the
-- mobile repo's lib/sync/cutoff-sync-down.ts inserts this column by name into
-- cutoff_periods_snapshot (NOT NULL there), so dropping it or letting it go null
-- would break their sync-down the moment this deploys. It is kept maintained as
-- the LOOSER of the two caps — anything still reading it therefore over-states
-- an allowance rather than marking a meeting over-cap that is not.
comment on column public.cutoff_periods.client_meeting_cap is
  'DEPRECATED as of migration 074 — superseded by sales_client_meeting_cap / rsr_client_meeting_cap, which are counted as separate per-role pools. Maintained as greatest(sales, rsr) purely so mobile''s sync-down keeps receiving a non-null value; it is no longer what attribution reads for a sales_specialist or rsr meeting.';

comment on column public.quota_settings.sales_client_meeting_cap is
  'Standing per-client visit limit for sales_specialist. New periods inherit it.';
comment on column public.quota_settings.rsr_client_meeting_cap is
  'Standing per-client visit limit for rsr. New periods inherit it.';

-- --- Which ceiling applies to a role ---------------------------------------

/*
 * The single definition of "the cap for this role", so the trigger, the mobile
 * RPC, and any later reader cannot drift apart on it.
 *
 * A role with no cap of its own falls back to the legacy shared ceiling. In
 * practice only sales_specialist and rsr ever appear as a meeting's agent — a
 * manager tagging along is recorded on the specialist's own meeting, not their
 * own — so the fallback is a safety net rather than a routine path. It exists
 * because the alternative is a null ceiling, and a null ceiling silently means
 * "no meeting ever counts".
 */
create or replace function public.cutoff_cap_for_role(
  p_role       text,
  p_sales_cap  integer,
  p_rsr_cap    integer,
  p_legacy_cap integer
)
returns integer
language sql
immutable
as $$
  select case p_role
    when 'sales_specialist' then coalesce(p_sales_cap, p_legacy_cap)
    when 'rsr'              then coalesce(p_rsr_cap,   p_legacy_cap)
    else p_legacy_cap
  end;
$$;

comment on function public.cutoff_cap_for_role(text, integer, integer, integer) is
  'The per-client visit ceiling that applies to a meeting recorded by an agent of this role, falling back to the legacy shared cap. The one definition of that mapping — attribution (074) and get_client_cutoff_allowance() both call it.';

-- --- The ledger learns which role a row belongs to --------------------------

alter table public.meeting_cutoff_attributions
  add column if not exists captured_agent_role text;

comment on column public.meeting_cutoff_attributions.captured_agent_role is
  'The agent''s role at the moment this meeting was attributed, frozen like captured_client_stage. It identifies which per-role pool the row consumed. Were it read live from profiles instead, a later role change would silently re-slot meetings decided months ago.';

-- Backfill from the roster's CURRENT roles. Imperfect by construction — a role
-- changed since the meeting cannot be recovered — and harmless here precisely
-- because both caps were just backfilled equal: whichever pool a historical row
-- is assigned to, it is measured against the same number it always was.
update public.meeting_cutoff_attributions mca
   set captured_agent_role = p.role
  from public.profiles p
 where p.id = mca.agent_id
   and mca.captured_agent_role is null;

-- The pool lookup is now (client, period, role), so the counting index has to
-- carry the role or every count degrades to a filter over the client's rows.
create index if not exists idx_mca_client_period_role_counted
  on public.meeting_cutoff_attributions (client_id, period_id, captured_agent_role)
  where attribution = 'counted';

-- --- Attribution: per-role pools -------------------------------------------

/*
 * Unchanged from 072 apart from the pool: Manila-local date resolution, stage
 * freezing, the tag-along gate, the outcome/evidence gate, idempotency and the
 * delayed-photo path all behave exactly as before. What changed is three lines —
 * the role is resolved and frozen, the cap comes from cutoff_cap_for_role(), and
 * both the advisory lock and the slot count are scoped by that role.
 *
 * The lock key gains the role for a reason: without it, two agents of DIFFERENT
 * roles racing for slots against the same client would serialise against each
 * other for no purpose, since they are no longer competing for the same pool.
 * With it, only writers genuinely contending for one pool's last slot block.
 */
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
  role_cap integer;
  used_count integer;
  meeting_local_date date;
begin
  if exists (select 1 from public.meeting_cutoff_attributions
             where meeting_id = p_meeting_id and attribution <> 'pending_validity') then return; end if;
  select * into m from public.meetings where id = p_meeting_id;
  if not found then return; end if;
  select * into c from public.clients where id = m.client_id;
  stage := coalesce(m.client_status_at_meeting, c.customer_type);
  meeting_local_date := (coalesce(m.start_captured_at, m.meeting_date) at time zone 'Asia/Manila')::date;

  -- Frozen here, once, and written onto every branch below — including the
  -- non-counting ones, so a report can say which role an invalid or unattributed
  -- meeting came from without joining back to a roster that may have changed.
  select role into agent_role from public.profiles where id = m.agent_id;

  select exists (select 1 from public.tag_along_requests
    where related_meeting_id = p_meeting_id and context = 'meeting'
      and invitee_kind = 'manager' and status = 'pending') into pending;
  select exists (select 1 from public.tag_along_requests
    where related_meeting_id = p_meeting_id and context = 'meeting'
      and invitee_kind = 'manager' and status = 'declined') into declined;
  if pending then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, captured_agent_role, attribution)
    values (m.id, null, m.client_id, m.agent_id, stage, agent_role, 'pending_validity')
    on conflict (meeting_id) do update set period_id = excluded.period_id,
      captured_client_stage = excluded.captured_client_stage,
      captured_agent_role = excluded.captured_agent_role, attribution = excluded.attribution,
      slot_index = null, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;
  if declined or m.outcome not in ('successful', 'follow_up') or m.photo_url is null then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, captured_agent_role, attribution)
    values (m.id, null, m.client_id, m.agent_id, stage, agent_role, 'excluded_invalid')
    on conflict (meeting_id) do update set captured_client_stage = excluded.captured_client_stage,
      captured_agent_role = excluded.captured_agent_role,
      attribution = excluded.attribution, period_id = null, slot_index = null, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;
  select * into p from public.cutoff_periods
   where status = 'active' and meeting_local_date between starts_on and ends_on
   order by starts_on desc limit 1;
  if not found then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, captured_agent_role, attribution)
    values (m.id, null, m.client_id, m.agent_id, stage, agent_role, 'unattributed')
    on conflict (meeting_id) do update set attribution = excluded.attribution,
      captured_client_stage = excluded.captured_client_stage,
      captured_agent_role = excluded.captured_agent_role, period_id = null, slot_index = null,
      attributed_at = now() where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;
  if stage not in ('new', 'existing') then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, captured_agent_role, attribution)
    values (m.id, p.id, m.client_id, m.agent_id, stage, agent_role, 'excluded_uncapped')
    on conflict (meeting_id) do update set attribution = excluded.attribution,
      captured_client_stage = excluded.captured_client_stage,
      captured_agent_role = excluded.captured_agent_role, period_id = excluded.period_id,
      slot_index = null, attributed_at = now() where public.meeting_cutoff_attributions.attribution = 'pending_validity';
    return;
  end if;

  role_cap := public.cutoff_cap_for_role(
    agent_role, p.sales_client_meeting_cap, p.rsr_client_meeting_cap, p.client_meeting_cap);

  -- Serialised per (client, period, role) — the pool, exactly.
  perform pg_advisory_xact_lock(
    hashtext(c.id::text || p.id::text || coalesce(agent_role, '')));

  -- `is not distinct from` rather than `=`, so rows whose agent has no profile
  -- row (a null role) form their own pool instead of matching nothing and
  -- letting every such meeting take slot 1 forever.
  select count(*) into used_count from public.meeting_cutoff_attributions
   where client_id = c.id and period_id = p.id and attribution = 'counted'
     and captured_agent_role is not distinct from agent_role;

  if used_count < role_cap then
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, captured_agent_role, attribution, slot_index)
    values (m.id, p.id, m.client_id, m.agent_id, stage, agent_role, 'counted', used_count + 1)
    on conflict (meeting_id) do update set attribution = excluded.attribution,
      captured_client_stage = excluded.captured_client_stage,
      captured_agent_role = excluded.captured_agent_role, period_id = excluded.period_id,
      slot_index = excluded.slot_index, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
  else
    insert into public.meeting_cutoff_attributions
      (meeting_id, period_id, client_id, agent_id, captured_client_stage, captured_agent_role, attribution)
    values (m.id, p.id, m.client_id, m.agent_id, stage, agent_role, 'over_cap')
    on conflict (meeting_id) do update set attribution = excluded.attribution,
      captured_client_stage = excluded.captured_client_stage,
      captured_agent_role = excluded.captured_agent_role, period_id = excluded.period_id,
      slot_index = null, attributed_at = now()
      where public.meeting_cutoff_attributions.attribution = 'pending_validity';
  end if;
end;
$$;

revoke all on function public.attribute_meeting_cutoff(uuid) from public, authenticated, anon;

-- --- Applying a standing change --------------------------------------------

/*
 * The 064 contract, with the cap split in two.
 *
 * The asymmetry it established is unchanged and is the whole reason this
 * function is shaped the way it is: TARGETS update in place on every period that
 * has not ended, because attribution never reads a target and so no ledger row
 * can move. CAPS reach only periods that have not STARTED, because attribution
 * does read them — a running period already has meetings holding slots allocated
 * against its current ceiling, and lowering it would not un-slot them.
 *
 * client_meeting_cap is carried along as greatest(sales, rsr) so the deprecated
 * column mobile still selects never goes stale or null. See its comment above.
 */
create or replace function public.apply_standing_targets(
  p_sales_target       integer,
  p_rsr_daily_target   integer,
  p_sales_client_cap   integer,
  p_rsr_client_cap     integer
)
returns table (
  periods_updated integer,
  cap_updated     integer,
  periods_ended   integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today   date := (now() at time zone 'Asia/Manila')::date;
  v_actor   uuid := public.current_profile_id();
  v_period  record;
  v_updated integer := 0;
  v_cap     integer := 0;
  v_ended   integer := 0;
  v_legacy  integer := greatest(p_sales_client_cap, p_rsr_client_cap);
begin
  if not public.is_admin() then
    raise exception 'Only an admin may change quota targets';
  end if;

  if p_sales_client_cap is null or p_sales_client_cap <= 0 then
    raise exception 'The Sales visit limit must be a positive number';
  end if;

  if p_rsr_client_cap is null or p_rsr_client_cap <= 0 then
    raise exception 'The RSR visit limit must be a positive number';
  end if;

  insert into public.quota_settings
    (id, sales_target, rsr_daily_target, sales_client_meeting_cap, rsr_client_meeting_cap,
     client_meeting_cap, updated_by, updated_at)
  values
    (true, p_sales_target, p_rsr_daily_target, p_sales_client_cap, p_rsr_client_cap,
     v_legacy, v_actor, now())
  on conflict (id) do update
    set sales_target             = excluded.sales_target,
        rsr_daily_target         = excluded.rsr_daily_target,
        sales_client_meeting_cap = excluded.sales_client_meeting_cap,
        rsr_client_meeting_cap   = excluded.rsr_client_meeting_cap,
        client_meeting_cap       = excluded.client_meeting_cap,
        updated_by               = excluded.updated_by,
        updated_at               = excluded.updated_at;

  select count(*) into v_ended
    from public.cutoff_periods
   where ends_on < v_today;

  for v_period in
    select * from public.cutoff_periods
     where ends_on >= v_today
       and status in ('draft', 'scheduled', 'active')
     order by starts_on
  loop
    if v_period.sales_target is distinct from p_sales_target then
      insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
      values (v_period.id, v_actor, 'sales_target', v_period.sales_target::text, p_sales_target::text);
    end if;

    if v_period.rsr_daily_target is distinct from p_rsr_daily_target then
      insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
      values (v_period.id, v_actor, 'rsr_daily_target', v_period.rsr_daily_target::text, p_rsr_daily_target::text);
    end if;

    if v_period.sales_target is distinct from p_sales_target
       or v_period.rsr_daily_target is distinct from p_rsr_daily_target then
      update public.cutoff_periods
         set sales_target     = p_sales_target,
             rsr_daily_target = p_rsr_daily_target,
             updated_at       = now()
       where id = v_period.id;
      v_updated := v_updated + 1;
    end if;

    -- Caps: future periods only. One audit row per cap that actually moved, and
    -- one v_cap increment per PERIOD touched — the count is reported to the
    -- admin as "the visit limit on N not yet started", so counting it twice for
    -- a period where both roles changed would read as twice as many periods.
    if v_period.starts_on > v_today
       and (v_period.sales_client_meeting_cap is distinct from p_sales_client_cap
            or v_period.rsr_client_meeting_cap is distinct from p_rsr_client_cap) then

      if v_period.sales_client_meeting_cap is distinct from p_sales_client_cap then
        insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
        values (v_period.id, v_actor, 'sales_client_meeting_cap',
                v_period.sales_client_meeting_cap::text, p_sales_client_cap::text);
      end if;

      if v_period.rsr_client_meeting_cap is distinct from p_rsr_client_cap then
        insert into public.cutoff_period_changes (period_id, changed_by, field, old_value, new_value)
        values (v_period.id, v_actor, 'rsr_client_meeting_cap',
                v_period.rsr_client_meeting_cap::text, p_rsr_client_cap::text);
      end if;

      update public.cutoff_periods
         set sales_client_meeting_cap = p_sales_client_cap,
             rsr_client_meeting_cap   = p_rsr_client_cap,
             client_meeting_cap       = v_legacy,
             updated_at               = now()
       where id = v_period.id;
      v_cap := v_cap + 1;
    end if;
  end loop;

  periods_updated := v_updated;
  cap_updated     := v_cap;
  periods_ended   := v_ended;
  return next;
end $$;

revoke all on function public.apply_standing_targets(integer, integer, integer, integer) from public;
grant execute on function public.apply_standing_targets(integer, integer, integer, integer) to authenticated;

comment on function public.apply_standing_targets(integer, integer, integer, integer) is
  'Upserts quota_settings and pushes the change onto every period that has not ended, writing one cutoff_period_changes row per field actually changed. Targets update in place because they feed no attribution decision; the two per-role visit limits reach only periods that have not started, because they do. Admin-only.';

-- The 3-argument form kept as a forwarding shim rather than dropped. Web's
-- Settings screen is its only known caller and moves to the 4-arg form in the
-- same change, but this schema is shared with a repo that deploys on its own
-- timetable, and a dropped function is a hard failure where a shim is merely a
-- less precise call. Passing one number for both roles is exactly the old
-- behaviour: a single ceiling shared by everyone.
create or replace function public.apply_standing_targets(
  p_sales_target       integer,
  p_rsr_daily_target   integer,
  p_client_meeting_cap integer
)
returns table (
  periods_updated integer,
  cap_updated     integer,
  periods_ended   integer
)
language sql
as $$
  select * from public.apply_standing_targets(
    p_sales_target, p_rsr_daily_target, p_client_meeting_cap, p_client_meeting_cap);
$$;

comment on function public.apply_standing_targets(integer, integer, integer) is
  'DEPRECATED as of migration 074 — forwards to the 4-argument form with the same cap for both roles, which is the pre-074 behaviour. Kept only so a caller that has not migrated keeps working; use the 4-argument form.';

-- --- Mobile read surface ----------------------------------------------------

/*
 * Same date resolution and single-row guarantee as 066; the allowance is now the
 * CALLER'S OWN role's pool against that client, not a shared total.
 *
 * The return signature is byte-identical to 060/066 — same columns, names, types
 * and order — so the mobile repo's lib/sync/cutoff-sync-down.ts needs no change,
 * exactly as with 066. `cap` simply now means "your role's ceiling on this
 * client" and `used` counts only your role's pool. That is the right answer for
 * every caller of this function: it is asked by an agent about a client they are
 * about to visit, and what they need to know is whether THEY have a slot left.
 */
create or replace function public.get_client_cutoff_allowance(p_client_id uuid)
returns table (
  period_id  uuid,
  period_label text,
  starts_on  date,
  ends_on    date,
  used       integer,
  cap        integer,
  remaining  integer
)
language sql
stable
as $$
  with active as (
    select cp.*
    from public.cutoff_periods cp
    where cp.status = 'active'
      and (now() at time zone 'Asia/Manila')::date between cp.starts_on and cp.ends_on
    order by cp.starts_on desc
    limit 1
  ),
  caller as (
    select p.id, p.role
    from public.profiles p
    where p.id = public.current_profile_id()
  ),
  ceiling as (
    select public.cutoff_cap_for_role(
             cl.role, a.sales_client_meeting_cap, a.rsr_client_meeting_cap, a.client_meeting_cap
           ) as cap
    from active a cross join caller cl
  )
  select
    a.id,
    a.label,
    a.starts_on,
    a.ends_on,
    coalesce(count(mca.meeting_id) filter (where mca.attribution = 'counted'), 0)::integer as used,
    ce.cap,
    greatest(0, ce.cap - coalesce(count(mca.meeting_id) filter (where mca.attribution = 'counted'), 0))::integer as remaining
  from public.clients c
  cross join active a
  cross join caller cl
  cross join ceiling ce
  left join public.meeting_cutoff_attributions mca
    on mca.period_id = a.id
   and mca.client_id = c.id
   -- An agent gets their OWN pool, matching the trigger's count predicate
   -- exactly, so what the phone shows as remaining is what the next insert will
   -- decide. Anyone else — a manager or admin asking about a client they do not
   -- carry — has no pool of their own to report, and narrowing to it would
   -- answer 0 used against a client with no slots left. They get the total
   -- across every pool instead, measured against the looser ceiling that
   -- cutoff_cap_for_role() hands their role.
   and (cl.role not in ('sales_specialist', 'rsr')
        or mca.captured_agent_role is not distinct from cl.role)
  where c.id = p_client_id
    and c.customer_type in ('new', 'existing')
  group by a.id, a.label, a.starts_on, a.ends_on, ce.cap;
$$;

grant execute on function public.get_client_cutoff_allowance(uuid) to authenticated;
