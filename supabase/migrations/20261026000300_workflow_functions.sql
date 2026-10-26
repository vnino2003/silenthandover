-- Workflow functions: the only way users change data.
-- Each function is security definer, pins search_path, and checks auth.uid() and role itself.
-- Errors are raised as 'SH:<code>' with a user-safe detail; the API maps codes to HTTP statuses.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function app.fail(p_code text, p_detail text) returns void
language plpgsql as $$
begin
  raise exception 'SH:%', p_code using errcode = 'P0001', detail = p_detail;
end $$;

create function app.setting(p_key text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select value from public.app_settings where key = p_key
$$;

create function app.setting_int(p_key text, p_default int) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select (value #>> '{}')::int from public.app_settings where key = p_key), p_default)
$$;

create function app.setting_bool(p_key text, p_default boolean) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select (value #>> '{}')::boolean from public.app_settings where key = p_key), p_default)
$$;

create function app.audit(p_action text, p_entity_type text, p_entity_id uuid, p_department uuid, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, department_id, details)
  values (auth.uid(), coalesce(app.my_role(), 'system'), p_action, p_entity_type, p_entity_id, p_department, coalesce(p_details, '{}'::jsonb))
$$;

-- Creates an in-app notification (idempotent per recipient + event key) and queues email/SMS
-- delivery rows according to the recipient's preferences.
create function app.notify(
  p_recipient uuid, p_kind text, p_title text, p_body text, p_link text, p_event_key text,
  p_automation_event uuid default null, p_external boolean default true
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_profile public.profiles;
  v_id uuid;
begin
  select * into v_profile from public.profiles where id = p_recipient;
  if not found or not v_profile.is_active then
    return null;
  end if;

  insert into public.notifications (recipient_id, kind, title, body, link, event_key)
  values (p_recipient, p_kind, p_title, coalesce(p_body, ''), p_link, p_event_key)
  on conflict (recipient_id, event_key) do nothing
  returning id into v_id;

  if v_id is null or not p_external then
    return v_id;
  end if;

  if v_profile.notify_email then
    insert into public.notification_deliveries (notification_id, recipient_id, automation_event_id, channel, address, idempotency_key)
    values (v_id, p_recipient, p_automation_event, 'email', v_profile.email, v_id::text || ':email')
    on conflict (idempotency_key) do nothing;
  end if;

  if v_profile.notify_sms and v_profile.phone is not null and app.setting_bool('sms_enabled', false) then
    insert into public.notification_deliveries (notification_id, recipient_id, automation_event_id, channel, address, idempotency_key)
    values (v_id, p_recipient, p_automation_event, 'sms', v_profile.phone, v_id::text || ':sms')
    on conflict (idempotency_key) do nothing;
  end if;

  return v_id;
end $$;

create function app.notify_managers(
  p_department uuid, p_kind text, p_title text, p_body text, p_link text, p_event_key text,
  p_extra_recipient uuid default null
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count int := 0;
  v_id uuid;
begin
  for v_id in
    select id from public.profiles where role = 'manager' and department_id = p_department and is_active
    union
    select p.id from public.profiles p where p.id = p_extra_recipient and p.role = 'manager' and p.is_active
  loop
    if app.notify(v_id, p_kind, p_title, p_body, p_link, p_event_key) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

create function app.notify_admins(p_kind text, p_title text, p_body text, p_link text, p_event_key text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  for v_id in select id from public.profiles where role = 'admin' and is_active loop
    perform app.notify(v_id, p_kind, p_title, p_body, p_link, p_event_key, null, false);
  end loop;
end $$;

create function app.server_now() returns timestamptz language sql stable as $$ select now() $$;

-- ---------------------------------------------------------------------------
-- Shifts and windows
-- ---------------------------------------------------------------------------

-- Authoritative reporting-window state, computed with the database clock.
create function app.window_state(p_shift uuid, p_employee uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
  v_override timestamptz;
  v_now timestamptz := now();
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found then return 'not_found'; end if;
  if v_shift.status = 'cancelled' then return 'cancelled'; end if;
  if not exists (
    select 1 from public.shift_assignments
    where shift_id = p_shift and employee_id = p_employee and removed_at is null
  ) then
    return 'not_assigned';
  end if;
  if v_now >= v_shift.window_opens_at and v_now < v_shift.window_closes_at then
    return 'open';
  end if;
  select max(expires_at) into v_override from public.report_window_overrides
  where shift_id = p_shift and employee_id = p_employee;
  if v_override is not null and v_now < v_override then
    return 'override';
  end if;
  if v_now >= v_shift.window_closes_at then return 'closed'; end if;
  if v_now >= v_shift.starts_at and v_shift.allow_early_draft then return 'early_draft'; end if;
  return 'not_started';
end $$;

-- The shift that receives this shift's handover: the next scheduled shift of the same
-- department and team that starts within 12 hours of this one ending.
create function app.next_shift(p_shift uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select n.id
  from public.shifts s
  join public.shifts n
    on n.department_id = s.department_id
   and n.team_id is not distinct from s.team_id
   and n.starts_at > s.starts_at
   and n.starts_at <= s.ends_at + interval '12 hours'
   and n.status = 'scheduled'
   and n.id <> s.id
  where s.id = p_shift
  order by n.starts_at
  limit 1
$$;

create function app.window_error(p_state text, p_shift public.shifts) returns void
language plpgsql as $$
begin
  case p_state
    when 'not_found', 'not_assigned' then
      perform app.fail('not_assigned', 'You are not assigned to this shift');
    when 'cancelled' then
      perform app.fail('shift_cancelled', 'This shift was cancelled');
    when 'closed' then
      perform app.fail('window_closed', 'The reporting window for this shift has closed. Ask your supervisor for an override.');
    else
      perform app.fail('window_not_open', 'Final submission opens at ' ||
        to_char(p_shift.window_opens_at at time zone p_shift.timezone, 'HH12:MI AM') || ' (' || p_shift.timezone || ')');
  end case;
end $$;

-- ---------------------------------------------------------------------------
-- Employee: reports
-- ---------------------------------------------------------------------------
create function app.get_or_create_report(p_shift uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_shift public.shifts;
  v_state text;
  v_id uuid;
begin
  if app.my_role() is distinct from 'employee' then
    perform app.fail('forbidden', 'Only employees submit shift reports');
  end if;

  select id into v_id from public.shift_reports where shift_id = p_shift and employee_id = v_uid;
  if v_id is not null then
    return v_id;
  end if;

  select * into v_shift from public.shifts where id = p_shift;
  v_state := app.window_state(p_shift, v_uid);
  if v_state not in ('early_draft', 'open', 'override') then
    perform app.window_error(v_state, v_shift);
  end if;

  insert into public.shift_reports (shift_id, employee_id, department_id)
  values (p_shift, v_uid, v_shift.department_id)
  on conflict (shift_id, employee_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.shift_reports where shift_id = p_shift and employee_id = v_uid;
  else
    perform app.audit('report.draft_created', 'shift_report', v_id, v_shift.department_id);
  end if;
  return v_id;
end $$;

create function app.save_draft(p_report uuid, p_content jsonb) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_report public.shift_reports;
  v_shift public.shifts;
  v_state text;
  v_updated timestamptz;
begin
  select * into v_report from public.shift_reports where id = p_report for update;
  if not found or v_report.employee_id <> auth.uid() then
    perform app.fail('not_found', 'Report not found');
  end if;
  if jsonb_typeof(p_content) <> 'object' or pg_column_size(p_content) > 65536 then
    perform app.fail('validation', 'Report content is invalid or too large');
  end if;

  if v_report.status = 'draft' then
    select * into v_shift from public.shifts where id = v_report.shift_id;
    v_state := app.window_state(v_report.shift_id, v_report.employee_id);
    if v_state not in ('early_draft', 'open', 'override') then
      perform app.window_error(v_state, v_shift);
    end if;
  elsif v_report.status <> 'revision_requested' then
    perform app.fail('not_editable', 'This report has been submitted and can no longer be edited');
  end if;

  update public.shift_reports set draft_content = p_content where id = p_report
  returning updated_at into v_updated;
  return v_updated;
end $$;

create function app.submit_report(p_report uuid, p_content jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_report public.shift_reports;
  v_shift public.shifts;
  v_state text;
  v_late boolean := false;
  v_rev int;
  v_event uuid;
begin
  select * into v_report from public.shift_reports where id = p_report for update;
  if not found or v_report.employee_id <> auth.uid() then
    perform app.fail('not_found', 'Report not found');
  end if;
  if app.my_role() is distinct from 'employee' then
    perform app.fail('forbidden', 'Only employees submit shift reports');
  end if;
  if jsonb_typeof(p_content) <> 'object' or pg_column_size(p_content) > 65536 then
    perform app.fail('validation', 'Report content is invalid or too large');
  end if;
  select * into v_shift from public.shifts where id = v_report.shift_id;

  if v_report.status = 'draft' then
    v_state := app.window_state(v_report.shift_id, v_report.employee_id);
    if v_state not in ('open', 'override') then
      perform app.window_error(v_state, v_shift);
    end if;
    v_late := now() >= v_shift.window_closes_at;
  elsif v_report.status = 'revision_requested' then
    -- A supervisor asked for this revision, so the original window does not apply.
    if not exists (select 1 from public.shift_assignments
                   where shift_id = v_report.shift_id and employee_id = v_report.employee_id and removed_at is null) then
      perform app.fail('not_assigned', 'You are no longer assigned to this shift');
    end if;
  else
    perform app.fail('already_submitted', 'This report has already been submitted');
  end if;

  v_rev := v_report.current_revision + 1;
  insert into public.report_revisions (report_id, revision_no, content, submitted_by, is_late)
  values (p_report, v_rev, p_content, auth.uid(), v_late);

  update public.shift_reports set
    status = 'submitted',
    draft_content = p_content,
    current_revision = v_rev,
    first_submitted_at = coalesce(first_submitted_at, now()),
    last_submitted_at = now(),
    is_late = is_late or v_late,
    analysis_state = 'queued'
  where id = p_report;

  insert into public.automation_events (kind, idempotency_key, department_id, report_id, revision_no, max_attempts)
  values ('report_analysis', 'analysis:' || p_report || ':r' || v_rev, v_report.department_id, p_report, v_rev,
          app.setting_int('ai_max_attempts', 3))
  returning id into v_event;

  perform app.audit('report.submitted', 'shift_report', p_report, v_report.department_id,
    jsonb_build_object('revision', v_rev, 'is_late', v_late, 'automation_event', v_event));
  perform app.notify(auth.uid(), 'report_submitted', 'Report ' || v_report.reference_code || ' submitted',
    'Your report was received and is queued for processing. A supervisor will review it before it is handed over.',
    '/reports/' || p_report, 'submitted:' || p_report || ':' || v_rev);

  return jsonb_build_object('report_id', p_report, 'revision_no', v_rev, 'event_id', v_event, 'is_late', v_late);
end $$;

-- ---------------------------------------------------------------------------
-- Delivery to the incoming shift
-- ---------------------------------------------------------------------------
create function app.deliver_approval(p_approval uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_approval public.handover_approvals;
  v_report public.shift_reports;
  v_next uuid;
  v_next_shift public.shifts;
  v_event uuid;
  v_emp uuid;
  v_delivery uuid;
  v_count int := 0;
begin
  select * into v_approval from public.handover_approvals where id = p_approval and decision = 'approved';
  if not found then return 0; end if;
  select * into v_report from public.shift_reports where id = v_approval.report_id;
  v_next := app.next_shift(v_report.shift_id);
  if v_next is null then return 0; end if;
  select * into v_next_shift from public.shifts where id = v_next;
  select id into v_event from public.automation_events where approval_id = p_approval and kind = 'handover_delivery';

  for v_emp in
    select employee_id from public.shift_assignments
    where shift_id = v_next and removed_at is null and employee_id <> v_report.employee_id
  loop
    insert into public.handover_deliveries (approval_id, report_id, recipient_id, shift_id)
    values (p_approval, v_report.id, v_emp, v_next)
    on conflict (approval_id, recipient_id) do nothing
    returning id into v_delivery;
    if v_delivery is not null then
      v_count := v_count + 1;
      perform app.notify(v_emp, 'handover_delivered', 'Incoming handover awaiting acknowledgment',
        'An approved handover (' || v_report.reference_code || ') is ready for your ' || v_next_shift.label || ' shift.',
        '/handover', 'handover:' || v_delivery, v_event);
    end if;
  end loop;

  if exists (select 1 from public.handover_deliveries where approval_id = p_approval) then
    update public.shift_reports set status = 'delivered' where id = v_report.id and status = 'approved';
  end if;
  if v_count > 0 then
    perform app.audit('handover.delivered', 'handover_approval', p_approval, v_report.department_id,
      jsonb_build_object('incoming_shift', v_next, 'recipients', v_count));
  end if;
  return v_count;
end $$;

-- Called when someone is assigned to a shift: deliver handovers that were approved before anyone was assigned.
create function app.deliver_pending_for_shift(p_shift uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
  v_row record;
  v_total int := 0;
begin
  select * into v_shift from public.shifts where id = p_shift;
  for v_row in
    select a.id as approval_id, r.shift_id as outgoing_shift_id
    from public.handover_approvals a
    join public.shift_reports r on r.id = a.report_id
    join public.shifts s on s.id = r.shift_id
    where a.decision = 'approved' and r.department_id = v_shift.department_id
      and r.status in ('approved', 'delivered')
      and s.starts_at < v_shift.starts_at and s.ends_at > v_shift.starts_at - interval '12 hours'
  loop
    if app.next_shift(v_row.outgoing_shift_id) = p_shift then
      v_total := v_total + app.deliver_approval(v_row.approval_id);
    end if;
  end loop;
  return v_total;
end $$;

-- ---------------------------------------------------------------------------
-- Manager: review decision (the human approval gate)
-- ---------------------------------------------------------------------------
create function app.decide_report(
  p_report uuid, p_decision text, p_content jsonb, p_flag_resolutions jsonb, p_note text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_report public.shift_reports;
  v_revision public.report_revisions;
  v_run public.ai_analysis_runs;
  v_issue public.operational_issues;
  v_flag_count int := 0;
  v_resolved int := 0;
  v_item jsonb;
  v_upd jsonb;
  v_items jsonb := '[]'::jsonb;
  v_content jsonb;
  v_approval uuid;
  v_event uuid;
  v_recipients int := 0;
  v_new_status text;
begin
  select * into v_report from public.shift_reports where id = p_report for update;
  if not found or not app.is_manager_of(v_report.department_id) then
    perform app.fail('forbidden', 'You can only review reports from your own department');
  end if;
  if v_report.employee_id = auth.uid() then
    perform app.fail('forbidden', 'You cannot review your own report');
  end if;
  if v_report.status <> 'pending_review' then
    perform app.fail('invalid_state', 'This report is not awaiting review');
  end if;

  select * into v_revision from public.report_revisions where report_id = p_report and revision_no = v_report.current_revision;
  select * into v_run from public.ai_analysis_runs
  where report_id = p_report and revision_no = v_report.current_revision and status = 'succeeded'
  order by created_at desc limit 1;

  if p_decision = 'approved' then
    if p_content is null or jsonb_typeof(p_content) <> 'object' then
      perform app.fail('validation', 'Approved handover content is required');
    end if;

    -- Every verification flag on the draft needs an explicit human decision.
    if v_run.id is not null then
      v_flag_count := jsonb_array_length(v_run.flags);
      select count(distinct (x ->> 'flag_index')::int) into v_resolved
      from jsonb_array_elements(coalesce(p_flag_resolutions, '[]'::jsonb)) x
      where (x ->> 'flag_index')::int between 0 and v_flag_count - 1;
      if v_resolved < v_flag_count then
        perform app.fail('flags_unresolved',
          format('%s of %s verification flags still need a decision', v_flag_count - v_resolved, v_flag_count));
      end if;
    end if;

    -- Issues: the manager decides, item by item, whether to link to an existing issue or open a new one.
    for v_item in select * from jsonb_array_elements(coalesce(p_content -> 'unresolved_issues', '[]'::jsonb)) loop
      if nullif(v_item ->> 'link_issue_id', '') is not null then
        select * into v_issue from public.operational_issues
        where id = (v_item ->> 'link_issue_id')::uuid and department_id = v_report.department_id
        for update;
        if not found then
          perform app.fail('validation', 'A linked issue was not found in this department');
        end if;
        if v_issue.status in ('resolved', 'closed') then
          perform app.fail('validation', v_issue.code || ' is ' || v_issue.status || '. Reopen it before linking new reports to it.');
        end if;
        insert into public.issue_updates (issue_id, author_id, report_id, kind, note)
        values (v_issue.id, auth.uid(), p_report, 'report_update',
                left('From approved handover ' || v_report.reference_code || ': ' || (v_item ->> 'title') ||
                     coalesce(nullif(' — ' || (v_item ->> 'description'), ' — '), ''), 2000));
        update public.operational_issues set
          last_activity_at = now(),
          is_safety = is_safety or coalesce((v_item ->> 'is_safety_concern')::boolean, false)
        where id = v_issue.id;
      else
        insert into public.operational_issues
          (department_id, title, description, severity, is_safety, status, origin_report_id, created_by)
        values (v_report.department_id, v_item ->> 'title', coalesce(v_item ->> 'description', ''), v_item ->> 'severity',
                coalesce((v_item ->> 'is_safety_concern')::boolean, false),
                coalesce(v_item ->> 'initial_status', 'open'), p_report, v_report.employee_id)
        returning * into v_issue;
        insert into public.issue_updates (issue_id, author_id, report_id, kind, to_status, note)
        values (v_issue.id, auth.uid(), p_report, 'created', v_issue.status,
                'Created from approved handover ' || v_report.reference_code);
      end if;
      v_items := v_items || jsonb_build_array(v_item || jsonb_build_object('issue_id', v_issue.id, 'issue_code', v_issue.code));
    end loop;
    v_content := jsonb_set(p_content, '{unresolved_issues}', v_items);

    -- Updates the employee recorded against existing issues. A claim that something was
    -- addressed moves it to resolution_submitted — never to resolved.
    for v_upd in select * from jsonb_array_elements(coalesce(v_revision.content -> 'issue_updates', '[]'::jsonb)) loop
      select * into v_issue from public.operational_issues
      where id = (v_upd ->> 'issue_id')::uuid and department_id = v_report.department_id
      for update;
      continue when not found or v_issue.status in ('resolved', 'closed');
      insert into public.issue_updates (issue_id, author_id, report_id, kind, note)
      values (v_issue.id, v_report.employee_id, p_report, 'report_update',
              left('Outgoing shift update (' || replace(v_upd ->> 'claimed_status', '_', ' ') || '): ' || (v_upd ->> 'note'), 2000));
      if v_upd ->> 'claimed_status' = 'addressed' and v_issue.status in ('open', 'in_progress') then
        update public.operational_issues set status = 'resolution_submitted', last_activity_at = now() where id = v_issue.id;
        insert into public.issue_updates (issue_id, author_id, report_id, kind, from_status, to_status, note)
        values (v_issue.id, v_report.employee_id, p_report, 'status_change', v_issue.status, 'resolution_submitted',
                'Reported as addressed in ' || v_report.reference_code || '. Awaiting verification by an authorized person.');
      elsif v_upd ->> 'claimed_status' = 'in_progress' and v_issue.status = 'open' then
        update public.operational_issues set status = 'in_progress', last_activity_at = now() where id = v_issue.id;
        insert into public.issue_updates (issue_id, author_id, report_id, kind, from_status, to_status, note)
        values (v_issue.id, v_report.employee_id, p_report, 'status_change', 'open', 'in_progress',
                'Reported in progress in ' || v_report.reference_code);
      else
        update public.operational_issues set last_activity_at = now() where id = v_issue.id;
      end if;
    end loop;

    insert into public.handover_approvals
      (report_id, report_reference, author_id, outgoing_shift_id, revision_no, analysis_run_id, decision, approved_content, flag_resolutions, note, reviewer_id)
    values (p_report, v_report.reference_code, v_report.employee_id, v_report.shift_id, v_report.current_revision, v_run.id, 'approved', v_content,
            coalesce(p_flag_resolutions, '[]'::jsonb), coalesce(p_note, ''), auth.uid())
    returning id into v_approval;

    insert into public.automation_events (kind, idempotency_key, department_id, report_id, revision_no, approval_id)
    values ('handover_delivery', 'delivery:' || v_approval, v_report.department_id, p_report, v_report.current_revision, v_approval)
    returning id into v_event;

    update public.shift_reports set status = 'approved' where id = p_report;
    perform app.notify(v_report.employee_id, 'report_approved', 'Report ' || v_report.reference_code || ' approved',
      'Your shift report was verified and approved by your supervisor.', '/reports/' || p_report,
      'decision:' || v_approval, v_event);

    v_recipients := app.deliver_approval(v_approval);
    perform app.audit('report.approved', 'shift_report', p_report, v_report.department_id,
      jsonb_build_object('approval', v_approval, 'revision', v_report.current_revision, 'analysis_run', v_run.id,
                         'flags', v_flag_count, 'recipients', v_recipients, 'issues', jsonb_array_length(v_items)));

  elsif p_decision in ('revision_requested', 'rejected') then
    if length(trim(coalesce(p_note, ''))) < 5 then
      perform app.fail('validation', 'Add a note for the employee');
    end if;
    insert into public.handover_approvals
      (report_id, report_reference, author_id, outgoing_shift_id, revision_no, analysis_run_id, decision, note, reviewer_id)
    values (p_report, v_report.reference_code, v_report.employee_id, v_report.shift_id, v_report.current_revision, v_run.id, p_decision, p_note, auth.uid())
    returning id into v_approval;

    update public.shift_reports set status = p_decision where id = p_report;
    if p_decision = 'revision_requested' then
      perform app.notify(v_report.employee_id, 'revision_requested', 'Revision requested for ' || v_report.reference_code,
        p_note, '/reports/' || p_report, 'decision:' || v_approval);
    else
      perform app.notify(v_report.employee_id, 'report_rejected', 'Report ' || v_report.reference_code || ' was rejected',
        p_note, '/reports/' || p_report, 'decision:' || v_approval);
    end if;
    perform app.audit('report.' || p_decision, 'shift_report', p_report, v_report.department_id,
      jsonb_build_object('approval', v_approval, 'revision', v_report.current_revision));
  else
    perform app.fail('validation', 'Unknown decision');
  end if;

  select status into v_new_status from public.shift_reports where id = p_report;
  return jsonb_build_object('approval_id', v_approval, 'status', v_new_status, 'recipients', v_recipients);
end $$;

create function app.request_reanalysis(p_report uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_report public.shift_reports;
  v_event uuid;
begin
  select * into v_report from public.shift_reports where id = p_report for update;
  if not found or not app.is_manager_of(v_report.department_id) then
    perform app.fail('forbidden', 'You can only manage reports from your own department');
  end if;
  if v_report.status <> 'pending_review' then
    perform app.fail('invalid_state', 'Only reports awaiting review can be re-analyzed');
  end if;
  insert into public.automation_events (kind, idempotency_key, department_id, report_id, revision_no, max_attempts)
  values ('report_analysis', 'analysis:' || p_report || ':r' || v_report.current_revision || ':manual:' || gen_random_uuid(),
          v_report.department_id, p_report, v_report.current_revision, app.setting_int('ai_max_attempts', 3))
  returning id into v_event;
  update public.shift_reports set status = 'submitted', analysis_state = 'queued' where id = p_report;
  perform app.audit('report.reanalysis_requested', 'shift_report', p_report, v_report.department_id,
    jsonb_build_object('automation_event', v_event));
  return v_event;
end $$;

create function app.grant_window_override(p_shift uuid, p_employee uuid, p_minutes int, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shift public.shifts;
  v_id uuid;
begin
  select * into v_shift from public.shifts where id = p_shift;
  if not found or not app.is_manager_of(v_shift.department_id) then
    perform app.fail('forbidden', 'You can only grant overrides for your own department');
  end if;
  if p_minutes not between 5 and 1440 then
    perform app.fail('validation', 'Overrides last between 5 minutes and 24 hours');
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    perform app.fail('validation', 'A reason is required');
  end if;
  if not exists (select 1 from public.shift_assignments where shift_id = p_shift and employee_id = p_employee and removed_at is null) then
    perform app.fail('validation', 'That employee is not assigned to this shift');
  end if;
  insert into public.report_window_overrides (shift_id, employee_id, granted_by, reason, expires_at)
  values (p_shift, p_employee, auth.uid(), trim(p_reason), now() + make_interval(mins => p_minutes))
  returning id into v_id;
  perform app.audit('shift.window_override', 'shift', p_shift, v_shift.department_id,
    jsonb_build_object('employee', p_employee, 'minutes', p_minutes));
  perform app.notify(p_employee, 'window_override', 'Reporting window extended',
    'Your supervisor allowed you to submit your ' || v_shift.label || ' report for the next ' || p_minutes || ' minutes.',
    '/', 'override:' || v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Incoming shift
-- ---------------------------------------------------------------------------
create function app.acknowledge_handover(p_delivery uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_delivery public.handover_deliveries;
  v_report public.shift_reports;
  v_ack public.handover_acknowledgments;
  v_new boolean := false;
begin
  select * into v_delivery from public.handover_deliveries where id = p_delivery;
  if not found or v_delivery.recipient_id <> auth.uid() then
    perform app.fail('not_found', 'Handover not found');
  end if;
  insert into public.handover_acknowledgments (delivery_id, employee_id, note)
  values (p_delivery, auth.uid(), left(coalesce(trim(p_note), ''), 500))
  on conflict (delivery_id) do nothing
  returning * into v_ack;
  if v_ack.id is null then
    select * into v_ack from public.handover_acknowledgments where delivery_id = p_delivery;
  else
    v_new := true;
    select * into v_report from public.shift_reports where id = v_delivery.report_id;
    perform app.audit('handover.acknowledged', 'handover_delivery', p_delivery, v_report.department_id);
    perform app.notify(v_report.employee_id, 'handover_acknowledged', 'Your handover was acknowledged',
      v_report.reference_code || ' was acknowledged by the incoming shift.', '/reports/' || v_report.id,
      'ack:' || v_ack.id, null, false);
  end if;
  -- Acknowledging a handover never changes any issue's status.
  return jsonb_build_object('acknowledged_at', v_ack.acknowledged_at, 'new', v_new);
end $$;

-- ---------------------------------------------------------------------------
-- Issues
-- ---------------------------------------------------------------------------
create function app.issue_transition_allowed(p_from text, p_to text, p_role text) returns boolean
language sql immutable as $$
  select case
    when (p_from, p_to) in (('open', 'in_progress'), ('open', 'resolution_submitted'),
                            ('in_progress', 'open'), ('in_progress', 'resolution_submitted'))
      then p_role in ('employee', 'manager')
    when (p_from, p_to) in (('reported', 'pending_verification'), ('reported', 'open'), ('reported', 'closed'),
                            ('pending_verification', 'open'), ('pending_verification', 'closed'),
                            ('open', 'closed'),
                            ('resolution_submitted', 'resolved'), ('resolution_submitted', 'in_progress'),
                            ('resolved', 'closed'), ('resolved', 'open'), ('closed', 'open'))
      then p_role = 'manager'
    else false
  end
$$;

create function app.transition_issue(p_issue uuid, p_to text, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_issue public.operational_issues;
  v_role text := app.my_role();
  v_note text := trim(coalesce(p_note, ''));
  v_assignee uuid;
begin
  select * into v_issue from public.operational_issues where id = p_issue for update;
  if not found or not app.in_department(v_issue.department_id) then
    perform app.fail('not_found', 'Issue not found');
  end if;
  if not app.issue_transition_allowed(v_issue.status, p_to, v_role) then
    if app.issue_transition_allowed(v_issue.status, p_to, 'manager') then
      perform app.fail('forbidden', 'Only a supervisor can move an issue from ' || replace(v_issue.status, '_', ' ') || ' to ' || replace(p_to, '_', ' '));
    end if;
    perform app.fail('invalid_transition', 'An issue cannot move from ' || replace(v_issue.status, '_', ' ') || ' to ' || replace(coalesce(p_to, '?'), '_', ' '));
  end if;
  if p_to in ('resolution_submitted', 'resolved', 'closed') and length(v_note) < 3 then
    perform app.fail('validation', 'Add a note describing what was done or verified');
  end if;

  update public.operational_issues set
    status = p_to,
    last_activity_at = now(),
    resolved_at = case when p_to = 'resolved' then now() when p_to = 'open' then null else resolved_at end,
    resolved_by = case when p_to = 'resolved' then auth.uid() when p_to = 'open' then null else resolved_by end
  where id = p_issue;

  insert into public.issue_updates (issue_id, author_id, kind, from_status, to_status, note)
  values (p_issue, auth.uid(), 'status_change', v_issue.status, p_to, v_note);
  perform app.audit('issue.' || p_to, 'operational_issue', p_issue, v_issue.department_id,
    jsonb_build_object('from', v_issue.status, 'to', p_to));

  select assignee_id into v_assignee from public.issue_assignments where issue_id = p_issue and ended_at is null;
  if p_to = 'resolution_submitted' then
    perform app.notify_managers(v_issue.department_id, 'verification_requested',
      'Verification requested: ' || v_issue.code, v_issue.title || ' — ' || v_note, '/manager/issues/' || p_issue,
      'verify:' || p_issue || ':' || extract(epoch from now())::bigint);
  elsif p_to = 'resolved' then
    for v_assignee in select distinct x from unnest(array[v_assignee, v_issue.created_by]) x where x is not null and x <> auth.uid() loop
      perform app.notify(v_assignee, 'issue_resolved', v_issue.code || ' verified as resolved', v_issue.title,
        '/tasks', 'resolved:' || p_issue || ':' || extract(epoch from now())::bigint, null, false);
    end loop;
  elsif v_issue.status = 'resolution_submitted' and p_to = 'in_progress' and v_assignee is not null then
    perform app.notify(v_assignee, 'verification_rejected', v_issue.code || ' needs more work', v_note,
      '/tasks', 'reverify:' || p_issue || ':' || extract(epoch from now())::bigint);
  end if;

  return jsonb_build_object('id', p_issue, 'status', p_to);
end $$;

create function app.add_issue_note(p_issue uuid, p_note text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_issue public.operational_issues;
  v_id uuid;
begin
  select * into v_issue from public.operational_issues where id = p_issue for update;
  if not found or not app.in_department(v_issue.department_id) then
    perform app.fail('not_found', 'Issue not found');
  end if;
  if length(trim(coalesce(p_note, ''))) < 3 then
    perform app.fail('validation', 'Write a short update');
  end if;
  insert into public.issue_updates (issue_id, author_id, kind, note) values (p_issue, auth.uid(), 'note', trim(p_note))
  returning id into v_id;
  update public.operational_issues set last_activity_at = now() where id = p_issue;
  return v_id;
end $$;

create function app.raise_issue(p_title text, p_description text, p_severity text, p_is_safety boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role text := app.my_role();
  v_dept uuid := app.my_department();
  v_issue public.operational_issues;
begin
  if v_role not in ('employee', 'manager') or v_dept is null then
    perform app.fail('forbidden', 'Only department staff can raise issues');
  end if;
  if length(trim(coalesce(p_title, ''))) < 3 then
    perform app.fail('validation', 'Give the issue a short title');
  end if;
  if p_severity not in ('low', 'medium', 'high', 'critical') then
    perform app.fail('validation', 'Choose a severity');
  end if;
  insert into public.operational_issues (department_id, title, description, severity, is_safety, status, created_by)
  values (v_dept, trim(p_title), trim(coalesce(p_description, '')), p_severity, coalesce(p_is_safety, false),
          case when v_role = 'manager' then 'open' else 'reported' end, auth.uid())
  returning * into v_issue;
  insert into public.issue_updates (issue_id, author_id, kind, to_status, note)
  values (v_issue.id, auth.uid(), 'created', v_issue.status, 'Raised directly');
  perform app.audit('issue.created', 'operational_issue', v_issue.id, v_dept, jsonb_build_object('status', v_issue.status));
  if v_role = 'employee' then
    perform app.notify_managers(v_dept, 'issue_reported', 'New issue reported: ' || v_issue.code, v_issue.title,
      '/manager/issues/' || v_issue.id, 'reported:' || v_issue.id);
  end if;
  return jsonb_build_object('id', v_issue.id, 'code', v_issue.code, 'status', v_issue.status);
end $$;

create function app.assign_issue(p_issue uuid, p_assignee uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_issue public.operational_issues;
  v_name text;
begin
  select * into v_issue from public.operational_issues where id = p_issue for update;
  if not found or not app.is_manager_of(v_issue.department_id) then
    perform app.fail('forbidden', 'Only a supervisor of this department can assign issues');
  end if;
  update public.issue_assignments set ended_at = now() where issue_id = p_issue and ended_at is null;
  if p_assignee is not null then
    select full_name into v_name from public.profiles
    where id = p_assignee and department_id = v_issue.department_id and is_active and role in ('employee', 'manager');
    if v_name is null then
      perform app.fail('validation', 'Assignee must be active staff in this department');
    end if;
    insert into public.issue_assignments (issue_id, assignee_id, assigned_by) values (p_issue, p_assignee, auth.uid());
    perform app.notify(p_assignee, 'issue_assigned', v_issue.code || ' assigned to you', v_issue.title, '/tasks',
      'assigned:' || p_issue || ':' || extract(epoch from now())::bigint);
  end if;
  insert into public.issue_updates (issue_id, author_id, kind, note)
  values (p_issue, auth.uid(), 'assignment', coalesce('Assigned to ' || v_name, 'Unassigned'));
  update public.operational_issues set last_activity_at = now() where id = p_issue;
  perform app.audit('issue.assigned', 'operational_issue', p_issue, v_issue.department_id, jsonb_build_object('assignee', p_assignee));
end $$;

create function app.add_operational_record(
  p_type text, p_reference text, p_title text, p_details text, p_recorded_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid := app.my_department();
  v_id uuid;
begin
  if not app.is_manager_of(v_dept) then
    perform app.fail('forbidden', 'Only supervisors can add source records');
  end if;
  insert into public.operational_records (department_id, record_type, reference_code, title, details, recorded_at, recorded_by)
  values (v_dept, p_type, trim(p_reference), trim(p_title), trim(coalesce(p_details, '')), coalesce(p_recorded_at, now()), auth.uid())
  on conflict (department_id, record_type, reference_code) do nothing
  returning id into v_id;
  if v_id is null then
    perform app.fail('conflict', 'A record with that reference already exists');
  end if;
  perform app.audit('record.created', 'operational_record', v_id, v_dept, jsonb_build_object('type', p_type));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Profile and notifications
-- ---------------------------------------------------------------------------
create function app.my_profile() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'full_name', p.full_name, 'email', p.email, 'phone', p.phone, 'role', p.role,
    'department_id', p.department_id, 'department_name', d.name, 'department_timezone', d.timezone,
    'team_id', p.team_id, 'team_name', t.name, 'pseudonym', p.pseudonym,
    'notify_email', p.notify_email, 'notify_sms', p.notify_sms, 'is_active', p.is_active,
    'server_now', now())
  from public.profiles p
  left join public.departments d on d.id = p.department_id
  left join public.teams t on t.id = p.team_id
  where p.id = auth.uid()
$$;

create function app.update_my_preferences(p_notify_email boolean, p_notify_sms boolean, p_phone text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then perform app.fail('forbidden', 'Sign in first'); end if;
  update public.profiles set
    notify_email = coalesce(p_notify_email, notify_email),
    notify_sms = coalesce(p_notify_sms, notify_sms),
    phone = nullif(trim(coalesce(p_phone, '')), '')
  where id = auth.uid();
  perform app.audit('profile.preferences_updated', 'profile', auth.uid(), app.my_department());
end $$;

create function app.mark_notifications_read(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count int;
begin
  update public.notifications set read_at = now()
  where recipient_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end $$;
