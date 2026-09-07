-- ============================================================================
-- 139 — The Lost Opportunities page, paged server-side
--
-- WHY: the page reads every client and every meeting in the company, filters to
-- `status = 'lost'`, and renders nine cards. On production that is a 3.5 MB
-- download to display ELEVEN rows.
--
-- THE LOSING MEETING. Each card explains why the client was lost, and that
-- explanation comes from one of two places depending on which path did the
-- losing:
--
--   * A meeting marked `lost_opportunity` carries the reason in its remarks and
--     leaves `inactive_reason` null (082 never sets it).
--   * A DECLARATION — mobile's Complete Info, or an admin on the Clients page —
--     has no meeting at all and puts the reason in `inactive_reason` (088/112).
--
-- `inactive_reason` wins when both exist, and the page is right to prefer it:
-- 037 clears it on claim and the Clients page clears it when a loss is undone,
-- so it always describes the CURRENT cycle. The meeting lookup is unordered and
-- could match one from a previous cycle. That precedence stays in the component;
-- this only supplies the meeting's remarks so it has both to choose from.
--
-- THE DATE FILTER has an asymmetry worth copying exactly: a client with no
-- `lost_at` is shown only when NO window is set. Under any window it is out,
-- because there is no date to place it in — rather than silently treating it as
-- in range.
--
-- SECURITY: SECURITY DEFINER, grants naming BOTH anon paths per migration 132.
-- ============================================================================

create or replace function public.get_lost_opportunities(
  p_search text        default null,
  -- 'all' | 'ready' (past its cooldown) | 'locked'
  p_status text        default 'all',
  p_from   timestamptz default null,
  p_to     timestamptz default null,
  p_limit  int         default 9,
  p_offset int         default 0
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
lost as (
  select c.*, ag.full_name as agent_name, ag.team_id as agent_team_id,
         (c.reassignable_at is not null and c.reassignable_at <= now()) as is_reassignable
  from public.clients c
  left join public.profiles ag on ag.id = c.assigned_agent_id
  where c.status = 'lost'
),
filtered as (
  select * from lost l
  where (
      p_search is null or p_search = ''
      or l.company_name ilike '%' || p_search || '%'
      or coalesce(l.contact_person, '') ilike '%' || p_search || '%'
      or coalesce(l.agent_name, '')     ilike '%' || p_search || '%'
    )
    and (
      p_status = 'all'
      or (p_status = 'ready'  and l.is_reassignable)
      or (p_status = 'locked' and not l.is_reassignable)
    )
    -- No window: everything. A window: only rows that have a lost_at to place.
    and (
      (p_from is null and p_to is null)
      or (l.lost_at is not null
          and (p_from is null or l.lost_at >= p_from)
          and (p_to   is null or l.lost_at <= p_to))
    )
),
windowed as (
  select * from filtered
  -- Most recently lost first; `id` for a total order under server-side paging.
  order by lost_at desc nulls last, id desc
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
)
select jsonb_build_object(
  'total',     (select count(*)::int from filtered),
  -- The header reads "<filtered> of <all lost>".
  'lostTotal', (select count(*)::int from lost),
  'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'client', jsonb_build_object(
        'id', w.id,
        'company_name', w.company_name,
        'contact_person', w.contact_person,
        'contact_position', w.contact_position,
        'contact_number', w.contact_number,
        'office_address', w.office_address,
        'customer_type', w.customer_type,
        'sales_channel', w.sales_channel,
        'assigned_agent_id', w.assigned_agent_id,
        'status', w.status,
        'lost_at', w.lost_at,
        'reassignable_at', w.reassignable_at,
        'inactive_reason', w.inactive_reason,
        'address_line1', w.address_line1,
        'address_line2', w.address_line2,
        'landmark', w.landmark,
        'city', w.city,
        'province', w.province,
        'office_lat', w.office_lat,
        'office_lng', w.office_lng,
        'created_at', w.created_at,
        'updated_at', w.updated_at,
        'credit_balance', w.credit_balance,
        'agent', case when ag.id is null then null else jsonb_build_object(
          'id', ag.id, 'user_id', ag.user_id, 'full_name', ag.full_name,
          'email', ag.email, 'role', ag.role, 'team_id', ag.team_id,
          'is_active', ag.is_active, 'avatar_url', ag.avatar_url,
          'created_at', ag.created_at) end),
      -- Remarks from the meeting that did the losing, when there was one. The
      -- component decides whether this or `inactive_reason` wins — see header.
      'lostMeetingRemarks', (
        select m.remarks from public.meetings m
        where m.client_id = w.id and m.outcome = 'lost_opportunity'
        order by m.meeting_date desc, m.id desc
        limit 1))
      order by w.lost_at desc nulls last, w.id desc)
    from windowed w
    left join public.profiles ag on ag.id = w.assigned_agent_id), '[]'::jsonb)
);
$$;

revoke all on function public.get_lost_opportunities(text, text, timestamptz, timestamptz, int, int)
  from public, anon;
grant execute on function public.get_lost_opportunities(text, text, timestamptz, timestamptz, int, int)
  to authenticated;
