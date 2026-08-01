-- ============================================================================
-- 053 - client_edit_requests backfill (Batch 6, File A)
--
-- public.client_edit_requests already exists (created in 001_initial.sql,
-- shape: id, client_id, requested_by, changes, status, reviewed_by,
-- reviewed_at, created_at) but has been unused/frozen since ADR-044
-- (2026-07-24) deferred the approval-request flow to a later batch. Batch 6
-- (ADR-052, projects/OracleSalesApp-Mobile/Decisions.md) reactivates it and
-- adds the columns needed for conflict-aware manager approval.
--
-- The CREATE TABLE IF NOT EXISTS below is inert (table already exists) and
-- is kept only so a from-scratch rebuild of supabase/migrations/ alone
-- reproduces the live schema. It intentionally matches 001_initial.sql's
-- live column list/constraints exactly, not a fresh redesign.
--
-- All statements idempotent per the 051 incident convention
-- (Migration-052-Report.md, vault repo).
-- ============================================================================

create table if not exists public.client_edit_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  requested_by uuid not null references public.profiles(id),
  changes jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.client_edit_requests add column if not exists review_note text;
alter table public.client_edit_requests add column if not exists base_updated_at timestamptz;
alter table public.client_edit_requests add column if not exists base_assigned_agent_id uuid references public.profiles(id);

-- Backfill base_updated_at on any pre-existing rows so it's never null for
-- a pending row going forward. clients.updated_at confirmed live (001_initial.sql,
-- maintained by the clients_updated_at trigger).
update public.client_edit_requests r
set base_updated_at = c.updated_at
from public.clients c
where r.client_id = c.id and r.base_updated_at is null;

-- Fallback for any row the join above couldn't reach (e.g. an orphaned
-- client_id with no matching live clients row) -- ADR-052 specifies
-- base_updated_at TIMESTAMPTZ NOT NULL, and a null here would silently break
-- decide_client_edit_request()'s base-conflict comparison (a null IS
-- DISTINCT FROM comparison is well-defined in Postgres, but we don't want to
-- depend on that subtlety for correctness). now() is a safe fallback: it
-- guarantees any future clients.updated_at will differ from it, so an
-- orphaned/unmatched row correctly falls into the base_conflict path instead
-- of silently passing or failing the check. Flagging this choice rather than
-- applying it silently, per instruction -- this only fires if the data has
-- pre-existing orphan rows, which have not been confirmed to exist.
update public.client_edit_requests
set base_updated_at = now()
where base_updated_at is null;

alter table public.client_edit_requests
  alter column base_updated_at set not null;

create unique index if not exists uq_client_edit_requests_one_pending
  on public.client_edit_requests (client_id)
  where status = 'pending';

create index if not exists idx_client_edit_requests_requester_status
  on public.client_edit_requests (requested_by, status);

create index if not exists idx_client_edit_requests_status_created
  on public.client_edit_requests (status, created_at desc);

comment on column public.client_edit_requests.review_note is
  'Manager''s reason/comment on decision. Singular, matches po_confirmation_requests.decision_note naming (ADR-052).';
comment on column public.client_edit_requests.base_updated_at is
  'clients.updated_at at request-creation time. Used by decide_client_edit_request() for optimistic-conflict detection.';
comment on column public.client_edit_requests.base_assigned_agent_id is
  'clients.assigned_agent_id at request-creation time. Used by decide_client_edit_request() for optimistic-conflict detection.';
