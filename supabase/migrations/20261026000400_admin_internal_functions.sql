-- Administrator functions (configuration) and internal service functions (automation callbacks).

-- ---------------------------------------------------------------------------
-- Administrator
-- ---------------------------------------------------------------------------
create function app.require_admin() returns void
language plpgsql stable as $$
begin
  if not app.is_admin() then
    perform app.fail('forbidden', 'Administrator access required');
  end if;
end $$;

create function app.valid_timezone(p_tz text) returns boolean
language plpgsql stable as $$
begin
  perform now() at time zone p_tz;
  return true;
exception when others then
  return false;
end $$;

create function app.admin_upsert_department(p_id uuid, p_code text, p_name text, p_timezone text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  perform app.require_admin();
  if not app.valid_timezone(p_timezone) then
    perform app.fail('validation', 'Unknown time zone: ' || coalesce(p_timezone, ''));
  end if;
  if p_id is null then
    insert into public.departments (code, name, timezone) values (upper(trim(p_code)), trim(p_name), p_timezone)
    returning id into v_id;
  else
    update public.departments set code = upper(trim(p_code)), name = trim(p_name), timezone = p_timezone
    where id = p_id returning id into v_id;
    if v_id is null then perform app.fail('not_found', 'Department not found'); end if;
  end if;
  perform app.audit(case when p_id is null then 'department.created' else 'department.updated' end, 'department', v_id, v_id);
  return v_id;
exception when unique_violation then
  perform app.fail('conflict', 'A department with that code or name already exists');
end $$;

create function app.admin_upsert_team(p_id uuid, p_department uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  perform app.require_admin();
  if p_id is null then
    insert into public.teams (department_id, name) values (p_department, trim(p_name)) returning id into v_id;
  else
    update public.teams set name = trim(p_name) where id = p_id returning id into v_id;
    if v_id is null then perform app.fail('not_found', 'Team not found'); end if;
  end if;
  perform app.audit('team.saved', 'team', v_id, p_department);
  return v_id;
exception when unique_violation then
  perform app.fail('conflict', 'That team already exists in this department');
end $$;

create function app.admin_upsert_template(
  p_id uuid, p_department uuid, p_team uuid, p_name text, p_start time, p_end time,
  p_window_open_minutes int, p_grace_minutes int, p_allow_early_draft boolean, p_is_active boolean
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  perform app.require_admin();
  if p_id is null then
    insert into public.shift_templates
      (department_id, team_id, name, start_time, end_time, window_open_minutes, grace_minutes, allow_early_draft, is_active)
    values (p_department, p_team, trim(p_name), p_start, p_end, p_window_open_minutes, p_grace_minutes,
            coalesce(p_allow_early_draft, true), coalesce(p_is_active, true))
    returning id into v_id;
  else
    update public.shift_templates set
      team_id = p_team, name = trim(p_name), start_time = p_start, end_time = p_end,
      window_open_minutes = p_window_open_minutes, grace_minutes = p_grace_minutes,
      allow_early_draft = coalesce(p_allow_early_draft, true), is_active = coalesce(p_is_active, true)
    where id = p_id returning id into v_id;
    if v_id is null then perform app.fail('not_found', 'Template not found'); end if;
  end if;
  perform app.audit('shift_template.saved', 'shift_template', v_id, p_department);
  return v_id;
exception
  when unique_violation then perform app.fail('conflict', 'A template with that name already exists');
  when check_violation then perform app.fail('validation', 'Check the times and window settings');
end $$;

-- Concrete shifts from a template. Local times are converted with the department's time zone,
-- so daylight-saving changes are handled by PostgreSQL. Overnight shifts end the next day.
create function app.admin_generate_shifts(p_template uuid, p_from date, p_to date, p_supervisor uuid) returns int
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
  perform app.require_admin();
  select * into v_t from public.shift_templates where id = p_template;
  if not found then perform app.fail('not_found', 'Template not found'); end if;
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

create function app.admin_create_shift(
  p_department uuid, p_team uuid, p_label text, p_starts_at timestamptz, p_ends_at timestamptz,
  p_window_open_minutes int, p_grace_minutes int, p_supervisor uuid, p_allow_early_draft boolean
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_id uuid;
begin
  perform app.require_admin();
  select timezone into v_tz from public.departments where id = p_department;
  if v_tz is null then perform app.fail('not_found', 'Department not found'); end if;
  if p_ends_at <= p_starts_at or p_ends_at - p_starts_at > interval '24 hours' then
    perform app.fail('validation', 'A shift must end after it starts and last at most 24 hours');
  end if;
  insert into public.shifts
    (department_id, team_id, label, shift_date, timezone, starts_at, ends_at, window_opens_at, window_closes_at,
     allow_early_draft, supervisor_id)
  values (p_department, p_team, trim(p_label), (p_starts_at at time zone v_tz)::date, v_tz, p_starts_at, p_ends_at,
          greatest(p_starts_at, p_ends_at - make_interval(mins => p_window_open_minutes)),
          p_ends_at + make_interval(mins => p_grace_minutes), coalesce(p_allow_early_draft, true), p_supervisor)
  returning id into v_id;
  perform app.audit('shift.created', 'shift', v_id, p_department);
  return v_id;
end $$;

create function app.admin_update_shift(p_shift uuid, p_supervisor uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
begin
  perform app.require_admin();
  update public.shifts set supervisor_id = p_supervisor, status = coalesce(p_status, status)
  where id = p_shift returning department_id into v_dept;
  if v_dept is null then perform app.fail('not_found', 'Shift not found'); end if;
  perform app.audit('shift.updated', 'shift', p_shift, v_dept, jsonb_build_object('status', p_status));
end $$;

create function app.admin_assign_employee(p_shift uuid, p_employee uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
  v_id uuid;
  v_delivered int;
begin
  perform app.require_admin();
  select * into v_shift from public.shifts where id = p_shift;
  if not found then perform app.fail('not_found', 'Shift not found'); end if;
  if not exists (select 1 from public.profiles where id = p_employee and role = 'employee' and is_active
                 and department_id = v_shift.department_id) then
    perform app.fail('validation', 'Only active employees of this department can be assigned');
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

create function app.admin_unassign_employee(p_shift uuid, p_employee uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
begin
  perform app.require_admin();
  update public.shift_assignments set removed_at = now(), removed_by = auth.uid()
  where shift_id = p_shift and employee_id = p_employee and removed_at is null;
  if not found then perform app.fail('not_found', 'Assignment not found'); end if;
  select department_id into v_dept from public.shifts where id = p_shift;
  perform app.audit('shift.unassigned', 'shift', p_shift, v_dept, jsonb_build_object('employee', p_employee));
end $$;

create function app.admin_create_profile(
  p_user uuid, p_full_name text, p_email text, p_role text, p_department uuid, p_team uuid, p_phone text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_admin();
  insert into public.profiles (id, full_name, email, role, department_id, team_id, phone)
  values (p_user, trim(p_full_name), lower(trim(p_email)), p_role, p_department, p_team, nullif(trim(coalesce(p_phone, '')), ''));
  perform app.audit('user.created', 'profile', p_user, p_department, jsonb_build_object('role', p_role));
exception
  when unique_violation then perform app.fail('conflict', 'A user with that email already exists');
  when check_violation then perform app.fail('validation', 'Check the role, department and phone number');
end $$;

create function app.admin_update_user(
  p_user uuid, p_full_name text, p_role text, p_department uuid, p_team uuid, p_phone text, p_is_active boolean
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old public.profiles;
begin
  perform app.require_admin();
  select * into v_old from public.profiles where id = p_user for update;
  if not found then perform app.fail('not_found', 'User not found'); end if;
  if p_user = auth.uid() and (p_role <> 'admin' or not p_is_active) then
    perform app.fail('validation', 'You cannot remove your own administrator access');
  end if;
  update public.profiles set
    full_name = trim(p_full_name), role = p_role, department_id = p_department, team_id = p_team,
    phone = nullif(trim(coalesce(p_phone, '')), ''), is_active = p_is_active
  where id = p_user;
  perform app.audit('user.updated', 'profile', p_user, coalesce(p_department, v_old.department_id), jsonb_build_object(
    'role', jsonb_build_object('from', v_old.role, 'to', p_role),
    'department_changed', v_old.department_id is distinct from p_department,
    'active', jsonb_build_object('from', v_old.is_active, 'to', p_is_active)));
exception
  when check_violation then perform app.fail('validation', 'Check the role, department and phone number');
end $$;

create function app.admin_list_users() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when app.is_admin() then coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'full_name', p.full_name, 'email', p.email, 'phone', p.phone, 'role', p.role,
    'department_id', p.department_id, 'department_name', d.name, 'team_id', p.team_id, 'team_name', t.name,
    'is_active', p.is_active, 'pseudonym', p.pseudonym, 'created_at', p.created_at) order by p.full_name), '[]'::jsonb)
  else null end
  from public.profiles p
  left join public.departments d on d.id = p.department_id
  left join public.teams t on t.id = p.team_id
$$;

create function app.admin_set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_admin();
  update public.app_settings set value = p_value, updated_by = auth.uid(), updated_at = now() where key = p_key;
  if not found then perform app.fail('not_found', 'Unknown setting'); end if;
  perform app.audit('setting.updated', 'app_setting', null, null, jsonb_build_object('key', p_key, 'value', p_value));
end $$;

create function app.admin_set_template(p_key text, p_subject text, p_body text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_admin();
  update public.notification_templates set subject = p_subject, body = p_body, updated_by = auth.uid(), updated_at = now()
  where key = p_key;
  if not found then perform app.fail('not_found', 'Unknown template'); end if;
  perform app.audit('notification_template.updated', 'notification_template', null, null, jsonb_build_object('key', p_key));
end $$;

create function app.admin_retry_event(p_event uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event public.automation_events;
begin
  perform app.require_admin();
  select * into v_event from public.automation_events where id = p_event for update;
  if not found then perform app.fail('not_found', 'Event not found'); end if;
  if v_event.status not in ('failed', 'dead') then
    perform app.fail('invalid_state', 'Only failed events can be retried');
  end if;
  update public.automation_events set status = 'failed', next_attempt_at = now(),
    max_attempts = greatest(max_attempts, attempts + 1)
  where id = p_event;
  if v_event.kind = 'report_analysis' then
    update public.shift_reports set status = 'processing', analysis_state = 'queued'
    where id = v_event.report_id and status = 'pending_review' and analysis_state = 'failed'
      and current_revision = v_event.revision_no;
  end if;
  perform app.audit('automation.retry', 'automation_event', p_event, v_event.department_id);
end $$;

create function app.admin_retry_delivery(p_delivery uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_admin();
  update public.notification_deliveries set status = 'failed', next_attempt_at = now(),
    max_attempts = greatest(max_attempts, attempts + 1)
  where id = p_delivery and status = 'failed';
  if not found then perform app.fail('invalid_state', 'Only failed deliveries can be retried'); end if;
  perform app.audit('notification.retry', 'notification_delivery', p_delivery, null);
end $$;

-- Operational overview for administrators: counts only, no report content.
create function app.admin_report_overview() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when app.is_admin() then coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) else null end
  from (
    select d.id as department_id, d.name as department_name, r.status, count(r.id)::int as count
    from public.departments d
    join public.shift_reports r on r.department_id = d.id
    where r.created_at > now() - interval '14 days'
    group by d.id, d.name, r.status
    order by d.name, r.status
  ) x
$$;

-- ---------------------------------------------------------------------------
-- Internal service functions (called by the API's automation layer only)
-- ---------------------------------------------------------------------------
create function internal.claim_analysis_events(p_limit int, p_adapter text) returns setof public.automation_events
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event public.automation_events;
begin
  for v_event in
    select * from public.automation_events
    where kind = 'report_analysis' and status in ('pending', 'failed') and next_attempt_at <= now()
      and attempts < max_attempts
    order by next_attempt_at
    limit p_limit
    for update skip locked
  loop
    update public.automation_events set
      status = 'dispatched', attempts = attempts + 1, dispatched_at = now(), adapter = p_adapter, last_error = null
    where id = v_event.id
    returning * into v_event;
    update public.shift_reports set status = 'processing'
    where id = v_event.report_id and status = 'submitted' and current_revision = v_event.revision_no;
    return next v_event;
  end loop;
end $$;

create function internal.store_analysis_input(
  p_report uuid, p_revision int, p_sanitized text, p_mapping jsonb, p_counts jsonb, p_injection jsonb
) returns void
language sql security definer set search_path = public, internal, pg_temp as $$
  insert into internal.analysis_inputs (report_id, revision_no, sanitized_text, name_mapping, redaction_counts, injection_findings, expires_at)
  values (p_report, p_revision, p_sanitized, p_mapping, p_counts, p_injection,
          now() + make_interval(days => app.setting_int('pii_retention_days', 30)))
  on conflict (report_id, revision_no) do update set
    sanitized_text = excluded.sanitized_text, name_mapping = excluded.name_mapping,
    redaction_counts = excluded.redaction_counts, injection_findings = excluded.injection_findings,
    expires_at = excluded.expires_at
$$;

create function internal.record_analysis_result(p_event uuid, p_attempt int, p_run jsonb) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event public.automation_events;
  v_report public.shift_reports;
  v_simulated boolean := coalesce((p_run ->> 'is_simulated')::boolean, false);
  v_run uuid;
begin
  select * into v_event from public.automation_events where id = p_event for update;
  if not found or v_event.kind <> 'report_analysis' or v_event.status <> 'dispatched' or v_event.attempts <> p_attempt then
    return 'ignored';
  end if;
  insert into public.ai_analysis_runs
    (report_id, revision_no, automation_event_id, attempt, prompt_version, engine, model, is_simulated, status, draft, flags, latency_ms, usage)
  values (v_event.report_id, v_event.revision_no, p_event, p_attempt, p_run ->> 'prompt_version', p_run ->> 'engine',
          p_run ->> 'model', v_simulated, 'succeeded', p_run -> 'draft', coalesce(p_run -> 'flags', '[]'::jsonb),
          (p_run ->> 'latency_ms')::int, p_run -> 'usage')
  returning id into v_run;
  update public.automation_events set status = 'completed', completed_at = now() where id = p_event;

  update public.shift_reports set status = 'pending_review',
    analysis_state = case when v_simulated then 'simulated' else 'succeeded' end
  where id = v_event.report_id and status in ('submitted', 'processing') and current_revision = v_event.revision_no
  returning * into v_report;

  if v_report.id is not null then
    perform app.notify_managers(v_report.department_id, 'review_required',
      'Review required: ' || v_report.reference_code,
      case when v_simulated then 'A simulated draft (development mode, no AI called) is ready for verification.'
           else 'An AI-generated draft is ready for verification.' end,
      '/manager/reports/' || v_report.id, 'review:' || v_report.id || ':' || v_report.current_revision,
      (select supervisor_id from public.shifts where id = v_report.shift_id));
  end if;
  perform app.audit('analysis.completed', 'shift_report', v_event.report_id, v_event.department_id,
    jsonb_build_object('run', v_run, 'engine', p_run ->> 'engine', 'simulated', v_simulated, 'prompt_version', p_run ->> 'prompt_version'));
  return 'recorded';
end $$;

-- Dispatch errors, timeouts and invalid model output all come through here.
create function internal.record_analysis_failure(p_event uuid, p_attempt int, p_status text, p_error text, p_run jsonb)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event public.automation_events;
  v_report public.shift_reports;
begin
  select * into v_event from public.automation_events where id = p_event for update;
  if not found or v_event.kind <> 'report_analysis' or v_event.status <> 'dispatched' or v_event.attempts <> p_attempt then
    return 'ignored';
  end if;
  if p_run is not null then
    insert into public.ai_analysis_runs
      (report_id, revision_no, automation_event_id, attempt, prompt_version, engine, model, is_simulated, status, validation_errors, latency_ms)
    values (v_event.report_id, v_event.revision_no, p_event, p_attempt, coalesce(p_run ->> 'prompt_version', 'unknown'),
            coalesce(p_run ->> 'engine', 'unknown'), p_run ->> 'model', coalesce((p_run ->> 'is_simulated')::boolean, false),
            p_status, p_run -> 'validation_errors', (p_run ->> 'latency_ms')::int);
  end if;

  if v_event.attempts >= v_event.max_attempts then
    update public.automation_events set status = 'dead', last_error = left(p_error, 500) where id = p_event;
    -- Never strand a report: send it to a human with the original submission.
    update public.shift_reports set status = 'pending_review', analysis_state = 'failed'
    where id = v_event.report_id and status in ('submitted', 'processing') and current_revision = v_event.revision_no
    returning * into v_report;
    if v_report.id is not null then
      perform app.notify_managers(v_report.department_id, 'review_required',
        'Manual review required: ' || v_report.reference_code,
        'The AI draft could not be produced. Review the original submission directly.',
        '/manager/reports/' || v_report.id, 'review:' || v_report.id || ':' || v_report.current_revision);
    end if;
    perform app.notify_admins('automation_failure', 'AI processing failed after ' || v_event.attempts || ' attempts',
      left(p_error, 300), '/admin/integrations', 'automation_dead:' || p_event);
  else
    update public.automation_events set status = 'failed', last_error = left(p_error, 500),
      next_attempt_at = now() + make_interval(mins => (power(2, v_event.attempts))::int)
    where id = p_event;
  end if;
  perform app.audit('analysis.failed', 'automation_event', p_event, v_event.department_id,
    jsonb_build_object('status', p_status, 'attempt', p_attempt, 'final', v_event.attempts >= v_event.max_attempts));
  return 'recorded';
end $$;

create function internal.claim_deliveries(p_limit int) returns table (
  delivery_id uuid, attempt int, channel text, address text, idempotency_key text, kind text, title text, body text,
  link text, recipient_name text
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  for v_id in
    select d.id from public.notification_deliveries d
    where (d.status = 'pending' or (d.status = 'failed' and d.attempts < d.max_attempts)) and d.next_attempt_at <= now()
    order by d.created_at
    limit p_limit
    for update skip locked
  loop
    update public.notification_deliveries set status = 'queued', attempts = attempts + 1, last_attempt_at = now()
    where id = v_id;
    return query
      select d.id, d.attempts, d.channel, d.address, d.idempotency_key, n.kind, n.title, n.body, n.link, p.full_name
      from public.notification_deliveries d
      join public.notifications n on n.id = d.notification_id
      join public.profiles p on p.id = d.recipient_id
      where d.id = v_id;
  end loop;
end $$;

create function internal.complete_delivery_events() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count int;
begin
  update public.automation_events e set status = 'completed', completed_at = now(),
    last_error = (select string_agg(distinct d.last_error, '; ') from public.notification_deliveries d
                  where d.automation_event_id = e.id and d.status = 'failed')
  where e.kind = 'handover_delivery' and e.status in ('pending', 'dispatched')
    and not exists (
      select 1 from public.notification_deliveries d
      where d.automation_event_id = e.id
        and (d.status in ('pending', 'queued') or (d.status = 'failed' and d.attempts < d.max_attempts)));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create function internal.record_delivery_result(
  p_delivery uuid, p_attempt int, p_status text, p_provider text, p_message_id text, p_response jsonb, p_error text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_d public.notification_deliveries;
begin
  if p_status not in ('sent', 'failed', 'simulated', 'skipped') then
    raise exception 'invalid delivery status %', p_status;
  end if;
  select * into v_d from public.notification_deliveries where id = p_delivery for update;
  if not found or v_d.status <> 'queued' or v_d.attempts <> p_attempt then
    return 'ignored';
  end if;
  update public.notification_deliveries set
    status = p_status, provider = p_provider, provider_message_id = p_message_id, provider_response = p_response,
    last_error = case when p_status in ('failed', 'skipped') then left(p_error, 500) else null end,
    next_attempt_at = case when p_status = 'failed' then now() + make_interval(mins => (power(2, v_d.attempts))::int) else next_attempt_at end
  where id = p_delivery;
  if p_status = 'failed' and v_d.attempts >= v_d.max_attempts then
    perform app.notify_admins('delivery_failure', 'Notification delivery failed',
      'A ' || v_d.channel || ' notification could not be delivered after ' || v_d.attempts || ' attempts: ' || left(coalesce(p_error, ''), 200),
      '/admin/integrations', 'delivery_failed:' || p_delivery);
  end if;
  perform internal.complete_delivery_events();
  return 'recorded';
end $$;

create function internal.scheduled_tick() returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_timeout int := app.setting_int('ai_timeout_minutes', 10);
  v_hours int := app.setting_int('escalation_hours', 12);
  v_event public.automation_events;
  v_issue public.operational_issues;
  v_row record;
  v_timeouts int := 0;
  v_stale int := 0;
  v_escalated int := 0;
  v_missing int := 0;
  v_purged int := 0;
begin
  -- AI results that never came back.
  for v_event in
    select * from public.automation_events
    where kind = 'report_analysis' and status = 'dispatched' and dispatched_at < now() - make_interval(mins => v_timeout)
  loop
    perform internal.record_analysis_failure(v_event.id, v_event.attempts, 'failed',
      'Timed out after ' || v_timeout || ' minutes waiting for the AI result', null);
    v_timeouts := v_timeouts + 1;
  end loop;

  -- Deliveries handed to a provider that never reported back.
  update public.notification_deliveries set status = 'failed', last_error = 'No result from provider within 15 minutes',
    next_attempt_at = now()
  where status = 'queued' and last_attempt_at < now() - interval '15 minutes';
  get diagnostics v_stale = row_count;

  -- Issues with no activity for too long go back to supervisors.
  for v_issue in
    select * from public.operational_issues
    where status in ('reported', 'pending_verification', 'open', 'in_progress', 'resolution_submitted')
      and last_activity_at < now() - make_interval(hours => v_hours)
      and (escalated_at is null or escalated_at < last_activity_at)
  loop
    update public.operational_issues set escalated_at = now() where id = v_issue.id;
    insert into public.issue_updates (issue_id, kind, note)
    values (v_issue.id, 'escalation', 'No update for ' || v_hours || ' hours — escalated to supervisors');
    perform app.notify_managers(v_issue.department_id, 'issue_follow_up', 'Follow-up needed: ' || v_issue.code,
      v_issue.title || ' has had no update for ' || v_hours || ' hours.', '/manager/issues/' || v_issue.id,
      'escalation:' || v_issue.id || ':' || extract(epoch from v_issue.last_activity_at)::bigint);
    v_escalated := v_escalated + 1;
  end loop;

  -- Reports that were never submitted.
  if app.setting_bool('missing_report_alerts', true) then
    for v_row in
      select s.id as shift_id, s.department_id, s.label, s.supervisor_id, a.employee_id, p.full_name
      from public.shifts s
      join public.shift_assignments a on a.shift_id = s.id and a.removed_at is null
      join public.profiles p on p.id = a.employee_id
      where s.status = 'scheduled' and s.window_closes_at < now() and s.window_closes_at > now() - interval '24 hours'
        and not exists (select 1 from public.shift_reports r
                        where r.shift_id = s.id and r.employee_id = a.employee_id and r.status <> 'draft')
    loop
      if app.notify_managers(v_row.department_id, 'missing_report', 'Missing report: ' || v_row.full_name,
           'No end-of-shift report was submitted for ' || v_row.label || '.', '/manager/shifts',
           'missing:' || v_row.shift_id || ':' || v_row.employee_id, v_row.supervisor_id) > 0 then
        v_missing := v_missing + 1;
      end if;
    end loop;
  end if;

  perform internal.complete_delivery_events();

  delete from internal.analysis_inputs where expires_at < now();
  get diagnostics v_purged = row_count;

  return jsonb_build_object('ai_timeouts', v_timeouts, 'stale_deliveries', v_stale, 'escalated_issues', v_escalated,
                            'missing_report_alerts', v_missing, 'purged_analysis_inputs', v_purged);
end $$;
