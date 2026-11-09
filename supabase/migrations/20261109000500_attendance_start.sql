-- Attendance starts per unit: at its first QR station or first recorded punch. Duties before that
-- have no attendance evidence and stay "historically unverified" instead of showing as possible
-- absences. (Punches recorded for earlier duties, e.g. attested or corrected, still count.)

create or replace function internal.attendance_start(p_department uuid) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select least((select min(created_at) from public.attendance_stations where department_id = p_department),
               (select min(received_at) from public.attendance_events where department_id = p_department))
$$;
revoke all on function internal.attendance_start(uuid) from public;

create or replace function internal.reconcile_one(p_shift uuid, p_profile uuid) returns void
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

  -- Before the unit's attendance started, a duty without punches stays historically unverified:
  -- no record, no "possible absence".
  if v_in is null and v_out is null and v_leave.id is null
     and (internal.attendance_start(v_s.department_id) is null or v_s.ends_at < internal.attendance_start(v_s.department_id)) then
    delete from public.attendance_records where shift_id = p_shift and profile_id = p_profile and verified_at is null and locked_at is null;
    update public.attendance_exceptions set state = 'cleared', resolved_at = now(), resolution = 'Before attendance started'
    where shift_id = p_shift and profile_id = p_profile and state = 'open';
    return;
  end if;

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

-- Clear what the earlier rule produced for duties before each unit's start.
delete from public.attendance_records r using public.shifts s
where s.id = r.shift_id and r.time_in is null and r.time_out is null and r.leave_request_id is null
  and r.verified_at is null and r.locked_at is null
  and (internal.attendance_start(r.department_id) is null or s.ends_at < internal.attendance_start(r.department_id));
update public.attendance_exceptions x set state = 'cleared', resolved_at = now(), resolution = 'Before attendance started'
from public.shifts s
where s.id = x.shift_id and x.state = 'open' and x.kind in ('possible_absence', 'pending_leave', 'missing_in', 'missing_out')
  and not exists (select 1 from public.attendance_records r where r.shift_id = x.shift_id and r.profile_id = x.profile_id);
