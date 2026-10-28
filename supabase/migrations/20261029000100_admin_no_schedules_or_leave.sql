-- Schedules and leave belong to the department: its team members and supervisors. The
-- administrator (IT) configures the system — accounts, departments, leave types, rules, AI — but
-- does not see department schedules or anyone's leave, and does not decide leave.

-- Schedules: no administrator read access.
drop policy shift_templates_read on public.shift_templates;
create policy shift_templates_read on public.shift_templates for select to authenticated
  using (app.in_department(department_id));
drop policy shifts_read on public.shifts;
create policy shifts_read on public.shifts for select to authenticated
  using (app.in_department(department_id));
drop policy shift_assignments_read on public.shift_assignments;
create policy shift_assignments_read on public.shift_assignments for select to authenticated
  using (exists (select 1 from public.shifts s where s.id = shift_id and app.in_department(s.department_id)));
drop policy schedule_day_marks_read on public.schedule_day_marks;
create policy schedule_day_marks_read on public.schedule_day_marks for select to authenticated
  using (employee_id = auth.uid() or app.is_manager_of(department_id));

-- Leave: decided only by a supervisor of the department other than the requester.
create or replace function app.can_decide_leave(p_request uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.leave_requests r
    where r.id = p_request and r.employee_id <> auth.uid() and app.is_manager_of(r.department_id)
  )
$$;

create or replace function app.leave_calendar(p_department uuid, p_from date, p_to date)
returns table (id uuid, employee_id uuid, leave_type text, start_date date, end_date date, status text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.is_manager_of(p_department) then perform app.fail('forbidden', 'Not allowed'); end if;
  return query
    select r.id, r.employee_id, t.name, r.start_date, r.end_date, r.status
    from public.leave_requests r join public.leave_types t on t.id = r.leave_type_id
    where r.department_id = p_department and r.status in ('pending', 'approved')
      and daterange(r.start_date, r.end_date, '[]') && daterange(p_from, p_to, '[]')
    order by r.start_date;
end $$;

drop function app.admin_leave_queue();

-- A supervisor's own leave needs another supervisor of the same department. Without one there is
-- nobody to decide it, so the request is refused with a clear message instead of waiting forever.
create function internal.leave_needs_a_decider() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.profiles p where p.id = new.employee_id and p.role = 'manager')
     and not exists (select 1 from public.profiles o where o.role = 'manager' and o.is_active
                       and o.department_id = new.department_id and o.id <> new.employee_id) then
    perform app.fail('conflict', 'No other supervisor in your department can approve your leave. Ask the administrator to add a second supervisor to the department.');
  end if;
  return new;
end $$;
create trigger leave_requests_need_a_decider before insert on public.leave_requests
  for each row execute function internal.leave_needs_a_decider();
revoke all on function internal.leave_needs_a_decider() from public, anon, authenticated;
