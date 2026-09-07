-- ============================================================================
-- 135 — Server-side aggregates for the Collection and Delivery dashboards
--
-- WHY: the same case 134 made for Sales. Both boards are metric cards, a
-- fourteen-day trend, a per-person performance table and five recent rows —
-- every figure a COUNT, a SUM or a GROUP BY — and both computed all of it in
-- JavaScript over every visit / purchase order and every remittance in the
-- database.
--
-- These aggregate MONEY, so two rules that the TypeScript flags as easy to get
-- wrong are passed IN as parameters rather than reimplemented here. Same
-- reasoning as p_milestones (131) and p_outcome_order (133): one definition,
-- and drift becomes impossible rather than merely unlikely.
--
--   p_receipt_methods — which payment methods require a delivery-receipt photo.
--       lib/collection.ts carries the warning in as many words: "Treating all
--       three as always-required is the bug this structure exists to prevent."
--       A capture the phone never asked for must not be reported as missing, or
--       an admin goes chasing a collector for a photo that was never required.
--
--   p_methods — the payment methods the breakdown knows about. Unrecognised
--       values are LEFT OUT rather than bucketed, preserving the component's
--       deliberate behaviour: mobile can ship a method before web widens its
--       union (that is how 'delivery_receipt' arrived on 2026-08-01), and an
--       unknown value should be a gap in a chart, not an outage.
--
-- ⚠️ BEHAVIOUR CHANGE — the daily trend moves by up to one day.
--
-- The component builds its fourteen bucket keys from LOCAL midnights
-- (`format(startOfDay(subDays(now, n)), 'yyyy-MM-dd')`) but keys each row off
-- `scheduled_for.slice(0, 10)` — the first ten characters of the ISO string,
-- which is the UTC date. `scheduled_for` is TIMESTAMPTZ, so at UTC+8 a visit
-- scheduled 07:00 Manila is 23:00 UTC the previous day and lands in the wrong
-- bucket. Local labels over UTC buckets is incoherent either way.
--
-- This buckets in the CALLER's zone on both sides, which is the same fix 134
-- made for months. Trend bars will therefore shift for rows near midnight.
-- That is a correction, not a regression — but it is a visible change, so it is
-- called out here rather than discovered.
--
-- SECURITY: SECURITY DEFINER, grants naming BOTH anon paths per migration 132.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. get_collection_dashboard
-- ----------------------------------------------------------------------------
create or replace function public.get_collection_dashboard(
  p_from            timestamptz default null,
  p_to              timestamptz default null,
  p_tz              text        default 'UTC',
  -- From PAYMENT_METHODS in lib/status-styles.ts.
  p_methods         text[]      default array['cash','check','gcash','counter','delivery_receipt'],
  -- From METHODS_WITH_RECEIPT_PHOTO in lib/collection.ts.
  p_receipt_methods text[]      default array['cash','check','gcash']
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
all_visits as (
  select
    v.id, v.client_id, v.collector_id, v.status, v.payment_method,
    v.amount_due, v.amount_collected, v.scheduled_for, v.visited_at,
    v.payment_photo_url, v.delivery_receipt_photo_url,
    -- The proof rule, evaluated once. Only a COLLECTED visit can be missing
    -- proof; pending and rescheduled legitimately have none.
    (
      v.status = 'collected'
      and (
        v.payment_photo_url is null
        or (v.payment_method = any(p_receipt_methods) and v.delivery_receipt_photo_url is null)
      )
    ) as missing_proof
  from public.collection_visits v
),
visits as (
  select * from all_visits
  where (p_from is null or scheduled_for >= p_from)
    and (p_to   is null or scheduled_for <= p_to)
),
-- Money handed over is tracked on the remittance, not on the visit, so a visit
-- counts as "still held" until some remittance names it. A partial store's
-- running total is real money in hand too (070), which is why the test is on
-- amount_collected rather than on status.
remitted_visits as (
  select distinct unnest(r.visit_ids) as visit_id from public.remittances r
),
trend_days as (
  select generate_series(
    (date_trunc('day', now() at time zone p_tz) - interval '13 days')::date,
    (date_trunc('day', now() at time zone p_tz))::date,
    interval '1 day'
  )::date as day
),
daily_trend as (
  select
    d.day,
    coalesce(sum(v.amount_due), 0)                          as due,
    coalesce(sum(coalesce(v.amount_collected, 0)), 0)       as collected
  from trend_days d
  -- Bucketed in the caller's zone on BOTH sides. See the header.
  -- Deliberately over all_visits, not `visits`: this chart is always the
  -- trailing fourteen days regardless of the period selector above it.
  left join all_visits v
    on (v.scheduled_for at time zone p_tz)::date = d.day
  group by d.day
),
collector_performance as (
  select
    v.collector_id                                              as id,
    coalesce(max(p.full_name), 'Unknown')                       as name,
    max(p.avatar_url)                                           as avatar_url,
    count(*)::int                                               as stores,
    coalesce(sum(coalesce(v.amount_collected, 0)), 0)           as collected,
    count(*) filter (where v.status = 'rescheduled')::int       as rescheduled
  from visits v
  left join public.profiles p on p.id = v.collector_id
  where v.collector_id is not null
  group by v.collector_id
)
select jsonb_build_object(
  'stats', (
    select jsonb_build_object(
      'listed',            count(*)::int,
      'collectedCount',    count(*) filter (where status = 'collected')::int,
      'rescheduledCount',  count(*) filter (where status = 'rescheduled')::int,
      'pendingCount',      count(*) filter (where status = 'pending')::int,
      'partialCount',      count(*) filter (where status = 'partial')::int,
      'totalDue',          coalesce(sum(amount_due), 0),
      -- Every collected AND partial store's real total, not just fully-paid.
      'totalCollected',    coalesce(sum(coalesce(amount_collected, 0)), 0),
      -- Only a pending store is still out today; a partial has closed for the
      -- day and its leftover rides on the store's credit balance.
      'outstanding',       coalesce(sum(amount_due) filter (where status = 'pending'), 0),
      'stillHeld',         coalesce(sum(coalesce(amount_collected, 0)) filter (
                             where coalesce(amount_collected, 0) > 0
                               and id not in (select visit_id from remitted_visits)), 0),
      'missingProof',      count(*) filter (where missing_proof)::int)
    from visits),
  -- Remittances are NOT date-filtered by the visit window: a shortfall stays
  -- the admin's problem regardless of which day's stores it came from.
  'variance', (
    select coalesce(sum(r.amount_remitted - r.amount_collected), 0)
    from public.remittances r),
  'dailyTrend', coalesce((
    -- The day LABEL is formatted by the component, which renders every other
    -- date on the page through date-fns.
    select jsonb_agg(jsonb_build_object(
      'day', t.day, 'due', t.due, 'collected', t.collected) order by t.day)
    from daily_trend t), '[]'::jsonb),
  'byMethod', coalesce((
    select jsonb_object_agg(m.method, jsonb_build_object(
      'count',  coalesce(x.n, 0),
      'amount', coalesce(x.amt, 0)))
    from unnest(p_methods) as m(method)
    left join lateral (
      select count(*)::int as n, coalesce(sum(coalesce(v.amount_collected, 0)), 0) as amt
      from visits v where v.payment_method = m.method
    ) x on true), '{}'::jsonb),
  'collectorPerformance', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', cp.id, 'name', cp.name, 'avatarUrl', cp.avatar_url,
      'stores', cp.stores, 'collected', cp.collected, 'rescheduled', cp.rescheduled)
      order by cp.collected desc, cp.name)
    from collector_performance cp), '[]'::jsonb),
  -- Variance first: a shortfall is the row an admin must not miss. Ordered by
  -- ABSOLUTE variance, so an overpayment surfaces as readily as a shortfall.
  -- Not date-filtered, matching the panel it feeds and the net variance above.
  'topRemittances', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'collectorName', r.collector_name,
      'amountRemitted', r.amount_remitted,
      'storeCount', r.store_count,
      'status', r.status,
      'variance', r.variance) order by abs(r.variance) desc, r.id)
    from (
      select rm.id, p.full_name as collector_name, rm.amount_remitted,
             coalesce(array_length(rm.visit_ids, 1), 0) as store_count,
             rm.status,
             (rm.amount_remitted - rm.amount_collected) as variance
      from public.remittances rm
      left join public.profiles p on p.id = rm.collector_id
      order by abs(rm.amount_remitted - rm.amount_collected) desc, rm.id
      limit 5
    ) r), '[]'::jsonb),
  'recentVisits', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'status', r.status,
      'visitedAt', r.visited_at,
      'amountCollected', coalesce(r.amount_collected, 0),
      'clientName', r.client_name,
      'collectorName', r.collector_name) order by r.visited_at desc)
    from (
      select v.id, v.status, v.visited_at, v.amount_collected,
             c.company_name as client_name, p.full_name as collector_name
      from visits v
      left join public.clients  c on c.id = v.client_id
      left join public.profiles p on p.id = v.collector_id
      where v.visited_at is not null
      order by v.visited_at desc
      limit 5
    ) r), '[]'::jsonb)
);
$$;

revoke all on function public.get_collection_dashboard(timestamptz, timestamptz, text, text[], text[])
  from public, anon;
grant execute on function public.get_collection_dashboard(timestamptz, timestamptz, text, text[], text[])
  to authenticated;


-- ----------------------------------------------------------------------------
-- 2. get_delivery_dashboard
--
-- The proof rule here is structural rather than method-driven, so it is encoded
-- directly — but it is still three separate cases and worth reading against
-- poProofs() in lib/delivery.ts:
--
--   delivered / partial — proof_url required; cod_photo_url required only when
--       the stop carries COD; receiver signature never required. A `partial` PO
--       was handed over exactly like a delivered one (073) — the goods went
--       out, only the COD is still coming in — so it carries the same captures.
--   failed             — backload_photo_url required.
--   pending            — no captures exist yet, so nothing can be missing.
-- ----------------------------------------------------------------------------
create or replace function public.get_delivery_dashboard(
  p_from timestamptz default null,
  p_to   timestamptz default null,
  p_tz   text        default 'UTC'
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
all_orders as (
  select
    po.id, po.client_id, po.driver_id, po.status, po.area, po.truck_plate,
    po.cod, po.cod_due, po.cod_amount, po.cod_remitted,
    po.scheduled_for, po.time_in, po.time_out,
    (
      (po.status in ('delivered', 'partial')
        and (po.proof_url is null or (po.cod and po.cod_photo_url is null)))
      or (po.status = 'failed' and po.backload_photo_url is null)
    ) as missing_proof,
    -- Minutes at the stop, floored at zero and null until both ends exist —
    -- never 0-as-unknown, matching dwellMinutes().
    case when po.time_in is not null and po.time_out is not null
         then greatest(0, round(extract(epoch from (po.time_out - po.time_in)) / 60))::int
    end as dwell_minutes,
    -- COD taken at a stop but not yet handed over: the driver is carrying it.
    (po.cod and po.status = 'delivered' and not po.cod_remitted) as held_cod
  from public.purchase_orders po
),
orders as (
  select * from all_orders
  where (p_from is null or scheduled_for >= p_from)
    and (p_to   is null or scheduled_for <= p_to)
),
trend_days as (
  select generate_series(
    (date_trunc('day', now() at time zone p_tz) - interval '13 days')::date,
    (date_trunc('day', now() at time zone p_tz))::date,
    interval '1 day'
  )::date as day
),
daily_trend as (
  select
    d.day,
    count(o.id) filter (where o.status = 'delivered')::int as delivered,
    count(o.id) filter (where o.status = 'failed')::int    as failed
  from trend_days d
  -- Over all_orders, not `orders`: always the trailing fourteen days. Bucketed
  -- in the caller's zone on both sides — see the header.
  left join all_orders o on (o.scheduled_for at time zone p_tz)::date = d.day
  group by d.day
),
driver_performance as (
  select
    o.driver_id                                            as id,
    coalesce(max(p.full_name), 'Unknown')                  as name,
    max(p.avatar_url)                                      as avatar_url,
    -- Plates run, deduplicated, in first-seen order.
    coalesce(array_agg(distinct o.truck_plate) filter (where o.truck_plate is not null),
             '{}')                                        as plates,
    count(*)::int                                          as stops,
    count(*) filter (where o.status = 'delivered')::int    as delivered,
    count(*) filter (where o.status = 'failed')::int       as failed,
    coalesce(sum(coalesce(o.cod_amount, 0)), 0)            as cod,
    round(avg(o.dwell_minutes))::int                       as avg_dwell
  from orders o
  left join public.profiles p on p.id = o.driver_id
  where o.driver_id is not null
  group by o.driver_id
)
select jsonb_build_object(
  'stats', (
    select jsonb_build_object(
      'listed',          count(*)::int,
      'deliveredCount',  count(*) filter (where status = 'delivered')::int,
      'failedCount',     count(*) filter (where status = 'failed')::int,
      'pendingCount',    count(*) filter (where status = 'pending')::int,
      -- 'partial' is a real stop status (073) and the Stop Status breakdown
      -- lists it, so it is carried here rather than re-derived from rows.
      'partialCount',    count(*) filter (where status = 'partial')::int,
      'codDue',          coalesce(sum(coalesce(cod_due, 0)), 0),
      'codCollected',    coalesce(sum(coalesce(cod_amount, 0)), 0),
      'codHeld',         coalesce(sum(coalesce(cod_amount, 0)) filter (where held_cod), 0),
      'missingProof',    count(*) filter (where missing_proof)::int,
      -- Null, not 0, when no stop has both ends recorded.
      'avgDwell',        round(avg(dwell_minutes))::int)
    from orders),
  'variance', (
    select coalesce(sum(r.amount_remitted - r.amount_collected), 0)
    from public.cod_remittances r),
  'dailyTrend', coalesce((
    select jsonb_agg(jsonb_build_object(
      'day', t.day, 'delivered', t.delivered, 'failed', t.failed) order by t.day)
    from daily_trend t), '[]'::jsonb),
  'byArea', coalesce((
    select jsonb_agg(a.obj order by (a.obj->>'stops')::int desc, a.obj->>'area')
    from (
      select jsonb_build_object(
        'area', o.area,
        'stops', count(*)::int,
        'failed', count(*) filter (where o.status = 'failed')::int) as obj
      from orders o group by o.area
    ) a), '[]'::jsonb),
  'driverPerformance', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', dp.id, 'name', dp.name, 'avatarUrl', dp.avatar_url,
      'plates', dp.plates, 'stops', dp.stops, 'delivered', dp.delivered,
      'failed', dp.failed, 'cod', dp.cod, 'avgDwell', dp.avg_dwell,
      'rate', case when dp.stops > 0
                   then round(dp.delivered * 100.0 / dp.stops)::int
                   else 0 end)
      order by dp.stops desc, dp.name)
    from driver_performance dp), '[]'::jsonb),
  'topRemittances', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'driverName', r.driver_name,
      'amountRemitted', r.amount_remitted,
      'stopCount', r.stop_count,
      'status', r.status,
      'variance', r.variance) order by abs(r.variance) desc, r.id)
    from (
      select rm.id, p.full_name as driver_name, rm.amount_remitted,
             coalesce(array_length(rm.po_ids, 1), 0) as stop_count,
             rm.status,
             (rm.amount_remitted - rm.amount_collected) as variance
      from public.cod_remittances rm
      left join public.profiles p on p.id = rm.driver_id
      order by abs(rm.amount_remitted - rm.amount_collected) desc, rm.id
      limit 5
    ) r), '[]'::jsonb),
  'recentStops', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'status', r.status, 'timeOut', r.time_out, 'area', r.area,
      'clientName', r.client_name, 'driverName', r.driver_name)
      order by r.time_out desc)
    from (
      select o.id, o.status, o.time_out, o.area,
             c.company_name as client_name, p.full_name as driver_name
      from orders o
      left join public.clients  c on c.id = o.client_id
      left join public.profiles p on p.id = o.driver_id
      where o.time_out is not null
      order by o.time_out desc
      limit 5
    ) r), '[]'::jsonb)
);
$$;

revoke all on function public.get_delivery_dashboard(timestamptz, timestamptz, text)
  from public, anon;
grant execute on function public.get_delivery_dashboard(timestamptz, timestamptz, text)
  to authenticated;
