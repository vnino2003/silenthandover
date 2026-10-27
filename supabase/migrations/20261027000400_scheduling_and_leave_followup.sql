-- Follow-up to 20261027000300: a local database could have applied an earlier draft of that
-- migration. These are the final versions of the functions that changed while it was written:
-- the administrator's leave queue, the shift-time notifier (no temporary table) and the staffing
-- alerts (each counted once). On a database that already has them, this replaces them unchanged.

create or replace function app.admin_leave_queue()
returns table (id uuid, employee_id uuid, employee_name text, department_name text, leave_type text,
               start_date date, end_date date, reason text, status text, created_at timestamptz,
               decided_at timestamptz, decision_note text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_admin();
  return query
    select r.id, r.employee_id, p.full_name, d.name, t.name, r.start_date, r.end_date, r.reason, r.status,
           r.created_at, r.decided_at, r.decision_note
    from public.leave_requests r
    join public.profiles p on p.id = r.employee_id
    join public.departments d on d.id = r.department_id
    join public.leave_types t on t.id = r.leave_type_id
    where p.role = 'manager' and not exists (
      select 1 from public.profiles o where o.role = 'manager' and o.is_active and o.department_id = r.department_id and o.id <> r.employee_id)
    order by (r.status = 'pending') desc, r.start_date desc
    limit 100;
end $$;

create or replace function app.sync_pattern_shifts(p_template uuid, p_restore boolean default false) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_t public.shift_templates;
  v_count int;
  v_shift uuid;
  v_moved uuid[];
begin
  select * into v_t from public.shift_templates where id = p_template;
  if not found then perform app.fail('not_found', 'Shift pattern not found'); end if;
  perform app.require_manager_of(v_t.department_id);
  if p_restore then
    update public.shifts s set status = 'scheduled'
    where s.template_id = p_template and s.status = 'cancelled' and s.starts_at > now()
      and extract(isodow from s.shift_date)::smallint = any(v_t.weekdays);
  end if;
  with moved as (
    select s.id,
           (s.shift_date + v_t.start_time) at time zone s.timezone as starts_at,
           ((case when v_t.end_time <= v_t.start_time then s.shift_date + 1 else s.shift_date end) + v_t.end_time) at time zone s.timezone as ends_at
    from public.shifts s
    where s.template_id = p_template and s.status = 'scheduled' and s.starts_at > now()
      and not exists (select 1 from public.shift_reports r where r.shift_id = s.id)
  ), changed as (
    update public.shifts s set
      label = v_t.name,
      starts_at = m.starts_at,
      ends_at = m.ends_at,
      window_opens_at = greatest(m.starts_at, m.ends_at - make_interval(mins => v_t.window_open_minutes)),
      window_closes_at = m.ends_at + make_interval(mins => v_t.grace_minutes),
      allow_early_draft = v_t.allow_early_draft
    from moved m
    where s.id = m.id and m.starts_at > now()
      and (s.label, s.starts_at, s.ends_at) is distinct from (v_t.name, m.starts_at, m.ends_at)
    returning s.id
  )
  select coalesce(array_agg(id), '{}') into v_moved from changed;
  v_count := cardinality(v_moved);
  foreach v_shift in array v_moved loop
    perform app.notify_shift_crew(v_shift, 'shift_changed', 'Shift time changed');
  end loop;
  for v_shift in
    select s.id from public.shifts s
    where s.template_id = p_template and s.status = 'scheduled' and s.starts_at > now()
      and not (extract(isodow from s.shift_date)::smallint = any(v_t.weekdays))
      and not exists (select 1 from public.shift_reports r where r.shift_id = s.id)
  loop
    perform app.notify_shift_crew(v_shift, 'shift_cancelled', 'Shift cancelled');
    update public.shifts set status = 'cancelled' where id = v_shift;
  end loop;
  if v_count > 0 then
    perform app.audit('shifts.moved', 'shift_template', p_template, v_t.department_id, jsonb_build_object('moved', v_count));
  end if;
  return v_count;
end $$;

create or replace function internal.schedule_tick() returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_hours int := app.setting_int('shift_reminder_hours', 12);
  v_row record;
  v_reminders int := 0;
  v_gaps int := 0;
begin
  if v_hours > 0 then
    for v_row in
      select a.id as assignment_id, a.employee_id, s.label, s.starts_at, s.ends_at, s.timezone
      from public.shift_assignments a join public.shifts s on s.id = a.shift_id
      where a.removed_at is null and s.status = 'scheduled'
        and s.starts_at > now() and s.starts_at <= now() + make_interval(hours => v_hours)
        and not exists (select 1 from public.notifications n where n.recipient_id = a.employee_id and n.event_key = 'reminder:' || a.id)
    loop
      perform app.notify(v_row.employee_id, 'shift_reminder', 'Upcoming shift: ' || v_row.label,
        to_char(v_row.starts_at at time zone v_row.timezone, 'Dy DD Mon, HH12:MI AM') || ' – ' ||
        to_char(v_row.ends_at at time zone v_row.timezone, 'HH12:MI AM'), '/schedule', 'reminder:' || v_row.assignment_id, null, false);
      v_reminders := v_reminders + 1;
    end loop;
  end if;
  -- Shifts starting within a day that are below their minimum: tell the supervisors once per shift.
  for v_row in
    select s.id, s.department_id, s.label, s.starts_at, s.timezone, s.min_staff,
           (select count(*)::int from public.shift_assignments a where a.shift_id = s.id and a.removed_at is null) as assigned
    from public.shifts s
    where s.status = 'scheduled' and s.min_staff > 0 and s.starts_at > now() and s.starts_at <= now() + interval '24 hours'
  loop
    continue when v_row.assigned >= v_row.min_staff
      or exists (select 1 from public.notifications n where n.event_key = 'gap-shift:' || v_row.id);
    perform app.notify_managers(v_row.department_id, 'staffing_gap', 'Understaffed: ' || v_row.label,
      to_char(v_row.starts_at at time zone v_row.timezone, 'Dy DD Mon, HH12:MI AM') || ' · ' || v_row.assigned || ' of ' || v_row.min_staff || ' staff',
      '/manager/schedule', 'gap-shift:' || v_row.id);
    v_gaps := v_gaps + 1;
  end loop;
  return jsonb_build_object('shift_reminders', v_reminders, 'staffing_alerts', v_gaps);
end $$;

revoke all on function app.admin_leave_queue(), internal.schedule_tick() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function internal.schedule_tick() from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function internal.schedule_tick() to service_role';
  end if;
end $$;
grant execute on function app.admin_leave_queue() to authenticated;
