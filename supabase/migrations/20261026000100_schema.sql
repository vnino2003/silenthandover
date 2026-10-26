-- Silent Handover — core schema
-- Runs on Supabase PostgreSQL (auth schema provided by Supabase) and on the local
-- embedded PostgreSQL (auth schema provided by server/src/db/local-shim.sql).

create schema if not exists app;       -- user-callable workflow functions (check auth.uid() themselves)
create schema if not exists internal;  -- service-only functions and restricted data (PII mappings)

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------
create table public.departments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9-]{2,12}$'),
  name text not null unique check (length(name) between 2 and 120),
  timezone text not null default 'Asia/Manila',
  created_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete cascade,
  name text not null check (length(name) between 2 and 120),
  created_at timestamptz not null default now(),
  unique (department_id, name)
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (length(full_name) between 2 and 120),
  email text not null unique,
  phone text check (phone is null or phone ~ '^\+?[0-9 -]{7,20}$'),
  role text not null check (role in ('employee', 'manager', 'admin')),
  department_id uuid references public.departments (id) on delete set null,
  team_id uuid references public.teams (id) on delete set null,
  -- Stable pseudonym used instead of the name whenever text leaves for an AI provider.
  pseudonym text not null unique default ('EMP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))),
  is_active boolean not null default true,
  notify_email boolean not null default true,
  notify_sms boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (role = 'admin' or department_id is not null)
);
create index profiles_department_idx on public.profiles (department_id, role) where is_active;

-- ---------------------------------------------------------------------------
-- Scheduling
-- ---------------------------------------------------------------------------
create table public.shift_templates (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete cascade,
  team_id uuid references public.teams (id) on delete set null,
  name text not null check (length(name) between 2 and 80),
  start_time time not null,
  end_time time not null,
  window_open_minutes int not null default 30 check (window_open_minutes between 5 and 240),
  grace_minutes int not null default 30 check (grace_minutes between 0 and 240),
  allow_early_draft boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (department_id, name),
  check (start_time <> end_time)
);

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references public.shift_templates (id) on delete set null,
  department_id uuid not null references public.departments (id) on delete cascade,
  team_id uuid references public.teams (id) on delete set null,
  label text not null,
  shift_date date not null,
  timezone text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  window_opens_at timestamptz not null,
  window_closes_at timestamptz not null,
  allow_early_draft boolean not null default true,
  supervisor_id uuid references public.profiles (id) on delete set null,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (window_opens_at >= starts_at and window_opens_at <= ends_at),
  check (window_closes_at >= ends_at)
);
create unique index shifts_template_date_uq on public.shifts (template_id, shift_date) where template_id is not null;
create index shifts_department_time_idx on public.shifts (department_id, starts_at);

create table public.shift_assignments (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts (id) on delete cascade,
  employee_id uuid not null references public.profiles (id) on delete cascade,
  assigned_by uuid references public.profiles (id) on delete set null,
  removed_at timestamptz,
  removed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index shift_assignments_active_uq on public.shift_assignments (shift_id, employee_id) where removed_at is null;
create index shift_assignments_employee_idx on public.shift_assignments (employee_id) where removed_at is null;

create table public.report_window_overrides (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts (id) on delete cascade,
  employee_id uuid not null references public.profiles (id) on delete cascade,
  granted_by uuid not null references public.profiles (id),
  reason text not null check (length(reason) between 3 and 500),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index report_window_overrides_idx on public.report_window_overrides (shift_id, employee_id);

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
create sequence public.report_ref_seq;

create table public.shift_reports (
  id uuid primary key default gen_random_uuid(),
  reference_code text not null unique
    default ('SR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.report_ref_seq')::text, 6, '0')),
  shift_id uuid not null references public.shifts (id),
  employee_id uuid not null references public.profiles (id),
  department_id uuid not null references public.departments (id),
  status text not null default 'draft' check (status in (
    'draft', 'submitted', 'processing', 'pending_review', 'revision_requested', 'approved', 'rejected', 'delivered')),
  draft_content jsonb not null default '{}'::jsonb check (jsonb_typeof(draft_content) = 'object'),
  current_revision int not null default 0,
  first_submitted_at timestamptz,
  last_submitted_at timestamptz,
  is_late boolean not null default false,
  analysis_state text not null default 'none' check (analysis_state in ('none', 'queued', 'succeeded', 'simulated', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shift_id, employee_id)
);
create index shift_reports_department_status_idx on public.shift_reports (department_id, status);
create index shift_reports_employee_idx on public.shift_reports (employee_id, created_at desc);

-- Immutable copy of every submission. Never updated or deleted.
create table public.report_revisions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.shift_reports (id),
  revision_no int not null check (revision_no >= 1),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  submitted_by uuid not null references public.profiles (id),
  submitted_at timestamptz not null default now(),
  is_late boolean not null default false,
  unique (report_id, revision_no)
);

-- ---------------------------------------------------------------------------
-- Automation
-- ---------------------------------------------------------------------------
create table public.automation_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('report_analysis', 'handover_delivery')),
  idempotency_key text not null unique,
  department_id uuid references public.departments (id),
  report_id uuid references public.shift_reports (id),
  revision_no int,
  approval_id uuid,
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'completed', 'failed', 'dead')),
  adapter text,
  attempts int not null default 0,
  max_attempts int not null default 3,
  next_attempt_at timestamptz not null default now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index automation_events_due_idx on public.automation_events (status, next_attempt_at);

create table public.ai_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.shift_reports (id),
  revision_no int not null,
  automation_event_id uuid references public.automation_events (id),
  attempt int not null,
  prompt_version text not null,
  engine text not null,
  model text,
  is_simulated boolean not null,
  status text not null check (status in ('succeeded', 'invalid_output', 'failed')),
  draft jsonb,
  flags jsonb not null default '[]'::jsonb,
  validation_errors jsonb,
  latency_ms int,
  usage jsonb,
  created_at timestamptz not null default now(),
  check ((status = 'succeeded') = (draft is not null))
);
create index ai_analysis_runs_report_idx on public.ai_analysis_runs (report_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Approval, delivery, acknowledgment
-- ---------------------------------------------------------------------------
create table public.handover_approvals (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.shift_reports (id),
  -- Denormalized so incoming staff can read an approved handover without access to the raw report.
  report_reference text not null,
  author_id uuid not null references public.profiles (id),
  outgoing_shift_id uuid not null references public.shifts (id),
  revision_no int not null,
  analysis_run_id uuid references public.ai_analysis_runs (id),
  decision text not null check (decision in ('approved', 'rejected', 'revision_requested')),
  approved_content jsonb,
  flag_resolutions jsonb not null default '[]'::jsonb,
  note text not null default '',
  reviewer_id uuid not null references public.profiles (id),
  decided_at timestamptz not null default now(),
  check ((decision = 'approved') = (approved_content is not null))
);
create unique index handover_approvals_one_approved_uq on public.handover_approvals (report_id) where decision = 'approved';

alter table public.automation_events
  add constraint automation_events_approval_fk foreign key (approval_id) references public.handover_approvals (id);

create table public.handover_deliveries (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.handover_approvals (id),
  report_id uuid not null references public.shift_reports (id),
  recipient_id uuid not null references public.profiles (id),
  shift_id uuid not null references public.shifts (id),
  delivered_at timestamptz not null default now(),
  unique (approval_id, recipient_id)
);
create index handover_deliveries_recipient_idx on public.handover_deliveries (recipient_id, delivered_at desc);

create table public.handover_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null unique references public.handover_deliveries (id),
  employee_id uuid not null references public.profiles (id),
  note text not null default '' check (length(note) <= 500),
  acknowledged_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Operational issues
-- ---------------------------------------------------------------------------
create sequence public.issue_code_seq;

create table public.operational_issues (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('ISS-' || lpad(nextval('public.issue_code_seq')::text, 6, '0')),
  department_id uuid not null references public.departments (id),
  title text not null check (length(title) between 3 and 160),
  description text not null default '' check (length(description) <= 2000),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  is_safety boolean not null default false,
  status text not null check (status in (
    'reported', 'pending_verification', 'open', 'in_progress', 'resolution_submitted', 'resolved', 'closed')),
  origin_report_id uuid references public.shift_reports (id),
  origin_approval_id uuid references public.handover_approvals (id),
  created_by uuid references public.profiles (id),
  last_activity_at timestamptz not null default now(),
  escalated_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index operational_issues_department_status_idx on public.operational_issues (department_id, status);

create table public.issue_updates (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.operational_issues (id),
  author_id uuid references public.profiles (id),
  report_id uuid references public.shift_reports (id),
  kind text not null check (kind in ('created', 'status_change', 'note', 'report_update', 'assignment', 'escalation')),
  from_status text,
  to_status text,
  note text not null default '' check (length(note) <= 2000),
  created_at timestamptz not null default now()
);
create index issue_updates_issue_idx on public.issue_updates (issue_id, created_at);

create table public.issue_assignments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.operational_issues (id),
  assignee_id uuid not null references public.profiles (id),
  assigned_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index issue_assignments_active_uq on public.issue_assignments (issue_id) where ended_at is null;
create index issue_assignments_assignee_idx on public.issue_assignments (assignee_id) where ended_at is null;

-- Authorized source records a reviewer can check claims against (maintenance logs,
-- inventory counts, dispatch records, approved policies).
create table public.operational_records (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id),
  record_type text not null check (record_type in ('maintenance', 'inventory', 'dispatch', 'policy')),
  reference_code text not null check (length(reference_code) between 2 and 60),
  title text not null check (length(title) between 3 and 160),
  details text not null default '' check (length(details) <= 2000),
  recorded_at timestamptz not null default now(),
  recorded_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (department_id, record_type, reference_code)
);
create index operational_records_department_idx on public.operational_records (department_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  link text,
  event_key text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (recipient_id, event_key)
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  automation_event_id uuid references public.automation_events (id),
  channel text not null check (channel in ('email', 'sms')),
  address text not null,
  status text not null default 'pending' check (status in ('pending', 'queued', 'sent', 'failed', 'simulated', 'skipped')),
  provider text,
  provider_message_id text,
  provider_response jsonb,
  attempts int not null default 0,
  max_attempts int not null default 3,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  last_error text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notification_deliveries_due_idx on public.notification_deliveries (status, next_attempt_at);

create table public.notification_templates (
  key text primary key,
  subject text not null check (length(subject) between 1 and 200),
  body text not null check (length(body) between 1 and 4000),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit (append-only)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  department_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_department_idx on public.audit_logs (department_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Restricted: exactly what was sent to the AI provider, plus the reversible pseudonym
-- mapping for names. No policies for users; reached only through the API after it has
-- confirmed the caller is a reviewer for the report. Deleted after pii_retention_days.
-- ---------------------------------------------------------------------------
create table internal.analysis_inputs (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.shift_reports (id),
  revision_no int not null,
  sanitized_text text not null,
  name_mapping jsonb not null default '{}'::jsonb,
  redaction_counts jsonb not null default '{}'::jsonb,
  injection_findings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (report_id, revision_no)
);

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles for each row execute function app.touch_updated_at();
create trigger shift_reports_touch before update on public.shift_reports for each row execute function app.touch_updated_at();
create trigger automation_events_touch before update on public.automation_events for each row execute function app.touch_updated_at();
create trigger operational_issues_touch before update on public.operational_issues for each row execute function app.touch_updated_at();
create trigger notification_deliveries_touch before update on public.notification_deliveries for each row execute function app.touch_updated_at();

create function app.forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'SH:immutable' using errcode = 'P0001', detail = tg_table_name || ' rows cannot be changed';
end $$;

create trigger report_revisions_immutable before update or delete on public.report_revisions for each row execute function app.forbid_mutation();
create trigger handover_approvals_immutable before update or delete on public.handover_approvals for each row execute function app.forbid_mutation();
create trigger handover_ack_immutable before update or delete on public.handover_acknowledgments for each row execute function app.forbid_mutation();
create trigger issue_updates_immutable before update or delete on public.issue_updates for each row execute function app.forbid_mutation();
create trigger audit_logs_immutable before update or delete on public.audit_logs for each row execute function app.forbid_mutation();

create function app.guard_report_identity() returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.shift_id <> old.shift_id or new.employee_id <> old.employee_id
     or new.reference_code <> old.reference_code or new.department_id <> old.department_id then
    raise exception 'SH:immutable' using errcode = 'P0001', detail = 'Report identity cannot be changed';
  end if;
  return new;
end $$;
create trigger shift_reports_identity before update on public.shift_reports for each row execute function app.guard_report_identity();
