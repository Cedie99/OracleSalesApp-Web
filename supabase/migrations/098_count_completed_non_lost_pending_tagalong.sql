-- 096: completed non-lost meetings count while a manager Tag-Along request is
-- pending. The request approval workflow remains independent.
create or replace function public.attribute_meeting_cutoff(p_meeting_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
 m public.meetings%rowtype; c public.clients%rowtype; p public.cutoff_periods%rowtype;
 declined boolean; stage text; agent_role text; agent_kind text; role_cap integer;
 used_count integer; meeting_local_date date; has_valid_evidence boolean; part record;
begin
 if exists(select 1 from public.meeting_cutoff_attributions where meeting_id=p_meeting_id and attribution<>'pending_validity') then return; end if;
 select * into m from public.meetings where id=p_meeting_id; if not found then return; end if;
 select * into c from public.clients where id=m.client_id;
 stage:=coalesce(m.client_status_at_meeting,c.customer_type);
 meeting_local_date:=(coalesce(m.start_captured_at,m.meeting_date) at time zone 'Asia/Manila')::date;
 has_valid_evidence:=m.photo_url is not null or (m.client_status_at_meeting in ('new','existing') and m.start_captured_at is not null and m.end_photo_url is not null);
 select pr.role,t.kind into agent_role,agent_kind from public.profiles pr left join public.teams t on t.id=pr.team_id where pr.id=m.agent_id;
 select exists(select 1 from public.tag_along_requests where related_meeting_id=p_meeting_id and context='meeting' and invitee_kind='manager' and status='declined') into declined;
 if declined or m.outcome not in ('successful','follow_up','no_decision') or not has_valid_evidence then
  insert into public.meeting_cutoff_attributions(meeting_id,period_id,client_id,agent_id,captured_client_stage,captured_agent_role,captured_team_kind,participation,attribution)
  values(m.id,null,m.client_id,m.agent_id,stage,agent_role,agent_kind,'agent','excluded_invalid')
  on conflict(meeting_id,agent_id) do update set attribution=excluded.attribution,period_id=null,slot_index=null,attributed_at=now() where public.meeting_cutoff_attributions.attribution='pending_validity'; return;
 end if;
 select * into p from public.cutoff_periods where status='active' and meeting_local_date between starts_on and ends_on order by starts_on desc limit 1;
 for part in
  select m.agent_id agent_id,agent_role role,agent_kind team_kind,'agent'::text participation
  union all
  select tar.invitee_id,pr.role,t.kind,'tag_along'::text from public.tag_along_requests tar join public.profiles pr on pr.id=tar.invitee_id left join public.teams t on t.id=pr.team_id
   where tar.related_meeting_id=m.id and tar.context='meeting' and tar.invitee_kind='manager' and tar.status='accepted' and tar.invitee_id<>m.agent_id order by 2 nulls last,1
 loop
  if p.id is null then
   insert into public.meeting_cutoff_attributions(meeting_id,period_id,client_id,agent_id,captured_client_stage,captured_agent_role,captured_team_kind,participation,attribution)
   values(m.id,null,m.client_id,part.agent_id,stage,part.role,part.team_kind,part.participation,'unattributed')
   on conflict(meeting_id,agent_id) do update set attribution=excluded.attribution,period_id=null,slot_index=null,attributed_at=now() where public.meeting_cutoff_attributions.attribution='pending_validity'; continue;
  end if;
  if stage not in ('new','existing') then
   insert into public.meeting_cutoff_attributions(meeting_id,period_id,client_id,agent_id,captured_client_stage,captured_agent_role,captured_team_kind,participation,attribution)
   values(m.id,p.id,m.client_id,part.agent_id,stage,part.role,part.team_kind,part.participation,'excluded_uncapped')
   on conflict(meeting_id,agent_id) do update set attribution=excluded.attribution,period_id=excluded.period_id,slot_index=null,attributed_at=now() where public.meeting_cutoff_attributions.attribution='pending_validity'; continue;
  end if;
  role_cap:=public.cutoff_cap_for_agent(part.role,part.team_kind,p.sales_client_meeting_cap,p.rsr_client_meeting_cap,p.client_meeting_cap);
  perform pg_advisory_xact_lock(hashtext(c.id::text||p.id::text||public.cutoff_pool_key(part.role,part.team_kind)));
  select count(*) into used_count from public.meeting_cutoff_attributions where client_id=c.id and period_id=p.id and attribution='counted' and captured_agent_role is not distinct from part.role and (part.role is distinct from 'sales_manager' or captured_team_kind is not distinct from part.team_kind);
  if used_count<role_cap then
   insert into public.meeting_cutoff_attributions(meeting_id,period_id,client_id,agent_id,captured_client_stage,captured_agent_role,captured_team_kind,participation,attribution,slot_index)
   values(m.id,p.id,m.client_id,part.agent_id,stage,part.role,part.team_kind,part.participation,'counted',used_count+1)
   on conflict(meeting_id,agent_id) do update set attribution=excluded.attribution,period_id=excluded.period_id,slot_index=excluded.slot_index,attributed_at=now() where public.meeting_cutoff_attributions.attribution='pending_validity';
  else
   insert into public.meeting_cutoff_attributions(meeting_id,period_id,client_id,agent_id,captured_client_stage,captured_agent_role,captured_team_kind,participation,attribution)
   values(m.id,p.id,m.client_id,part.agent_id,stage,part.role,part.team_kind,part.participation,'over_cap')
   on conflict(meeting_id,agent_id) do update set attribution=excluded.attribution,period_id=excluded.period_id,slot_index=null,attributed_at=now() where public.meeting_cutoff_attributions.attribution='pending_validity';
  end if;
 end loop;
end;
$$;
revoke all on function public.attribute_meeting_cutoff(uuid) from public,authenticated,anon;

-- Re-evaluate pending rows in still-active periods using the same authority.
do $$ declare r record; begin
 for r in select distinct a.meeting_id from public.meeting_cutoff_attributions a join public.meetings m on m.id=a.meeting_id join public.cutoff_periods p on p.status='active' and (coalesce(m.start_captured_at,m.meeting_date) at time zone 'Asia/Manila')::date between p.starts_on and p.ends_on where a.attribution='pending_validity' loop
  delete from public.meeting_cutoff_attributions where meeting_id=r.meeting_id and attribution='pending_validity'; perform public.attribute_meeting_cutoff(r.meeting_id);
 end loop;
end $$;
