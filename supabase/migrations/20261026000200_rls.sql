-- Row Level Security and privileges.
-- Users only ever READ tables directly, and only the rows these policies allow.
-- Every write goes through a checked function in the app schema (next migration).

-- ---------------------------------------------------------------------------
-- Identity helpers (security definer so they can read profiles without recursing into RLS)
-- ---------------------------------------------------------------------------
create function app.my_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

create function app.my_department() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select department_id from public.profiles where id = auth.uid() and is_active
$$;

create function app.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid() and is_active), false)
$$;

create function app.is_manager_of(p_department uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role = 'manager' and department_id = p_department
                   from public.profiles where id = auth.uid() and is_active), false)
$$;

create function app.in_department(p_department uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role in ('employee', 'manager') and department_id = p_department
                   from public.profiles where id = auth.uid() and is_active), false)
$$;

-- ---------------------------------------------------------------------------
-- Privileges: start from nothing, grant SELECT only.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on schema internal from public;
revoke all on all tables in schema internal from public;
revoke all on all functions in schema app from public;
grant usage on schema app to authenticated;

grant select on
  public.departments, public.teams, public.shift_templates, public.shifts, public.shift_assignments,
  public.report_window_overrides, public.shift_reports, public.report_revisions, public.automation_events,
  public.ai_analysis_runs, public.handover_approvals, public.handover_deliveries, public.handover_acknowledgments,
  public.operational_issues, public.issue_updates, public.issue_assignments, public.operational_records,
  public.notifications, public.notification_templates, public.app_settings, public.audit_logs
to authenticated;

-- Column-level privacy: colleagues' email and phone are not readable directly.
grant select (id, full_name, role, department_id, team_id, pseudonym, is_active, created_at) on public.profiles to authenticated;
-- Delivery addresses are not readable directly either.
grant select (id, notification_id, recipient_id, automation_event_id, channel, status, provider, provider_message_id,
              attempts, max_attempts, next_attempt_at, last_attempt_at, last_error, created_at, updated_at)
  on public.notification_deliveries to authenticated;

grant execute on function app.my_role(), app.my_department(), app.is_admin(), app.is_manager_of(uuid), app.in_department(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table public.departments enable row level security;
alter table public.teams enable row level security;
alter table public.profiles enable row level security;
alter table public.shift_templates enable row level security;
alter table public.shifts enable row level security;
alter table public.shift_assignments enable row level security;
alter table public.report_window_overrides enable row level security;
alter table public.shift_reports enable row level security;
alter table public.report_revisions enable row level security;
alter table public.automation_events enable row level security;
alter table public.ai_analysis_runs enable row level security;
alter table public.handover_approvals enable row level security;
alter table public.handover_deliveries enable row level security;
alter table public.handover_acknowledgments enable row level security;
alter table public.operational_issues enable row level security;
alter table public.issue_updates enable row level security;
alter table public.issue_assignments enable row level security;
alter table public.operational_records enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_templates enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_logs enable row level security;
alter table internal.analysis_inputs enable row level security; -- no policies: nobody but the service role

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
create policy departments_read on public.departments for select to authenticated using (true);
create policy teams_read on public.teams for select to authenticated using (true);

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or app.is_admin() or (department_id is not null and department_id = app.my_department()));

create policy shift_templates_read on public.shift_templates for select to authenticated
  using (app.is_admin() or app.in_department(department_id));

create policy shifts_read on public.shifts for select to authenticated
  using (app.is_admin() or app.in_department(department_id));

create policy shift_assignments_read on public.shift_assignments for select to authenticated
  using (
    app.is_admin()
    or exists (select 1 from public.shifts s where s.id = shift_id and app.in_department(s.department_id))
  );

create policy report_window_overrides_read on public.report_window_overrides for select to authenticated
  using (
    employee_id = auth.uid()
    or exists (select 1 from public.shifts s where s.id = shift_id and app.is_manager_of(s.department_id))
  );

-- Report content: the author and the department's managers. Not administrators.
create policy shift_reports_read on public.shift_reports for select to authenticated
  using (employee_id = auth.uid() or app.is_manager_of(department_id));

create policy report_revisions_read on public.report_revisions for select to authenticated
  using (exists (
    select 1 from public.shift_reports r
    where r.id = report_id and (r.employee_id = auth.uid() or app.is_manager_of(r.department_id))
  ));

-- AI drafts are for reviewers only; employees never see an unapproved draft.
create policy ai_analysis_runs_read on public.ai_analysis_runs for select to authenticated
  using (exists (select 1 from public.shift_reports r where r.id = report_id and app.is_manager_of(r.department_id)));

create policy automation_events_read on public.automation_events for select to authenticated
  using (app.is_admin() or (department_id is not null and app.is_manager_of(department_id)));

create policy handover_approvals_read on public.handover_approvals for select to authenticated
  using (exists (
    select 1 from public.shift_reports r
    where r.id = report_id and (r.employee_id = auth.uid() or app.is_manager_of(r.department_id))
  ) or (decision = 'approved' and exists (
    select 1 from public.handover_deliveries d where d.approval_id = handover_approvals.id and d.recipient_id = auth.uid()
  )));

create policy handover_deliveries_read on public.handover_deliveries for select to authenticated
  using (recipient_id = auth.uid() or exists (
    select 1 from public.shift_reports r
    where r.id = report_id and (r.employee_id = auth.uid() or app.is_manager_of(r.department_id))
  ));

create policy handover_acknowledgments_read on public.handover_acknowledgments for select to authenticated
  using (employee_id = auth.uid() or exists (
    select 1 from public.handover_deliveries d join public.shift_reports r on r.id = d.report_id
    where d.id = delivery_id and (r.employee_id = auth.uid() or app.is_manager_of(r.department_id))
  ));

create policy operational_issues_read on public.operational_issues for select to authenticated
  using (app.in_department(department_id));

create policy issue_updates_read on public.issue_updates for select to authenticated
  using (exists (select 1 from public.operational_issues i where i.id = issue_id and app.in_department(i.department_id)));

create policy issue_assignments_read on public.issue_assignments for select to authenticated
  using (exists (select 1 from public.operational_issues i where i.id = issue_id and app.in_department(i.department_id)));

create policy operational_records_read on public.operational_records for select to authenticated
  using (app.in_department(department_id));

create policy notifications_read on public.notifications for select to authenticated
  using (recipient_id = auth.uid());

create policy notification_deliveries_read on public.notification_deliveries for select to authenticated
  using (recipient_id = auth.uid() or app.is_admin());

create policy notification_templates_read on public.notification_templates for select to authenticated
  using (app.is_admin());

create policy app_settings_read on public.app_settings for select to authenticated using (true);

create policy audit_logs_read on public.audit_logs for select to authenticated
  using (app.is_admin() or (department_id is not null and app.is_manager_of(department_id)));
