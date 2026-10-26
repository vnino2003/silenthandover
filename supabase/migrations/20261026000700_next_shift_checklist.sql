-- Next-shift checklist.
-- 1. "For the next shift" items in an approved handover become tracked tasks, so the incoming
--    shift gets a checklist of problems and tasks it can tick off.
-- 2. Ticking an item off can carry a photo as proof. Ticking it off moves it to
--    resolution_submitted; the supervisor confirms it before it counts as resolved.

alter table public.operational_issues
  add column kind text not null default 'problem' check (kind in ('problem', 'task'));

create table public.issue_photos (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.operational_issues (id),
  update_id uuid references public.issue_updates (id),
  uploaded_by uuid not null references public.profiles (id),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size int not null check (byte_size between 1 and 3145728),
  data bytea not null,
  created_at timestamptz not null default now()
);
create index issue_photos_issue_idx on public.issue_photos (issue_id, created_at);
create trigger issue_photos_immutable before update or delete on public.issue_photos
  for each row execute function app.forbid_mutation();

alter table public.issue_photos enable row level security;
create policy issue_photos_read on public.issue_photos for select to authenticated
  using (exists (select 1 from public.operational_issues i where i.id = issue_id and app.in_department(i.department_id)));
grant select on public.issue_photos to authenticated;

create function app.add_issue_photo(p_issue uuid, p_update uuid, p_content_type text, p_base64 text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
  v_data bytea;
  v_id uuid;
begin
  select department_id into v_dept from public.operational_issues where id = p_issue;
  if v_dept is null or not app.in_department(v_dept) then
    perform app.fail('not_found', 'Issue not found');
  end if;
  if p_update is not null and not exists (select 1 from public.issue_updates where id = p_update and issue_id = p_issue) then
    perform app.fail('validation', 'That update does not belong to this issue');
  end if;
  if p_content_type not in ('image/jpeg', 'image/png', 'image/webp') then
    perform app.fail('validation', 'Photos must be JPEG, PNG or WebP');
  end if;
  begin
    v_data := decode(p_base64, 'base64');
  exception when others then
    perform app.fail('validation', 'The photo could not be read');
  end;
  if length(v_data) > 3145728 then
    perform app.fail('validation', 'Photos must be 3 MB or smaller');
  end if;
  insert into public.issue_photos (issue_id, update_id, uploaded_by, content_type, byte_size, data)
  values (p_issue, p_update, auth.uid(), p_content_type, length(v_data), v_data)
  returning id into v_id;
  perform app.audit('issue.photo_added', 'operational_issue', p_issue, v_dept, jsonb_build_object('photo', v_id));
  return v_id;
end $$;

-- Same as before, and now also returns the id of the history entry so a photo can be attached to it.
create or replace function app.transition_issue(p_issue uuid, p_to text, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_issue public.operational_issues;
  v_role text := app.my_role();
  v_note text := trim(coalesce(p_note, ''));
  v_assignee uuid;
  v_update uuid;
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
  values (p_issue, auth.uid(), 'status_change', v_issue.status, p_to, v_note)
  returning id into v_update;
  perform app.audit('issue.' || p_to, 'operational_issue', p_issue, v_issue.department_id,
    jsonb_build_object('from', v_issue.status, 'to', p_to));

  select assignee_id into v_assignee from public.issue_assignments where issue_id = p_issue and ended_at is null;
  if p_to = 'resolution_submitted' then
    perform app.notify_managers(v_issue.department_id, 'verification_requested',
      'Check and confirm: ' || v_issue.code, v_issue.title || ' — ' || v_note, '/manager/issues/' || p_issue,
      'verify:' || p_issue || ':' || extract(epoch from now())::bigint);
  elsif p_to = 'resolved' then
    for v_assignee in
      select distinct x from unnest(array[v_assignee, v_issue.created_by,
        (select author_id from public.issue_updates where issue_id = p_issue and to_status = 'resolution_submitted' order by created_at desc limit 1)]) x
      where x is not null and x <> auth.uid()
    loop
      perform app.notify(v_assignee, 'issue_resolved', v_issue.code || ' confirmed done', v_issue.title,
        '/tasks', 'resolved:' || p_issue || ':' || extract(epoch from now())::bigint, null, false);
    end loop;
  elsif v_issue.status = 'resolution_submitted' and p_to = 'in_progress' then
    for v_assignee in
      select distinct x from unnest(array[v_assignee,
        (select author_id from public.issue_updates where issue_id = p_issue and to_status = 'resolution_submitted' order by created_at desc limit 1)]) x
      where x is not null
    loop
      perform app.notify(v_assignee, 'verification_rejected', v_issue.code || ' needs more work', v_note,
        '/tasks', 'reverify:' || p_issue || ':' || extract(epoch from now())::bigint);
    end loop;
  end if;

  return jsonb_build_object('id', p_issue, 'status', p_to, 'update_id', v_update);
end $$;

-- Same as before, plus: every "for the next shift" item becomes a tracked task.
create or replace function app.decide_report(
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
  v_tasks jsonb := '[]'::jsonb;
  v_desc text;
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

    -- Problems: the manager decides, item by item, whether to link to an existing issue or open a new one.
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
          (department_id, kind, title, description, severity, is_safety, status, origin_report_id, created_by)
        values (v_report.department_id, 'problem', v_item ->> 'title', coalesce(v_item ->> 'description', ''), v_item ->> 'severity',
                coalesce((v_item ->> 'is_safety_concern')::boolean, false),
                coalesce(v_item ->> 'initial_status', 'open'), p_report, v_report.employee_id)
        returning * into v_issue;
        insert into public.issue_updates (issue_id, author_id, report_id, kind, to_status, note)
        values (v_issue.id, auth.uid(), p_report, 'created', v_issue.status,
                'Created from approved handover ' || v_report.reference_code);
      end if;
      v_items := v_items || jsonb_build_array(v_item || jsonb_build_object('issue_id', v_issue.id, 'issue_code', v_issue.code));
    end loop;

    -- Tasks for the next shift: each becomes a checklist item that persists until confirmed done.
    for v_item in select * from jsonb_array_elements(coalesce(p_content -> 'pending_actions', '[]'::jsonb)) loop
      v_desc := trim(coalesce(v_item ->> 'description', ''));
      continue when length(v_desc) < 3;
      insert into public.operational_issues
        (department_id, kind, title, description, severity, is_safety, status, origin_report_id, created_by)
      values (v_report.department_id, 'task',
              case when length(v_desc) > 160 then left(v_desc, 157) || '…' else v_desc end,
              case when length(v_desc) > 160 then v_desc else '' end,
              'low', false, 'open', p_report, v_report.employee_id)
      returning * into v_issue;
      insert into public.issue_updates (issue_id, author_id, report_id, kind, to_status, note)
      values (v_issue.id, auth.uid(), p_report, 'created', 'open', 'Task for the next shift from ' || v_report.reference_code);
      v_tasks := v_tasks || jsonb_build_array(v_item || jsonb_build_object('issue_id', v_issue.id, 'issue_code', v_issue.code));
    end loop;
    v_content := jsonb_set(jsonb_set(p_content, '{unresolved_issues}', v_items), '{pending_actions}', v_tasks);

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
                         'flags', v_flag_count, 'recipients', v_recipients, 'issues', jsonb_array_length(v_items),
                         'tasks', jsonb_array_length(v_tasks)));

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

revoke all on function app.add_issue_photo(uuid, uuid, text, text) from public;
grant execute on function app.add_issue_photo(uuid, uuid, text, text) to authenticated;
