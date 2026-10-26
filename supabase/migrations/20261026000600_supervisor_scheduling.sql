-- Shift scheduling belongs to the department's supervisors, not to administrators.
-- Administrators keep accounts, departments and settings; supervisors build templates,
-- generate shifts and decide who is on duty, for their own department only.

drop function app.admin_upsert_template(uuid, uuid, uuid, text, time, time, int, int, boolean, boolean);
drop function app.admin_generate_shifts(uuid, date, date, uuid);
drop function app.admin_create_shift(uuid, uuid, text, timestamptz, timestamptz, int, int, uuid, boolean);
drop function app.admin_update_shift(uuid, uuid, text);
drop function app.admin_assign_employee(uuid, uuid);
drop function app.admin_unassign_employee(uuid, uuid);

create function app.require_manager_of(p_department uuid) returns void
language plpgsql stable as $$
begin
  if p_department is null or not app.is_manager_of(p_department) then
    perform app.fail('forbidden', 'Only a supervisor of this department can manage its shifts');
  end if;
end $$;

-- A shift's supervisor must be an active supervisor of the same department.
create function app.check_supervisor(p_department uuid, p_supervisor uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_supervisor is not null and not exists (
    select 1 from public.profiles
    where id = p_supervisor and role = 'manager' and department_id = p_department and is_active
  ) then
    perform app.fail('validation', 'The supervisor must be an active supervisor of this department');
  end if;
end $$;

create function app.upsert_shift_template(
  p_id uuid, p_team uuid, p_name text, p_start time, p_end time,
  p_window_open_minutes int, p_grace_minutes int, p_allow_early_draft boolean, p_is_active boolean
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid := app.my_department();
  v_id uuid;
begin
  perform app.require_manager_of(v_dept);
  if p_team is not null and not exists (select 1 from public.teams where id = p_team and department_id = v_dept) then
    perform app.fail('validation', 'That team is not in your department');
  end if;
  if p_id is null then
    insert into public.shift_templates
      (department_id, team_id, name, start_time, end_time, window_open_minutes, grace_minutes, allow_early_draft, is_active)
    values (v_dept, p_team, trim(p_name), p_start, p_end, p_window_open_minutes, p_grace_minutes,
            coalesce(p_allow_early_draft, true), coalesce(p_is_active, true))
    returning id into v_id;
  else
    update public.shift_templates set
      team_id = p_team, name = trim(p_name), start_time = p_start, end_time = p_end,
      window_open_minutes = p_window_open_minutes, grace_minutes = p_grace_minutes,
      allow_early_draft = coalesce(p_allow_early_draft, true), is_active = coalesce(p_is_active, true)
    where id = p_id and department_id = v_dept returning id into v_id;
    if v_id is null then perform app.fail('not_found', 'Template not found'); end if;
  end if;
  perform app.audit('shift_template.saved', 'shift_template', v_id, v_dept);
  return v_id;
exception
  when unique_violation then perform app.fail('conflict', 'A template with that name already exists');
  when check_violation then perform app.fail('validation', 'Check the times and window settings');
end $$;

-- Concrete shifts from a template. Local times are converted with the department's time zone,
-- so daylight-saving changes are handled by PostgreSQL. Overnight shifts end the next day.
create function app.generate_shifts(p_template uuid, p_from date, p_to date, p_supervisor uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_t public.shift_templates;
  v_tz text;
  v_day date;
  v_start timestamptz;
  v_end timestamptz;
  v_count int := 0;
  v_rows int;
begin
  select * into v_t from public.shift_templates where id = p_template;
  if not found then perform app.fail('not_found', 'Template not found'); end if;
  perform app.require_manager_of(v_t.department_id);
  perform app.check_supervisor(v_t.department_id, p_supervisor);
  if p_to < p_from or p_to - p_from > 62 then
    perform app.fail('validation', 'Choose a range of up to 62 days');
  end if;
  select timezone into v_tz from public.departments where id = v_t.department_id;

  for v_day in select generate_series(p_from, p_to, interval '1 day')::date loop
    v_start := (v_day + v_t.start_time) at time zone v_tz;
    v_end := ((case when v_t.end_time <= v_t.start_time then v_day + 1 else v_day end) + v_t.end_time) at time zone v_tz;
    insert into public.shifts
      (template_id, department_id, team_id, label, shift_date, timezone, starts_at, ends_at,
       window_opens_at, window_closes_at, allow_early_draft, supervisor_id)
    values (v_t.id, v_t.department_id, v_t.team_id, v_t.name, v_day, v_tz, v_start, v_end,
            greatest(v_start, v_end - make_interval(mins => v_t.window_open_minutes)),
            v_end + make_interval(mins => v_t.grace_minutes), v_t.allow_early_draft, p_supervisor)
    on conflict (template_id, shift_date) where template_id is not null do nothing;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;
  perform app.audit('shifts.generated', 'shift_template', p_template, v_t.department_id,
    jsonb_build_object('from', p_from, 'to', p_to, 'created', v_count));
  return v_count;
end $$;

create function app.create_shift(
  p_team uuid, p_label text, p_starts_at timestamptz, p_ends_at timestamptz,
  p_window_open_minutes int, p_grace_minutes int, p_supervisor uuid, p_allow_early_draft boolean
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid := app.my_department();
  v_tz text;
  v_id uuid;
begin
  perform app.require_manager_of(v_dept);
  perform app.check_supervisor(v_dept, p_supervisor);
  if p_team is not null and not exists (select 1 from public.teams where id = p_team and department_id = v_dept) then
    perform app.fail('validation', 'That team is not in your department');
  end if;
  if p_ends_at <= p_starts_at or p_ends_at - p_starts_at > interval '24 hours' then
    perform app.fail('validation', 'A shift must end after it starts and last at most 24 hours');
  end if;
  select timezone into v_tz from public.departments where id = v_dept;
  insert into public.shifts
    (department_id, team_id, label, shift_date, timezone, starts_at, ends_at, window_opens_at, window_closes_at,
     allow_early_draft, supervisor_id)
  values (v_dept, p_team, trim(p_label), (p_starts_at at time zone v_tz)::date, v_tz, p_starts_at, p_ends_at,
          greatest(p_starts_at, p_ends_at - make_interval(mins => p_window_open_minutes)),
          p_ends_at + make_interval(mins => p_grace_minutes), coalesce(p_allow_early_draft, true), p_supervisor)
  returning id into v_id;
  perform app.audit('shift.created', 'shift', v_id, v_dept);
  return v_id;
end $$;

create function app.update_shift(p_shift uuid, p_supervisor uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
begin
  select department_id into v_dept from public.shifts where id = p_shift;
  if v_dept is null then perform app.fail('not_found', 'Shift not found'); end if;
  perform app.require_manager_of(v_dept);
  perform app.check_supervisor(v_dept, p_supervisor);
  update public.shifts set supervisor_id = p_supervisor, status = coalesce(p_status, status) where id = p_shift;
  perform app.audit('shift.updated', 'shift', p_shift, v_dept, jsonb_build_object('status', p_status));
end $$;

create function app.assign_to_shift(p_shift uuid, p_employee uuid) returns jsonb
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

create function app.unassign_from_shift(p_shift uuid, p_employee uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
begin
  select department_id into v_dept from public.shifts where id = p_shift;
  if v_dept is null then perform app.fail('not_found', 'Shift not found'); end if;
  perform app.require_manager_of(v_dept);
  update public.shift_assignments set removed_at = now(), removed_by = auth.uid()
  where shift_id = p_shift and employee_id = p_employee and removed_at is null;
  if not found then perform app.fail('not_found', 'Assignment not found'); end if;
  perform app.audit('shift.unassigned', 'shift', p_shift, v_dept, jsonb_build_object('employee', p_employee));
end $$;

revoke all on function
  app.require_manager_of(uuid), app.check_supervisor(uuid, uuid),
  app.upsert_shift_template(uuid, uuid, text, time, time, int, int, boolean, boolean),
  app.generate_shifts(uuid, date, date, uuid),
  app.create_shift(uuid, text, timestamptz, timestamptz, int, int, uuid, boolean),
  app.update_shift(uuid, uuid, text),
  app.assign_to_shift(uuid, uuid),
  app.unassign_from_shift(uuid, uuid)
from public;
grant execute on function
  app.upsert_shift_template(uuid, uuid, text, time, time, int, int, boolean, boolean),
  app.generate_shifts(uuid, date, date, uuid),
  app.create_shift(uuid, text, timestamptz, timestamptz, int, int, uuid, boolean),
  app.update_shift(uuid, uuid, text),
  app.assign_to_shift(uuid, uuid),
  app.unassign_from_shift(uuid, uuid)
to authenticated;
