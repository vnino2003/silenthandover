-- Attendance and timekeeping (QR attendance pilot).
--
-- The roster stays the plan: shifts and shift_assignments. This adds the evidence and its result:
--   duty_expectations      versioned record of who was expected on which shift, and when that changed
--   attendance_stations    staff-only QR stations (their secret lives in internal.*)
--   attendance_events      append-only punches: source, captured and received time, unique event key
--   attendance_event_voids corrections that set a wrong punch aside (the punch itself is never changed)
--   attendance_records     one row per expected person and shift: reconciled status and minutes
--   attendance_exceptions  review items: missing punch, late, undertime, overtime, possible absence...
--   attendance_corrections staff requests for a missing or wrong punch, decided by the Head Nurse
--   coverage_changes       replacements and swaps: who covered whom, authorised by whom and when
--   workforce_policies     versioned attendance and pay rules (owned by HR; demo values are samples)
-- Leave links in directly: approved leave excuses the duty (paid or unpaid by leave type), pending
-- leave becomes a review item. Endorsements stay operational and are not attendance evidence.

-- ---------------------------------------------------------------------------
-- Policy (versioned)
-- ---------------------------------------------------------------------------
create table public.workforce_policies (
  id uuid primary key default gen_random_uuid(),
  version int not null unique,
  effective_from date not null,
  rules jsonb not null,
  note text not null default '',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
-- SAMPLE rules for the demo (a government hospital). Every value must be confirmed with the
-- hospital's HR and Finance before real use:
--   hourly rate = monthly basic / 22 / 8 (RA 11701 IRR wording); night differential 10% of the
--   hourly rate for 6 PM-6 AM (floor for public health workers, RA 11701 IRR); overtime 125%;
--   no grace period; overnight duty split at midnight.
insert into public.workforce_policies (version, effective_from, rules, note) values (1, date '2026-01-01', jsonb_build_object(
  'sample', true,
  'employer_type', 'government',
  'grace_minutes', 0,
  'match_before_minutes', 120,
  'match_after_minutes', 240,
  'possible_absence_after_minutes', 60,
  'overtime_min_minutes', 30,
  'overnight_attribution', 'split_midnight',
  'days_per_month', 22,
  'hours_per_day', 8,
  'night_start', '18:00',
  'night_end', '06:00',
  'night_rate', 0.10,
  'overtime_rate', 1.25,
  'cutoff', 'semi_monthly'
), 'Sample rules for the demonstration. Confirm with HR and Finance.');

create function app.policy_for(p_day date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select rules from public.workforce_policies where effective_from <= p_day order by effective_from desc, version desc limit 1
$$;

-- ---------------------------------------------------------------------------
-- Leave: paid or unpaid
-- ---------------------------------------------------------------------------
alter table public.leave_types add column is_paid boolean not null default true;
insert into public.leave_types (name, description, requires_reason, sort_order, is_paid)
values ('Leave without pay', 'Approved time off without pay.', true, 90, false)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Duty expectations: a version for every roster change
-- ---------------------------------------------------------------------------
create table public.duty_expectations (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  assignment_id uuid references public.shift_assignments (id) on delete set null,
  version int not null,
  expected boolean not null,
  expected_start timestamptz not null,
  expected_end timestamptz not null,
  change_kind text not null check (change_kind in ('assigned', 'removed', 'shift_changed', 'cancelled')),
  effective_at timestamptz not null default now(),
  changed_by uuid references public.profiles (id) on delete set null,
  unique (shift_id, profile_id, version)
);
create index duty_expectations_profile_idx on public.duty_expectations (profile_id, shift_id);

create function internal.record_expectation(p_shift uuid, p_profile uuid, p_assignment uuid, p_expected boolean, p_kind text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_s public.shifts;
begin
  select * into v_s from public.shifts where id = p_shift;
  insert into public.duty_expectations (shift_id, profile_id, assignment_id, version, expected, expected_start, expected_end, change_kind, changed_by)
  values (p_shift, p_profile, p_assignment,
          coalesce((select max(version) from public.duty_expectations where shift_id = p_shift and profile_id = p_profile), 0) + 1,
          p_expected, v_s.starts_at, v_s.ends_at, p_kind, auth.uid());
end $$;

create function internal.on_assignment_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' and new.removed_at is null then
    perform internal.record_expectation(new.shift_id, new.employee_id, new.id, true, 'assigned');
  elsif tg_op = 'UPDATE' and old.removed_at is null and new.removed_at is not null then
    perform internal.record_expectation(new.shift_id, new.employee_id, new.id, false, 'removed');
  end if;
  return new;
end $$;
create trigger shift_assignments_expectations after insert or update of removed_at on public.shift_assignments
  for each row execute function internal.on_assignment_change();

create function internal.on_shift_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_a record;
begin
  if new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at or new.status is distinct from old.status then
    for v_a in select id, employee_id from public.shift_assignments where shift_id = new.id and removed_at is null loop
      perform internal.record_expectation(new.id, v_a.employee_id, v_a.id, new.status = 'scheduled',
        case when new.status <> 'scheduled' then 'cancelled' else 'shift_changed' end);
    end loop;
  end if;
  return new;
end $$;
create trigger shifts_expectations after update on public.shifts
  for each row execute function internal.on_shift_change();

-- Existing assignments get their first version now. Past shifts without punches stay
-- "unverified": reconciliation only starts from this migration.
insert into public.duty_expectations (shift_id, profile_id, assignment_id, version, expected, expected_start, expected_end, change_kind, effective_at)
select a.shift_id, a.employee_id, a.id, 1, a.removed_at is null and s.status = 'scheduled', s.starts_at, s.ends_at,
       case when a.removed_at is null then 'assigned' else 'removed' end, a.created_at
from public.shift_assignments a join public.shifts s on s.id = a.shift_id
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Stations and punches
-- ---------------------------------------------------------------------------
create table public.attendance_stations (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete cascade,
  name text not null check (length(name) between 2 and 80),
  kind text not null default 'qr_station' check (kind in ('qr_station', 'kiosk', 'device')),
  is_active boolean not null default true,
  last_seen_at timestamptz,
  clock_drift_ms int,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create table internal.attendance_station_secrets (
  station_id uuid primary key references public.attendance_stations (id) on delete cascade,
  secret text not null,
  rotated_at timestamptz not null default now()
);
-- A terminal (future fingerprint/face device or gateway) reports its own staff numbers; this maps
-- them to accounts. No biometric data is ever stored here.
create table public.attendance_device_staff (
  station_id uuid not null references public.attendance_stations (id) on delete cascade,
  external_ref text not null check (length(external_ref) between 1 and 64),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  primary key (station_id, external_ref)
);

create table public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique check (length(event_key) between 8 and 120),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  kind text not null check (kind in ('in', 'out')),
  source text not null check (source in ('qr', 'attestation', 'correction', 'kiosk', 'device')),
  station_id uuid references public.attendance_stations (id) on delete set null,
  captured_at timestamptz not null,
  received_at timestamptz not null default now(),
  recorded_by uuid references public.profiles (id) on delete set null,
  note text not null default '' check (length(note) <= 500)
);
create index attendance_events_profile_idx on public.attendance_events (profile_id, captured_at);
create index attendance_events_department_idx on public.attendance_events (department_id, captured_at);

-- Punches are evidence: never edited or deleted. A correction voids one by adding a row here.
create function internal.attendance_events_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'SH:immutable' using errcode = 'P0001', detail = 'Attendance punches cannot be changed. Request a correction instead.';
end $$;
create trigger attendance_events_no_change before update or delete on public.attendance_events
  for each row execute function internal.attendance_events_immutable();

create table public.attendance_event_voids (
  event_id uuid primary key references public.attendance_events (id) on delete cascade,
  correction_id uuid,
  voided_by uuid references public.profiles (id) on delete set null,
  voided_at timestamptz not null default now(),
  reason text not null check (length(reason) between 3 and 500)
);

-- ---------------------------------------------------------------------------
-- Reconciled records and review items
-- ---------------------------------------------------------------------------
create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  status text not null check (status in ('scheduled', 'clocked_in', 'present', 'incomplete', 'no_show', 'absent', 'excused')),
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  time_in timestamptz,
  time_out timestamptz,
  scheduled_minutes int not null default 0,
  worked_minutes int not null default 0,
  late_minutes int not null default 0,
  undertime_minutes int not null default 0,
  overtime_candidate_minutes int not null default 0,
  overtime_approved_minutes int not null default 0,
  overtime_treatment text check (overtime_treatment in ('pay', 'compensatory_time')),
  overtime_decided_by uuid references public.profiles (id) on delete set null,
  leave_request_id uuid references public.leave_requests (id) on delete set null,
  paid_leave_minutes int not null default 0,
  unpaid_leave_minutes int not null default 0,
  verified_by uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  absence_confirmed_by uuid references public.profiles (id) on delete set null,
  locked_at timestamptz,
  policy_version int,
  computed_at timestamptz not null default now(),
  unique (shift_id, profile_id)
);
create index attendance_records_department_idx on public.attendance_records (department_id, scheduled_start);
create index attendance_records_profile_idx on public.attendance_records (profile_id, scheduled_start);

create table public.attendance_exceptions (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  shift_id uuid references public.shifts (id) on delete cascade,
  event_id uuid references public.attendance_events (id) on delete cascade,
  kind text not null check (kind in ('missing_in', 'missing_out', 'late', 'undertime', 'overtime', 'possible_absence', 'unscheduled', 'duplicate', 'pending_leave')),
  detail text not null default '',
  state text not null default 'open' check (state in ('open', 'resolved', 'cleared')),
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  resolution text not null default '',
  created_at timestamptz not null default now()
);
create unique index attendance_exceptions_open_uq on public.attendance_exceptions
  (profile_id, coalesce(shift_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(event_id, '00000000-0000-0000-0000-000000000000'::uuid), kind)
  where state = 'open';
create index attendance_exceptions_department_idx on public.attendance_exceptions (department_id, state);

create table public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  shift_id uuid references public.shifts (id) on delete cascade,
  kind text not null check (kind in ('add_in', 'add_out', 'void_punch')),
  event_id uuid references public.attendance_events (id) on delete cascade,
  proposed_at timestamptz,
  reason text not null check (length(reason) between 3 and 500),
  requested_by uuid not null references public.profiles (id) on delete cascade,
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_note text not null default '',
  created_event_id uuid references public.attendance_events (id) on delete set null
);
create index attendance_corrections_department_idx on public.attendance_corrections (department_id, status);

create table public.coverage_changes (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete cascade,
  original_profile_id uuid not null references public.profiles (id) on delete cascade,
  replacement_profile_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null check (length(reason) between 3 and 500),
  emergency boolean not null default false,
  retrospective boolean not null default false,
  authorized_by uuid not null references public.profiles (id) on delete cascade,
  authorized_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Reading rules (RLS): your own rows; the unit's rows for its Head Nurse / Nursing Service; totals
-- for HR. Payroll and Finance read certified DTR totals instead (next migration), never punches.
-- ---------------------------------------------------------------------------
alter table public.workforce_policies enable row level security;
create policy workforce_policies_read on public.workforce_policies for select to authenticated using (true);
alter table public.duty_expectations enable row level security;
create policy duty_expectations_read on public.duty_expectations for select to authenticated
  using (profile_id = auth.uid() or exists (select 1 from public.shifts s where s.id = shift_id
         and (app.can_supervise_attendance(s.department_id) or app.has_capability('timekeeper', s.department_id))));
alter table public.attendance_stations enable row level security;
create policy attendance_stations_read on public.attendance_stations for select to authenticated
  using (app.in_department(department_id) or app.can_supervise_attendance(department_id) or app.is_admin());
alter table public.attendance_device_staff enable row level security;
create policy attendance_device_staff_read on public.attendance_device_staff for select to authenticated
  using (exists (select 1 from public.attendance_stations s where s.id = station_id and app.can_supervise_attendance(s.department_id)));
alter table public.attendance_events enable row level security;
create policy attendance_events_read on public.attendance_events for select to authenticated
  using (profile_id = auth.uid() or app.can_supervise_attendance(department_id) or app.has_capability('timekeeper', department_id));
alter table public.attendance_event_voids enable row level security;
create policy attendance_event_voids_read on public.attendance_event_voids for select to authenticated
  using (exists (select 1 from public.attendance_events e where e.id = event_id and (e.profile_id = auth.uid()
         or app.can_supervise_attendance(e.department_id) or app.has_capability('timekeeper', e.department_id))));
alter table public.attendance_records enable row level security;
create policy attendance_records_read on public.attendance_records for select to authenticated
  using (profile_id = auth.uid() or app.can_supervise_attendance(department_id) or app.has_capability('timekeeper', department_id));
alter table public.attendance_exceptions enable row level security;
create policy attendance_exceptions_read on public.attendance_exceptions for select to authenticated
  using (profile_id = auth.uid() or app.can_supervise_attendance(department_id) or app.has_capability('timekeeper', department_id));
alter table public.attendance_corrections enable row level security;
create policy attendance_corrections_read on public.attendance_corrections for select to authenticated
  using (profile_id = auth.uid() or app.can_supervise_attendance(department_id) or app.has_capability('timekeeper', department_id));
alter table public.coverage_changes enable row level security;
create policy coverage_changes_read on public.coverage_changes for select to authenticated
  using (original_profile_id = auth.uid() or replacement_profile_id = auth.uid() or app.can_supervise_attendance(department_id)
         or app.has_capability('timekeeper', department_id));

grant select on public.workforce_policies, public.duty_expectations, public.attendance_stations, public.attendance_device_staff,
  public.attendance_events, public.attendance_event_voids, public.attendance_records, public.attendance_exceptions,
  public.attendance_corrections, public.coverage_changes to authenticated;

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------
create function internal.minutes(p_from timestamptz, p_to timestamptz) returns int
language sql immutable as $$ select greatest(0, floor(extract(epoch from (p_to - p_from)) / 60))::int $$;

-- Opens a review item, or keeps the open one (idempotent).
create function internal.open_exception(p_department uuid, p_profile uuid, p_shift uuid, p_event uuid, p_kind text, p_detail text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.attendance_exceptions (department_id, profile_id, shift_id, event_id, kind, detail)
  values (p_department, p_profile, p_shift, p_event, p_kind, p_detail)
  on conflict (profile_id, coalesce(shift_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(event_id, '00000000-0000-0000-0000-000000000000'::uuid), kind)
    where state = 'open'
  do update set detail = excluded.detail
$$;

-- Recomputes one person's attendance for one shift from the roster, leave and punches.
create function internal.reconcile_one(p_shift uuid, p_profile uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_s public.shifts;
  v_rec public.attendance_records;
  v_policy jsonb;
  v_expected boolean;
  v_leave record;
  v_pending boolean;
  v_in timestamptz;
  v_out timestamptz;
  v_ins int;
  v_status text;
  v_worked int := 0;
  v_late int := 0;
  v_under int := 0;
  v_ot int := 0;
  v_sched int;
  v_paid int := 0;
  v_unpaid int := 0;
  v_keep text[] := '{}';
begin
  select * into v_s from public.shifts where id = p_shift;
  if not found then return; end if;
  select * into v_rec from public.attendance_records where shift_id = p_shift and profile_id = p_profile;
  if found and v_rec.locked_at is not null then return; end if;
  v_policy := app.policy_for(v_s.shift_date);
  v_sched := internal.minutes(v_s.starts_at, v_s.ends_at);

  v_expected := v_s.status = 'scheduled' and exists (
    select 1 from public.shift_assignments where shift_id = p_shift and employee_id = p_profile and removed_at is null);
  -- Approved leave on the shift's day excuses the duty, even though approval removed the assignment.
  select r.id, t.is_paid into v_leave
  from public.leave_requests r join public.leave_types t on t.id = r.leave_type_id
  where r.employee_id = p_profile and r.status = 'approved' and v_s.shift_date between r.start_date and r.end_date
    and exists (select 1 from public.shift_assignments a where a.shift_id = p_shift and a.employee_id = p_profile)
  limit 1;
  v_pending := exists (select 1 from public.leave_requests r where r.employee_id = p_profile and r.status = 'pending'
                       and app.shift_overlaps_days(v_s.starts_at, v_s.ends_at, v_s.timezone, r.start_date, r.end_date));

  -- Punches that belong to this shift (not voided), inside the matching window.
  select min(e.captured_at) filter (where e.kind = 'in'), max(e.captured_at) filter (where e.kind = 'out'),
         count(*) filter (where e.kind = 'in')
    into v_in, v_out, v_ins
  from public.attendance_events e
  where e.profile_id = p_profile
    and e.captured_at between v_s.starts_at - make_interval(mins => (v_policy ->> 'match_before_minutes')::int)
                          and v_s.ends_at + make_interval(mins => (v_policy ->> 'match_after_minutes')::int)
    and not exists (select 1 from public.attendance_event_voids v where v.event_id = e.id);
  if v_out is not null and v_in is not null and v_out < v_in then v_out := null; end if;

  if not v_expected and v_leave.id is null and v_in is null and v_out is null then
    -- Not expected any more and nothing recorded: drop the computed row (history stays in duty_expectations).
    delete from public.attendance_records where shift_id = p_shift and profile_id = p_profile and verified_at is null;
    update public.attendance_exceptions set state = 'cleared', resolved_at = now(), resolution = 'No longer on this shift'
    where shift_id = p_shift and profile_id = p_profile and state = 'open';
    return;
  end if;

  if v_leave.id is not null and v_in is null then
    v_status := 'excused';
    if v_leave.is_paid then v_paid := v_sched; else v_unpaid := v_sched; end if;
  elsif v_rec.status = 'absent' and v_in is null and v_out is null then
    v_status := 'absent';
  elsif v_in is not null and v_out is not null then
    v_status := 'present';
  elsif v_in is not null then
    v_status := case when now() < v_s.ends_at + make_interval(mins => (v_policy ->> 'match_after_minutes')::int) then 'clocked_in' else 'incomplete' end;
  elsif v_out is not null then
    v_status := 'incomplete';
  elsif now() < v_s.starts_at + make_interval(mins => (v_policy ->> 'possible_absence_after_minutes')::int) then
    v_status := 'scheduled';
  else
    v_status := 'no_show';
  end if;

  if v_in is not null and v_out is not null then
    v_worked := internal.minutes(v_in, v_out);
    v_late := internal.minutes(v_s.starts_at + make_interval(mins => (v_policy ->> 'grace_minutes')::int), v_in);
    v_under := internal.minutes(v_out, v_s.ends_at);
    v_ot := internal.minutes(v_s.ends_at, v_out) + internal.minutes(v_in, v_s.starts_at);
    if v_ot < (v_policy ->> 'overtime_min_minutes')::int then v_ot := 0; end if;
  elsif v_in is not null then
    v_late := internal.minutes(v_s.starts_at + make_interval(mins => (v_policy ->> 'grace_minutes')::int), v_in);
  end if;

  insert into public.attendance_records as r (shift_id, profile_id, department_id, status, scheduled_start, scheduled_end,
    time_in, time_out, scheduled_minutes, worked_minutes, late_minutes, undertime_minutes, overtime_candidate_minutes,
    leave_request_id, paid_leave_minutes, unpaid_leave_minutes, policy_version, computed_at)
  values (p_shift, p_profile, v_s.department_id, v_status, v_s.starts_at, v_s.ends_at, v_in, v_out, v_sched, v_worked, v_late,
    v_under, v_ot, v_leave.id, v_paid, v_unpaid,
    (select version from public.workforce_policies where effective_from <= v_s.shift_date order by effective_from desc, version desc limit 1), now())
  on conflict (shift_id, profile_id) do update set
    status = excluded.status, scheduled_start = excluded.scheduled_start, scheduled_end = excluded.scheduled_end,
    time_in = excluded.time_in, time_out = excluded.time_out, scheduled_minutes = excluded.scheduled_minutes,
    worked_minutes = excluded.worked_minutes, late_minutes = excluded.late_minutes, undertime_minutes = excluded.undertime_minutes,
    overtime_candidate_minutes = excluded.overtime_candidate_minutes,
    -- An approved overtime decision stays, but never above what was actually worked beyond the shift.
    overtime_approved_minutes = least(r.overtime_approved_minutes, excluded.overtime_candidate_minutes),
    leave_request_id = excluded.leave_request_id, paid_leave_minutes = excluded.paid_leave_minutes,
    unpaid_leave_minutes = excluded.unpaid_leave_minutes, policy_version = excluded.policy_version, computed_at = now(),
    -- New evidence after verification means it has to be verified again.
    verified_at = case when r.time_in is distinct from excluded.time_in or r.time_out is distinct from excluded.time_out then null else r.verified_at end,
    verified_by = case when r.time_in is distinct from excluded.time_in or r.time_out is distinct from excluded.time_out then null else r.verified_by end;

  -- Review items that apply now; the others for this shift are cleared.
  if v_status = 'incomplete' and v_in is null then v_keep := v_keep || 'missing_in'::text;
    perform internal.open_exception(v_s.department_id, p_profile, p_shift, null, 'missing_in', 'Time-out recorded without a time-in'); end if;
  if v_status = 'incomplete' and v_out is null then v_keep := v_keep || 'missing_out'::text;
    perform internal.open_exception(v_s.department_id, p_profile, p_shift, null, 'missing_out', 'Time-in recorded but no time-out'); end if;
  if v_status = 'no_show' then v_keep := v_keep || 'possible_absence'::text;
    perform internal.open_exception(v_s.department_id, p_profile, p_shift, null, 'possible_absence', 'Scheduled but no time-in recorded'); end if;
  if v_late > 0 then v_keep := v_keep || 'late'::text;
    perform internal.open_exception(v_s.department_id, p_profile, p_shift, null, 'late', v_late || ' min late'); end if;
  if v_under > 0 then v_keep := v_keep || 'undertime'::text;
    perform internal.open_exception(v_s.department_id, p_profile, p_shift, null, 'undertime', v_under || ' min before the end of the shift'); end if;
  if v_ot > 0 and coalesce(v_rec.overtime_decided_by, null) is null then v_keep := v_keep || 'overtime'::text;
    perform internal.open_exception(v_s.department_id, p_profile, p_shift, null, 'overtime', v_ot || ' min outside the scheduled shift'); end if;
  if v_ins > 1 then v_keep := v_keep || 'duplicate'::text;
    perform internal.open_exception(v_s.department_id, p_profile, p_shift, null, 'duplicate', v_ins || ' time-ins recorded; the first is used'); end if;
  if v_pending and v_status <> 'excused' then v_keep := v_keep || 'pending_leave'::text;
    perform internal.open_exception(v_s.department_id, p_profile, p_shift, null, 'pending_leave', 'Leave for this duty is still waiting for a decision'); end if;
  update public.attendance_exceptions set state = 'cleared', resolved_at = now(), resolution = 'Cleared by the latest records'
  where shift_id = p_shift and profile_id = p_profile and state = 'open' and not (kind = any (v_keep));
end $$;

-- Reconciles a department for a date range: every expected person, everyone with leave on a
-- shift they were assigned to, and punches that match no shift (unscheduled work).
create function internal.reconcile_department(p_department uuid, p_from date, p_to date) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pair record;
  v_n int := 0;
  v_e record;
begin
  perform pg_advisory_xact_lock(hashtext('attendance:' || p_department::text));
  for v_pair in
    select distinct a.shift_id, a.employee_id as profile_id
    from public.shift_assignments a join public.shifts s on s.id = a.shift_id
    where s.department_id = p_department and s.shift_date between p_from and p_to
      and (a.removed_at is null or exists (select 1 from public.leave_requests r where r.employee_id = a.employee_id
           and r.status = 'approved' and s.shift_date between r.start_date and r.end_date))
    union
    select r.shift_id, r.profile_id from public.attendance_records r join public.shifts s on s.id = r.shift_id
    where r.department_id = p_department and s.shift_date between p_from and p_to
  loop
    perform internal.reconcile_one(v_pair.shift_id, v_pair.profile_id);
    v_n := v_n + 1;
  end loop;

  for v_e in
    select e.id, e.profile_id, e.captured_at, e.kind from public.attendance_events e
    where e.department_id = p_department
      and e.captured_at >= (p_from::timestamp at time zone (select timezone from public.departments where id = p_department))
      and e.captured_at < ((p_to + 1)::timestamp at time zone (select timezone from public.departments where id = p_department))
      and not exists (select 1 from public.attendance_event_voids v where v.event_id = e.id)
  loop
    if not exists (
      select 1 from public.attendance_records r
      where r.profile_id = v_e.profile_id and r.status <> 'excused'
        and v_e.captured_at between r.scheduled_start - make_interval(mins => (app.policy_for((r.scheduled_start)::date) ->> 'match_before_minutes')::int)
                                and r.scheduled_end + make_interval(mins => (app.policy_for((r.scheduled_start)::date) ->> 'match_after_minutes')::int)
    ) then
      perform internal.open_exception(p_department, v_e.profile_id, null, v_e.id, 'unscheduled',
        'Time-' || v_e.kind || ' with no matching duty');
    else
      update public.attendance_exceptions set state = 'cleared', resolved_at = now(), resolution = 'Matched a duty'
      where event_id = v_e.id and kind = 'unscheduled' and state = 'open';
    end if;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Capture
-- ---------------------------------------------------------------------------
-- Called by the API only after it has checked the signed-in person and the station's current
-- code. In or out is decided here: after a time-in within the last 16 hours, the next scan is a
-- time-out. A repeat scan within 2 minutes returns the same punch (no double entries).
create function internal.record_station_punch(p_profile uuid, p_station uuid, p_event_key text, p_source text default 'qr') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_station public.attendance_stations;
  v_me public.profiles;
  v_last public.attendance_events;
  v_kind text;
  v_id uuid;
  v_existing public.attendance_events;
begin
  select * into v_existing from public.attendance_events where event_key = p_event_key;
  if found then
    return jsonb_build_object('event_id', v_existing.id, 'kind', v_existing.kind, 'captured_at', v_existing.captured_at, 'repeat', true);
  end if;
  select * into v_station from public.attendance_stations where id = p_station and is_active;
  if not found then perform app.fail('not_found', 'This attendance station is not active'); end if;
  select * into v_me from public.profiles where id = p_profile and is_active;
  if not found or v_me.department_id is distinct from v_station.department_id then
    perform app.fail('forbidden', 'This station belongs to another unit');
  end if;
  perform pg_advisory_xact_lock(hashtext('punch:' || p_profile::text));
  select * into v_last from public.attendance_events e where e.profile_id = p_profile
    and not exists (select 1 from public.attendance_event_voids v where v.event_id = e.id)
    order by e.captured_at desc limit 1;
  if found and v_last.captured_at > now() - interval '2 minutes' then
    return jsonb_build_object('event_id', v_last.id, 'kind', v_last.kind, 'captured_at', v_last.captured_at, 'repeat', true);
  end if;
  v_kind := case when found and v_last.kind = 'in' and v_last.captured_at > now() - interval '16 hours' then 'out' else 'in' end;
  insert into public.attendance_events (event_key, profile_id, department_id, kind, source, station_id, captured_at, recorded_by)
  values (p_event_key, p_profile, v_station.department_id, v_kind, p_source, p_station, now(), p_profile)
  returning id into v_id;
  update public.attendance_stations set last_seen_at = now() where id = p_station;
  perform internal.reconcile_department(v_station.department_id, (now() at time zone 'UTC')::date - 1, (now() at time zone 'UTC')::date + 1);
  return jsonb_build_object('event_id', v_id, 'kind', v_kind, 'captured_at', now(), 'repeat', false);
end $$;

-- A registered terminal reports punches it captured (possibly while offline). Same rules: unique
-- event keys make retries safe; the API has already checked the device signature and clock.
create function internal.record_device_punch(p_station uuid, p_external_ref text, p_kind text, p_captured_at timestamptz, p_event_key text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_station public.attendance_stations;
  v_profile uuid;
begin
  if exists (select 1 from public.attendance_events where event_key = p_event_key) then return 'duplicate'; end if;
  select * into v_station from public.attendance_stations where id = p_station and is_active and kind = 'device';
  if not found then return 'unknown_device'; end if;
  select profile_id into v_profile from public.attendance_device_staff where station_id = p_station and external_ref = p_external_ref;
  if v_profile is null then return 'unknown_staff'; end if;
  if p_kind not in ('in', 'out') then return 'invalid'; end if;
  insert into public.attendance_events (event_key, profile_id, department_id, kind, source, station_id, captured_at)
  values (p_event_key, v_profile, v_station.department_id, p_kind, 'device', p_station, p_captured_at);
  update public.attendance_stations set last_seen_at = now() where id = p_station;
  return 'recorded';
end $$;

-- ---------------------------------------------------------------------------
-- Head Nurse / Nursing Service actions (never on their own attendance)
-- ---------------------------------------------------------------------------
create function internal.require_supervisor_not_self(p_department uuid, p_profile uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.can_supervise_attendance(p_department) then
    perform app.fail('forbidden', 'Only the department head or Nursing Service can do this');
  end if;
  if p_profile = auth.uid() then
    perform app.fail('forbidden', 'You cannot approve or verify your own attendance');
  end if;
end $$;

create function app.create_attendance_station(p_name text, p_secret text, p_kind text default 'qr_station') returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_department uuid := app.my_department();
  v_id uuid;
begin
  if v_department is null or not app.can_supervise_attendance(v_department) then
    perform app.fail('forbidden', 'Only the department head can set up an attendance station');
  end if;
  if length(coalesce(p_secret, '')) < 32 then perform app.fail('validation', 'Station secret too short'); end if;
  insert into public.attendance_stations (department_id, name, kind, created_by) values (v_department, trim(p_name), p_kind, auth.uid())
  returning id into v_id;
  insert into internal.attendance_station_secrets (station_id, secret) values (v_id, p_secret);
  perform app.audit('attendance.station_created', 'attendance_station', v_id, v_department, jsonb_build_object('name', p_name, 'kind', p_kind));
  return v_id;
end $$;

create function app.rotate_attendance_station(p_station uuid, p_secret text, p_active boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_s public.attendance_stations;
begin
  select * into v_s from public.attendance_stations where id = p_station;
  if not found or not app.can_supervise_attendance(v_s.department_id) then perform app.fail('not_found', 'Station not found'); end if;
  update public.attendance_stations set is_active = p_active where id = p_station;
  if p_secret is not null then
    if length(p_secret) < 32 then perform app.fail('validation', 'Station secret too short'); end if;
    update internal.attendance_station_secrets set secret = p_secret, rotated_at = now() where station_id = p_station;
  end if;
  perform app.audit(case when p_active then 'attendance.station_reset' else 'attendance.station_disabled' end, 'attendance_station', p_station, v_s.department_id);
end $$;

-- Fallback when the QR station is down, phones are not allowed, or hands are gloved: the Head
-- Nurse records that the person was there, with a reason. Shown as "attested", never as a scan.
create function app.attest_attendance(p_shift uuid, p_profile uuid, p_kind text, p_at timestamptz, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_s public.shifts;
  v_id uuid;
begin
  select * into v_s from public.shifts where id = p_shift;
  if not found then perform app.fail('not_found', 'Shift not found'); end if;
  perform internal.require_supervisor_not_self(v_s.department_id, p_profile);
  if p_kind not in ('in', 'out') then perform app.fail('validation', 'Choose time-in or time-out'); end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then perform app.fail('validation', 'Say why the time is attested'); end if;
  if p_at > now() + interval '5 minutes' then perform app.fail('validation', 'The time cannot be in the future'); end if;
  if p_at < v_s.starts_at - interval '12 hours' or p_at > v_s.ends_at + interval '12 hours' then
    perform app.fail('validation', 'The time must be close to the shift');
  end if;
  insert into public.attendance_events (event_key, profile_id, department_id, kind, source, captured_at, recorded_by, note)
  values ('attest:' || gen_random_uuid(), p_profile, v_s.department_id, p_kind, 'attestation', p_at, auth.uid(), trim(p_reason))
  returning id into v_id;
  perform app.audit('attendance.attested', 'attendance_event', v_id, v_s.department_id,
    jsonb_build_object('profile', p_profile, 'shift', p_shift, 'kind', p_kind, 'at', p_at));
  perform internal.reconcile_one(p_shift, p_profile);
  return v_id;
end $$;

create function app.verify_attendance(p_records uuid[]) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_r public.attendance_records;
  v_n int := 0;
begin
  for v_r in select * from public.attendance_records where id = any (p_records) for update loop
    perform internal.require_supervisor_not_self(v_r.department_id, v_r.profile_id);
    if v_r.locked_at is not null then perform app.fail('immutable', 'This period is locked'); end if;
    if v_r.status <> 'present' then perform app.fail('invalid_state', 'Only complete time-in and time-out can be verified'); end if;
    update public.attendance_records set verified_by = auth.uid(), verified_at = now() where id = v_r.id;
    update public.attendance_exceptions set state = 'resolved', resolved_by = auth.uid(), resolved_at = now(), resolution = 'Seen when verifying'
    where shift_id = v_r.shift_id and profile_id = v_r.profile_id and state = 'open' and kind in ('late', 'undertime', 'duplicate');
    perform app.audit('attendance.verified', 'attendance_record', v_r.id, v_r.department_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create function app.confirm_absence(p_record uuid, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_r public.attendance_records;
begin
  select * into v_r from public.attendance_records where id = p_record for update;
  if not found then perform app.fail('not_found', 'Record not found'); end if;
  perform internal.require_supervisor_not_self(v_r.department_id, v_r.profile_id);
  if v_r.locked_at is not null then perform app.fail('immutable', 'This period is locked'); end if;
  if v_r.status not in ('no_show', 'absent') then perform app.fail('invalid_state', 'Only a duty with no time recorded can be confirmed as absent'); end if;
  update public.attendance_records set status = 'absent', absence_confirmed_by = auth.uid() where id = p_record;
  update public.attendance_exceptions set state = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
    resolution = 'Absence confirmed' || case when trim(coalesce(p_note, '')) <> '' then ': ' || trim(p_note) else '' end
  where shift_id = v_r.shift_id and profile_id = v_r.profile_id and state = 'open' and kind = 'possible_absence';
  perform app.audit('attendance.absence_confirmed', 'attendance_record', p_record, v_r.department_id);
  perform app.notify(v_r.profile_id, 'attendance_absent', 'Absence recorded', 'Your department head recorded an absence for a duty with no time-in. You can request a correction if this is wrong.',
    '/attendance', 'absent:' || p_record, null, false);
end $$;

create function app.decide_overtime(p_record uuid, p_minutes int, p_treatment text, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_r public.attendance_records;
begin
  select * into v_r from public.attendance_records where id = p_record for update;
  if not found then perform app.fail('not_found', 'Record not found'); end if;
  perform internal.require_supervisor_not_self(v_r.department_id, v_r.profile_id);
  if v_r.locked_at is not null then perform app.fail('immutable', 'This period is locked'); end if;
  if p_minutes < 0 or p_minutes > v_r.overtime_candidate_minutes then
    perform app.fail('validation', 'Approve between 0 and ' || v_r.overtime_candidate_minutes || ' minutes (the time actually recorded)');
  end if;
  if p_minutes > 0 and p_treatment not in ('pay', 'compensatory_time') then perform app.fail('validation', 'Choose overtime pay or compensatory time'); end if;
  update public.attendance_records set overtime_approved_minutes = p_minutes,
    overtime_treatment = case when p_minutes > 0 then p_treatment end, overtime_decided_by = auth.uid()
  where id = p_record;
  update public.attendance_exceptions set state = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
    resolution = case when p_minutes > 0 then p_minutes || ' min approved as ' || replace(p_treatment, '_', ' ') else 'Not approved as overtime' end
      || case when trim(coalesce(p_note, '')) <> '' then ' · ' || trim(p_note) else '' end
  where shift_id = v_r.shift_id and profile_id = v_r.profile_id and state = 'open' and kind = 'overtime';
  perform app.audit('attendance.overtime_decided', 'attendance_record', p_record, v_r.department_id,
    jsonb_build_object('minutes', p_minutes, 'treatment', p_treatment));
end $$;

create function app.resolve_attendance_exception(p_exception uuid, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_x public.attendance_exceptions;
begin
  select * into v_x from public.attendance_exceptions where id = p_exception for update;
  if not found then perform app.fail('not_found', 'Review item not found'); end if;
  if not (app.can_supervise_attendance(v_x.department_id) or app.has_capability('timekeeper', v_x.department_id)) then
    perform app.fail('forbidden', 'Not allowed');
  end if;
  if v_x.profile_id = auth.uid() then perform app.fail('forbidden', 'You cannot resolve your own attendance items'); end if;
  if v_x.state <> 'open' then perform app.fail('invalid_state', 'This item is already closed'); end if;
  if v_x.kind in ('missing_in', 'missing_out', 'possible_absence', 'overtime') then
    perform app.fail('validation', 'Fix this with a correction, an attestation, an absence or an overtime decision');
  end if;
  if length(trim(coalesce(p_note, ''))) < 3 then perform app.fail('validation', 'Add a short note'); end if;
  update public.attendance_exceptions set state = 'resolved', resolved_by = auth.uid(), resolved_at = now(), resolution = trim(p_note) where id = p_exception;
  perform app.audit('attendance.exception_resolved', 'attendance_exception', p_exception, v_x.department_id, jsonb_build_object('kind', v_x.kind));
end $$;

-- ---------------------------------------------------------------------------
-- Corrections: staff ask, the Head Nurse decides (never their own)
-- ---------------------------------------------------------------------------
create function app.request_attendance_correction(p_shift uuid, p_kind text, p_at timestamptz, p_event uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me public.profiles;
  v_s public.shifts;
  v_id uuid;
  v_approver uuid;
begin
  select * into v_me from public.profiles where id = auth.uid() and is_active;
  if not found or v_me.department_id is null then perform app.fail('forbidden', 'Only unit staff can request a correction'); end if;
  if p_kind not in ('add_in', 'add_out', 'void_punch') then perform app.fail('validation', 'Choose what to correct'); end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then perform app.fail('validation', 'Say briefly what happened'); end if;
  if p_kind = 'void_punch' then
    if not exists (select 1 from public.attendance_events where id = p_event and profile_id = auth.uid()) then
      perform app.fail('not_found', 'Punch not found');
    end if;
  else
    select * into v_s from public.shifts where id = p_shift and department_id = v_me.department_id;
    if not found then perform app.fail('not_found', 'Shift not found'); end if;
    if p_at is null or p_at > now() then perform app.fail('validation', 'Enter the actual time (not in the future)'); end if;
    if p_at < v_s.starts_at - interval '12 hours' or p_at > v_s.ends_at + interval '12 hours' then
      perform app.fail('validation', 'The time must be close to the shift');
    end if;
  end if;
  if exists (select 1 from public.attendance_records r where r.profile_id = auth.uid() and r.shift_id = p_shift and r.locked_at is not null) then
    perform app.fail('immutable', 'This period is locked. Ask HR for an adjustment in the next period.');
  end if;
  insert into public.attendance_corrections (department_id, profile_id, shift_id, kind, event_id, proposed_at, reason, requested_by)
  values (v_me.department_id, auth.uid(), p_shift, p_kind, p_event, p_at, trim(p_reason), auth.uid()) returning id into v_id;
  perform app.audit('attendance.correction_requested', 'attendance_correction', v_id, v_me.department_id, jsonb_build_object('kind', p_kind));
  for v_approver in
    select id from public.profiles where role = 'manager' and is_active and department_id = v_me.department_id and id <> auth.uid()
  loop
    perform app.notify(v_approver, 'attendance_correction', 'Attendance correction: ' || v_me.full_name,
      case p_kind when 'add_in' then 'Missing time-in' when 'add_out' then 'Missing time-out' else 'Wrong punch' end,
      '/manager/attendance', 'att-corr:' || v_id, null, false);
  end loop;
  return v_id;
end $$;

create function app.decide_attendance_correction(p_correction uuid, p_decision text, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_c public.attendance_corrections;
  v_event uuid;
begin
  select * into v_c from public.attendance_corrections where id = p_correction for update;
  if not found then perform app.fail('not_found', 'Correction not found'); end if;
  perform internal.require_supervisor_not_self(v_c.department_id, v_c.profile_id);
  if v_c.status <> 'pending' then perform app.fail('invalid_state', 'This correction was already decided'); end if;
  if p_decision not in ('approved', 'rejected') then perform app.fail('validation', 'Approve or reject the correction'); end if;
  if p_decision = 'rejected' and length(trim(coalesce(p_note, ''))) < 3 then perform app.fail('validation', 'Say briefly why'); end if;
  if p_decision = 'approved' then
    if v_c.kind = 'void_punch' then
      insert into public.attendance_event_voids (event_id, correction_id, voided_by, reason) values (v_c.event_id, v_c.id, auth.uid(), v_c.reason)
      on conflict (event_id) do nothing;
    else
      insert into public.attendance_events (event_key, profile_id, department_id, kind, source, captured_at, recorded_by, note)
      values ('correction:' || v_c.id, v_c.profile_id, v_c.department_id, case v_c.kind when 'add_in' then 'in' else 'out' end,
              'correction', v_c.proposed_at, auth.uid(), v_c.reason)
      returning id into v_event;
    end if;
  end if;
  update public.attendance_corrections set status = p_decision, decided_by = auth.uid(), decided_at = now(),
    decision_note = trim(coalesce(p_note, '')), created_event_id = v_event where id = p_correction;
  perform app.audit('attendance.correction_' || p_decision, 'attendance_correction', p_correction, v_c.department_id);
  perform app.notify(v_c.profile_id, 'attendance_correction_' || p_decision,
    'Attendance correction ' || case when p_decision = 'approved' then 'approved' else 'not approved' end,
    coalesce(nullif(trim(p_note), ''), 'Open Attendance to see your records.'), '/attendance', 'att-corr:' || p_correction || ':' || p_decision, null, false);
  if v_c.shift_id is not null then perform internal.reconcile_one(v_c.shift_id, v_c.profile_id);
  else perform internal.reconcile_department(v_c.department_id, (v_c.requested_at at time zone 'UTC')::date - 2, (v_c.requested_at at time zone 'UTC')::date + 1);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Replacement on a shift: the original assignment's history stays (removed, not deleted), the
-- replacement is assigned with the usual checks (unit, overlap, approved leave), and both are
-- linked here with who authorised it and when. Works for past shifts (retrospective).
-- ---------------------------------------------------------------------------
create function app.replace_on_shift(p_shift uuid, p_original uuid, p_replacement uuid, p_reason text, p_emergency boolean) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_s public.shifts;
  v_name text;
  v_id uuid;
begin
  select * into v_s from public.shifts where id = p_shift for update;
  if not found then perform app.fail('not_found', 'Shift not found'); end if;
  if not app.can_supervise_attendance(v_s.department_id) then perform app.fail('forbidden', 'Only the department head can arrange cover'); end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then perform app.fail('validation', 'Say why the cover is needed'); end if;
  if p_original = p_replacement then perform app.fail('validation', 'Choose a different person'); end if;
  if not exists (select 1 from public.shift_assignments where shift_id = p_shift and employee_id = p_original and removed_at is null) then
    perform app.fail('not_found', 'That person is not on this shift');
  end if;
  select full_name into v_name from public.profiles where id = p_replacement and is_active and role = 'employee' and department_id = v_s.department_id;
  if v_name is null then perform app.fail('validation', 'The replacement must be active staff of this unit'); end if;
  if exists (select 1 from public.shift_assignments a join public.shifts s on s.id = a.shift_id
             where a.employee_id = p_replacement and a.removed_at is null and s.status = 'scheduled' and s.id <> p_shift
               and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(v_s.starts_at, v_s.ends_at, '[)')) then
    perform app.fail('conflict', v_name || ' is already on an overlapping shift');
  end if;
  if exists (select 1 from public.leave_requests where employee_id = p_replacement and status = 'approved'
             and v_s.shift_date between start_date and end_date) then
    perform app.fail('conflict', v_name || ' is on approved leave that day');
  end if;
  update public.shift_assignments set removed_at = now(), removed_by = auth.uid()
  where shift_id = p_shift and employee_id = p_original and removed_at is null;
  insert into public.shift_assignments (shift_id, employee_id, assigned_by) values (p_shift, p_replacement, auth.uid())
  on conflict (shift_id, employee_id) where removed_at is null do nothing;
  insert into public.coverage_changes (shift_id, department_id, original_profile_id, replacement_profile_id, reason, emergency, retrospective, authorized_by)
  values (p_shift, v_s.department_id, p_original, p_replacement, trim(p_reason), coalesce(p_emergency, false), v_s.ends_at < now(), auth.uid())
  returning id into v_id;
  perform app.audit('shift.replaced', 'shift', p_shift, v_s.department_id,
    jsonb_build_object('original', p_original, 'replacement', p_replacement, 'emergency', p_emergency, 'retrospective', v_s.ends_at < now()));
  perform app.notify(p_replacement, 'shift_assigned', 'Covering: ' || v_s.label,
    to_char(v_s.starts_at at time zone v_s.timezone, 'Dy DD Mon, HH12:MI AM') || ' – ' || to_char(v_s.ends_at at time zone v_s.timezone, 'HH12:MI AM'),
    '/schedule', 'cover:' || v_id, null, false);
  perform app.notify(p_original, 'shift_removed', 'Covered: ' || v_s.label,
    'Someone else covers this shift. ' || trim(p_reason), '/schedule', 'covered:' || v_id, null, false);
  perform internal.reconcile_one(p_shift, p_original);
  perform internal.reconcile_one(p_shift, p_replacement);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function app.policy_for(date), app.create_attendance_station(text, text, text), app.rotate_attendance_station(uuid, text, boolean),
  app.attest_attendance(uuid, uuid, text, timestamptz, text), app.verify_attendance(uuid[]), app.confirm_absence(uuid, text),
  app.decide_overtime(uuid, int, text, text), app.resolve_attendance_exception(uuid, text),
  app.request_attendance_correction(uuid, text, timestamptz, uuid, text), app.decide_attendance_correction(uuid, text, text),
  app.replace_on_shift(uuid, uuid, uuid, text, boolean) from public;
revoke all on function internal.record_expectation(uuid, uuid, uuid, boolean, text), internal.minutes(timestamptz, timestamptz),
  internal.open_exception(uuid, uuid, uuid, uuid, text, text), internal.reconcile_one(uuid, uuid), internal.reconcile_department(uuid, date, date),
  internal.record_station_punch(uuid, uuid, text, text), internal.record_device_punch(uuid, text, text, timestamptz, text),
  internal.require_supervisor_not_self(uuid, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema internal from anon, authenticated';
  end if;
end $$;
grant execute on function app.policy_for(date), app.create_attendance_station(text, text, text), app.rotate_attendance_station(uuid, text, boolean),
  app.attest_attendance(uuid, uuid, text, timestamptz, text), app.verify_attendance(uuid[]), app.confirm_absence(uuid, text),
  app.decide_overtime(uuid, int, text, text), app.resolve_attendance_exception(uuid, text),
  app.request_attendance_correction(uuid, text, timestamptz, uuid, text), app.decide_attendance_correction(uuid, text, text),
  app.replace_on_shift(uuid, uuid, uuid, text, boolean) to authenticated;
