-- 127_client_created_source.sql
-- Record how a client row got here, so a bulk-imported record is
-- distinguishable from one a person typed in.
--
-- Additive only, no backfill, no RLS change (the existing "Admin full access
-- on clients" and "Agents update own clients" policies carry no column-level
-- grant restriction, so they already cover this column once it exists).
--
-- NULL is deliberate and is the value every existing row keeps. It means "not
-- recorded", NOT "created by hand": this database predates the column, and the
-- mobile app writes clients too and does not set it. Backfilling the ~1,200
-- existing rows to 'manual' would be inventing provenance we do not have.
-- Only the superadmin spreadsheet import (app/(admin)/clients/import) writes a
-- value today.
--
-- 'manual' is allowed by the constraint but nothing writes it yet. It is there
-- so the web Create Client form and the mobile create path can start recording
-- themselves without a second migration.
--
-- All statements are idempotent (IF NOT EXISTS / pg_constraint guard) so a
-- re-run by CI cannot fail or double-apply -- see the 051 incident
-- (Migration-052-Report.md, vault repo) that established this convention.

alter table public.clients add column if not exists created_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.clients'::regclass
       and conname  = 'clients_created_source_check'
  ) then
    alter table public.clients
      add constraint clients_created_source_check
      check (created_source is null
             or created_source in ('import', 'manual'));
  end if;
end $$;

-- The Clients page filters on this, and an imported batch is a small slice of
-- a large table, so the index is partial: it covers the rows that have a value
-- and stays out of the way of every row that does not.
create index if not exists idx_clients_created_source
  on public.clients (created_source)
  where created_source is not null;

comment on column public.clients.created_source is
  'How the row was created. import = superadmin spreadsheet bulk import; manual = typed into a create form; NULL = predates the column or written by a path that does not record it (mobile). Never inferred or backfilled.';
