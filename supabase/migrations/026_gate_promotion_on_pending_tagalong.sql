-- ============================================================================
-- 026 - Gate prospect-to-new promotion on a pending manager tag-along (F-204)
--
-- BACKFILL - this SQL is ALREADY LIVE on the shared Supabase project, applied
-- by hand through the SQL Editor on 2026-07-23, outside web's migration history.
-- The file exists so this repo's history matches production and a rebuild from
-- supabase/migrations/ alone reproduces the live schema.
--
-- DO NOT re-run it against production. The remote schema_migrations row for
-- this version is created with `supabase migration repair --status applied`,
-- so `supabase db push` skips it. If a push ever tries to EXECUTE this file,
-- stop and fix the repair rather than letting it run.
--
-- Spec, rollback and verification query: the vault's
-- projects/OracleSalesApp-Mobile/Migration-026-Report.md
--
-- Renumbered from 023 by the vault on 2026-07-25; web had claimed 023 for
-- add_delivery_role. Superseded at runtime by migration 040, which retires
-- promote_client_to_new() entirely - kept here because it is what actually
-- ran.
-- ============================================================================

-- Migration 026 (formerly numbered 023): gate ADR-027's auto-promotion on
-- there being no pending manager tag-along request for this client (F-204).
create or replace function public.promote_client_to_new(p_client_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  update public.clients
  set customer_type = 'new'
  where id = p_client_id
    and (customer_type is null or customer_type = 'prospect')
    and details_completed_at is not null
    and exists (
      select 1 from public.meetings
      where client_id = p_client_id
        and outcome = 'successful'
    )
    and not exists (
      select 1 from public.tag_along_requests
      where related_client_id = p_client_id
        and invitee_kind = 'manager'
        and context = 'meeting'
        and status = 'pending'
    );
end;
$$;

-- Trigger 3: re-check promotion once a manager tag-along resolves.
create or replace function public.trg_promote_on_tagalong_resolved()
returns trigger
language plpgsql
as $$
begin
  if (new.status in ('accepted', 'declined')
      and old.status = 'pending'
      and new.invitee_kind = 'manager'
      and new.context = 'meeting'
      and new.related_client_id is not null) then
    perform public.promote_client_to_new(new.related_client_id);
  end if;
  return new;
end;
$$;

drop trigger if exists promote_on_tagalong_resolved on public.tag_along_requests;
create trigger promote_on_tagalong_resolved
  after update of status on public.tag_along_requests
  for each row
  execute function public.trg_promote_on_tagalong_resolved();
