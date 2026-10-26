-- Many employees may share a shift, but one employee cannot work two overlapping shifts.
create or replace function app.assign_to_shift(p_shift uuid, p_employee uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
  v_id uuid;
  v_delivered int;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found then perform app.fail('not_found', 'Shift not found'); end if;
  perform app.require_manager_of(v_shift.department_id);
  if v_shift.status <> 'scheduled' then perform app.fail('invalid_state', 'This shift was cancelled'); end if;
  if not exists (select 1 from public.profiles where id = p_employee and role = 'employee' and is_active
                 and department_id = v_shift.department_id) then
    perform app.fail('validation', 'Only active workers of this department can be assigned');
  end if;
  if exists (
    select 1 from public.shift_assignments a
    join public.shifts s on s.id = a.shift_id
    where a.employee_id = p_employee and a.removed_at is null and s.status = 'scheduled'
      and s.id <> p_shift
      and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(v_shift.starts_at, v_shift.ends_at, '[)')
  ) then
    perform app.fail('conflict', 'This employee is already assigned to an overlapping shift');
  end if;
  insert into public.shift_assignments (shift_id, employee_id, assigned_by) values (p_shift, p_employee, auth.uid())
  on conflict (shift_id, employee_id) where removed_at is null do nothing
  returning id into v_id;
  if v_id is null then perform app.fail('conflict', 'Already assigned to this shift'); end if;
  perform app.audit('shift.assigned', 'shift', p_shift, v_shift.department_id, jsonb_build_object('employee', p_employee));
  perform app.notify(p_employee, 'shift_assigned', 'New shift: ' || v_shift.label,
    to_char(v_shift.starts_at at time zone v_shift.timezone, 'Dy DD Mon, HH12:MI AM') || ' – ' ||
    to_char(v_shift.ends_at at time zone v_shift.timezone, 'HH12:MI AM'), '/', 'assigned:' || v_id, null, false);
  v_delivered := app.deliver_pending_for_shift(p_shift);
  return jsonb_build_object('assignment_id', v_id, 'handovers_delivered', v_delivered);
end $$;

