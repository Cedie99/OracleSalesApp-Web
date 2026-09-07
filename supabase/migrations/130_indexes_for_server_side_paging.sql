-- ============================================================================
-- 130 — Indexes for server-side paging, filtering and search
--
-- WHY: every list page on the web is a client component that downloads its
-- whole table and then filters, sorts and paginates in JavaScript. That works
-- at the 4,000 rows one month of operation produced and stops working at the
-- 20k–50k the business expects. The fix is to push the filter, the sort and
-- the page window into Postgres — and this migration is the groundwork that
-- has to land BEFORE any of that, because a server-side filter on an unindexed
-- column is a sequential scan, i.e. slower than what it replaced.
--
-- Migration 101 indexed these same tables for the auto-refresh probe, but only
-- on `updated_at` — the one column that probe reads. Nothing here overlaps it.
-- What is missing is everything the pages actually filter and order BY:
-- `clients` has no index on `assigned_agent_id` at all, and `meetings` has
-- none on `agent_id`, `recorded_by`, `client_id` or `meeting_date`. Every
-- drill-down into an agent's records is a full scan today; it is simply too
-- cheap to notice at four thousand rows.
--
-- MOBILE, PLEASE NOTE: additive only. New indexes and one extension. No
-- column, constraint, policy or trigger changes, and no behaviour changes —
-- the only observable effect is that some of mobile's own reads get faster
-- (`meetings` by `client_id` and `agent_id` especially, which the My Clients
-- and meeting-history screens both filter on).
--
-- WRITE COST: an index is maintained on every insert and update, and mobile
-- writes `meetings` and `clients` all day. Ten indexes across two hot tables
-- is a deliberate ceiling, not an accident — each one below is here because a
-- specific query in the plan needs it, and the composites are ordered so one
-- index serves both a filter and its sort rather than needing two.
--
-- NOT `CONCURRENTLY`: the Supabase CLI runs each migration inside a
-- transaction, and `create index concurrently` cannot run there. A plain build
-- takes an ACCESS EXCLUSIVE lock for its duration, which at current table
-- sizes is milliseconds. Doing this now rather than at 50,000 rows is a large
-- part of the point.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. clients — the drill-down and its ordering
--
-- The Clients page is manager -> agent -> a page of nine cards. The leaf query
-- is `where assigned_agent_id = $1 order by created_at desc, id desc` with a
-- window on the end, so the composite carries the filter AND the sort in one
-- index and the planner never sorts. The `id` tiebreaker matters for the same
-- reason lib/supabase/paginate.ts documents: the bulk import stamps 200 rows
-- per statement with an identical created_at, and a page boundary landing
-- inside such a tie can repeat one row while dropping another.
-- ----------------------------------------------------------------------------
create index if not exists idx_clients_agent_created
  on public.clients (assigned_agent_id, created_at desc, id desc);

-- The same order without an agent scope — the unfiltered list, and the
-- "Unassigned" bucket.
create index if not exists idx_clients_created_id
  on public.clients (created_at desc, id desc);

-- The stat row counts by customer_type and by status over whatever the current
-- filter selects, and Lost Opportunities is `status = 'lost'` plus the
-- reassignment window. Separate single-column indexes rather than one
-- composite: the two are filtered independently at least as often as together,
-- and Postgres will combine them with a bitmap AND when they are not.
create index if not exists idx_clients_status
  on public.clients (status);
create index if not exists idx_clients_customer_type
  on public.clients (customer_type);


-- ----------------------------------------------------------------------------
-- 2. meetings — three different owners, one date order
--
-- A meeting reaches a person three ways, and the manager buckets need all
-- three: `agent_id` (they held it), `recorded_by` (they filled the form in),
-- and the tag-along ledger below (they were invited along). Each gets the
-- meeting_date sort folded in, because every one of those lookups is then
-- ordered newest-first and paged.
--
-- `recorded_by` is nullable and usually null, so that index stays small.
-- ----------------------------------------------------------------------------
create index if not exists idx_meetings_agent_date
  on public.meetings (agent_id, meeting_date desc, id desc);

create index if not exists idx_meetings_recorded_by_date
  on public.meetings (recorded_by, meeting_date desc)
  where recorded_by is not null;

-- The client detail dialog reads one client's meetings, and the Clients page's
-- progress ring aggregates a client's agenda coverage. Both are
-- `where client_id = $1` — currently a full scan of meetings, per client.
create index if not exists idx_meetings_client_date
  on public.meetings (client_id, meeting_date desc);

-- The unscoped Meetings list order.
create index if not exists idx_meetings_date_id
  on public.meetings (meeting_date desc, id desc);


-- ----------------------------------------------------------------------------
-- 3. tag_along_requests — the reverse lookup
--
-- 019 indexed this table by invitee and by requester, which is what mobile
-- asks of it ("what was I invited to?"). The web asks the opposite question —
-- "who was invited to THIS client / THIS meeting?" — to build the manager
-- buckets' tag-along counts, and that direction has no index at all.
--
-- Partial, because the two columns are mutually exclusive in practice: a
-- request has a related_client_id or a related_meeting_id depending on its
-- `context`, so indexing the nulls would double the size for nothing.
-- ----------------------------------------------------------------------------
create index if not exists idx_tar_related_client
  on public.tag_along_requests (related_client_id)
  where related_client_id is not null;

create index if not exists idx_tar_related_meeting
  on public.tag_along_requests (related_meeting_id)
  where related_meeting_id is not null;


-- ----------------------------------------------------------------------------
-- 4. Search — trigram indexes
--
-- The search boxes on Clients and Meetings are unanchored, case-insensitive
-- substring matches (`company_name.toLowerCase().includes(term)` today). Moved
-- server-side that becomes `ilike '%term%'`, which no btree index can serve —
-- a btree only helps a left-anchored prefix. pg_trgm's GIN index is what makes
-- an infix match indexable, and without it search would be the one operation
-- that got SLOWER by moving to the server.
--
-- pg_trgm ships with Supabase and is enabled per-database; `if not exists`
-- makes this safe whether or not mobile has already enabled it.
--
-- The opclass is written UNQUALIFIED and resolved through search_path, which
-- is widened just below. Hardcoding `extensions.gin_trgm_ops` would be a trap:
-- `if not exists` silently does nothing if mobile already created pg_trgm in
-- `public`, and the schema-qualified opclass would then fail to resolve
-- against an extension that exists but lives somewhere else. Widening the path
-- covers both homes.
--
-- gin_trgm_ops on the raw column, not on lower(column): the `%` and `ilike`
-- operators pg_trgm accelerates are case-insensitive in their own right, so a
-- functional lower() index would be a second, redundant copy.
-- ----------------------------------------------------------------------------
create extension if not exists pg_trgm with schema extensions;

-- Session-scoped rather than `set local`: `set local` is a no-op outside a
-- transaction, and this must hold whether or not the runner wraps the file.
set search_path = public, extensions;

create index if not exists idx_clients_company_name_trgm
  on public.clients using gin (company_name gin_trgm_ops);

create index if not exists idx_clients_contact_person_trgm
  on public.clients using gin (contact_person gin_trgm_ops);

-- Both Clients and Meetings search the agent's name alongside the record's own
-- fields, which is a join to profiles and an ilike on the far side.
create index if not exists idx_profiles_full_name_trgm
  on public.profiles using gin (full_name gin_trgm_ops);

reset search_path;


-- ----------------------------------------------------------------------------
-- 5. Refresh planner statistics
--
-- A new index is invisible to the planner until it has stats to cost it
-- against. Without this the first queries after deploy can still choose a seq
-- scan, which reads as "the migration did nothing" during verification.
-- ----------------------------------------------------------------------------
analyze public.clients;
analyze public.meetings;
analyze public.tag_along_requests;
analyze public.profiles;
