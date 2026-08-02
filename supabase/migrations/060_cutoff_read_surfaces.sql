-- ============================================================================
-- 060 - Narrow authorized reads for mobile (Batch 7A/7B)
--
-- SECURITY INVOKER (the default - no "security definer" here) on purpose:
-- these functions run with the CALLING user's own privileges, so they
-- inherit the RLS policies already defined on cutoff_periods (058) and
-- meeting_cutoff_attributions (057) rather than re-implementing
-- authorization logic. Mobile is read-only through both of these; nothing
-- here grants any write path.
-- ============================================================================

-- This agent's own period-quota usage against their role's target for the
-- currently active period. Confirmed count = counted + excluded_uncapped
-- (contract: Prospect/In Progress meetings are uncapped per-client but still
-- contribute to the period quota; only over_cap is excluded from the target,
-- per contract O-3).
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
  select
    cp.id,
    cp.label,
    cp.starts_on,
    cp.ends_on,
    p.role,
    case p.role
      when 'sales_specialist' then cp.sales_target
      when 'rsr' then cp.rsr_target
      else null
    end as target,
    coalesce(count(mca.meeting_id) filter (
      where mca.attribution in ('counted', 'excluded_uncapped')
    ), 0)::integer as confirmed_count,
    greatest(
      0,
      (case p.role when 'sales_specialist' then cp.sales_target when 'rsr' then cp.rsr_target else 0 end)
      - coalesce(count(mca.meeting_id) filter (
          where mca.attribution in ('counted', 'excluded_uncapped')
        ), 0)
    )::integer as remaining
  from public.cutoff_periods cp
  join public.profiles p on p.id = public.current_profile_id()
  left join public.meeting_cutoff_attributions mca
    on mca.period_id = cp.id and mca.agent_id = p.id
  where cp.status = 'active'
  group by cp.id, cp.label, cp.starts_on, cp.ends_on, p.role, cp.sales_target, cp.rsr_target
  order by cp.starts_on desc
  limit 1;
$$;

grant execute on function public.get_my_cutoff_usage_summary() to authenticated;

-- Per-client New/Existing allowance for the active period, scoped to
-- whatever clients the caller can already read (relies entirely on the
-- existing clients RLS policies - own clients for sales_specialist/rsr, team
-- for sales_manager, org-wide for admin/executive; SECURITY INVOKER means
-- this function cannot see a client the caller couldn't already select
-- directly).
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
  select
    cp.id,
    cp.label,
    cp.starts_on,
    cp.ends_on,
    coalesce(count(mca.meeting_id) filter (where mca.attribution = 'counted'), 0)::integer as used,
    cp.client_meeting_cap,
    greatest(0, cp.client_meeting_cap - coalesce(count(mca.meeting_id) filter (where mca.attribution = 'counted'), 0))::integer as remaining
  from public.clients c
  join public.cutoff_periods cp on cp.status = 'active'
  left join public.meeting_cutoff_attributions mca
    on mca.period_id = cp.id and mca.client_id = c.id
  where c.id = p_client_id
    and c.customer_type in ('new', 'existing')
  group by cp.id, cp.label, cp.starts_on, cp.ends_on, cp.client_meeting_cap;
$$;

grant execute on function public.get_client_cutoff_allowance(uuid) to authenticated;
