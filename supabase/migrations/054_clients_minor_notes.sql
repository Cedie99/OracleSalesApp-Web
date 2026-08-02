-- ============================================================================
-- 054 - clients.minor_notes (Batch 6, File B)
--
-- Own file, deliberately minimal: clients is a hot/widely-consumed table and
-- this is the single most likely Batch 6 change to need independent revert
-- or re-sequencing. minor_notes is the one CLIENT_EDITABLE_FIELDS entry that
-- is approval-exempt (ADR-052 section C) -- any role can write it directly.
-- ============================================================================

alter table public.clients add column if not exists minor_notes text;

comment on column public.clients.minor_notes is
  'Approval-exempt free-text note (ADR-052). Any role with write access to the client may set this directly, unlike the other 7 CLIENT_EDITABLE_FIELDS which require manager approval via client_edit_requests.';
