-- A supervisor needs two separate concepts:
--   1. the department's normal operating day; and
--   2. reusable shift patterns that cover selected weekdays.
-- Concrete shifts and employee assignments remain unchanged.

alter table public.departments
  add column operating_start_time time not null default '07:00',
  add column operating_end_time time not null default '22:00',
  add column operates_24_hours boolean not null default false;

alter table public.departments add constraint departments_operating_hours_ck
  check (operates_24_hours or operating_start_time <> operating_end_time);

alter table public.shift_templates
  add column weekdays smallint[] not null default array[1, 2, 3, 4, 5, 6, 7];

alter table public.shift_templates add constraint shift_templates_weekdays_ck
  check (
    cardinality(weekdays) between 1 and 7
    and weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
  );

create function app.update_schedule_settings(p_start time, p_end time, p_24_hours boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid := app.my_department();
begin
  perform app.require_manager_of(v_dept);
  if not coalesce(p_24_hours, false) and p_start = p_end then
    perform app.fail('validation', 'Opening and closing time must be different');
  end if;
  update public.departments set
    operating_start_time = p_start,
    operating_end_time = p_end,
    operates_24_hours = coalesce(p_24_hours, false)
  where id = v_dept;
  perform app.audit('schedule.settings_updated', 'department', v_dept, v_dept,
    jsonb_build_object('operating_start_time', p_start, 'operating_end_time', p_end, 'operates_24_hours', p_24_hours));
end $$;

drop function app.upsert_shift_template(uuid, uuid, text, time, time, int, int, boolean, boolean);

create function app.upsert_shift_template(
  p_id uuid, p_team uuid, p_name text, p_start time, p_end time,
  p_window_open_minutes int, p_grace_minutes int, p_allow_early_draft boolean, p_is_active boolean,
  p_weekdays smallint[] default array[1, 2, 3, 4, 5, 6, 7]::smallint[]
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid := app.my_department();
  v_id uuid;
  v_weekdays smallint[] := (select array_agg(distinct d order by d) from unnest(p_weekdays) d);
begin
  perform app.require_manager_of(v_dept);
  if p_team is not null and not exists (select 1 from public.teams where id = p_team and department_id = v_dept) then
    perform app.fail('validation', 'That team is not in your department');
  end if;
  if cardinality(v_weekdays) is null or cardinality(v_weekdays) = 0 or not (v_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]) then
    perform app.fail('validation', 'Choose at least one valid weekday');
  end if;
  if p_id is null then
    insert into public.shift_templates
      (department_id, team_id, name, start_time, end_time, window_open_minutes, grace_minutes, allow_early_draft, is_active, weekdays)
    values (v_dept, p_team, trim(p_name), p_start, p_end, p_window_open_minutes, p_grace_minutes,
            coalesce(p_allow_early_draft, true), coalesce(p_is_active, true), v_weekdays)
    returning id into v_id;
  else
    update public.shift_templates set
      team_id = p_team, name = trim(p_name), start_time = p_start, end_time = p_end,
      window_open_minutes = p_window_open_minutes, grace_minutes = p_grace_minutes,
      allow_early_draft = coalesce(p_allow_early_draft, true), is_active = coalesce(p_is_active, true),
      weekdays = v_weekdays
    where id = p_id and department_id = v_dept returning id into v_id;
    if v_id is null then perform app.fail('not_found', 'Template not found'); end if;
  end if;
  perform app.audit('shift_template.saved', 'shift_template', v_id, v_dept,
    jsonb_build_object('weekdays', v_weekdays));
  return v_id;
exception
  when unique_violation then perform app.fail('conflict', 'A shift pattern with that name already exists');
  when check_violation then perform app.fail('validation', 'Check the times, days and reporting window settings');
end $$;

create or replace function app.generate_shifts(p_template uuid, p_from date, p_to date, p_supervisor uuid) returns int
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
  if not found then perform app.fail('not_found', 'Shift pattern not found'); end if;
  perform app.require_manager_of(v_t.department_id);
  perform app.check_supervisor(v_t.department_id, p_supervisor);
  if p_to < p_from or p_to - p_from > 62 then
    perform app.fail('validation', 'Choose a range of up to 62 days');
  end if;
  select timezone into v_tz from public.departments where id = v_t.department_id;

  for v_day in select generate_series(p_from, p_to, interval '1 day')::date loop
    continue when not (extract(isodow from v_day)::smallint = any(v_t.weekdays));
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
    jsonb_build_object('from', p_from, 'to', p_to, 'created', v_count, 'weekdays', v_t.weekdays));
  return v_count;
end $$;

revoke all on function
  app.update_schedule_settings(time, time, boolean),
  app.upsert_shift_template(uuid, uuid, text, time, time, int, int, boolean, boolean, smallint[])
from public;

grant execute on function
  app.update_schedule_settings(time, time, boolean),
  app.upsert_shift_template(uuid, uuid, text, time, time, int, int, boolean, boolean, smallint[])
to authenticated;
