-- ============================================================================
-- 140 — Card counts for the Collection and Delivery lenses on Reports
--
-- The same split 136 made for Sales, finishing the job: the CARDS are
-- aggregates and belong here, the DOWNLOADS are every row by definition and now
-- fetch when the button is pressed rather than on mount.
--
-- ONE WRINKLE WORTH NAMING: the two cards on each page filter on DIFFERENT date
-- columns. Stores and stops are dated by when they were SCHEDULED; remittances
-- by when they were SUBMITTED. A remittance covering last week's stores is this
-- week's paperwork, and the panels are read that way — so a single date window
-- means two different things depending on which card you are looking at, and
-- that is correct.
--
-- SECURITY: SECURITY DEFINER, grants naming BOTH anon paths per migration 132.
-- ============================================================================

create or replace function public.get_collection_report_counts(
  p_collector_id uuid        default null,
  p_from         timestamptz default null,
  p_to           timestamptz default null
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
visits as (
  select v.status, v.amount_collected
  from public.collection_visits v
  where (p_collector_id is null or v.collector_id = p_collector_id)
    and (p_from is null or v.scheduled_for >= p_from)
    and (p_to   is null or v.scheduled_for <= p_to)
),
remittances as (
  select r.status, r.amount_remitted
  from public.remittances r
  where (p_collector_id is null or r.collector_id = p_collector_id)
    and (p_from is null or r.submitted_at >= p_from)
    and (p_to   is null or r.submitted_at <= p_to)
)
select jsonb_build_object(
  'visits', (
    select jsonb_build_object(
      'count',       count(*)::int,
      'collected',   count(*) filter (where status = 'collected')::int,
      'rescheduled', count(*) filter (where status = 'rescheduled')::int,
      -- Every collected AND partial store's real total, matching the board.
      'totalCollected', coalesce(sum(coalesce(amount_collected, 0)), 0))
    from visits),
  'remittances', (
    select jsonb_build_object(
      'count',      count(*)::int,
      'reconciled', count(*) filter (where status = 'reconciled')::int,
      'variance',   count(*) filter (where status = 'variance')::int,
      'remitted',   coalesce(sum(amount_remitted), 0))
    from remittances)
);
$$;

revoke all on function public.get_collection_report_counts(uuid, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.get_collection_report_counts(uuid, timestamptz, timestamptz)
  to authenticated;


create or replace function public.get_delivery_report_counts(
  p_driver_id uuid        default null,
  p_from      timestamptz default null,
  p_to        timestamptz default null
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
orders as (
  select po.status, po.cod_amount
  from public.purchase_orders po
  where (p_driver_id is null or po.driver_id = p_driver_id)
    and (p_from is null or po.scheduled_for >= p_from)
    and (p_to   is null or po.scheduled_for <= p_to)
),
remittances as (
  select r.status, r.amount_remitted
  from public.cod_remittances r
  where (p_driver_id is null or r.driver_id = p_driver_id)
    and (p_from is null or r.submitted_at >= p_from)
    and (p_to   is null or r.submitted_at <= p_to)
)
select jsonb_build_object(
  'orders', (
    select jsonb_build_object(
      'count',        count(*)::int,
      'delivered',    count(*) filter (where status = 'delivered')::int,
      'failed',       count(*) filter (where status = 'failed')::int,
      'codCollected', coalesce(sum(coalesce(cod_amount, 0)), 0))
    from orders),
  'remittances', (
    select jsonb_build_object(
      'count',      count(*)::int,
      'reconciled', count(*) filter (where status = 'reconciled')::int,
      'variance',   count(*) filter (where status = 'variance')::int,
      'remitted',   coalesce(sum(amount_remitted), 0))
    from remittances)
);
$$;

revoke all on function public.get_delivery_report_counts(uuid, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.get_delivery_report_counts(uuid, timestamptz, timestamptz)
  to authenticated;
