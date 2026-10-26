-- Switching to a different set of shifts (for example from 24-hour Day/Evening/Night to
-- Morning/Afternoon) also cancels the upcoming shifts of the retired patterns that nobody
-- has been assigned to yet, so the schedule shows only the shifts the department now runs.
-- Staffed shifts are kept for the supervisor to move people first.
create or replace function app.apply_schedule_preset(p_preset text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid := app.my_department();
  v_names text[];
begin
  perform app.require_manager_of(v_dept);

  if p_preset = 'two_shift' then
    update public.departments set operating_start_time = '06:00', operating_end_time = '22:00', operates_24_hours = false where id = v_dept;
    v_names := array['Morning', 'Afternoon'];
    insert into public.shift_templates
      (department_id, name, start_time, end_time, window_open_minutes, grace_minutes, allow_early_draft, is_active, weekdays)
    values
      (v_dept, 'Morning',   '06:00', '14:00', 30, 30, true, true, array[1,2,3,4,5,6,7]::smallint[]),
      (v_dept, 'Afternoon', '14:00', '22:00', 30, 30, true, true, array[1,2,3,4,5,6,7]::smallint[])
    on conflict (department_id, name) do update set
      start_time = excluded.start_time, end_time = excluded.end_time,
      window_open_minutes = excluded.window_open_minutes, grace_minutes = excluded.grace_minutes,
      allow_early_draft = excluded.allow_early_draft, is_active = true, weekdays = excluded.weekdays;
  elsif p_preset = 'warehouse_extended' then
    update public.departments set operating_start_time = '07:00', operating_end_time = '22:00', operates_24_hours = false where id = v_dept;
    v_names := array['Opening', 'Mid', 'Closing'];
    insert into public.shift_templates
      (department_id, name, start_time, end_time, window_open_minutes, grace_minutes, allow_early_draft, is_active, weekdays)
    values
      (v_dept, 'Opening', '07:00', '15:00', 30, 30, true, true, array[1,2,3,4,5,6,7]::smallint[]),
      (v_dept, 'Mid',     '11:00', '19:00', 30, 30, true, true, array[1,2,3,4,5,6,7]::smallint[]),
      (v_dept, 'Closing', '14:00', '22:00', 30, 30, true, true, array[1,2,3,4,5,6,7]::smallint[])
    on conflict (department_id, name) do update set
      start_time = excluded.start_time, end_time = excluded.end_time,
      window_open_minutes = excluded.window_open_minutes, grace_minutes = excluded.grace_minutes,
      allow_early_draft = excluded.allow_early_draft, is_active = true, weekdays = excluded.weekdays;
  elsif p_preset = 'office_weekdays' then
    update public.departments set operating_start_time = '08:00', operating_end_time = '17:00', operates_24_hours = false where id = v_dept;
    v_names := array['Day'];
    insert into public.shift_templates
      (department_id, name, start_time, end_time, window_open_minutes, grace_minutes, allow_early_draft, is_active, weekdays)
    values (v_dept, 'Day', '08:00', '17:00', 30, 30, true, true, array[1,2,3,4,5]::smallint[])
    on conflict (department_id, name) do update set
      start_time = excluded.start_time, end_time = excluded.end_time,
      window_open_minutes = excluded.window_open_minutes, grace_minutes = excluded.grace_minutes,
      allow_early_draft = excluded.allow_early_draft, is_active = true, weekdays = excluded.weekdays;
  elsif p_preset = 'continuous_24h' then
    update public.departments set operating_start_time = '06:00', operating_end_time = '06:00', operates_24_hours = true where id = v_dept;
    v_names := array['Day', 'Evening', 'Night'];
    insert into public.shift_templates
      (department_id, name, start_time, end_time, window_open_minutes, grace_minutes, allow_early_draft, is_active, weekdays)
    values
      (v_dept, 'Day',     '06:00', '14:00', 30, 30, true, true, array[1,2,3,4,5,6,7]::smallint[]),
      (v_dept, 'Evening', '14:00', '22:00', 30, 30, true, true, array[1,2,3,4,5,6,7]::smallint[]),
      (v_dept, 'Night',   '22:00', '06:00', 30, 30, true, true, array[1,2,3,4,5,6,7]::smallint[])
    on conflict (department_id, name) do update set
      start_time = excluded.start_time, end_time = excluded.end_time,
      window_open_minutes = excluded.window_open_minutes, grace_minutes = excluded.grace_minutes,
      allow_early_draft = excluded.allow_early_draft, is_active = true, weekdays = excluded.weekdays;
  else
    perform app.fail('validation', 'Unknown schedule preset');
  end if;

  update public.shift_templates set is_active = false
  where department_id = v_dept and not (name = any(v_names));

  update public.shifts s set status = 'cancelled'
  from public.shift_templates t
  where t.id = s.template_id and t.department_id = v_dept and not t.is_active
    and s.status = 'scheduled' and s.starts_at > now()
    and not exists (select 1 from public.shift_assignments a where a.shift_id = s.id and a.removed_at is null);

  perform app.audit('schedule.preset_applied', 'department', v_dept, v_dept,
    jsonb_build_object('preset', p_preset, 'active_patterns', v_names));
  return jsonb_build_object('preset', p_preset, 'active_patterns', v_names);
end $$;

