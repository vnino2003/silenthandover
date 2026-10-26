-- Crew takeover: many workers leave, many arrive.
-- 1. Each approved handover records the shifts it was routed to. If the supervisor approves
--    after every receiving crew has already gone home, it goes to whoever is on duty now
--    (or the next crew to start) instead of to people who have left.
-- 2. A worker can take an item ("I'll take it") so two people don't do the same job and
--    nothing is left because everyone assumed someone else had it.
-- 3. The incoming crew can see which outgoing workers' handovers are still on the way.

create table public.handover_routes (
  approval_id uuid not null references public.handover_approvals (id),
  shift_id uuid not null references public.shifts (id),
  routed_at timestamptz not null default now(),
  primary key (approval_id, shift_id)
);
create index handover_routes_shift_idx on public.handover_routes (shift_id);
alter table public.handover_routes enable row level security;
grant select on public.handover_routes to authenticated;
create policy handover_routes_read on public.handover_routes for select to authenticated
  using (exists (select 1 from public.shifts s where s.id = shift_id and app.in_department(s.department_id)));

-- Existing deliveries keep the crews they already went to.
insert into public.handover_routes (approval_id, shift_id)
select distinct approval_id, shift_id from public.handover_deliveries
on conflict do nothing;

-- Where an approved handover should go if it were delivered now: the crews on duty when the
-- outgoing shift ended, unless all of them have already finished; then the crew on duty now,
-- or the next one to start within 12 hours.
create function app.receiving_shifts(p_shift uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  with s as (select * from public.shifts where id = p_shift),
  planned as (
    select n.id from public.shifts n
    where n.id in (select app.incoming_shifts(p_shift)) and n.ends_at > now()
  ),
  current as (
    select n.id, n.starts_at from s join public.shifts n
      on n.department_id = s.department_id
     and n.team_id is not distinct from s.team_id
     and n.status = 'scheduled'
     and n.id <> s.id
     and n.ends_at > now()
     and n.starts_at <= now() + interval '12 hours'
  )
  select id from planned
  union all
  select id from current
  where not exists (select 1 from planned)
    and (starts_at <= now() or starts_at = (select min(starts_at) from current))
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

  -- Decide the receiving crews once; later assignments to those crews are delivered too.
  if not exists (select 1 from public.handover_routes where approval_id = p_approval) then
    insert into public.handover_routes (approval_id, shift_id)
    select p_approval, x from app.receiving_shifts(v_report.shift_id) x
    on conflict do nothing;
  end if;

  for v_shift in
    select n.* from public.handover_routes hr join public.shifts n on n.id = hr.shift_id
    where hr.approval_id = p_approval and n.status = 'scheduled'
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

-- Called when a worker is assigned to p_shift: deliver handovers already routed to it, and
-- approved handovers from the last 36 hours that found no crew yet.
create or replace function app.deliver_pending_for_shift(p_shift uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
  v_approval uuid;
  v_total int := 0;
begin
  select * into v_shift from public.shifts where id = p_shift;
  for v_approval in
    select approval_id from public.handover_routes where shift_id = p_shift
    union
    select a.id
    from public.handover_approvals a
    join public.shift_reports r on r.id = a.report_id
    join public.shifts s on s.id = r.shift_id
    where a.decision = 'approved' and r.department_id = v_shift.department_id and r.status = 'approved'
      and s.ends_at > now() - interval '36 hours'
      and not exists (select 1 from public.handover_routes hr where hr.approval_id = a.id)
  loop
    v_total := v_total + app.deliver_approval(v_approval);
  end loop;
  return v_total;
end $$;

-- "I'll take it" / "Let go". Workers can take an item nobody holds and let go of their own;
-- a supervisor reassigns with app.assign_issue.
create function app.claim_issue(p_issue uuid, p_take boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_issue public.operational_issues;
  v_holder uuid;
  v_holder_name text;
begin
  select * into v_issue from public.operational_issues where id = p_issue for update;
  if not found or not app.in_department(v_issue.department_id) then
    perform app.fail('not_found', 'Issue not found');
  end if;
  if app.my_role() <> 'employee' then
    perform app.fail('forbidden', 'Supervisors assign items from the issue page');
  end if;
  select ia.assignee_id, p.full_name into v_holder, v_holder_name
  from public.issue_assignments ia join public.profiles p on p.id = ia.assignee_id
  where ia.issue_id = p_issue and ia.ended_at is null;

  if p_take then
    if v_issue.status not in ('open', 'in_progress') then
      perform app.fail('invalid_state', 'Only open items can be taken');
    end if;
    if v_holder = auth.uid() then
      return jsonb_build_object('id', p_issue, 'owner_id', v_holder, 'status', v_issue.status);
    end if;
    if v_holder is not null then
      perform app.fail('conflict', v_holder_name || ' already took this. Ask your supervisor to reassign it.');
    end if;
    insert into public.issue_assignments (issue_id, assignee_id, assigned_by) values (p_issue, auth.uid(), auth.uid());
    insert into public.issue_updates (issue_id, author_id, kind, from_status, to_status, note)
    values (p_issue, auth.uid(),
            case when v_issue.status = 'open' then 'status_change' else 'assignment' end,
            case when v_issue.status = 'open' then 'open' end,
            case when v_issue.status = 'open' then 'in_progress' end,
            'Taken by ' || (select full_name from public.profiles where id = auth.uid()));
    update public.operational_issues set status = 'in_progress', last_activity_at = now() where id = p_issue;
    perform app.audit('issue.claimed', 'operational_issue', p_issue, v_issue.department_id, '{}'::jsonb);
    return jsonb_build_object('id', p_issue, 'owner_id', auth.uid(), 'status', 'in_progress');
  end if;

  if v_holder is distinct from auth.uid() then
    perform app.fail('forbidden', 'You can only let go of items you took');
  end if;
  update public.issue_assignments set ended_at = now() where issue_id = p_issue and ended_at is null;
  insert into public.issue_updates (issue_id, author_id, kind, from_status, to_status, note)
  values (p_issue, auth.uid(),
          case when v_issue.status = 'in_progress' then 'status_change' else 'assignment' end,
          case when v_issue.status = 'in_progress' then 'in_progress' end,
          case when v_issue.status = 'in_progress' then 'open' end,
          'Released by ' || (select full_name from public.profiles where id = auth.uid()) || ' — free for anyone to take');
  update public.operational_issues set
    status = case when status = 'in_progress' then 'open' else status end,
    last_activity_at = now()
  where id = p_issue;
  perform app.audit('issue.released', 'operational_issue', p_issue, v_issue.department_id, '{}'::jsonb);
  return jsonb_build_object('id', p_issue, 'owner_id', null,
    'status', case when v_issue.status = 'in_progress' then 'open' else v_issue.status end);
end $$;

-- Who is handing over to p_shift and how far each handover has got. Status only: the
-- content of a report stays private until the supervisor approves it.
create function app.turnover_status(p_shift uuid)
returns table (employee_name text, outgoing_shift_id uuid, outgoing_label text, outgoing_ends_at timestamptz, report_status text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found then perform app.fail('not_found', 'Shift not found'); end if;
  if not (app.is_manager_of(v_shift.department_id) or exists (
    select 1 from public.shift_assignments where shift_id = p_shift and employee_id = auth.uid() and removed_at is null
  )) then
    perform app.fail('forbidden', 'You are not on this shift');
  end if;
  return query
    select p.full_name, o.id, o.label, o.ends_at,
           coalesce(r.status, 'not_started')
    from public.shifts o
    join public.shift_assignments a on a.shift_id = o.id and a.removed_at is null
    join public.profiles p on p.id = a.employee_id
    left join public.shift_reports r on r.shift_id = o.id and r.employee_id = a.employee_id
    where o.department_id = v_shift.department_id and o.status = 'scheduled' and o.id <> p_shift
      and o.ends_at < v_shift.ends_at and o.ends_at >= v_shift.starts_at - interval '12 hours'
      and a.employee_id <> auth.uid()
      and (p_shift in (select app.incoming_shifts(o.id))
           or exists (select 1 from public.handover_routes hr join public.handover_approvals ha on ha.id = hr.approval_id
                      where hr.shift_id = p_shift and ha.outgoing_shift_id = o.id))
    order by o.ends_at, p.full_name;
end $$;

revoke all on function app.receiving_shifts(uuid), app.claim_issue(uuid, boolean), app.turnover_status(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app.receiving_shifts(uuid), app.claim_issue(uuid, boolean), app.turnover_status(uuid) from anon';
  end if;
end $$;
grant execute on function app.receiving_shifts(uuid), app.claim_issue(uuid, boolean), app.turnover_status(uuid) to authenticated;
