-- ============================================================================
-- 034 - Meeting photos storage scope
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-26, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version is created with `supabase migration repair --status applied`,
-- so `supabase db push` skips it. If a push ever tries to EXECUTE this file,
-- stop and fix the repair rather than letting it run.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-034-Report.md
--
-- THIS IS THE CORRECTED SQL, not the first attempt. The original apply used
-- current_profile_id() where the app passes auth.uid(), and tried to drop a
-- guessed policy name so the real bucket-wide policy survived - leaving
-- meeting-photos as open as before with a dead policy beside it. Both were
-- fixed the same day and verified against pg_policies. The report keeps the
-- broken version for the postmortem; this file carries what is actually
-- live.
-- ============================================================================

drop policy if exists "Agents upload meeting photos" on storage.objects;
drop policy if exists "Agents upload own meeting photos" on storage.objects;

create policy "Agents upload own meeting photos" on storage.objects
  for insert
  with check (
    bucket_id = 'meeting-photos'
    and (storage.foldername(name))[1] = 'meetings'
    and (storage.foldername(name))[2] = auth.uid()::text
  );
