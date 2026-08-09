-- ============================================================================
-- 081 - auto-approve PO confirmation for manager-authored requests
--
-- Vince (2026-08-10): a Manager recording their OWN meeting (Manager
-- Record Meeting, shipped 2026-08-10 per the mobile vault's Context.md)
-- must not see "Naghihintay ng approval ng Manager" on a Close-deal PO
-- confirmation they submitted themselves — they ARE the approver for their
-- own team. This must still be a real, auditable approval row (decided_by
-- = the manager's own profile id), not a silent skip/bypass of the
-- approval workflow.
--
-- 039_po_confirmation_requests.sql's "Agents create own PO confirmation"
-- INSERT policy already lets a sales_manager insert a row with
-- requester_id = their own profile id (no requester-role restriction).
-- decide_po_confirmation()'s is_manager_of_profile(req.requester_id) check
-- (029_rls_helper_functions.sql) is also trivially true when the requester
-- IS the manager (same-team self-join), so a manager was always eligible to
-- approve their own request manually — this migration just makes that
-- decision automatic and recorded at submission time instead of requiring
-- a manual approval step against themselves.
-- ============================================================================

create or replace function public.auto_approve_manager_po_confirmation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status = 'pending' and exists (
    select 1 from public.profiles p
    where p.id = NEW.requester_id and p.role = 'sales_manager'
  ) then
    NEW.status := 'approved';
    NEW.decided_by := NEW.requester_id;
    NEW.decided_at := now();
    NEW.decision_note := coalesce(NEW.decision_note, 'Auto-approved: manager recorded own meeting');
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_auto_approve_manager_po_confirmation on public.po_confirmation_requests;
create trigger trg_auto_approve_manager_po_confirmation
  before insert on public.po_confirmation_requests
  for each row execute function public.auto_approve_manager_po_confirmation();
