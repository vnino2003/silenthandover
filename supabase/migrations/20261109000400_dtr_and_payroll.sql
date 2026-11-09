-- Daily Time Records (DTR), cutoff periods and payroll.
--
-- Flow: staff confirm their DTR (honor statement) -> the Head Nurse (or Nursing Service, for a Head
-- Nurse's own) verifies and certifies it -> HR timekeeping locks the cutoff period -> Payroll
-- prepares a run from the CERTIFIED totals only -> Finance (a different person) approves ->
-- Finance releases it and staff see their payslip. A locked period never changes; later fixes
-- are adjustments in a later run. Every step is audited.
--
-- The pay computation is a SAMPLE for a government hospital (see workforce_policies): it shows the
-- mechanics with labelled demo rules and leaves out taxes and statutory contributions.

create table public.pay_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(name) between 2 and 80),
  employment_category text not null default 'permanent' check (employment_category in ('permanent', 'casual', 'contractual', 'job_order')),
  cutoff text not null default 'semi_monthly' check (cutoff in ('semi_monthly', 'monthly')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.pay_groups (name, employment_category, cutoff) values ('Nursing service — salaried (sample)', 'permanent', 'semi_monthly');

create table public.pay_group_members (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  pay_group_id uuid not null references public.pay_groups (id) on delete cascade,
  added_by uuid references public.profiles (id) on delete set null,
  added_at timestamptz not null default now()
);

create table public.cutoff_periods (
  id uuid primary key default gen_random_uuid(),
  pay_group_id uuid not null references public.pay_groups (id) on delete cascade,
  start_date date not null,
  end_date date not null,
  pay_date date not null,
  state text not null default 'open' check (state in ('open', 'locked')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  locked_by uuid references public.profiles (id) on delete set null,
  locked_at timestamptz,
  check (end_date >= start_date),
  unique (pay_group_id, start_date)
);

create table public.dtr_versions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  period_id uuid not null references public.cutoff_periods (id) on delete cascade,
  department_id uuid references public.departments (id) on delete set null,
  version int not null,
  state text not null default 'draft' check (state in ('draft', 'staff_confirmed', 'certified', 'superseded')),
  totals jsonb not null,
  days jsonb not null,
  source_records uuid[] not null default '{}',
  policy_version int,
  blocking_items int not null default 0,
  created_at timestamptz not null default now(),
  staff_confirmed_at timestamptz,
  certified_by uuid references public.profiles (id) on delete set null,
  certified_at timestamptz,
  unique (profile_id, period_id, version)
);
create index dtr_versions_period_idx on public.dtr_versions (period_id, state);

create table public.compensation_settings (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  monthly_basic numeric(12, 2) not null check (monthly_basic >= 0),
  effective_from date not null,
  note text not null default '',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (profile_id, effective_from)
);

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.cutoff_periods (id) on delete cascade,
  state text not null default 'draft' check (state in ('draft', 'submitted', 'returned', 'approved', 'released')),
  policy_version int not null,
  totals jsonb not null default '{}'::jsonb,
  prepared_by uuid not null references public.profiles (id),
  prepared_at timestamptz not null default now(),
  submitted_at timestamptz,
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  decision_note text not null default '',
  released_by uuid references public.profiles (id),
  released_at timestamptz
);
create unique index payroll_runs_one_active on public.payroll_runs (period_id) where state <> 'returned';

create table public.payroll_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  dtr_version_id uuid references public.dtr_versions (id) on delete set null,
  kind text not null check (kind in ('earning', 'deduction')),
  code text not null,
  label text not null,
  quantity numeric(12, 2) not null default 0,
  rate numeric(12, 4) not null default 0,
  amount numeric(12, 2) not null,
  sort int not null default 0
);
create index payroll_lines_run_idx on public.payroll_lines (run_id, profile_id);

create table public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('earning', 'deduction')),
  amount numeric(12, 2) not null check (amount > 0),
  label text not null check (length(label) between 3 and 120),
  reason text not null check (length(reason) between 3 and 500),
  for_period_id uuid references public.cutoff_periods (id) on delete set null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  applied_run_id uuid references public.payroll_runs (id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Reading rules. Payroll and Finance see certified totals and pay data, never punches or leave
-- reasons (those tables are not readable to them). Staff see their own DTR and released payslips.
-- ---------------------------------------------------------------------------
create function app.is_payroll_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_capability('payroll_preparer') or app.has_capability('finance_approver') or app.has_capability('hr_admin')
$$;

alter table public.pay_groups enable row level security;
create policy pay_groups_read on public.pay_groups for select to authenticated using (true);
alter table public.pay_group_members enable row level security;
create policy pay_group_members_read on public.pay_group_members for select to authenticated
  using (profile_id = auth.uid() or app.is_payroll_staff() or app.has_capability('timekeeper'));
alter table public.cutoff_periods enable row level security;
create policy cutoff_periods_read on public.cutoff_periods for select to authenticated using (true);
alter table public.dtr_versions enable row level security;
create policy dtr_versions_read on public.dtr_versions for select to authenticated
  using (profile_id = auth.uid() or app.can_supervise_attendance(department_id) or app.has_capability('timekeeper', department_id)
         or (state = 'certified' and app.is_payroll_staff()));
alter table public.compensation_settings enable row level security;
create policy compensation_settings_read on public.compensation_settings for select to authenticated
  using (app.is_payroll_staff());
alter table public.payroll_runs enable row level security;
create policy payroll_runs_read on public.payroll_runs for select to authenticated using (app.is_payroll_staff());
-- Staff see the run header of a released payslip of their own (checked without reading the lines
-- table through its own policy, which would loop).
create function app.has_released_payslip(p_run uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.payroll_lines l join public.payroll_runs r on r.id = l.run_id
                 where l.run_id = p_run and l.profile_id = auth.uid() and r.state = 'released')
$$;
create policy payroll_runs_read_own on public.payroll_runs for select to authenticated using (app.has_released_payslip(id));
alter table public.payroll_lines enable row level security;
create policy payroll_lines_read on public.payroll_lines for select to authenticated
  using (app.is_payroll_staff() or (profile_id = auth.uid() and app.has_released_payslip(run_id)));
alter table public.payroll_adjustments enable row level security;
create policy payroll_adjustments_read on public.payroll_adjustments for select to authenticated using (app.is_payroll_staff());

grant select on public.pay_groups, public.pay_group_members, public.cutoff_periods, public.dtr_versions,
  public.compensation_settings, public.payroll_runs, public.payroll_lines, public.payroll_adjustments to authenticated;

-- ---------------------------------------------------------------------------
-- Periods and pay groups (HR)
-- ---------------------------------------------------------------------------
create function app.create_cutoff_period(p_group uuid, p_start date, p_end date, p_pay date) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if not (app.has_capability('timekeeper') or app.has_capability('hr_admin')) then perform app.fail('forbidden', 'Only HR can set cutoff periods'); end if;
  if p_end < p_start or p_end - p_start > 31 then perform app.fail('validation', 'A cutoff period is 1 to 31 days'); end if;
  if exists (select 1 from public.cutoff_periods where pay_group_id = p_group and daterange(start_date, end_date, '[]') && daterange(p_start, p_end, '[]')) then
    perform app.fail('conflict', 'This overlaps another cutoff period of the pay group');
  end if;
  insert into public.cutoff_periods (pay_group_id, start_date, end_date, pay_date, created_by) values (p_group, p_start, p_end, p_pay, auth.uid())
  returning id into v_id;
  perform app.audit('dtr.period_created', 'cutoff_period', v_id, null, jsonb_build_object('start', p_start, 'end', p_end));
  return v_id;
end $$;

create function app.set_pay_group_member(p_profile uuid, p_group uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (app.has_capability('hr_admin') or app.has_capability('timekeeper')) then perform app.fail('forbidden', 'Only HR can change pay groups'); end if;
  if p_group is null then delete from public.pay_group_members where profile_id = p_profile;
  else
    insert into public.pay_group_members (profile_id, pay_group_id, added_by) values (p_profile, p_group, auth.uid())
    on conflict (profile_id) do update set pay_group_id = excluded.pay_group_id, added_by = excluded.added_by, added_at = now();
  end if;
  perform app.audit('payroll.pay_group_set', 'profile', p_profile, null, jsonb_build_object('pay_group', p_group));
end $$;

-- ---------------------------------------------------------------------------
-- DTR computation (from reconciled attendance records only)
-- ---------------------------------------------------------------------------
-- Minutes of [p_from, p_to) that fall in the night window (e.g. 18:00-06:00) in the time zone.
create function internal.night_minutes(p_from timestamptz, p_to timestamptz, p_tz text, p_start text, p_end text) returns int
language sql immutable as $$
  select coalesce(sum(internal.minutes(greatest(p_from, w.s), least(p_to, w.e))) filter (where least(p_to, w.e) > greatest(p_from, w.s)), 0)::int
  from (
    select ((g.d::date + p_start::time) at time zone p_tz) as s,
           (((g.d::date + 1) + p_end::time) at time zone p_tz) as e
    from generate_series(((p_from at time zone p_tz)::date - 1)::timestamp, ((p_to at time zone p_tz)::date)::timestamp, interval '1 day') as g(d)
  ) w
$$;

create function internal.build_dtr(p_profile uuid, p_period uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.cutoff_periods;
  v_me public.profiles;
  v_tz text;
  v_policy jsonb;
  v_latest public.dtr_versions;
  v_totals jsonb;
  v_days jsonb;
  v_ids uuid[];
  v_blocking int;
  v_id uuid;
begin
  select * into v_p from public.cutoff_periods where id = p_period;
  if not found then perform app.fail('not_found', 'Cutoff period not found'); end if;
  select * into v_me from public.profiles where id = p_profile;
  select coalesce(d.timezone, 'Asia/Manila') into v_tz from public.departments d where d.id = v_me.department_id;
  v_tz := coalesce(v_tz, 'Asia/Manila');
  v_policy := app.policy_for(v_p.start_date);
  if v_me.department_id is not null and v_p.state = 'open' then
    perform internal.reconcile_department(v_me.department_id, v_p.start_date - 1, v_p.end_date);
  end if;

  with recs as (
    select r.*, s.shift_date, s.label
    from public.attendance_records r join public.shifts s on s.id = r.shift_id
    where r.profile_id = p_profile and s.shift_date between v_p.start_date and v_p.end_date
  )
  select
    jsonb_build_object(
      'duties', count(*),
      'scheduled_minutes', coalesce(sum(scheduled_minutes), 0),
      'worked_minutes', coalesce(sum(worked_minutes), 0),
      'regular_payable_minutes', coalesce(sum(case
          when status = 'present' then greatest(0, scheduled_minutes - late_minutes - undertime_minutes)
          when status = 'excused' then paid_leave_minutes else 0 end), 0),
      'late_minutes', coalesce(sum(late_minutes), 0),
      'undertime_minutes', coalesce(sum(undertime_minutes), 0),
      'absences', count(*) filter (where status = 'absent'),
      'absent_minutes', coalesce(sum(scheduled_minutes) filter (where status = 'absent'), 0),
      'paid_leave_minutes', coalesce(sum(paid_leave_minutes), 0),
      'unpaid_leave_minutes', coalesce(sum(unpaid_leave_minutes), 0),
      'overtime_pay_minutes', coalesce(sum(overtime_approved_minutes) filter (where overtime_treatment = 'pay'), 0),
      'compensatory_minutes', coalesce(sum(overtime_approved_minutes) filter (where overtime_treatment = 'compensatory_time'), 0),
      'night_minutes', coalesce(sum(case when status = 'present' then
          internal.night_minutes(greatest(time_in, scheduled_start), least(time_out, scheduled_end), v_tz, v_policy ->> 'night_start', v_policy ->> 'night_end')
          else 0 end), 0),
      'unverified_duties', count(*) filter (where status = 'present' and verified_at is null),
      'unresolved_duties', count(*) filter (where status in ('no_show', 'incomplete', 'clocked_in', 'scheduled'))
    ),
    coalesce(jsonb_agg(jsonb_build_object(
      'day', shift_date, 'shift', label, 'status', status,
      'time_in', time_in, 'time_out', time_out, 'scheduled_start', scheduled_start, 'scheduled_end', scheduled_end,
      'worked_minutes', worked_minutes, 'late_minutes', late_minutes, 'undertime_minutes', undertime_minutes,
      'overtime_minutes', overtime_approved_minutes, 'overtime_treatment', overtime_treatment,
      'paid_leave_minutes', paid_leave_minutes, 'unpaid_leave_minutes', unpaid_leave_minutes,
      'verified', verified_at is not null,
      -- Overnight duty split at local midnight (policy 'split_midnight'), for day-by-day records.
      'split', case when time_in is not null and time_out is not null and (v_policy ->> 'overnight_attribution') = 'split_midnight'
                         and (time_in at time zone v_tz)::date <> (time_out at time zone v_tz)::date
                    then jsonb_build_array(
                      jsonb_build_object('day', (time_in at time zone v_tz)::date,
                        'minutes', internal.minutes(time_in, (((time_out at time zone v_tz)::date)::timestamp at time zone v_tz))),
                      jsonb_build_object('day', (time_out at time zone v_tz)::date,
                        'minutes', internal.minutes((((time_out at time zone v_tz)::date)::timestamp at time zone v_tz), time_out)))
               end
    ) order by scheduled_start), '[]'::jsonb),
    coalesce(array_agg(id), '{}')
  into v_totals, v_days, v_ids
  from recs;

  v_blocking := (v_totals ->> 'unresolved_duties')::int + (v_totals ->> 'unverified_duties')::int
    + (select count(*)::int from public.attendance_exceptions x join public.shifts s on s.id = x.shift_id
       where x.profile_id = p_profile and x.state = 'open' and s.shift_date between v_p.start_date and v_p.end_date
         and x.kind in ('missing_in', 'missing_out', 'possible_absence', 'overtime', 'pending_leave'));

  select * into v_latest from public.dtr_versions where profile_id = p_profile and period_id = p_period order by version desc limit 1;
  if found and v_latest.totals = v_totals and v_latest.days = v_days then
    update public.dtr_versions set blocking_items = v_blocking where id = v_latest.id;
    return v_latest.id;
  end if;
  if found and v_latest.state in ('draft', 'staff_confirmed') then
    -- Not certified yet: the draft is refreshed (staff confirm again after any change).
    update public.dtr_versions set totals = v_totals, days = v_days, source_records = v_ids, blocking_items = v_blocking,
      state = 'draft', staff_confirmed_at = null, created_at = now() where id = v_latest.id;
    return v_latest.id;
  end if;
  if found and v_p.state = 'locked' then return v_latest.id; end if;
  -- First version, or the certified one no longer matches the records: a new version to certify.
  update public.dtr_versions set state = 'superseded' where profile_id = p_profile and period_id = p_period and state = 'certified';
  insert into public.dtr_versions (profile_id, period_id, department_id, version, totals, days, source_records, policy_version, blocking_items)
  values (p_profile, p_period, v_me.department_id, coalesce(v_latest.version, 0) + 1, v_totals, v_days, v_ids,
          (select version from public.workforce_policies where effective_from <= v_p.start_date order by effective_from desc, version desc limit 1), v_blocking)
  returning id into v_id;
  return v_id;
end $$;

-- Opens (refreshes) a DTR: the person themselves, their Head Nurse / Nursing Service, or HR.
create function app.open_dtr(p_profile uuid, p_period uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
begin
  select department_id into v_dept from public.profiles where id = p_profile;
  if not (p_profile = auth.uid() or app.can_supervise_attendance(v_dept) or app.has_capability('timekeeper', v_dept)) then
    perform app.fail('not_found', 'DTR not found');
  end if;
  return internal.build_dtr(p_profile, p_period);
end $$;

create function app.confirm_my_dtr(p_dtr uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_d public.dtr_versions;
begin
  select * into v_d from public.dtr_versions where id = p_dtr for update;
  if not found or v_d.profile_id <> auth.uid() then perform app.fail('not_found', 'DTR not found'); end if;
  if v_d.state <> 'draft' then perform app.fail('invalid_state', 'This DTR is already ' || replace(v_d.state, '_', ' ')); end if;
  update public.dtr_versions set state = 'staff_confirmed', staff_confirmed_at = now() where id = p_dtr;
  perform app.audit('dtr.staff_confirmed', 'dtr_version', p_dtr, v_d.department_id);
end $$;

create function app.certify_dtr(p_dtr uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_d public.dtr_versions;
  v_fresh uuid;
begin
  select * into v_d from public.dtr_versions where id = p_dtr for update;
  if not found then perform app.fail('not_found', 'DTR not found'); end if;
  perform internal.require_supervisor_not_self(v_d.department_id, v_d.profile_id);
  v_fresh := internal.build_dtr(v_d.profile_id, v_d.period_id);
  select * into v_d from public.dtr_versions where id = v_fresh for update;
  if v_d.state <> 'staff_confirmed' then
    perform app.fail('invalid_state', 'The staff member must confirm this DTR first (it changed or was not confirmed yet)');
  end if;
  if v_d.blocking_items > 0 then
    perform app.fail('invalid_state', v_d.blocking_items || ' item(s) need attention first: verify duties, and settle missing punches, possible absences, overtime and pending leave');
  end if;
  update public.dtr_versions set state = 'certified', certified_by = auth.uid(), certified_at = now() where id = v_d.id;
  perform app.audit('dtr.certified', 'dtr_version', v_d.id, v_d.department_id, jsonb_build_object('version', v_d.version));
  perform app.notify(v_d.profile_id, 'dtr_certified', 'Your DTR was certified', 'Your daily time record for the cutoff was verified and certified.',
    '/my-dtr', 'dtr:' || v_d.id, null, false);
end $$;

-- HR locks the period: every member of the pay group with duties needs a certified DTR. Records
-- are frozen; later changes go through adjustments.
create function app.lock_period(p_period uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.cutoff_periods;
  v_missing int;
begin
  if not app.has_capability('timekeeper') then perform app.fail('forbidden', 'Only HR timekeeping can lock a period'); end if;
  select * into v_p from public.cutoff_periods where id = p_period for update;
  if not found then perform app.fail('not_found', 'Cutoff period not found'); end if;
  if v_p.state = 'locked' then perform app.fail('invalid_state', 'Already locked'); end if;
  select count(*) into v_missing
  from public.pay_group_members m
  where m.pay_group_id = v_p.pay_group_id
    and exists (select 1 from public.attendance_records r join public.shifts s on s.id = r.shift_id
                where r.profile_id = m.profile_id and s.shift_date between v_p.start_date and v_p.end_date)
    and not exists (select 1 from public.dtr_versions d where d.profile_id = m.profile_id and d.period_id = p_period and d.state = 'certified');
  if v_missing > 0 then perform app.fail('invalid_state', v_missing || ' DTR(s) in this pay group are not certified yet'); end if;
  update public.cutoff_periods set state = 'locked', locked_by = auth.uid(), locked_at = now() where id = p_period;
  update public.attendance_records r set locked_at = now()
  from public.shifts s, public.pay_group_members m
  where s.id = r.shift_id and m.profile_id = r.profile_id and m.pay_group_id = v_p.pay_group_id
    and s.shift_date between v_p.start_date and v_p.end_date and r.locked_at is null;
  perform app.audit('dtr.period_locked', 'cutoff_period', p_period, null);
  return jsonb_build_object('locked', true);
end $$;

-- ---------------------------------------------------------------------------
-- Payroll
-- ---------------------------------------------------------------------------
create function app.set_compensation(p_profile uuid, p_monthly numeric, p_from date, p_note text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if not app.has_capability('hr_admin') then perform app.fail('forbidden', 'Only HR can set compensation'); end if;
  if p_profile = auth.uid() then perform app.fail('forbidden', 'You cannot set your own compensation'); end if;
  insert into public.compensation_settings (profile_id, monthly_basic, effective_from, note, created_by)
  values (p_profile, round(p_monthly, 2), p_from, coalesce(trim(p_note), ''), auth.uid())
  on conflict (profile_id, effective_from) do update set monthly_basic = excluded.monthly_basic, note = excluded.note, created_by = excluded.created_by
  returning id into v_id;
  perform app.audit('payroll.compensation_set', 'profile', p_profile, null, jsonb_build_object('effective_from', p_from));
  return v_id;
end $$;

create function app.add_payroll_adjustment(p_profile uuid, p_kind text, p_amount numeric, p_label text, p_reason text, p_for_period uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if not (app.has_capability('payroll_preparer') or app.has_capability('hr_admin')) then perform app.fail('forbidden', 'Not allowed'); end if;
  if p_profile = auth.uid() then perform app.fail('forbidden', 'You cannot adjust your own pay'); end if;
  insert into public.payroll_adjustments (profile_id, kind, amount, label, reason, for_period_id, created_by)
  values (p_profile, p_kind, round(p_amount, 2), trim(p_label), trim(p_reason), p_for_period, auth.uid()) returning id into v_id;
  perform app.audit('payroll.adjustment_added', 'payroll_adjustment', v_id, null, jsonb_build_object('kind', p_kind));
  return v_id;
end $$;

-- Builds a draft run for a LOCKED period from certified DTRs and the versioned policy.
create function app.prepare_payroll(p_period uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.cutoff_periods;
  v_g public.pay_groups;
  v_policy jsonb;
  v_run uuid;
  v_d record;
  v_monthly numeric;
  v_hourly numeric;
  v_per_min numeric;
  v_t jsonb;
  v_basic numeric;
  v_sort int;
  v_a record;
begin
  if not app.has_capability('payroll_preparer') then perform app.fail('forbidden', 'Only payroll personnel prepare payroll'); end if;
  select * into v_p from public.cutoff_periods where id = p_period;
  if not found then perform app.fail('not_found', 'Cutoff period not found'); end if;
  if v_p.state <> 'locked' then perform app.fail('invalid_state', 'HR must lock this period first'); end if;
  select * into v_g from public.pay_groups where id = v_p.pay_group_id;
  if exists (select 1 from public.payroll_runs where period_id = p_period and state <> 'returned') then
    perform app.fail('conflict', 'A payroll run for this period already exists');
  end if;
  v_policy := app.policy_for(v_p.start_date);
  insert into public.payroll_runs (period_id, policy_version, prepared_by)
  values (p_period, (select version from public.workforce_policies where effective_from <= v_p.start_date order by effective_from desc, version desc limit 1), auth.uid())
  returning id into v_run;

  for v_d in
    select d.* from public.dtr_versions d join public.pay_group_members m on m.profile_id = d.profile_id and m.pay_group_id = v_p.pay_group_id
    where d.period_id = p_period and d.state = 'certified'
  loop
    if v_d.profile_id = auth.uid() then perform app.fail('forbidden', 'Your own pay is in this period; another payroll staff member must prepare it'); end if;
    select monthly_basic into v_monthly from public.compensation_settings
      where profile_id = v_d.profile_id and effective_from <= v_p.end_date order by effective_from desc limit 1;
    if v_monthly is null then continue; end if;
    v_hourly := v_monthly / (v_policy ->> 'days_per_month')::numeric / (v_policy ->> 'hours_per_day')::numeric;
    v_per_min := v_hourly / 60;
    v_t := v_d.totals;
    v_basic := case when v_g.cutoff = 'semi_monthly' then v_monthly / 2 else v_monthly end;
    v_sort := 0;
    insert into public.payroll_lines (run_id, profile_id, dtr_version_id, kind, code, label, quantity, rate, amount, sort) values
      (v_run, v_d.profile_id, v_d.id, 'earning', 'basic', 'Basic pay (' || replace(v_g.cutoff, '_', '-') || ')', 1, v_basic, round(v_basic, 2), 10);
    if (v_t ->> 'night_minutes')::int > 0 then
      insert into public.payroll_lines (run_id, profile_id, dtr_version_id, kind, code, label, quantity, rate, amount, sort) values
        (v_run, v_d.profile_id, v_d.id, 'earning', 'night_differential', 'Night differential (sample ' || ((v_policy ->> 'night_rate')::numeric * 100)::int || '%)',
         round((v_t ->> 'night_minutes')::numeric / 60, 2), round(v_hourly * (v_policy ->> 'night_rate')::numeric, 4),
         round((v_t ->> 'night_minutes')::numeric / 60 * v_hourly * (v_policy ->> 'night_rate')::numeric, 2), 20);
    end if;
    if (v_t ->> 'overtime_pay_minutes')::int > 0 then
      insert into public.payroll_lines (run_id, profile_id, dtr_version_id, kind, code, label, quantity, rate, amount, sort) values
        (v_run, v_d.profile_id, v_d.id, 'earning', 'overtime', 'Overtime (sample ' || ((v_policy ->> 'overtime_rate')::numeric * 100)::int || '%)',
         round((v_t ->> 'overtime_pay_minutes')::numeric / 60, 2), round(v_hourly * (v_policy ->> 'overtime_rate')::numeric, 4),
         round((v_t ->> 'overtime_pay_minutes')::numeric / 60 * v_hourly * (v_policy ->> 'overtime_rate')::numeric, 2), 30);
    end if;
    if ((v_t ->> 'late_minutes')::int + (v_t ->> 'undertime_minutes')::int) > 0 then
      insert into public.payroll_lines (run_id, profile_id, dtr_version_id, kind, code, label, quantity, rate, amount, sort) values
        (v_run, v_d.profile_id, v_d.id, 'deduction', 'tardiness', 'Tardiness and undertime',
         (v_t ->> 'late_minutes')::int + (v_t ->> 'undertime_minutes')::int, round(v_per_min, 4),
         round(((v_t ->> 'late_minutes')::int + (v_t ->> 'undertime_minutes')::int) * v_per_min, 2), 40);
    end if;
    if (v_t ->> 'absent_minutes')::int > 0 then
      insert into public.payroll_lines (run_id, profile_id, dtr_version_id, kind, code, label, quantity, rate, amount, sort) values
        (v_run, v_d.profile_id, v_d.id, 'deduction', 'absence', 'Absences', round((v_t ->> 'absent_minutes')::numeric / 60, 2), round(v_hourly, 4),
         round((v_t ->> 'absent_minutes')::numeric * v_per_min, 2), 50);
    end if;
    if (v_t ->> 'unpaid_leave_minutes')::int > 0 then
      insert into public.payroll_lines (run_id, profile_id, dtr_version_id, kind, code, label, quantity, rate, amount, sort) values
        (v_run, v_d.profile_id, v_d.id, 'deduction', 'leave_without_pay', 'Leave without pay', round((v_t ->> 'unpaid_leave_minutes')::numeric / 60, 2), round(v_hourly, 4),
         round((v_t ->> 'unpaid_leave_minutes')::numeric * v_per_min, 2), 60);
    end if;
    for v_a in select * from public.payroll_adjustments where profile_id = v_d.profile_id and applied_run_id is null
               and (for_period_id is null or for_period_id = p_period) loop
      insert into public.payroll_lines (run_id, profile_id, dtr_version_id, kind, code, label, quantity, rate, amount, sort) values
        (v_run, v_d.profile_id, v_d.id, v_a.kind, 'adjustment', 'Adjustment: ' || v_a.label, 1, v_a.amount, v_a.amount, 70);
      update public.payroll_adjustments set applied_run_id = v_run where id = v_a.id;
    end loop;
  end loop;

  update public.payroll_runs set totals = (
    select jsonb_build_object(
      'people', count(distinct profile_id),
      'earnings', coalesce(sum(amount) filter (where kind = 'earning'), 0),
      'deductions', coalesce(sum(amount) filter (where kind = 'deduction'), 0),
      'net', coalesce(sum(case when kind = 'earning' then amount else -amount end), 0))
    from public.payroll_lines where run_id = v_run) where id = v_run;
  perform app.audit('payroll.prepared', 'payroll_run', v_run, null, jsonb_build_object('period', p_period));
  return v_run;
end $$;

create function app.submit_payroll(p_run uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_r public.payroll_runs;
begin
  select * into v_r from public.payroll_runs where id = p_run for update;
  if not found then perform app.fail('not_found', 'Payroll run not found'); end if;
  if v_r.prepared_by <> auth.uid() then perform app.fail('forbidden', 'Only the preparer submits the run'); end if;
  if v_r.state <> 'draft' then perform app.fail('invalid_state', 'Only a draft can be submitted'); end if;
  update public.payroll_runs set state = 'submitted', submitted_at = now() where id = p_run;
  perform app.audit('payroll.submitted', 'payroll_run', p_run, null);
end $$;

-- Finance decides; the preparer can never approve their own run.
create function app.decide_payroll(p_run uuid, p_decision text, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_r public.payroll_runs;
begin
  if not app.has_capability('finance_approver') then perform app.fail('forbidden', 'Only Finance approves payroll'); end if;
  select * into v_r from public.payroll_runs where id = p_run for update;
  if not found then perform app.fail('not_found', 'Payroll run not found'); end if;
  if v_r.prepared_by = auth.uid() then perform app.fail('forbidden', 'The person who prepared the run cannot approve it'); end if;
  if exists (select 1 from public.payroll_lines where run_id = p_run and profile_id = auth.uid()) then
    perform app.fail('forbidden', 'Your own pay is in this run; another Finance approver must decide it');
  end if;
  if v_r.state <> 'submitted' then perform app.fail('invalid_state', 'Only a submitted run can be decided'); end if;
  if p_decision not in ('approved', 'returned') then perform app.fail('validation', 'Approve or return the run'); end if;
  if p_decision = 'returned' and length(trim(coalesce(p_note, ''))) < 3 then perform app.fail('validation', 'Say what must be fixed'); end if;
  if p_decision = 'returned' then
    update public.payroll_adjustments set applied_run_id = null where applied_run_id = p_run;
  end if;
  update public.payroll_runs set state = p_decision, approved_by = auth.uid(), approved_at = now(), decision_note = trim(coalesce(p_note, '')) where id = p_run;
  perform app.audit('payroll.' || p_decision, 'payroll_run', p_run, null);
end $$;

create function app.release_payroll(p_run uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_r public.payroll_runs;
  v_person uuid;
begin
  if not app.has_capability('finance_approver') then perform app.fail('forbidden', 'Only Finance releases payroll'); end if;
  select * into v_r from public.payroll_runs where id = p_run for update;
  if not found then perform app.fail('not_found', 'Payroll run not found'); end if;
  if v_r.state <> 'approved' then perform app.fail('invalid_state', 'Only an approved run can be released'); end if;
  update public.payroll_runs set state = 'released', released_by = auth.uid(), released_at = now() where id = p_run;
  for v_person in select distinct profile_id from public.payroll_lines where run_id = p_run loop
    perform app.notify(v_person, 'payslip_released', 'Your payslip is ready', 'Open Payslips to see the details.', '/payslips', 'payslip:' || p_run || ':' || v_person, null, false);
  end loop;
  perform app.audit('payroll.released', 'payroll_run', p_run, null);
end $$;

revoke all on function app.is_payroll_staff(), app.has_released_payslip(uuid), app.create_cutoff_period(uuid, date, date, date), app.set_pay_group_member(uuid, uuid),
  app.open_dtr(uuid, uuid), app.confirm_my_dtr(uuid), app.certify_dtr(uuid), app.lock_period(uuid),
  app.set_compensation(uuid, numeric, date, text), app.add_payroll_adjustment(uuid, text, numeric, text, text, uuid),
  app.prepare_payroll(uuid), app.submit_payroll(uuid), app.decide_payroll(uuid, text, text), app.release_payroll(uuid) from public;
revoke all on function internal.night_minutes(timestamptz, timestamptz, text, text, text), internal.build_dtr(uuid, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema internal from anon, authenticated';
  end if;
end $$;
grant execute on function app.is_payroll_staff(), app.has_released_payslip(uuid), app.create_cutoff_period(uuid, date, date, date), app.set_pay_group_member(uuid, uuid),
  app.open_dtr(uuid, uuid), app.confirm_my_dtr(uuid), app.certify_dtr(uuid), app.lock_period(uuid),
  app.set_compensation(uuid, numeric, date, text), app.add_payroll_adjustment(uuid, text, numeric, text, text, uuid),
  app.prepare_payroll(uuid), app.submit_payroll(uuid), app.decide_payroll(uuid, text, text), app.release_payroll(uuid) to authenticated;
