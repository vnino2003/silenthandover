-- Leave: show overnight shifts that run into a leave day, and route requests nobody can approve.
--
-- 1. Leave impact used each shift's start date only, so a Night shift that starts the evening before
--    a leave day and runs into it was not shown. The preview now lists every shift whose time
--    overlaps the leave days (in the shift's own time zone), marked 'full' or 'partial'. Approval
--    still removes only the shifts on the leave days ('full'): whether an overnight shift belongs to
--    the day it starts or ends is a hospital policy decision, so it is made visible, not assumed.
-- 2. When nobody else in the department can decide a request, the old notice sent IT to /admin/leave,
--    a page that no longer exists (the administrator has no leave access). IT is now asked to add an
--    approver on User accounts, without the leave details, and the requester is told.

create or replace function app.shift_overlaps_days(p_starts timestamptz, p_ends timestamptz, p_tz text, p_first date, p_last date)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select tstzrange(p_starts, p_ends, '[)')
      && tstzrange((p_first::timestamp at time zone p_tz), ((p_last + 1)::timestamp at time zone p_tz), '[)')
$$;

create or replace function app.request_leave(p_type uuid, p_start date, p_end date, p_reason text) returns uuid
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
    -- Nobody in the department can decide it (the requester is its only department head, or it has
    -- none). IT cannot decide leave; it can add an approver. No leave type, dates or reason are sent.
    perform app.notify_admins('leave_no_approver', 'Leave request needs an approver',
      v_me.full_name || ' requested leave, but no other department head in the department can approve it. Add an approver on User accounts.',
      '/admin/users', 'leave:' || v_id || ':no-approver');
    perform app.notify(auth.uid(), 'leave_no_approver', 'Your leave request is waiting for an approver',
      'No other department head in your department can approve it yet. The system administrator has been asked to add one.',
      '/leave', 'leave:' || v_id || ':no-approver-self');
  end if;
  perform app.audit('leave.requested', 'leave_request', v_id, v_me.department_id,
    jsonb_build_object('type', v_type.name, 'start', p_start, 'end', p_end));
  return v_id;
end $$;

create or replace function app.leave_impact(p_request uuid) returns jsonb
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
        -- 'full': the shift belongs to a leave day and is removed on approval. 'partial': an overnight
        -- shift from the day before that runs into the leave; it stays until the unit's overnight
        -- rule is decided, so it is shown for the Head Nurse to handle.
        'overlap', case when s.shift_date between v_r.start_date and v_r.end_date then 'full' else 'partial' end,
        'assigned', (select count(*)::int from public.shift_assignments x where x.shift_id = s.id and x.removed_at is null),
        'assigned_after', (select count(*)::int from public.shift_assignments x where x.shift_id = s.id and x.removed_at is null and x.employee_id <> v_r.employee_id))
        order by s.starts_at)
      from public.shift_assignments a join public.shifts s on s.id = a.shift_id
      where a.employee_id = v_r.employee_id and a.removed_at is null and s.status = 'scheduled'
        and app.shift_overlaps_days(s.starts_at, s.ends_at, s.timezone, v_r.start_date, v_r.end_date)), '[]'::jsonb),
    -- Colleagues already off on those days (approved leave), so overlapping absences are visible.
    'others_on_leave', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.full_name, 'start_date', o.start_date, 'end_date', o.end_date) order by o.start_date)
      from public.leave_requests o join public.profiles p on p.id = o.employee_id
      where o.department_id = v_r.department_id and o.id <> v_r.id and o.status = 'approved'
        and daterange(o.start_date, o.end_date, '[]') && daterange(v_r.start_date, v_r.end_date, '[]')), '[]'::jsonb)
  );
end $$;

grant execute on function app.shift_overlaps_days(timestamptz, timestamptz, text, date, date) to authenticated;
