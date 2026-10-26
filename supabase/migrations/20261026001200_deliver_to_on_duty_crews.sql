-- Deliver a handover to everyone on duty when the outgoing shift ends.
-- With overlapping patterns (Opening 07–15, Mid 11–19, Closing 14–22) more than one crew is
-- working at hand-off time, so "the next shift" is a set: every scheduled shift of the same
-- department and team that is running at the outgoing shift's end. When nobody is on duty
-- (end of the operating day), the earliest shift starting within 12 hours receives it instead.

create function app.incoming_shifts(p_shift uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  with s as (select * from public.shifts where id = p_shift),
  candidates as (
    select n.id, n.starts_at, n.starts_at <= s.ends_at as on_duty
    from s join public.shifts n
      on n.department_id = s.department_id
     and n.team_id is not distinct from s.team_id
     and n.status = 'scheduled'
     and n.id <> s.id
     and n.ends_at > s.ends_at
     and n.starts_at <= s.ends_at + interval '12 hours'
  )
  select id from candidates where on_duty
  union all
  select id from (
    select id from candidates where not exists (select 1 from candidates where on_duty)
    order by starts_at limit 1
  ) fallback
$$;

-- Kept for callers that need one shift: the earliest-starting receiving shift.
create or replace function app.next_shift(p_shift uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select n.id from public.shifts n where n.id in (select app.incoming_shifts(p_shift))
  order by n.starts_at limit 1
$$;

create or replace function app.deliver_approval(p_approval uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_approval public.handover_approvals;
  v_report public.shift_reports;
  v_shift public.shifts;
  v_shifts uuid[] := '{}';
  v_event uuid;
  v_emp uuid;
  v_delivery uuid;
  v_count int := 0;
begin
  select * into v_approval from public.handover_approvals where id = p_approval and decision = 'approved';
  if not found then return 0; end if;
  select * into v_report from public.shift_reports where id = v_approval.report_id;
  select id into v_event from public.automation_events where approval_id = p_approval and kind = 'handover_delivery';

  for v_shift in
    select n.* from public.shifts n where n.id in (select app.incoming_shifts(v_report.shift_id))
    order by n.starts_at
  loop
    v_shifts := v_shifts || v_shift.id;
    for v_emp in
      select employee_id from public.shift_assignments
      where shift_id = v_shift.id and removed_at is null and employee_id <> v_report.employee_id
    loop
      v_delivery := null;
      insert into public.handover_deliveries (approval_id, report_id, recipient_id, shift_id)
      values (p_approval, v_report.id, v_emp, v_shift.id)
      on conflict (approval_id, recipient_id) where revoked_at is null do nothing
      returning id into v_delivery;
      if v_delivery is not null then
        v_count := v_count + 1;
        perform app.notify(v_emp, 'handover_delivered', 'Incoming handover awaiting acknowledgment',
          'An approved handover (' || v_report.reference_code || ') is ready for your ' || v_shift.label || ' shift.',
          '/handover', 'handover:' || v_delivery, v_event);
      end if;
    end loop;
  end loop;

  if exists (select 1 from public.handover_deliveries where approval_id = p_approval and revoked_at is null) then
    update public.shift_reports set status = 'delivered' where id = v_report.id and status = 'approved';
  end if;
  if v_count > 0 then
    perform app.audit('handover.delivered', 'handover_approval', p_approval, v_report.department_id,
      jsonb_build_object('incoming_shifts', to_jsonb(v_shifts), 'recipients', v_count));
  end if;
  return v_count;
end $$;

-- Called when a worker is assigned to p_shift: deliver every approved handover whose
-- outgoing shift hands off to p_shift. The outgoing shift ended before p_shift ends and
-- at most 12 hours before it starts.
create or replace function app.deliver_pending_for_shift(p_shift uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
  v_row record;
  v_total int := 0;
begin
  select * into v_shift from public.shifts where id = p_shift;
  for v_row in
    select a.id as approval_id, r.shift_id as outgoing_shift_id
    from public.handover_approvals a
    join public.shift_reports r on r.id = a.report_id
    join public.shifts s on s.id = r.shift_id
    where a.decision = 'approved' and r.department_id = v_shift.department_id
      and r.status in ('approved', 'delivered')
      and s.id <> p_shift
      and s.ends_at < v_shift.ends_at and s.ends_at >= v_shift.starts_at - interval '12 hours'
  loop
    if p_shift in (select app.incoming_shifts(v_row.outgoing_shift_id)) then
      v_total := v_total + app.deliver_approval(v_row.approval_id);
    end if;
  end loop;
  return v_total;
end $$;

revoke all on function app.incoming_shifts(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app.incoming_shifts(uuid) from anon';
  end if;
end $$;
grant execute on function app.incoming_shifts(uuid) to authenticated;
