-- Scheduling and leave (see docs/plan-scheduling-and-leave.md).
--
-- * Leave types are configured organisation-wide by administrators; nothing is hard-coded.
-- * Employees (and supervisors) request leave for whole days. Pending leave never affects the
--   schedule; only approved leave does. Nobody decides their own request: a supervisor's request
--   goes to another supervisor of the department, or to administrators when there is none.
-- * Approving leave removes the person from their shifts on those days, tells them, and alerts
--   supervisors about shifts that fall below their minimum staffing.
-- * Supervisors mark rest days and days off per person. A day with neither and no shift is simply
--   "not scheduled".
-- * Every change to someone's shifts (assigned, removed, cancelled, moved) now notifies them,
--   and upcoming shifts send a reminder.

-- ---------------------------------------------------------------------------
-- Tables and columns
-- ---------------------------------------------------------------------------
alter table public.profiles add column job_title text check (job_title is null or length(job_title) between 2 and 80);
alter table public.shift_templates add column min_staff int not null default 1 check (min_staff between 0 and 50);
alter table public.shifts add column min_staff int not null default 1 check (min_staff between 0 and 50);

create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(name) between 2 and 60),
  description text not null default '' check (length(description) <= 300),
  requires_reason boolean not null default false,
  max_days int check (max_days is null or max_days between 1 and 365),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
insert into public.leave_types (name, description, requires_reason, sort_order) values
  ('Vacation leave', 'Planned time off.', false, 10),
  ('Sick leave', 'Illness or medical appointment. Only you and the approving supervisor see the reason.', true, 20),
  ('Emergency leave', 'Urgent personal or family matters.', true, 30),
  ('Unpaid leave', 'Time off without pay, by arrangement.', true, 40);

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  leave_type_id uuid not null references public.leave_types (id),
  start_date date not null,
  end_date date not null,
  reason text not null default '' check (length(reason) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_note text not null default '' check (length(decision_note) <= 1000),
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date < 366)
);
create index leave_requests_department_idx on public.leave_requests (department_id, start_date);
create index leave_requests_employee_idx on public.leave_requests (employee_id, start_date);

create table public.schedule_day_marks (
  employee_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  department_id uuid not null references public.departments (id) on delete cascade,
  kind text not null check (kind in ('rest_day', 'day_off')),
  note text not null default '' check (length(note) <= 200),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (employee_id, day)
);
create index schedule_day_marks_department_idx on public.schedule_day_marks (department_id, day);

insert into public.app_settings (key, value, description) values
  ('leave_min_notice_days', '0', 'Leave must be requested at least this many days before it starts (0 = same day allowed)'),
  ('leave_cancel_pending_allowed', 'true', 'Employees may cancel their own leave request while it is still pending'),
  ('shift_reminder_hours', '12', 'Remind people this many hours before their shift starts (0 = no reminders)');

-- ---------------------------------------------------------------------------
-- Row-level security. Writes only go through the checked functions below.
-- ---------------------------------------------------------------------------
alter table public.leave_types enable row level security;
create policy leave_types_read on public.leave_types for select to authenticated using (true);
grant select on public.leave_types to authenticated;

-- Leave (including the reason, which may be medical) is visible to the person and the
-- supervisors of their department. Administrators see leave on the schedule board through
-- app.leave_calendar, which leaves the reason out.
alter table public.leave_requests enable row level security;
create policy leave_requests_read on public.leave_requests for select to authenticated
  using (employee_id = auth.uid() or app.is_manager_of(department_id));
grant select on public.leave_requests to authenticated;

alter table public.schedule_day_marks enable row level security;
create policy schedule_day_marks_read on public.schedule_day_marks for select to authenticated
  using (employee_id = auth.uid() or app.is_manager_of(department_id) or app.is_admin());
grant select on public.schedule_day_marks to authenticated;

grant select (job_title) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function app.department_today(p_department uuid) returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select (now() at time zone d.timezone)::date from public.departments d where d.id = p_department
$$;

-- Who may decide a leave request: supervisors of the department other than the requester; and
-- administrators, only for a supervisor's request when no other supervisor of the department is active.
create function app.can_decide_leave(p_request uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.leave_requests r join public.profiles p on p.id = r.employee_id
    where r.id = p_request and r.employee_id <> auth.uid() and (
      app.is_manager_of(r.department_id)
      or (app.is_admin() and p.role = 'manager' and not exists (
            select 1 from public.profiles o where o.role = 'manager' and o.is_active
              and o.department_id = r.department_id and o.id <> r.employee_id))
    )
  )
$$;

-- Shifts that are short of their minimum, counting only active assignments.
create function app.shift_coverage(p_shift uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'shift_id', s.id, 'label', s.label, 'shift_date', s.shift_date, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
    'min_staff', s.min_staff,
    'assigned', (select count(*)::int from public.shift_assignments a where a.shift_id = s.id and a.removed_at is null))
  from public.shifts s where s.id = p_shift
$$;

-- ---------------------------------------------------------------------------
-- Leave requests
-- ---------------------------------------------------------------------------
create function app.request_leave(p_type uuid, p_start date, p_end date, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me public.profiles;
  v_type public.leave_types;
  v_reason text := trim(coalesce(p_reason, ''));
  v_notice int := app.setting_int('leave_min_notice_days', 0);
  v_id uuid;
  v_dates text;
  v_approver uuid;
  v_sent int := 0;
begin
  select * into v_me from public.profiles where id = auth.uid() and is_active;
  if not found or v_me.role not in ('employee', 'manager') or v_me.department_id is null then
    perform app.fail('forbidden', 'Only staff of a department can request leave');
  end if;
  select * into v_type from public.leave_types where id = p_type and is_active;
  if not found then perform app.fail('validation', 'Choose a leave type'); end if;
  if p_start is null or p_end is null or p_end < p_start then perform app.fail('validation', 'The last day must be on or after the first day'); end if;
  if p_start < app.department_today(v_me.department_id) + v_notice then
    perform app.fail('validation', case when v_notice = 0 then 'Leave cannot start in the past'
      else 'Leave must be requested at least ' || v_notice || ' day' || case when v_notice = 1 then '' else 's' end || ' ahead' end);
  end if;
  if v_type.max_days is not null and (p_end - p_start + 1) > v_type.max_days then
    perform app.fail('validation', v_type.name || ' is limited to ' || v_type.max_days || ' days per request');
  end if;
  if v_type.requires_reason and length(v_reason) < 3 then perform app.fail('validation', 'Add a short reason for ' || lower(v_type.name)); end if;
  if exists (select 1 from public.leave_requests where employee_id = auth.uid() and status in ('pending', 'approved')
             and daterange(start_date, end_date, '[]') && daterange(p_start, p_end, '[]')) then
    perform app.fail('conflict', 'You already have leave requested or approved on some of these days');
  end if;

  insert into public.leave_requests (employee_id, department_id, leave_type_id, start_date, end_date, reason)
  values (auth.uid(), v_me.department_id, p_type, p_start, p_end, v_reason) returning id into v_id;

  v_dates := to_char(p_start, 'Dy DD Mon') || case when p_end > p_start then ' – ' || to_char(p_end, 'Dy DD Mon') else '' end;
  -- Notify whoever may decide it (never the requester).
  for v_approver in
    select id from public.profiles where role = 'manager' and is_active and department_id = v_me.department_id and id <> auth.uid()
  loop
    perform app.notify(v_approver, 'leave_requested', 'Leave request: ' || v_me.full_name, v_type.name || ' · ' || v_dates,
      '/manager/leave', 'leave:' || v_id || ':requested');
    v_sent := v_sent + 1;
  end loop;
  if v_sent = 0 then
    perform app.notify_admins('leave_requested', 'Leave request: ' || v_me.full_name, v_type.name || ' · ' || v_dates || ' (no other supervisor in the department)',
      '/admin/leave', 'leave:' || v_id || ':requested');
  end if;
  perform app.audit('leave.requested', 'leave_request', v_id, v_me.department_id,
    jsonb_build_object('type', v_type.name, 'start', p_start, 'end', p_end));
  return v_id;
end $$;

-- What approving would do: the person's shifts on those days, and the staffing left on each.
create function app.leave_impact(p_request uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_r public.leave_requests;
begin
  select * into v_r from public.leave_requests where id = p_request;
  if not found or not (app.can_decide_leave(p_request) or app.is_manager_of(v_r.department_id)) then
    perform app.fail('not_found', 'Leave request not found');
  end if;
  return jsonb_build_object(
    'shifts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'shift_id', s.id, 'label', s.label, 'shift_date', s.shift_date, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
        'min_staff', s.min_staff,
        'assigned', (select count(*)::int from public.shift_assignments x where x.shift_id = s.id and x.removed_at is null),
        'assigned_after', (select count(*)::int from public.shift_assignments x where x.shift_id = s.id and x.removed_at is null and x.employee_id <> v_r.employee_id))
        order by s.starts_at)
      from public.shift_assignments a join public.shifts s on s.id = a.shift_id
      where a.employee_id = v_r.employee_id and a.removed_at is null and s.status = 'scheduled'
        and s.shift_date between v_r.start_date and v_r.end_date), '[]'::jsonb),
    -- Colleagues already off on those days (approved leave), so overlapping absences are visible.
    'others_on_leave', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.full_name, 'start_date', o.start_date, 'end_date', o.end_date) order by o.start_date)
      from public.leave_requests o join public.profiles p on p.id = o.employee_id
      where o.department_id = v_r.department_id and o.id <> v_r.id and o.status = 'approved'
        and daterange(o.start_date, o.end_date, '[]') && daterange(v_r.start_date, v_r.end_date, '[]')), '[]'::jsonb)
  );
end $$;

create function app.decide_leave(p_request uuid, p_decision text, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_r public.leave_requests;
  v_type public.leave_types;
  v_note text := trim(coalesce(p_note, ''));
  v_shift public.shifts;
  v_removed int := 0;
  v_short jsonb := '[]'::jsonb;
  v_cov jsonb;
  v_dates text;
begin
  select * into v_r from public.leave_requests where id = p_request for update;
  if not found then perform app.fail('not_found', 'Leave request not found'); end if;
  if v_r.employee_id = auth.uid() then perform app.fail('forbidden', 'You cannot decide your own leave request'); end if;
  if not app.can_decide_leave(p_request) then perform app.fail('forbidden', 'Only a supervisor of this department can decide this request'); end if;
  if v_r.status <> 'pending' then perform app.fail('invalid_state', 'This request was already ' || v_r.status); end if;
  if p_decision not in ('approved', 'rejected') then perform app.fail('validation', 'Approve or reject the request'); end if;
  if p_decision = 'rejected' and length(v_note) < 3 then perform app.fail('validation', 'Say briefly why the request is rejected'); end if;
  select * into v_type from public.leave_types where id = v_r.leave_type_id;
  v_dates := to_char(v_r.start_date, 'Dy DD Mon') || case when v_r.end_date > v_r.start_date then ' – ' || to_char(v_r.end_date, 'Dy DD Mon') else '' end;

  update public.leave_requests set status = p_decision, decided_by = auth.uid(), decided_at = now(), decision_note = v_note, updated_at = now()
  where id = p_request;

  if p_decision = 'approved' then
    -- Approved leave takes the person off their shifts on those days.
    for v_shift in
      select s.* from public.shift_assignments a join public.shifts s on s.id = a.shift_id
      where a.employee_id = v_r.employee_id and a.removed_at is null and s.status = 'scheduled'
        and s.shift_date between v_r.start_date and v_r.end_date
      order by s.starts_at
    loop
      update public.shift_assignments set removed_at = now(), removed_by = auth.uid()
      where shift_id = v_shift.id and employee_id = v_r.employee_id and removed_at is null;
      update public.handover_deliveries set revoked_at = now()
      where shift_id = v_shift.id and recipient_id = v_r.employee_id and revoked_at is null;
      v_removed := v_removed + 1;
      v_cov := app.shift_coverage(v_shift.id);
      if (v_cov ->> 'assigned')::int < (v_cov ->> 'min_staff')::int then v_short := v_short || jsonb_build_array(v_cov); end if;
    end loop;
    perform app.notify(v_r.employee_id, 'leave_approved', v_type.name || ' approved', v_dates
      || case when v_removed > 0 then ' · removed from ' || v_removed || ' shift' || case when v_removed = 1 then '' else 's' end else '' end
      || case when v_note <> '' then ' · ' || v_note else '' end,
      '/leave', 'leave:' || p_request || ':approved');
    if jsonb_array_length(v_short) > 0 then
      perform app.notify_managers(v_r.department_id, 'staffing_gap', 'Understaffed after approved leave',
        jsonb_array_length(v_short) || ' shift' || case when jsonb_array_length(v_short) = 1 then ' is' else 's are' end || ' below the minimum (' || v_dates || ')',
        '/manager/schedule', 'gap:' || p_request);
    end if;
  else
    perform app.notify(v_r.employee_id, 'leave_rejected', v_type.name || ' not approved', v_dates || ' · ' || v_note,
      '/leave', 'leave:' || p_request || ':rejected');
  end if;

  perform app.audit('leave.' || p_decision, 'leave_request', p_request, v_r.department_id,
    jsonb_build_object('removed_from_shifts', v_removed, 'understaffed', jsonb_array_length(v_short)));
  return jsonb_build_object('id', p_request, 'status', p_decision, 'removed_from_shifts', v_removed, 'understaffed', v_short);
end $$;

-- The person cancels their own pending request; a supervisor (or the deciding admin) can cancel
-- an approved one. Cancelling approved leave does not put anyone back on shifts automatically.
create function app.cancel_leave(p_request uuid, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_r public.leave_requests;
  v_type public.leave_types;
  v_note text := trim(coalesce(p_note, ''));
begin
  select * into v_r from public.leave_requests where id = p_request for update;
  if not found or not (v_r.employee_id = auth.uid() or app.is_manager_of(v_r.department_id) or app.can_decide_leave(p_request)) then
    perform app.fail('not_found', 'Leave request not found');
  end if;
  select * into v_type from public.leave_types where id = v_r.leave_type_id;
  if v_r.employee_id = auth.uid() then
    if v_r.status <> 'pending' then perform app.fail('invalid_state', 'Only a pending request can be cancelled here; ask your supervisor to change approved leave'); end if;
    if not app.setting_bool('leave_cancel_pending_allowed', true) then perform app.fail('forbidden', 'Ask your supervisor to cancel this request'); end if;
  else
    if v_r.status not in ('pending', 'approved') then perform app.fail('invalid_state', 'This request was already ' || v_r.status); end if;
    if length(v_note) < 3 then perform app.fail('validation', 'Say briefly why the leave is cancelled'); end if;
    perform app.notify(v_r.employee_id, 'leave_changed', v_type.name || ' cancelled by your supervisor',
      to_char(v_r.start_date, 'Dy DD Mon') || ' · ' || v_note, '/leave', 'leave:' || p_request || ':cancelled');
  end if;
  update public.leave_requests set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
    decision_note = case when v_r.employee_id = auth.uid() then decision_note else v_note end, updated_at = now()
  where id = p_request;
  perform app.audit('leave.cancelled', 'leave_request', p_request, v_r.department_id, jsonb_build_object('was', v_r.status));
end $$;

-- Leave on the board: dates, status and type, never the reason. For the department's supervisors
-- and (read-only) administrators.
create function app.leave_calendar(p_department uuid, p_from date, p_to date)
returns table (id uuid, employee_id uuid, leave_type text, start_date date, end_date date, status text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not (app.is_manager_of(p_department) or app.is_admin()) then perform app.fail('forbidden', 'Not allowed'); end if;
  return query
    select r.id, r.employee_id, t.name, r.start_date, r.end_date, r.status
    from public.leave_requests r join public.leave_types t on t.id = r.leave_type_id
    where r.department_id = p_department and r.status in ('pending', 'approved')
      and daterange(r.start_date, r.end_date, '[]') && daterange(p_from, p_to, '[]')
    order by r.start_date;
end $$;

-- Requests an administrator may decide: a supervisor's own leave when no other supervisor of
-- the department is active. Includes the reason, since the administrator is the approver here.
create function app.admin_leave_queue()
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

-- ---------------------------------------------------------------------------
-- Rest days and days off (set by the supervisor)
-- ---------------------------------------------------------------------------
create function app.set_day_mark(p_employee uuid, p_day date, p_kind text, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
begin
  select department_id into v_dept from public.profiles where id = p_employee and role = 'employee' and is_active;
  if v_dept is null then perform app.fail('validation', 'Choose an active worker'); end if;
  perform app.require_manager_of(v_dept);
  if p_kind is null then
    delete from public.schedule_day_marks where employee_id = p_employee and day = p_day;
  elsif p_kind in ('rest_day', 'day_off') then
    insert into public.schedule_day_marks (employee_id, day, department_id, kind, note, created_by)
    values (p_employee, p_day, v_dept, p_kind, left(trim(coalesce(p_note, '')), 200), auth.uid())
    on conflict (employee_id, day) do update set kind = excluded.kind, note = excluded.note, created_by = excluded.created_by, created_at = now();
  else
    perform app.fail('validation', 'Unknown day type');
  end if;
  perform app.audit('schedule.day_marked', 'profile', p_employee, v_dept, jsonb_build_object('day', p_day, 'kind', p_kind));
end $$;

-- "Rest days every Sunday from … to …" in one step. Days that already have another mark are left alone.
create function app.set_rest_days(p_employee uuid, p_from date, p_to date, p_weekdays smallint[]) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
  v_count int;
begin
  select department_id into v_dept from public.profiles where id = p_employee and role = 'employee' and is_active;
  if v_dept is null then perform app.fail('validation', 'Choose an active worker'); end if;
  perform app.require_manager_of(v_dept);
  if p_to < p_from or p_to - p_from > 120 then perform app.fail('validation', 'Choose a range of up to 120 days'); end if;
  insert into public.schedule_day_marks (employee_id, day, department_id, kind, created_by)
  select p_employee, d::date, v_dept, 'rest_day', auth.uid()
  from generate_series(p_from, p_to, interval '1 day') d
  where extract(isodow from d)::smallint = any(p_weekdays)
  on conflict (employee_id, day) do nothing;
  get diagnostics v_count = row_count;
  perform app.audit('schedule.rest_days_set', 'profile', p_employee, v_dept,
    jsonb_build_object('from', p_from, 'to', p_to, 'weekdays', p_weekdays, 'added', v_count));
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Staffing minimums and job titles
-- ---------------------------------------------------------------------------
create function app.set_pattern_min_staff(p_template uuid, p_min int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
begin
  select department_id into v_dept from public.shift_templates where id = p_template;
  if v_dept is null then perform app.fail('not_found', 'Shift pattern not found'); end if;
  perform app.require_manager_of(v_dept);
  if p_min is null or p_min < 0 or p_min > 50 then perform app.fail('validation', 'Minimum staff must be between 0 and 50'); end if;
  update public.shift_templates set min_staff = p_min where id = p_template;
  -- Upcoming shifts of the pattern follow the new minimum.
  update public.shifts set min_staff = p_min where template_id = p_template and starts_at > now();
end $$;

create function app.set_shift_min_staff(p_shift uuid, p_min int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
begin
  select department_id into v_dept from public.shifts where id = p_shift;
  if v_dept is null then perform app.fail('not_found', 'Shift not found'); end if;
  perform app.require_manager_of(v_dept);
  if p_min is null or p_min < 0 or p_min > 50 then perform app.fail('validation', 'Minimum staff must be between 0 and 50'); end if;
  update public.shifts set min_staff = p_min where id = p_shift;
end $$;

create function app.admin_set_job_title(p_profile uuid, p_title text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_admin();
  update public.profiles set job_title = nullif(trim(coalesce(p_title, '')), '') where id = p_profile;
  if not found then perform app.fail('not_found', 'User not found'); end if;
end $$;

create function app.admin_upsert_leave_type(p_id uuid, p_name text, p_description text, p_requires_reason boolean, p_max_days int, p_is_active boolean, p_sort int) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  perform app.require_admin();
  if p_id is null then
    insert into public.leave_types (name, description, requires_reason, max_days, is_active, sort_order)
    values (trim(p_name), trim(coalesce(p_description, '')), coalesce(p_requires_reason, false), p_max_days, coalesce(p_is_active, true), coalesce(p_sort, 0))
    returning id into v_id;
  else
    update public.leave_types set name = trim(p_name), description = trim(coalesce(p_description, '')), requires_reason = coalesce(p_requires_reason, false),
      max_days = p_max_days, is_active = coalesce(p_is_active, true), sort_order = coalesce(p_sort, sort_order)
    where id = p_id returning id into v_id;
    if v_id is null then perform app.fail('not_found', 'Leave type not found'); end if;
  end if;
  perform app.audit('leave_type.saved', 'leave_type', v_id, null, jsonb_build_object('name', trim(p_name)));
  return v_id;
exception
  when unique_violation then perform app.fail('conflict', 'A leave type with that name already exists');
  when check_violation then perform app.fail('validation', 'Check the name (2–60 characters) and the day limit');
end $$;

-- New shifts copy the pattern's minimum (same body as before, plus min_staff).
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
       window_opens_at, window_closes_at, allow_early_draft, supervisor_id, min_staff)
    values (v_t.id, v_t.department_id, v_t.team_id, v_t.name, v_day, v_tz, v_start, v_end,
            greatest(v_start, v_end - make_interval(mins => v_t.window_open_minutes)),
            v_end + make_interval(mins => v_t.grace_minutes), v_t.allow_early_draft, p_supervisor, v_t.min_staff)
    on conflict (template_id, shift_date) where template_id is not null do nothing;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;
  perform app.audit('shifts.generated', 'shift_template', p_template, v_t.department_id,
    jsonb_build_object('from', p_from, 'to', p_to, 'created', v_count, 'weekdays', v_t.weekdays));
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Assigning: refuses approved leave, warns about rest days and pending leave
-- (same body as before otherwise).
-- ---------------------------------------------------------------------------
create or replace function app.assign_to_shift(p_shift uuid, p_employee uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
  v_id uuid;
  v_delivered int;
  v_name text;
  v_mark text;
  v_pending boolean;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found then perform app.fail('not_found', 'Shift not found'); end if;
  perform app.require_manager_of(v_shift.department_id);
  if v_shift.status <> 'scheduled' then perform app.fail('invalid_state', 'This shift was cancelled'); end if;
  select full_name into v_name from public.profiles where id = p_employee and role = 'employee' and is_active
    and department_id = v_shift.department_id;
  if v_name is null then
    perform app.fail('validation', 'Only active workers of this department can be assigned');
  end if;
  if exists (
    select 1 from public.shift_assignments a
    join public.shifts s on s.id = a.shift_id
    where a.employee_id = p_employee and a.removed_at is null and s.status = 'scheduled'
      and s.id <> p_shift
      and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(v_shift.starts_at, v_shift.ends_at, '[)')
  ) then
    perform app.fail('conflict', v_name || ' is already assigned to an overlapping shift');
  end if;
  if exists (select 1 from public.leave_requests where employee_id = p_employee and status = 'approved'
             and v_shift.shift_date between start_date and end_date) then
    perform app.fail('conflict', v_name || ' is on approved leave that day');
  end if;
  insert into public.shift_assignments (shift_id, employee_id, assigned_by) values (p_shift, p_employee, auth.uid())
  on conflict (shift_id, employee_id) where removed_at is null do nothing
  returning id into v_id;
  if v_id is null then perform app.fail('conflict', v_name || ' is already on this shift'); end if;
  perform app.audit('shift.assigned', 'shift', p_shift, v_shift.department_id, jsonb_build_object('employee', p_employee));
  perform app.notify(p_employee, 'shift_assigned', 'New shift: ' || v_shift.label,
    to_char(v_shift.starts_at at time zone v_shift.timezone, 'Dy DD Mon, HH12:MI AM') || ' – ' ||
    to_char(v_shift.ends_at at time zone v_shift.timezone, 'HH12:MI AM'), '/schedule', 'assigned:' || v_id, null, false);
  v_delivered := app.deliver_pending_for_shift(p_shift);
  select kind into v_mark from public.schedule_day_marks where employee_id = p_employee and day = v_shift.shift_date;
  v_pending := exists (select 1 from public.leave_requests where employee_id = p_employee and status = 'pending'
                       and v_shift.shift_date between start_date and end_date);
  return jsonb_build_object('assignment_id', v_id, 'handovers_delivered', v_delivered,
    'warnings', to_jsonb(array_remove(array[
      case when v_mark = 'rest_day' then v_name || ' has a rest day then' when v_mark = 'day_off' then v_name || ' has a day off then' end,
      case when v_pending then v_name || ' has pending leave that day' end], null)));
end $$;

-- Removing someone from a shift now tells them (same body as before otherwise).
create or replace function app.unassign_from_shift(p_shift uuid, p_employee uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found then perform app.fail('not_found', 'Shift not found'); end if;
  perform app.require_manager_of(v_shift.department_id);
  update public.shift_assignments set removed_at = now(), removed_by = auth.uid()
  where shift_id = p_shift and employee_id = p_employee and removed_at is null;
  if not found then perform app.fail('not_found', 'Assignment not found'); end if;

  update public.handover_deliveries set revoked_at = now()
  where shift_id = p_shift and recipient_id = p_employee and revoked_at is null;

  update public.shift_reports r set status = 'approved'
  where r.status = 'delivered'
    and exists (select 1 from public.handover_deliveries d where d.report_id = r.id and d.shift_id = p_shift)
    and not exists (select 1 from public.handover_deliveries d where d.report_id = r.id and d.revoked_at is null);

  if v_shift.ends_at > now() then
    perform app.notify(p_employee, 'shift_removed', 'Removed from shift: ' || v_shift.label,
      to_char(v_shift.starts_at at time zone v_shift.timezone, 'Dy DD Mon, HH12:MI AM'), '/schedule',
      'removed:' || p_shift || ':' || p_employee || ':' || extract(epoch from now())::bigint, null, false);
  end if;
  perform app.audit('shift.unassigned', 'shift', p_shift, v_shift.department_id, jsonb_build_object('employee', p_employee));
end $$;

-- Tells everyone on an upcoming shift that it was cancelled or moved.
create function app.notify_shift_crew(p_shift uuid, p_kind text, p_title text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
  v_emp uuid;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found or v_shift.ends_at <= now() then return; end if;
  for v_emp in select employee_id from public.shift_assignments where shift_id = p_shift and removed_at is null loop
    perform app.notify(v_emp, p_kind, p_title || ': ' || v_shift.label,
      to_char(v_shift.starts_at at time zone v_shift.timezone, 'Dy DD Mon, HH12:MI AM') || ' – ' ||
      to_char(v_shift.ends_at at time zone v_shift.timezone, 'HH12:MI AM'), '/schedule',
      p_kind || ':' || p_shift || ':' || extract(epoch from now())::bigint, null, false);
  end loop;
end $$;
revoke all on function app.notify_shift_crew(uuid, text, text) from public;

-- Cancelling or restoring a shift tells its crew (same body as before otherwise).
create or replace function app.update_shift(p_shift uuid, p_supervisor uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found then perform app.fail('not_found', 'Shift not found'); end if;
  perform app.require_manager_of(v_shift.department_id);
  perform app.check_supervisor(v_shift.department_id, p_supervisor);
  update public.shifts set supervisor_id = p_supervisor, status = coalesce(p_status, status) where id = p_shift;
  if p_status = 'cancelled' and v_shift.status = 'scheduled' then
    perform app.notify_shift_crew(p_shift, 'shift_cancelled', 'Shift cancelled');
  elsif p_status = 'scheduled' and v_shift.status = 'cancelled' then
    perform app.notify_shift_crew(p_shift, 'shift_changed', 'Shift back on the schedule');
  end if;
  perform app.audit('shift.updated', 'shift', p_shift, v_shift.department_id, jsonb_build_object('status', p_status));
end $$;

-- Removing a pattern cancels its shifts; their crews are told (same body as before otherwise).
create or replace function app.retire_inactive_pattern_shifts() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid := app.my_department();
  v_count int := 0;
  v_shift uuid;
begin
  perform app.require_manager_of(v_dept);
  for v_shift in
    select s.id from public.shifts s join public.shift_templates t on t.id = s.template_id
    where t.department_id = v_dept and not t.is_active and s.status = 'scheduled'
      and not exists (select 1 from public.shift_reports r where r.shift_id = s.id and r.status <> 'draft')
      and (s.ends_at > now()
           or not exists (select 1 from public.shift_assignments a where a.shift_id = s.id and a.removed_at is null))
  loop
    perform app.notify_shift_crew(v_shift, 'shift_cancelled', 'Shift cancelled');
    update public.shifts set status = 'cancelled' where id = v_shift;
    v_count := v_count + 1;
  end loop;
  if v_count > 0 then
    perform app.audit('shifts.retired', 'department', v_dept, v_dept, jsonb_build_object('cancelled', v_count));
  end if;
  return v_count;
end $$;

-- New times for a pattern tell the crews of the moved shifts (same body as before otherwise).
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

-- ---------------------------------------------------------------------------
-- Reminders and staffing alerts (run with the scheduled checks)
-- ---------------------------------------------------------------------------
create function internal.schedule_tick() returns jsonb
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

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  app.department_today(uuid), app.can_decide_leave(uuid), app.shift_coverage(uuid),
  app.request_leave(uuid, date, date, text), app.leave_impact(uuid), app.decide_leave(uuid, text, text),
  app.cancel_leave(uuid, text), app.leave_calendar(uuid, date, date), app.admin_leave_queue(),
  app.set_day_mark(uuid, date, text, text), app.set_rest_days(uuid, date, date, smallint[]),
  app.set_pattern_min_staff(uuid, int), app.set_shift_min_staff(uuid, int),
  app.admin_set_job_title(uuid, text), app.admin_upsert_leave_type(uuid, text, text, boolean, int, boolean, int),
  internal.schedule_tick()
from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app.request_leave(uuid, date, date, text), app.decide_leave(uuid, text, text), app.cancel_leave(uuid, text), app.set_day_mark(uuid, date, text, text), app.set_rest_days(uuid, date, date, smallint[]), app.admin_upsert_leave_type(uuid, text, text, boolean, int, boolean, int), app.admin_set_job_title(uuid, text) from anon';
    execute 'revoke all on function internal.schedule_tick() from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function internal.schedule_tick() to service_role';
  end if;
end $$;
grant execute on function
  app.department_today(uuid), app.can_decide_leave(uuid), app.shift_coverage(uuid),
  app.request_leave(uuid, date, date, text), app.leave_impact(uuid), app.decide_leave(uuid, text, text),
  app.cancel_leave(uuid, text), app.leave_calendar(uuid, date, date), app.admin_leave_queue(),
  app.set_day_mark(uuid, date, text, text), app.set_rest_days(uuid, date, date, smallint[]),
  app.set_pattern_min_staff(uuid, int), app.set_shift_min_staff(uuid, int),
  app.admin_set_job_title(uuid, text), app.admin_upsert_leave_type(uuid, text, text, boolean, int, boolean, int)
to authenticated;
