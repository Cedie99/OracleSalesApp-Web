-- The direct Joint Manager holder experiment is retired. Manager access must
-- be derived only from an accepted Meeting Tag-Along, never from a standalone
-- client-holder request made by Sales/RSR.
--
-- Keep the older tables/functions for migration-history compatibility, but
-- close every callable/write path now. A future meeting-context migration may
-- reuse a new, explicitly authorized read model; it must not re-enable these.

drop policy if exists "agents create joint requests" on public.joint_manager_requests;
drop policy if exists "joint requests participants read" on public.joint_manager_requests;
drop policy if exists "joint decisions participants read" on public.joint_manager_request_decisions;
drop policy if exists "joint holders participants read" on public.client_record_holders;
drop policy if exists "Active record holders read canonical clients" on public.clients;

-- A staging environment that did not receive every earlier experiment
-- migration must still be able to apply this retirement migration. Resolve
-- each function from pg_proc first instead of failing on a missing signature.
do $$
declare
  target regprocedure;
begin
  for target in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'public' and p.proname in (
              'create_joint_manager_request',
              'decide_joint_manager_request',
              'get_manager_joint_requests',
              'get_my_holder_clients',
              'get_my_client_record_holders'
            ))
        or (n.nspname = 'app_private' and p.proname = 'can_read_client_record')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', target);
  end loop;
end;
$$;

-- Deliberately retained: Sales/RSR use this restricted, read-only directory
-- to select active Managers for a Meeting Tag-Along. It does not assign a
-- holder or grant client access by itself.
