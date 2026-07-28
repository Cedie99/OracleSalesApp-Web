-- ============================================================================
-- 042 - Unified approval feeds
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-27, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version is created with `supabase migration repair --status applied`,
-- so `supabase db push` skips it. If a push ever tries to EXECUTE this file,
-- stop and fix the repair rather than letting it run.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-042-Report.md
--
-- No schema change - RPCs only. There is no 041: it was reserved as a
-- numbering placeholder and never used, so the gap between 040 and 042 is
-- correct. Do not fill it.
-- ============================================================================

-- Migration 042: unified approval feeds. SECURITY INVOKER — RLS on the
-- underlying tables does the authorization work, this RPC just reshapes.
create or replace function public.get_manager_approval_feed()
returns table (
  request_kind text, request_id uuid, requester_id uuid,
  client_id uuid, status text, created_at timestamptz,
  decided_at timestamptz, summary jsonb
)
language sql security invoker stable set search_path = public as $$
  select 'po_confirmation'::text, p.id, p.requester_id, p.client_id, p.status,
         p.created_at, p.decided_at,
         jsonb_build_object('po_photo_path', p.po_photo_path, 'meeting_id', p.meeting_id)
  from public.po_confirmation_requests p
  union all
  select 'tag_along'::text, t.id, t.requester_id, t.related_client_id, t.status,
         t.created_at, t.responded_at,
         jsonb_build_object('invitee_kind', t.invitee_kind, 'context', t.context)
  from public.tag_along_requests t
  where t.invitee_kind = 'manager';
$$;
revoke execute on function public.get_manager_approval_feed() from public, anon;
grant execute on function public.get_manager_approval_feed() to authenticated;

create or replace function public.get_my_request_statuses()
returns table (
  request_kind text, request_id uuid, client_id uuid, status text,
  created_at timestamptz, decided_at timestamptz, summary jsonb
)
language sql security invoker stable set search_path = public as $$
  select 'po_confirmation'::text, p.id, p.client_id, p.status, p.created_at, p.decided_at,
         jsonb_build_object('po_photo_path', p.po_photo_path)
  from public.po_confirmation_requests p
  where p.requester_id = public.current_profile_id()
  union all
  select 'tag_along'::text, t.id, t.related_client_id, t.status, t.created_at, t.responded_at,
         jsonb_build_object('invitee_kind', t.invitee_kind)
  from public.tag_along_requests t
  where t.requester_id = public.current_profile_id();
$$;
revoke execute on function public.get_my_request_statuses() from public, anon;
grant execute on function public.get_my_request_statuses() to authenticated;
