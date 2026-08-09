-- 076 — Managers enter the quota ledger.
--
-- Three gaps close here, all of them the same omission from different angles:
-- the quota system knew about sales_specialist and rsr, and nothing else.
--
--   1. A manager had no CAP. 074's cutoff_cap_for_role() mapped two roles and
--      dropped everything else onto the legacy shared ceiling, because the only
--      record of whether a manager ran sales or RSR was a hardcoded UUID array
--      in lib/teams.ts that SQL could not read. 075 made that `teams.kind`, so
--      the supervisor's rule — sales manager to sales, sales manager to RSR —
--      is now a join.
--
--   2. A manager had no TARGET. get_my_cutoff_usage_summary() reads
--      `case role when 'sales_specialist' ... when 'rsr' ... else null end`, so
--      a manager's quota card has always shown no target and a count of zero.
--
--   3. A manager earned no CREDIT for a tag-along, contrary to what everyone
--      assumed was already happening. meeting_cutoff_attributions has one row
--      per meeting carrying one agent_id, and a companion lives in a separate
--      tag_along_requests row that attribution reads only as a GATE (pending
--      holds the meeting, declined kills it). Nobody was double-counted; the
--      manager simply was not counted at all.
--
-- (3) is why this migration is long: crediting an attendee means the ledger
-- holds one row per PARTICIPANT, so the primary key moves from (meeting_id) to
-- (meeting_id, agent_id).
--
-- WHO COUNTS AS A PARTICIPANT: the meeting's own agent, plus any manager whose
-- tag-along request for that meeting is ACCEPTED. A teammate companion earns
-- nothing — attribution has filtered on `invitee_kind = 'manager'` since 059 and
-- still does, so two specialists tagging along on each other cannot both bank
-- the same visit.
--
-- WHAT DOES NOT CHANGE: the six verdicts, Manila-local date resolution, stage
-- freezing, the outcome/evidence gate, the pending/declined gates, the
-- delayed-photo path, and both RPC signatures. Mobile reads this ledger only
-- through get_my_cutoff_usage_summary() and get_client_cutoff_allowance()
-- (lib/sync/cutoff-sync-down.ts touches no table but cutoff_periods), and both
-- keep their exact return shape, so mobile needs no change for any of this.
--
-- DEPENDS ON 074 (the per-role caps and captured_agent_role) and 075
-- (teams.kind). Apply in order.

-- --- The ceiling, now aware of a manager's team -----------------------------

/*
 * 074's cutoff_cap_for_role() answered from the role alone, which cannot work
 * for a manager: since migration 010 folded rsr_manager into sales_manager, one
 * role covers both kinds of team. This takes the team kind alongside it.
 *
 * A manager is capped as their team is capped — a sales manager against the
 * sales ceiling, an RSR manager against the RSR one. They still get their OWN
 * pool per client (the pool key is the role, per 074), so a manager's visits
 * never consume the specialist's slots; they are simply measured by the same
 * number the team they run is measured by.
 */
create or replace function public.cutoff_cap_for_agent(
  p_role       text,
  p_team_kind  text,
  p_sales_cap  integer,
  p_rsr_cap    integer,
  p_legacy_cap integer
)
returns integer
language sql
immutable
as $$
  select case
    when p_role = 'sales_specialist' then coalesce(p_sales_cap, p_legacy_cap)
    when p_role = 'rsr'              then coalesce(p_rsr_cap,   p_legacy_cap)
    when p_role = 'sales_manager' and p_team_kind = 'sales' then coalesce(p_sales_cap, p_legacy_cap)
    when p_role = 'sales_manager' and p_team_kind = 'rsr'   then coalesce(p_rsr_cap,   p_legacy_cap)
    -- Includes a manager with no team. 075 makes that unsavable through the UI,
    -- but a row predating it would land here rather than on a null ceiling,
    -- which would silently mean "nothing this person does ever counts".
    else p_legacy_cap
  end;
$$;

comment on function public.cutoff_cap_for_agent(text, text, integer, integer, integer) is
  'The per-client visit ceiling for a meeting recorded by an agent of this role on a team of this kind. Supersedes cutoff_cap_for_role(), which could not answer for sales_manager because that one role covers both team kinds.';

-- Kept as a forwarding shim rather than dropped: 074 is the version of this
-- schema another repo may already have applied, and a two-argument-shorter
-- call site failing at runtime is a worse outcome than one extra function.
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
  select public.cutoff_cap_for_agent(p_role, null, p_sales_cap, p_rsr_cap, p_legacy_cap);
$$;

comment on function public.cutoff_cap_for_role(text, integer, integer, integer) is
  'DEPRECATED as of migration 076 — forwards to cutoff_cap_for_agent() with an unknown team kind, which resolves a sales_manager to the legacy shared ceiling. Pass the team kind instead.';

/*
 * Which pool a participant draws from.
 *
 * 074 keyed the pool on the role alone. That breaks for managers and only for
 * managers: one role, `sales_manager`, now maps to two different ceilings
 * depending on team kind, so a sales manager and an RSR manager visiting the
 * same client would share one pool measured against two different numbers —
 * whoever was inserted second would be judged by their own cap against a count
 * that included the other's visits.
 *
 * Splitting them by team kind fixes it without touching anyone else: a
 * sales_specialist is always on a sales team and an rsr always on an RSR team,
 * so folding team kind into THEIR key would only strand a teamless agent in a
 * pool of their own for no benefit. Hence the case: managers split, everyone
 * else keyed exactly as 074 keyed them.
 */
create or replace function public.cutoff_pool_key(p_role text, p_team_kind text)
returns text
language sql
immutable
as $$
  select case
    when p_role = 'sales_manager' then 'sales_manager:' || coalesce(p_team_kind, 'none')
    else coalesce(p_role, '')
  end;
$$;

comment on function public.cutoff_pool_key(text, text) is
  'Identifies the per-client slot pool a participant draws from. Role alone for everyone except sales_manager, which splits by team kind because that role carries two different ceilings.';

-- --- The ledger holds one row per participant -------------------------------

-- Who this row credits: the meeting's own agent, or a manager who tagged along.
alter table public.meeting_cutoff_attributions
  add column if not exists participation text not null default 'agent';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.meeting_cutoff_attributions'::regclass
       and conname  = 'mca_participation_check'
  ) then
    alter table public.meeting_cutoff_attributions
      add constraint mca_participation_check
      check (participation in ('agent', 'tag_along'));
  end if;
end $$;

-- Frozen for the same reason as captured_agent_role: a manager who moves from a
-- sales team to an RSR team must not retroactively change the ceiling their
-- past meetings were judged against.
alter table public.meeting_cutoff_attributions
  add column if not exists captured_team_kind text;

update public.meeting_cutoff_attributions mca
   set captured_team_kind = t.kind
  from public.profiles p
  join public.teams t on t.id = p.team_id
 where p.id = mca.agent_id
   and mca.captured_team_kind is null;

-- The key change. Every existing row has a distinct meeting_id, so widening the
-- key rejects nothing and rewrites no data.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.meeting_cutoff_attributions'::regclass
       and conname  = 'meeting_cutoff_attributions_pkey'
       and array_length(conkey, 1) = 1
  ) then
    alter table public.meeting_cutoff_attributions
      drop constraint meeting_cutoff_attributions_pkey;
    alter table public.meeting_cutoff_attributions
      add constraint meeting_cutoff_attributions_pkey primary key (meeting_id, agent_id);
  end if;
end $$;

comment on table public.meeting_cutoff_attributions is
  'Server-authoritative cutoff/quota attribution ledger, one row per PARTICIPANT per meeting (widened from one row per meeting in migration 076, so a manager who tagged along earns credit). Written only by public.attribute_meeting_cutoff() — no client role has INSERT/UPDATE here, enforced by the absence of any such RLS policy.';

comment on column public.meeting_cutoff_attributions.participation is
  'agent = the meeting''s own agent_id. tag_along = a sales_manager whose companion request for this meeting was accepted. Teammate companions get no row at all.';
comment on column public.meeting_cutoff_attributions.captured_team_kind is
  'The team kind the agent belonged to when this was attributed, frozen. Explains which ceiling a sales_manager row was measured against after they have moved teams.';

-- --- Attribution ------------------------------------------------------------

/*
 * The 074 body, with the single-row insert replaced by a loop over participants.
 *
 * Everything before the loop is untouched: the idempotency guard, Manila-local
 * date resolution, stage freezing, the pending gate, the declined/outcome/photo
 * gate, and the period lookup all behave exactly as they did.
 *
 * The two early-return gates deliberately write a row for the AGENT ONLY.
 * pending_validity means no manager has answered yet, so there is no accepted
 * companion to credit; excluded_invalid means the meeting counts for nobody, and
 * a row per attendee recording that would be noise. Once past both gates, every
 * branch loops.
 *
 * LOCK ORDER. Each participant takes the advisory lock for its own pool, so a
 * meeting with an agent and a manager takes two. They are acquired in a fixed
 * order — by role, then agent id — so two concurrent transactions touching the
 * same client can never take the same two locks in opposite orders and deadlock.
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
  agent_kind text;
  role_cap integer;
  used_count integer;
  meeting_local_date date;
  part record;
begin
  if exists (select 1 from public.meeting_cutoff_attributions
             where meeting_id = p_meeting_id and attribution <> 'pending_validity') then return; end if;
  select * into m from public.meetings where id = p_meeting_id;
  if not found then return; end if;
  select * into c from public.clients where id = m.client_id;
  stage := coalesce(m.client_status_at_meeting, c.customer_type);
  meeting_local_date := (coalesce(m.start_captured_at, m.meeting_date) at time zone 'Asia/Manila')::date;

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

  if declined or m.outcome not in ('successful', 'follow_up') or m.photo_url is null then
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

  /*
   * The participants, in a deterministic lock order.
   *
   * The tag-along arm excludes the meeting's own agent: a manager who somehow
   * appears as their own companion would otherwise produce two rows with the
   * same key, and the second would be swallowed by the on-conflict guard rather
   * than raising anything.
   */
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

    -- Serialised per pool, exactly — so only writers genuinely contending for
    -- one pool's last slot block each other.
    perform pg_advisory_xact_lock(
      hashtext(c.id::text || p.id::text || public.cutoff_pool_key(part.role, part.team_kind)));

    -- Deliberately NOT expressed as cutoff_pool_key(...) = cutoff_pool_key(...),
    -- which would be tidier and would also stop the planner using
    -- idx_mca_client_period_role_counted (074). The role predicate carries the
    -- index; the team-kind predicate then filters the handful of rows it returns.
    --
    -- `is not distinct from` rather than `=`, so rows whose agent has no role
    -- form their own pool instead of matching nothing and letting every such
    -- meeting take slot 1 forever.
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

-- --- A manager's own quota card ---------------------------------------------

/*
 * Same signature and same shape as 066; the only change is that `target` now has
 * an answer for a sales_manager, taken from the kind of team they run.
 *
 * A manager inherits their team's target rather than getting one of their own —
 * decided 2026-08-09. That carries the RSR unit with it: an RSR manager's target
 * is rsr_daily_target × working days, exactly as their RSRs' is, while a sales
 * manager's is the flat per-cutoff sales_target. It also means raising a
 * specialist target raises their manager's by the same stroke, with no separate
 * control — the accepted cost of not adding manager target columns.
 *
 * The count needed no change at all: it already joins on mca.agent_id, so the
 * tag-along rows this migration introduces are picked up as the manager's own.
 */
create or replace function public.get_my_cutoff_usage_summary()
returns table (
  period_id       uuid,
  period_label    text,
  starts_on       date,
  ends_on         date,
  role            text,
  target          integer,
  confirmed_count integer,
  remaining       integer
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
    select p.role, t.kind as team_kind
    from public.profiles p
    left join public.teams t on t.id = p.team_id
    where p.id = public.current_profile_id()
  ),
  working_days as (
    select
      case
        when a.working_days_override is not null then a.working_days_override
        else (
          select count(*)::integer
          from generate_series(a.starts_on::timestamp, a.ends_on::timestamp, interval '1 day') d
          where extract(isodow from d) < 6
            and not exists (
              select 1 from public.holidays h where h.holiday_date = d::date
            )
        )
      end as days
    from active a
  ),
  usage as (
    select
      a.id as period_id,
      a.label as period_label,
      a.starts_on,
      a.ends_on,
      c.role,
      case
        when c.role = 'sales_specialist' then a.sales_target
        when c.role = 'rsr' or (c.role = 'sales_manager' and c.team_kind = 'rsr')
          then case when a.rsr_daily_target is null then null else a.rsr_daily_target * wd.days end
        when c.role = 'sales_manager' and c.team_kind = 'sales' then a.sales_target
        else null
      end as target,
      coalesce(count(mca.meeting_id) filter (
        where mca.attribution in ('counted', 'excluded_uncapped')
      ), 0)::integer as confirmed_count
    from active a
    cross join caller c
    cross join working_days wd
    left join public.meeting_cutoff_attributions mca
      on mca.period_id = a.id and mca.agent_id = public.current_profile_id()
    group by a.id, a.label, a.starts_on, a.ends_on, c.role, c.team_kind,
             a.sales_target, a.rsr_daily_target, wd.days
  )
  select
    period_id,
    period_label,
    starts_on,
    ends_on,
    role,
    target,
    confirmed_count,
    case when target is null then null else greatest(0, target - confirmed_count) end as remaining
  from usage;
$$;

grant execute on function public.get_my_cutoff_usage_summary() to authenticated;

-- --- A manager's allowance against one client -------------------------------

/*
 * Return signature still byte-identical to 060/066/074.
 *
 * Two changes, both consequences of a manager now having a pool of their own:
 * the ceiling comes from cutoff_cap_for_agent() so it reflects their team kind,
 * and sales_manager joins the set of roles narrowed to their own pool. Before
 * this, a manager asking about a client got the total across every pool — the
 * right answer when they had no pool, and the wrong one now that they do.
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
    select p.id, p.role, t.kind as team_kind
    from public.profiles p
    left join public.teams t on t.id = p.team_id
    where p.id = public.current_profile_id()
  ),
  ceiling as (
    select public.cutoff_cap_for_agent(
             cl.role, cl.team_kind,
             a.sales_client_meeting_cap, a.rsr_client_meeting_cap, a.client_meeting_cap
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
   -- Anyone with a pool gets their own, matching the trigger's count predicate
   -- exactly, so what the phone shows as remaining is what the next insert will
   -- decide. Anyone else — an admin or executive asking about a client they do
   -- not carry — has no pool to report, and narrowing to it would answer 0 used
   -- against a client with no slots left. They get the total across every pool.
   and (cl.role not in ('sales_specialist', 'rsr', 'sales_manager')
        or (mca.captured_agent_role is not distinct from cl.role
            and (cl.role is distinct from 'sales_manager'
                 or mca.captured_team_kind is not distinct from cl.team_kind)))
  where c.id = p_client_id
    and c.customer_type in ('new', 'existing')
  group by a.id, a.label, a.starts_on, a.ends_on, ce.cap;
$$;

grant execute on function public.get_client_cutoff_allowance(uuid) to authenticated;

-- ============================================================================
-- FIXED IN 077 — READ THIS IF YOU APPLY 076 ALONE
--
-- A manager invited to a meeting that was ALREADY attributed earns nothing: the
-- idempotency guard returns early once any non-pending_validity row exists.
--
-- That was written here as a harmless edge case, on the assumption that mobile
-- creates the companion request alongside the meeting so the request is already
-- 'pending' when attribution first runs. Checking the mobile repo showed the
-- opposite: its outbox pushes meetings (priority 20) before tag_along_requests
-- (priority 30), and must, because of the FK between them. The companion is
-- therefore NEVER visible on the first run, which makes this the only path
-- rather than an edge case — and means 059's pending/declined gates have never
-- fired in production either.
--
-- 077 adds the missing trigger and repairs the affected rows. Apply it with
-- this migration; 076 on its own leaves managers uncredited.
--
-- ROLLBACK
--   The PK widening is the only irreversible-ish step; narrowing it back
--   requires deleting the tag_along rows first:
--     delete from public.meeting_cutoff_attributions where participation = 'tag_along';
--     alter table public.meeting_cutoff_attributions drop constraint meeting_cutoff_attributions_pkey;
--     alter table public.meeting_cutoff_attributions add constraint meeting_cutoff_attributions_pkey primary key (meeting_id);
--   then re-run 074 to restore the previous function bodies.
-- ============================================================================
