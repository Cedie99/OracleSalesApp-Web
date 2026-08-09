-- PO evidence uses the shared meeting-photos bucket at:
--   meetings/{auth.uid()}/{request_id}-po-evidence.jpg
-- The mobile client uploads with upsert: true. Supabase Storage needs a
-- matching SELECT policy to return inserted-object metadata and an UPDATE
-- policy to overwrite a same-request retry safely.

drop policy if exists "Agents read own meeting photos" on storage.objects;
create policy "Agents read own meeting photos"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'meeting-photos'
  and (storage.foldername(name))[1] = 'meetings'
  and (storage.foldername(name))[2] = (select auth.uid()::text)
);

drop policy if exists "Agents update own meeting photos" on storage.objects;
create policy "Agents update own meeting photos"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'meeting-photos'
  and (storage.foldername(name))[1] = 'meetings'
  and (storage.foldername(name))[2] = (select auth.uid()::text)
)
with check (
  bucket_id = 'meeting-photos'
  and (storage.foldername(name))[1] = 'meetings'
  and (storage.foldername(name))[2] = (select auth.uid()::text)
);
