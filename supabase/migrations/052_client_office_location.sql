-- 052_client_office_location.sql
-- Permanent client office pin (mobile Batch 4, Office Location feature).
-- Additive only, no backfill, no RLS change (existing "Agents update own
-- clients" UPDATE policy has no column-level grant restriction, so it
-- already covers writes to these new columns once they exist).
--
-- Contract: projects/OracleSalesApp-Mobile/Office-Location-Spec-2026-07-29.md
-- (vault, OracleSalesApp-Vault repo)
--
-- Meeting GPS evidence (public.meetings.gps_lat/gps_lng) is NEVER copied
-- here except via the mobile app's explicit "Client Office" meeting path
-- (client_office_meeting source) or an explicit user-initiated Set/Update
-- Office Location action (manual source).
--
-- All statements are idempotent (IF NOT EXISTS / pg_constraint guard) so a
-- re-run by CI cannot fail or double-apply -- see the 051 incident
-- (Migration-052-Report.md, vault repo) that established this convention.

alter table public.clients add column if not exists office_lat            double precision;
alter table public.clients add column if not exists office_lng            double precision;
alter table public.clients add column if not exists office_pin_updated_at timestamptz;
alter table public.clients add column if not exists office_pin_source     text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.clients'::regclass
       and conname  = 'clients_office_pin_source_check'
  ) then
    alter table public.clients
      add constraint clients_office_pin_source_check
      check (office_pin_source is null
             or office_pin_source in ('manual', 'client_office_meeting'));
  end if;
end $$;

comment on column public.clients.office_lat is
  'Permanent client office pin latitude. Never meeting GPS evidence.';
comment on column public.clients.office_lng is
  'Permanent client office pin longitude. Never meeting GPS evidence.';
comment on column public.clients.office_pin_source is
  'manual = explicit Set/Update Office Location; client_office_meeting = auto-captured from a Client Office in-person meeting start GPS.';
comment on column public.clients.office_pin_updated_at is
  'Timestamp of the last permanent-office-pin write (manual or auto-captured). Distinct from clients.updated_at.';
